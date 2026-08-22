import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * TP-1.4a / TP-1.4b（T1.4，CL-2 R-2.4）：删除收口等待的竞态剧本——
 * 「等到无 run」语义漂移 → 捕获 run 引用语义。
 *
 * 【竞态窗口机制（ex3 §1.3/1.4 实读口径）】一个 run 的收口非原子：
 *   ① agent_end 经引擎监听器**同步**回流 → settleRunEnd → setLifecycle("idle")
 *      （aborting→idle 合法迁移）；
 *   ② 之后 engine.start promise 才 resolve → sendMessage 的 await run 才恢复
 *      → finally 清 activeRun。
 * 窗口 = ①与②之间（若干微任务拍）：此刻 lifecycle=idle 而 activeRun 仍指旧 run。
 * 窗口内开新 run 的路径 = sendMessage(idle)（同步登记完毕）与
 * injectClosure(idle)（fire-and-forget void sendMessage）；steer 被
 * lifecycle.assertIn("running") 拦截（idle/aborting 下抛业务错误）。
 *
 * 【时序控制（确定性，无 timer 竞态）】spy publisher 在首个
 * agent.state.changed{state:"idle"}（即 A 的 abort 收口回流）时
 * queueMicrotask 注入 run B：该微任务先于「engine.start resolve → IIFE
 * 继续 → run A promise settle」入队，故 B 的登记确定性地落在窗口内；
 * 旧 run 的 finally 判等保护（activeRun === run）不清空新 run（B 不被误杀）。
 *
 * 【断言语义】删除等待（whenSettled——SessionRegistry.deleteSession 的
 * 收口等待面）应 = 捕获时刻的 run A 收口：A settle 即等待完成，不因窗口内
 * 起飞的 run B 延长；B 生命周期与等待决策解耦（正常运行至完成）。
 * 现状（while 轮询）在 A 收口后重读 activeRun 查到 B → 等待被 B 延长
 * （「等到无 run」漂移）——RED 即该漂移的复现证据。
 *
 * 注：剧本不调 stop()——stop 置 stopped 终态后 sendMessage 抛错、
 * injectClosure 丢弃，B 结构性无法起飞；生产删除链的 abort/stop/等待发起
 * 同处一个同步块（无 interleaving 点），捕获语义对二者等价，剧本聚焦
 * 等待原语本身。FakeAgentEngine 接口契约不变（TR-TEST-3）。
 */

class FixedClock {
  private t = 0;
  now(): string {
    return new Date(this.t++).toISOString();
  }
  nowMs(): number {
    return this.t++;
  }
}

/**
 * 窗口注入 spy：首个 agent.state.changed{state:"idle"}（A 的 abort 收口
 * 回流）→ queueMicrotask 触发注入回调；可选监听 turn.completed（B 收口
 * 可观测点——同步推送，位置确定）。是观察面非替身（不替被测单元）。
 */
class WindowSpyPublisher implements EventPublisherPort {
  private injected = false;
  readonly domainEvents: DomainEvent[] = [];
  constructor(
    private readonly onIdleWindow: () => void,
    private readonly onTurnCompleted?: () => void,
  ) {}
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
    if (
      !this.injected &&
      event.type === "agent.state.changed" &&
      (event.payload as { state?: string }).state === "idle"
    ) {
      this.injected = true;
      queueMicrotask(this.onIdleWindow);
    }
    if (event.type === "turn.completed") this.onTurnCompleted?.();
  }
  publishDelta(_delta: StreamDelta): void {}
}

/** 轮询等待条件成立（收尾观测用，非次序断言源）。 */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TP-1.4a 竞态剧本：删除等待 = 捕获的 run A 收口（不因窗口内 run B 延长）", () => {
  test("① sendMessage 路径：A abort 收口窗口内新 run B 起飞——等待在 A 收口后完成，B 正常运行不被误杀", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "第一问的长回复，给 abort 与竞态窗口留出时序。", chunkDelayMs: 12 },
        { text: "第二问的回复。" },
      ],
    });
    const order: string[] = [];
    let sendBDone: Promise<void> | undefined;
    let chat: ChatService; // eslint-disable-line prefer-const
    const spy = new WindowSpyPublisher(() => {
      // 窗口内（lifecycle=idle、run A 的 promise 未 settle）：开 run B——
      // sendMessage 的 idle 分支同步登记完毕（appendUserEntry → beginTurn →
      // running → activeRun=runB）
      sendBDone = chat.sendMessage("第二问").then(() => {
        order.push("sendB-done");
      });
    });
    chat = new ChatService({ engine, events: spy, clock: new FixedClock() });

    // 剧本：run A 进行中 → 删除链同款等待面发起（捕获语义应等 A）→ abort A
    //（生产链序为 abort → stop → 等待；三者同处一个同步块，捕获点等价）
    const sendA = chat.sendMessage("第一问");
    const settledDone = chat.whenSettled().then(() => {
      order.push(`settled:${chat.agentState}`);
    });
    chat.abort();

    await sendA; // A 收口（abort 序列 + 窗口 + B 起飞均在此期间完成）
    await settledDone;
    expect(sendBDone).toBeDefined();
    await sendBDone!;

    // 核心断言（次序确定）：等待完成先于 B 收口，且完成时刻 B 仍在飞——
    // 现状轮询实现下等待被 B 延长（order = ["sendB-done","settled:idle"]）→ RED
    expect(order).toEqual(["settled:running", "sendB-done"]);

    // B 不被误杀：B 的 run 正常跑完（assistant 落账 + turn completed）
    const view = chat.sessionView;
    const texts = view.entryList().map((e) => ("text" in e ? (e as { text?: string }).text ?? "" : ""));
    expect(texts.some((t) => t.includes("第一问"))).toBe(true); // A 的 user 落账
    expect(texts.some((t) => t.includes("第二问"))).toBe(true); // B 的 user 落账
    expect(texts.some((t) => t.includes("第二问的回复"))).toBe(true); // B 的 assistant 落账
    expect(engine.events.filter((e) => e.type === "agent_end").length).toBe(2); // A、B 各收口一次
    // domain 契约：A 的 turn interrupted（abort 收口）、B 的 turn completed
    expect(view.turnList().map((t) => t.status)).toEqual(["interrupted", "completed"]);
    expect(chat.agentState).toBe("idle");
  });

  test("② injectClosure 路径（fire-and-forget）：同窗口经调度侧收口回调开 run B——等待仍 = A 收口，B 解耦运行", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "第一问的长回复，给 abort 与竞态窗口留出时序。", chunkDelayMs: 12 },
        { text: "闭包注入的回复。" },
      ],
    });
    const order: string[] = [];
    let chat: ChatService; // eslint-disable-line prefer-const
    const spy = new WindowSpyPublisher(
      () => {
        // 窗口内经 injectClosure(idle) fire-and-forget 开 run B（ex3 路径 B）
        chat.injectClosure("闭包注入的第二问");
        order.push(`B-launched:${chat.agentState}`);
      },
      () => {
        order.push("B-turn-completed");
      },
    );
    chat = new ChatService({ engine, events: spy, clock: new FixedClock() });

    const sendA = chat.sendMessage("第一问");
    const settledDone = chat.whenSettled().then(() => {
      order.push(`settled:${chat.agentState}`);
    });
    chat.abort();

    await sendA;
    await settledDone;
    // B 经 fire-and-forget 起飞，收口以事件可观测（turn.completed 同步推送）
    await until(() => order.includes("B-turn-completed"));

    // 核心断言：等待完成（settled:running——B 仍在飞）先于 B 收口——
    // 现状轮询实现下为 ["B-launched:running","B-turn-completed","settled:idle"] → RED
    expect(order).toEqual(["B-launched:running", "settled:running", "B-turn-completed"]);

    // B 不被误杀 + domain 契约
    const view = chat.sessionView;
    const texts = view.entryList().map((e) => ("text" in e ? (e as { text?: string }).text ?? "" : ""));
    expect(texts.some((t) => t.includes("闭包注入的第二问"))).toBe(true);
    expect(texts.some((t) => t.includes("闭包注入的回复"))).toBe(true);
    expect(view.turnList().map((t) => t.status)).toEqual(["interrupted", "completed"]);
    expect(chat.agentState).toBe("idle");
  });
});

describe("TP-1.4b 结构断言：while 轮询消灭（grep 判据）", () => {
  test("ChatService 源码 `while (this.activeRun` 零残留", () => {
    const src = readFileSync(
      path.join(import.meta.dir, "..", "..", "src", "application", "services", "ChatService.ts"),
      "utf8",
    );
    expect(src.includes("while (this.activeRun")).toBe(false);
  });
});

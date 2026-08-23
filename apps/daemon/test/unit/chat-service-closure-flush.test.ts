import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T2（closure 送达补齐）：aborting 窗口的 closure 暂存（FIFO）+ abort 收尾
 * 回 idle 后逐条 flush——每条独立新 turn（fire-and-forget sendMessage，失败
 * engine.error 可观测、不崩链）；stopped 维持可观测丢弃。
 *
 * 【flush 时机机制依据（delete-settle-race 同款竞态窗口口径）】run 收口
 * 非原子：agent_end 经引擎监听器同步回流 → settleRunEnd → setLifecycle
 * ("idle")；此后 engine.start promise 才 resolve。窗口内（idle 已置、run
 * promise 未 settle）引擎仍视为在飞——FakeAgentEngine.start 在飞守卫会抛
 * 「协议误用」。故 flush 不可在 settleRunEnd 同步段内直接 sendMessage，
 * 必须挂 dying run 的 promise settle 之后（微任务拍）。
 *
 * 【flush 机制选型：逐条链式】每条经 sendMessage idle 路径独立成 turn
 * （与 idle 分支同语义），一条 promise settle 后续发下一条（FIFO）；
 * 余量不并入 steer 队列（closure 是 SubAgent 收口结论，须以顶层新 turn
 * 送达而非混入在飞 run 的注入队列）。窗口被用户新 run 占用时挂该 run
 * 收口后续送（不丢），由幂等守卫收敛多条触发链。
 */

class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  readonly deltas: StreamDelta[] = [];
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
  }
  publishDelta(delta: StreamDelta): void {
    this.deltas.push(delta);
  }
}

class FixedClock {
  private t = 0;
  now(): string {
    return new Date(this.t++).toISOString();
  }
  nowMs(): number {
    return this.t++;
  }
}

/** 轮询等待条件成立（时序测试用，规避微任务次序敏感断言）。 */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const chat = new ChatService({ engine, events: publisher, clock: new FixedClock() });
  return { chat, publisher };
}

/** role entry 文本序列（快照断言便利）。 */
function userFacingTexts(chat: ChatService): string[] {
  return chat.sessionSnapshot.entries.filter((e) => "role" in e).map((e) => (e as { text: string }).text);
}

/** 窗口注入 spy：首个 agent.state.changed{idle}（abort 收口回流）时 queueMicrotask
 *  注入回调（先于 dying run promise settle 入队——确定性抢占 flush 窗口；
 *  delete-settle-race WindowSpyPublisher 同款机制）。 */
class IdleWindowSpyPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  readonly deltas: StreamDelta[] = [];
  private fired = false;
  constructor(private readonly onIdleWindow: () => void) {}
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
    if (
      !this.fired &&
      event.type === "agent.state.changed" &&
      (event.payload as { state?: string }).state === "idle"
    ) {
      this.fired = true;
      queueMicrotask(this.onIdleWindow);
    }
  }
  publishDelta(delta: StreamDelta): void {
    this.deltas.push(delta);
  }
}

describe("T2 验收① aborting 暂存 → abort 收尾回 idle 后逐条 flush", () => {
  test("aborting 窗口 injectClosure 未投递；回 idle 后以新 turn（sendMessage 直启新 run）送达", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "很长很长很长很长很长很长很长很长的回复占满流式窗口。", chunkDelayMs: 12 },
        { text: "对 closure 的回复。" },
      ],
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("第一问");
    await until(() => publisher.deltas.length >= 2);
    chat.abort();
    expect(chat.agentState).toBe("aborting");

    chat.injectClosure("子代理结论");

    // 当时未投递：不入 steer 队列、不落 entry、不丢（无丢弃 engine.error）、状态不动
    expect(engine.queuedCount).toBe(0);
    expect(engine.events.filter((e) => e.type === "agent_start")).toHaveLength(1);
    expect(publisher.domainEvents.some((e) => e.type === "steer.queued")).toBe(false);
    expect(publisher.domainEvents.filter((e) => e.type === "engine.error")).toHaveLength(0); // 暂存而非可观测丢弃
    expect(chat.agentState).toBe("aborting");
    expect(userFacingTexts(chat).some((t) => t === "子代理结论")).toBe(false);

    await run; // abort 收尾（agent_end → turn.interrupted → idle → flush 接管）
    // flush 完成：closure turn 以新 run 直启（非 steer drain）、跑完回 idle
    await until(() => chat.sessionSnapshot.turns.length === 2 && chat.agentState === "idle");

    expect(chat.sessionSnapshot.turns.map((t) => t.status)).toEqual(["interrupted", "completed"]);
    expect(userFacingTexts(chat)).toEqual(["第一问", "子代理结论", "对 closure 的回复。"]);
    // 新 turn 直证：两轮 agent_start；closure 轮 user 消息 source=prompt（steer 路径为 steer-drain）
    expect(engine.events.filter((e) => e.type === "agent_start")).toHaveLength(2);
    const userSources = engine.events
      .filter((e) => e.type === "message_start" && e.role === "user")
      .map((e) => (e as { source: string }).source);
    expect(userSources).toEqual(["prompt", "prompt"]);
  });
});

describe("T2 验收② 多条缓冲 FIFO 保序", () => {
  test("3 条 closure 逐条独立 turn，按缓冲顺序送达（不丢、不乱序、不混 steer 队列）", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "很长很长很长很长很长很长很长很长的回复占满流式窗口。", chunkDelayMs: 12 },
        { text: "对结论一的回复。", chunkDelayMs: 4 },
        { text: "对结论二的回复。", chunkDelayMs: 4 },
        { text: "对结论三的回复。", chunkDelayMs: 4 },
      ],
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("第一问");
    await until(() => publisher.deltas.length >= 2);
    chat.abort();
    expect(chat.agentState).toBe("aborting");

    chat.injectClosure("结论一");
    chat.injectClosure("结论二");
    chat.injectClosure("结论三");

    // 全部暂存：不入队、不落账、无丢弃事件
    expect(engine.queuedCount).toBe(0);
    expect(publisher.domainEvents.some((e) => e.type === "steer.queued")).toBe(false);
    expect(publisher.domainEvents.filter((e) => e.type === "engine.error")).toHaveLength(0);

    await run;
    await until(() => chat.sessionSnapshot.turns.length === 4 && chat.agentState === "idle");

    expect(chat.sessionSnapshot.turns.map((t) => t.status)).toEqual([
      "interrupted",
      "completed",
      "completed",
      "completed",
    ]);
    expect(userFacingTexts(chat)).toEqual([
      "第一问",
      "结论一",
      "对结论一的回复。",
      "结论二",
      "对结论二的回复。",
      "结论三",
      "对结论三的回复。",
    ]);
    // 逐条链式直证：4 轮 agent_start（原 run + 3 条 closure 各自成 run），全部 prompt 直启
    expect(engine.events.filter((e) => e.type === "agent_start")).toHaveLength(4);
    expect(
      engine.events.filter((e) => e.type === "message_start" && e.role === "user").map((e) => (e as { source: string }).source),
    ).toEqual(["prompt", "prompt", "prompt", "prompt"]);
  });
});

describe("T2 验收③ stopped 维持可观测丢弃（现状语义回归保护）", () => {
  test("stopped 状态 injectClosure → engine.error（含「丢弃」与文本截断）+ 零投递", () => {
    const engine = new FakeAgentEngine();
    const { chat, publisher } = makeChat(engine);
    chat.stop();
    expect(chat.agentState).toBe("stopped");

    chat.injectClosure("迟到的结论");

    const err = publisher.domainEvents.find((e) => e.type === "engine.error");
    expect(err).toBeDefined();
    const message = (err!.payload as { message: string }).message;
    expect(message).toContain("丢弃");
    expect(message).toContain("stopped");
    expect(message).toContain("迟到的结论");
    // 零投递：无 entry、无 turn、引擎零触碰
    expect(chat.sessionSnapshot.entries).toHaveLength(0);
    expect(chat.sessionSnapshot.turns).toHaveLength(0);
    expect(engine.events).toHaveLength(0);
  });
});

describe("T2 flush 失败隔离（不崩链、无 unhandled rejection）", () => {
  test("单条 flush 失败（sendMessage 抛错）→ engine.error 可观测；余量继续送达（FIFO 余位）", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "很长很长很长很长很长很长很长很长的回复占满流式窗口。", chunkDelayMs: 12 },
        { text: "对结论二的回复。", chunkDelayMs: 4 },
      ],
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("第一问");
    await until(() => publisher.deltas.length >= 2);
    chat.abort();
    chat.injectClosure("   "); // 空白文本 → flush 时 sendMessage 抛「消息内容不能为空」
    chat.injectClosure("结论二");
    await run;

    // 失败条目可观测（closure 注入失败），成功条目照常送达，链不中断
    await until(() => chat.sessionSnapshot.turns.length === 2 && chat.agentState === "idle");
    const errors = publisher.domainEvents
      .filter((e) => e.type === "engine.error")
      .map((e) => (e.payload as { message: string }).message);
    expect(errors.some((m) => m.includes("closure 注入失败") && m.includes("消息内容不能为空"))).toBe(true);
    expect(userFacingTexts(chat)).toEqual(["第一问", "结论二", "对结论二的回复。"]);
    expect(chat.sessionSnapshot.turns.map((t) => t.status)).toEqual(["interrupted", "completed"]);
  });
});

describe("T2 flush 窗口被用户新 run 抢占：closure 挂该 run 收口后续送（不丢）", () => {
  test("abort 收口 idle 窗口内用户新消息先起飞 → closure 等该 run 结束后仍以新 turn 送达", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "很长很长很长很长很长很长很长很长的回复占满流式窗口。", chunkDelayMs: 12 },
        { text: "用户新问的回复。", chunkDelayMs: 4 },
        { text: "对缓冲结论的回复。", chunkDelayMs: 4 },
      ],
    });
    let chat!: ChatService;
    let userRun: Promise<unknown> | undefined;
    const spy = new IdleWindowSpyPublisher(() => {
      // idle 窗口内（dying run promise 未 settle、flush 尚未接管）：用户新消息抢占
      userRun = chat.sendMessage("用户新问");
    });
    chat = new ChatService({ engine, events: spy, clock: new FixedClock() });

    const run = chat.sendMessage("第一问");
    await until(() => spy.deltas.length >= 2);
    chat.abort();
    chat.injectClosure("缓冲结论");
    await run;

    // 用户 run B 先完成（抢占窗口），closure 挂 B 收口后续送（run C）
    await until(() => chat.sessionSnapshot.turns.length === 3 && chat.agentState === "idle");
    expect(userRun).toBeDefined();
    await userRun!;

    expect(chat.sessionSnapshot.turns.map((t) => t.status)).toEqual([
      "interrupted",
      "completed",
      "completed",
    ]);
    expect(userFacingTexts(chat)).toEqual([
      "第一问",
      "用户新问",
      "用户新问的回复。",
      "缓冲结论",
      "对缓冲结论的回复。",
    ]);
  });
});

describe("T2 边界守护：running/steering 分支行为不变（现有语义回归保护）", () => {
  test("running 中 injectClosure 仍即时 steer 入队（source=closure 同队列同语义）", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "足够长的回复留出注入窗口。", chunkDelayMs: 12 }],
      steerReplies: [{ text: "注入后的回复。" }],
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("主线");
    await until(() => publisher.deltas.length >= 2);
    chat.injectClosure("运行中结论");

    expect(engine.queuedCount).toBe(1);
    expect(publisher.domainEvents.some((e) => e.type === "steer.queued")).toBe(true);
    expect(chat.agentState).toBe("steering");

    await run;
    expect(publisher.domainEvents.some((e) => e.type === "steer.drained")).toBe(true);
    expect(userFacingTexts(chat).at(-1)).toBe("注入后的回复。");
    expect(chat.agentState).toBe("idle");
  });
});

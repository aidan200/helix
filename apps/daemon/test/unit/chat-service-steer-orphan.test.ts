/**
 * B 收口清账回归：turn 收口时 domain SteerQueue 残留清账——按 source 分流。
 *
 * 缺陷现场一（task-20260824 steer_queue 孤儿，session 00386a2c）：注入经
 * running 分支入 domain 队列 + engine.steer() 双通道，但 run 已无后续
 * 消费轮（模型正在写最后回复，pi run 收尾不消费残留 pending）——双通道
 * 的引擎侧消费不到；turn 正常收口回 idle 后无人检查 domain 队列，注入
 * 成为永久孤儿（steer_queue 表脏行，下次发消息还可能被补注入过时内容）。
 *
 * 缺陷现场二（task-20260909 closure 丢失，实例 agent-8c1c1106…）：B 清账
 * 不分 source 一律丢弃——closure（SubAgent 收口结论）在 running 窗口入队、
 * 所在轮因 429 秒挂后被当 orphan 丢弃，终态事实从未落时间轴（applySteer
 * 只入队，条目在 drain 才落盘），用户与主线永久看不到该 closure。
 *
 * 现行语义：
 * - closure/progress → 转 closureBuffer 走 T2 续送链（idle 后 sendMessage
 *   落时间轴条目）——必达的终态事实不丢弃；被清项从未 drain 落盘，续送
 *   无重复注入风险。
 * - user/缺省 → 维持 B 原语义：可观测丢弃（engine.error），防过时 steer
 *   被补注入导致重复回复。
 *
 * FakeAgentEngine 是「turn 边界必 drain」策略（§5.3-2），模拟不了这个窗口
 * ——本文件用 NoDrainEngine（steer 只入 pi 等价队列、run 收尾不消费）精确
 * 复现生产时序。
 */
import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import { SessionProjection } from "../../src/application/services/SessionProjection";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { AgentEngineEvent, AgentEnginePort, AgentEngineListener } from "../../src/application/ports/outbound/AgentEnginePort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/** 录音式 EventPublisherPort（chat-service.test.ts 同构，独立内联）。 */
class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  readonly deltas: StreamDelta[] = [];
  private readonly targets: EventPublisherPort[] = [];

  addTarget(target: EventPublisherPort): void {
    this.targets.push(target);
  }
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
    for (const t of this.targets) t.publish(event);
  }
  publishDelta(delta: StreamDelta): void {
    this.deltas.push(delta);
    for (const t of this.targets) t.publishDelta(delta);
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

/**
 * 生产缺陷时序引擎（最小事件序列 + steer 永不消费）：
 * start → 流式 assistant 回复（含流式窗口）→ agent_end 收口。
 * steer() 仅登记（模拟 pi 内建队列残留），run 收尾不 drain——
 * 精确复现 00386a2c 现场（模型正写最后回复时 closure 到达）。
 */
class NoDrainEngine implements AgentEnginePort {
  readonly steered: string[] = [];
  private listener: AgentEngineListener | null = null;
  private streaming = false;

  async start(input: string, listener: AgentEngineListener): Promise<void> {
    this.listener = listener;
    this.streaming = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", role: "assistant", source: "prompt" });
    // 流式窗口：分片间留缝，调用方在此窗 injectClosure
    for (const seg of ["总结", "：", "任务完成。"]) {
      this.emit({ type: "message_update", delta: seg });
      await new Promise((r) => setTimeout(r, 8));
    }
    this.emit({ type: "message_end", role: "assistant", text: "总结：任务完成。", stopReason: "stop" });
    this.emit({ type: "turn_end", toolResultCount: 0 });
    this.emit({ type: "agent_end", messageCount: 1 });
    this.streaming = false;
    this.listener = null;
  }

  steer(text: string): void {
    this.steered.push(text); // 只登记，永不消费（生产缺陷形态）
  }
  abort(): void {
    /* 本测试不用 */
  }
  isStreaming(): boolean {
    return this.streaming;
  }

  private emit(e: AgentEngineEvent): void {
    this.listener?.(e);
  }
}

function makeChat(engine: AgentEnginePort) {
  const publisher = new RecordingPublisher();
  const repo = new InMemorySessionRepository();
  const chat = new ChatService({ engine, events: publisher, clock: new FixedClock() });
  const projection = new SessionProjection({
    repository: repo,
    getSession: () => chat.sessionView,
    getMainState: () => ({ agentState: chat.agentState, toolCalls: chat.toolCallData }),
  });
  publisher.addTarget(projection);
  return { chat, publisher, domainEvents: publisher.domainEvents, deltas: publisher.deltas, repo };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("B 收口清账：turn 收口时 domain SteerQueue 残留按 source 分流", () => {
  test("closure 入队但 run 收尾不消费（8c1c 现场）→ 不丢弃，T2 续送链落时间轴", async () => {
    const engine = new NoDrainEngine();
    const { chat, publisher, domainEvents } = makeChat(engine);

    const run = chat.sendMessage("主线任务");
    await until(() => publisher.deltas.length >= 1);
    // 流式窗口内注入（lifecycle=running）：双通道入队，引擎侧永不消费
    chat.injectClosure("agent-11 closure: done — 已获取结果");
    await run;

    // 清账后队列清空（不留孤儿）
    expect(chat.sessionSnapshot.pendingSteer).toHaveLength(0);
    // closure 不丢弃：无清账 engine.error
    expect(
      domainEvents.some(
        (e) => e.type === "engine.error" && String((e.payload as { message?: string }).message).includes("注入被丢弃"),
      ),
    ).toBe(false);

    // T2 续送链：idle 后以 closure 文本开新轮 → 落时间轴 user 条目（message.completed）
    await until(() =>
      domainEvents.some(
        (e) =>
          e.type === "message.completed" &&
          String((e.payload as { text?: string }).text).includes("agent-11 closure: done — 已获取结果"),
      ),
    );
    await until(() => chat.agentState === "idle");

    // 首轮 turn 正常收口（completed），不因清账中断
    expect(domainEvents.some((e) => e.type === "turn.completed")).toBe(true);
    // 引擎侧 steer 已投递（双通道投递面正常，缺陷仅在收尾不消费）
    expect(engine.steered).toEqual(["agent-11 closure: done — 已获取结果"]);
  });

  test("user steer 入队但 run 收尾不消费 → 维持 B 原语义：可观测丢弃，不补注入", async () => {
    const engine = new NoDrainEngine();
    const { chat, publisher, domainEvents } = makeChat(engine);

    const run = chat.sendMessage("主线任务");
    await until(() => publisher.deltas.length >= 1);
    await chat.steer("用户运行中注入");
    await run;
    await until(() => chat.agentState === "idle");

    expect(chat.sessionSnapshot.pendingSteer).toHaveLength(0);
    const discarded = domainEvents.filter(
      (e) => e.type === "engine.error" && String((e.payload as { message?: string }).message).includes("注入被丢弃"),
    );
    expect(discarded.length).toBe(1);
    expect(String((discarded[0]!.payload as { message?: string }).message)).toContain("用户运行中注入");
    // 不补注入：user steer 文本不落时间轴
    expect(
      domainEvents.some(
        (e) => e.type === "message.completed" && String((e.payload as { text?: string }).text).includes("用户运行中注入"),
      ),
    ).toBe(false);
  });

  test("正常 drain 路径不受影响（FakeAgentEngine 必 drain 策略，有续轮时 closure 照常注入）", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "这是足够长的回复，留出流式注入窗口。", chunkDelayMs: 12 }],
      steerReplies: [{ text: "收到收口结论。" }],
    });
    const { chat, publisher, domainEvents } = makeChat(engine);

    const run = chat.sendMessage("主线任务");
    await until(() => publisher.deltas.length >= 2);
    chat.injectClosure("agent-1 closure: done — 调研完成");
    await run;
    await until(() => chat.agentState === "idle");

    // 正常路径：drain 发生（steer.drained 存在）+ 队列清空 + 无清账丢弃
    expect(domainEvents.some((e) => e.type === "steer.drained")).toBe(true);
    expect(chat.sessionSnapshot.pendingSteer).toHaveLength(0);
    const discarded = domainEvents.find(
      (e) => e.type === "engine.error" && String((e.payload as { message?: string }).message).includes("注入被丢弃"),
    );
    expect(discarded).toBeUndefined();
  });
});

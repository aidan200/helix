import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import { SessionProjection } from "../../src/application/services/SessionProjection";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { AgentEnginePort } from "../../src/application/ports/outbound/AgentEnginePort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/**
 * error entry 批：引擎/模型失败链落错误条目（时间轴原位红条的数据源）。
 *
 * - engine.start 抛错（run 启动即败）：轮次失败收尾时先落错误条目再收口——
 *   error 条目挂出错轮（turnId），error.entry 领域事件携带完整 entry
 *  （仿 compaction.completed 先例），engine.error 事件本身不变（trace 链不动），
 *   轮次按既有语义 aborted 收口，write-through 快照含 error 条目；
 * - engine_error 引擎事件（run 中失败注入，如 turn 边界 compaction 失败）：
 *   error 条目落树 + error.entry 事件 + 会话无损可继续。
 */

/** 录音式 EventPublisherPort（与 chat-service.test.ts 同型）。 */
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

/** 启动即抛错的引擎（run 失败链：engine.start throw 分支）。 */
class ThrowingEngine implements AgentEnginePort {
  constructor(private readonly failure: string) {}
  async start(): Promise<void> {
    throw new Error(this.failure);
  }
  steer(): void {}
  abort(): void {}
  isStreaming(): boolean {
    return false;
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
  return { chat, publisher, repo };
}

describe("error entry 批：engine.start 抛错 → 错误条目落盘 + error.entry 事件", () => {
  test("错误条目挂出错轮 + error.entry 携带完整 entry + engine.error 不变 + 轮次 aborted 收口 + 快照含 error 条目", async () => {
    const { chat, publisher, repo } = makeChat(new ThrowingEngine("503 Service Unavailable"));

    await chat.sendMessage("第一问");

    // ① error 条目落聚合：kind=error、挂出错轮、主实例归属
    const entries = chat.sessionView.entryList();
    const errEntry = entries.find((e) => "kind" in e && e.kind === "error");
    expect(errEntry).toBeDefined();
    expect(errEntry).toMatchObject({
      kind: "error",
      instanceId: chat.sessionView.mainInstanceId,
      message: "503 Service Unavailable",
      turnId: "t1", // 出错轮（原位可见的锚）
    });

    // ② error.entry 领域事件携带完整 entry（仿 compaction.completed 先例）
    const errorEntryEvent = publisher.domainEvents.find((e) => e.type === "error.entry");
    expect(errorEntryEvent).toBeDefined();
    expect(errorEntryEvent?.instanceId).toBe(chat.sessionView.mainInstanceId);
    expect((errorEntryEvent?.payload as { entry: unknown }).entry).toEqual(errEntry);

    // ③ engine.error 事件本身不变（trace 链不动）——同失败链两事件并存
    const engineError = publisher.domainEvents.find((e) => e.type === "engine.error");
    expect(engineError).toMatchObject({ type: "engine.error", payload: { message: "503 Service Unavailable" } });

    // ④ 轮次按既有语义收口（aborted），生命周期回 idle
    const interrupted = publisher.domainEvents.find((e) => e.type === "turn.interrupted");
    expect(interrupted).toBeDefined();
    expect(chat.agentState).toBe("idle");

    // ⑤ write-through：error.entry 事件触发落盘，快照 entries 含 error 条目
    const saved = await repo.restore(chat.sessionId);
    expect(saved?.session.entries.some((e) => "kind" in e && e.kind === "error")).toBe(true);
  });
});

describe("error entry 批：engine_error 引擎事件（run 中失败注入）→ 错误条目落树 + 会话无损", () => {
  test("compaction 失败注入：error 条目落树 + error.entry 事件 + engine.error 不变 + 回复正常落账", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "正常回复。", compactionError: "compaction 摘要失败：boom" }],
    });
    const { chat, publisher } = makeChat(engine);

    await chat.sendMessage("问一句");
    await chat.whenSettled();

    // ① error 条目落树（run 中失败：挂当前 open turn）
    const errEntry = chat.sessionView.entryList().find((e) => "kind" in e && e.kind === "error");
    expect(errEntry).toMatchObject({
      kind: "error",
      message: "compaction 摘要失败：boom",
      turnId: "t1",
    });

    // ② error.entry 事件携带完整 entry
    const errorEntryEvent = publisher.domainEvents.find((e) => e.type === "error.entry");
    expect((errorEntryEvent?.payload as { entry: unknown }).entry).toEqual(errEntry);

    // ③ engine.error 事件不变（可观测面/trace 链不动）
    expect(
      publisher.domainEvents.some(
        (e) => e.type === "engine.error" && (e.payload as { message: string }).message === "compaction 摘要失败：boom",
      ),
    ).toBe(true);

    // ④ 会话无损：回复正常落账、轮次正常完成
    expect(chat.sessionView.entryList().some((e) => "role" in e && e.role === "assistant" && e.text === "正常回复。")).toBe(true);
    expect(publisher.domainEvents.some((e) => e.type === "turn.completed")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import type { UsageRecordedPayload } from "../../src/domain/events/DomainEvent";

/**
 * T3.2 RED：ChatService turn 入账编排（FakeAgentEngine 剧本）——
 * ① 每 turn 恰一条 usage.recorded(source=turn)（message_end 携带 usage 即入账，
 *    多轮等量、载荷七字段不变换）；
 * ② 流式中不动账（首条文本 delta 到达时账目事件数为 0——delta 分支结构性
 *    不触 usage；turn 完成即刻 +1）；
 * ③ 工具轮的中间 message_end（stopReason=toolUse，无 usage）不入账；
 * ④ compaction 剧本：turn 一条 + compaction 一条，不重复发。
 */

/** 记账型 publisher：流式首 delta 时刻的账目事件数快照（结构性零账断言源）。 */
class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  readonly deltas: StreamDelta[] = [];
  usageCountAtFirstMessageDelta: number | undefined;

  private usageCount(): number {
    return this.domainEvents.filter((e) => e.type === "usage.recorded").length;
  }

  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
  }
  publishDelta(delta: StreamDelta): void {
    if (delta.channel !== "thinking" && this.usageCountAtFirstMessageDelta === undefined) {
      this.usageCountAtFirstMessageDelta = this.usageCount();
    }
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

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const chat = new ChatService({
    engine,
    events: publisher,
    clock: new FixedClock(),
  });
  return { chat, publisher };
}

function usageEvents(publisher: RecordingPublisher): (DomainEvent & { payload: UsageRecordedPayload })[] {
  return publisher.domainEvents.filter((e) => e.type === "usage.recorded") as (DomainEvent & {
    payload: UsageRecordedPayload;
  })[];
}

describe("T3.2 ① 每 turn 恰一条 usage.recorded(source=turn)", () => {
  test("多轮对话：事件数与 turn 数等量、instanceId=main、载荷七字段不变换", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "第一答。", usage: { input: 10, output: 20, reasoning: 5, totalTokens: 35, cost: 0.01 } },
        { text: "第二答。", usage: { input: 100, output: 200, totalTokens: 300, cost: 0.1 } },
      ],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("第一问");
    await chat.sendMessage("第二问");

    const events = usageEvents(publisher);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.payload.source === "turn")).toBe(true);
    // T10a：主实例 id = 会话创建生成的 agent-<唯一串>（非 "main"）
    const mainId = chat.sessionView.mainInstanceId;
    expect(mainId).toMatch(/^agent-/);
    expect(events.every((e) => e.payload.instanceId === mainId)).toBe(true);
    expect(events.every((e) => e.instanceId === mainId)).toBe(true); // envelope 同值（四维落列）
    expect(events[0]!.payload.usage).toEqual({
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 5,
      totalTokens: 35,
      cost: 0.01,
    });
    expect(events[1]!.payload.usage.totalTokens).toBe(300);
  });
});

describe("T3.2 ② 流式中不动账（结构性：delta 分支零账目事件）", () => {
  test("首条文本 delta 到达时账目事件数为 0；turn 完成即刻 +1", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "一段足够长的流式回复正文。", usage: { input: 1, totalTokens: 2 }, chunkDelayMs: 5 }],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("问");

    // 流式期间（首 delta 已在消息完成前多次到达）账目事件数恒 0
    expect(publisher.deltas.filter((d) => d.channel !== "thinking").length).toBeGreaterThan(0);
    expect(publisher.usageCountAtFirstMessageDelta).toBe(0);
    // turn 完成（message_end 携带 usage）即刻 +1
    expect(usageEvents(publisher)).toHaveLength(1);
  });
});

describe("T3.2 ③ 工具轮中间 message_end（无 usage）不入账", () => {
  test("带工具批的 turn：中间 stopReason=toolUse 消息不产生账目事件，终条恰一条", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        {
          toolCalls: [{ toolName: "bash", args: { command: "echo hi" }, result: "hi" }],
          text: "工具跑完的正式回答。",
          usage: { input: 50, totalTokens: 60 },
        },
      ],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("跑工具");

    expect(usageEvents(publisher)).toHaveLength(1);
    expect(usageEvents(publisher)[0]!.payload.usage.input).toBe(50);
    // turn 正常收口（入账不破坏既有编排）
    expect(chat.agentState).toBe("idle");
    expect(chat.sessionSnapshot.turns.every((t) => t.status === "completed")).toBe(true);
  });
});

describe("T3.2 ④ compaction 与 turn 入账并存不重复", () => {
  test("compaction 剧本：source=turn 一条 + source=compaction 一条", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        {
          text: "回复。",
          usage: { input: 7, totalTokens: 9 },
          compaction: { tokensBefore: 1000, tokensAfter: 100, summary: "摘要", usage: { input: 40, totalTokens: 46 } },
        },
      ],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("长对话");

    const events = usageEvents(publisher);
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.payload.source === "turn").length).toBe(1);
    expect(events.filter((e) => e.payload.source === "compaction").length).toBe(1);
    expect(events.find((e) => e.payload.source === "compaction")!.payload.usage.totalTokens).toBe(46);
  });
});

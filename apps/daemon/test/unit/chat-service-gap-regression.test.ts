import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import type { ThinkingEntryData } from "../../src/domain/session/ThinkingEntry";
import type { SessionEntryData } from "../../src/domain/session/SessionSnapshot";

/** message 变体（thinking 无 role 字段，以 "role" in 判别）。 */
type MessageEntry = Extract<SessionEntryData, { role: string }>;

/**
 * TP-2.4c 覆盖缝隙补测（ex3 §6.3 G3/G4——onEngineEvent 拆解回归网）：
 *
 * - G3 steer drain 轮 × thinking 交错：drain 出的新 assistant 消息内含
 *   thinking 块——message_start 的三态重置（streamEntryId 预分配 /
 *   thinkingStarts 清空 / pendingThinking 清空）与 steer-drain 分支
 *   同 case 交错，无专项剧本。锚定：两轮 thinking 块各自独立落账
 *   （reasoningTokens 各关联本轮 usage.reasoning）、drain 轮 delta
 *   messageId 对齐 drain 轮 assistant entry id（D-2 在 drain 轮同样成立）。
 * - G4 abort 轮 pendingThinking flush：thinking_end 已暂存后 abort →
 *   message_end(stop=error 空文本) 时 flushPendingThinking(0) 仍执行——
 *   已暂存 thinking 块以 reasoningTokens=0 落 Entry（reasoning 取
 *   e.usage?.reasoning ?? 0，error 轮 usage undefined）。
 *
 * 缝隙性质 = 「无覆盖」非「行为错」：对现状正确行为断言，直接绿锚定
 * （brief 裁决），作为拆解的行为等价回归网。
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

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const repo = new InMemorySessionRepository();
  const chat = new ChatService({ engine, events: publisher, clock: new FixedClock() });
  return { chat, publisher, repo };
}

/** 轮询等待条件成立（2ms 间隔，确定性时序测试用）。 */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function thinkingEntries(chat: ChatService): ThinkingEntryData[] {
  return chat.sessionSnapshot.entries.filter((e): e is ThinkingEntryData => "kind" in e && e.kind === "thinking");
}

function messageEntries(chat: ChatService): MessageEntry[] {
  return chat.sessionSnapshot.entries.filter((e): e is MessageEntry => "role" in e);
}

describe("G3：steer drain 轮 × thinking 交错（三态重置无残留串扰）", () => {
  test("drain 轮 assistant 消息内 thinking 块独立落账 + delta messageId 对齐 drain 轮 entry id", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "第一轮答复正文。", thinking: "第一轮思考内容。", usage: { reasoning: 5 } }],
      steerReplies: [{ text: "drain 轮答复正文。", thinking: "drain 轮独立思考。", usage: { reasoning: 9 } }],
      chunkDelayMs: 10,
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("第一问");
    await until(() => publisher.deltas.some((d) => d.channel === "thinking")); // 第一轮 thinking 流式中
    await chat.steer("追加指示");
    await run;

    // 两轮 thinking 块各自独立落账（drain 轮 message_start 重置三态：
    // 第一轮块已随本轮 message_end flush，无残留串入 drain 轮）
    const thinking = thinkingEntries(chat);
    expect(thinking).toHaveLength(2);
    expect(thinking[0]!.text).toBe("第一轮思考内容。");
    expect(thinking[0]!.reasoningTokens).toBe(5); // 关联第一轮 usage.reasoning
    expect(thinking[1]!.text).toBe("drain 轮独立思考。");
    expect(thinking[1]!.reasoningTokens).toBe(9); // 关联 drain 轮 usage.reasoning（重置后重新关联）

    // 两轮 assistant 文本各自落账
    const texts = messageEntries(chat).filter((e) => e.role === "assistant").map((e) => e.text);
    expect(texts).toEqual(["第一轮答复正文。", "drain 轮答复正文。"]);

    // D-2 在 drain 轮同样成立：drain 轮 thinking delta 的 messageId ===
    // drain 轮 assistant entry id（message_start 预分配对 drain 轮新消息生效）
    const drainAssistant = messageEntries(chat).find((e) => e.role === "assistant" && e.text === "drain 轮答复正文。")!;
    const drainTurnDeltas = publisher.deltas.slice(
      publisher.deltas.findIndex((d) => d.delta === "drain"),
    );
    expect(drainTurnDeltas.length).toBeGreaterThan(0);
    for (const d of drainTurnDeltas) {
      expect(d.messageId).toBe(drainAssistant.id);
      if (d.channel === "thinking") expect(d.instanceId).toBe("main");
    }

    // turn 收口序：第一 turn completed（steerDrained）→ drain turn completed
    const types = publisher.domainEvents.map((e) => e.type);
    expect(types.indexOf("steer.drained")).toBeGreaterThan(types.indexOf("steer.queued"));
    const turns = chat.sessionSnapshot.turns;
    expect(turns).toHaveLength(2);
    expect(turns.every((t) => t.status === "completed")).toBe(true);
    expect(chat.agentState).toBe("idle");
  });
});

describe("G4：abort 轮 pendingThinking flush（reasoning=0 落账）", () => {
  test("thinking_end 已暂存后 abort → 空消息 stop=error 收尾时 thinking 块以 reasoningTokens=0 落 Entry", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "会被中断的回复正文。", thinking: "中断前已完成的思考。" }],
      chunkDelayMs: 40, // 拉大窗口：thinking_end 之后 message_update 首片前确定性落 abort
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("第一问");
    // 在 thinking_end 已发出（块暂存完成）、message_update 首片 delay 窗口内 abort
    await until(() => engine.events.some((e) => e.type === "thinking_end"));
    chat.abort();
    expect(chat.agentState).toBe("aborting");
    await run;

    // 已暂存 thinking 块以 reasoningTokens=0 落 Entry（error 轮 usage
    // undefined → e.usage?.reasoning ?? 0；零值关联仍落账——thinking 是
    // 语义单元，不因 abort 丢弃）
    const thinking = thinkingEntries(chat);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.text).toBe("中断前已完成的思考。");
    expect(thinking[0]!.reasoningTokens).toBe(0);
    expect(thinking[0]!.durationMs).toBeGreaterThanOrEqual(0);

    // assistant 空文本不落 Entry（abort 非语义单元）；无 usage.recorded 入账
    expect(messageEntries(chat).filter((e) => e.role === "assistant")).toHaveLength(0);
    expect(publisher.domainEvents.find((e) => e.type === "usage.recorded")).toBeUndefined();

    // 事件序：thinking.completed（flush 落账）先于 turn.interrupted；轮收口回 idle
    const types = publisher.domainEvents.map((e) => e.type);
    expect(types.indexOf("thinking.completed")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("turn.interrupted")).toBeGreaterThan(types.indexOf("thinking.completed"));
    expect(chat.agentState).toBe("idle");
    expect(chat.sessionSnapshot.turns[0]!.status).toBe("interrupted");
  });
});

import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import { Session } from "../../src/domain/session/Session";
import type { ThinkingEntryData } from "../../src/domain/session/ThinkingEntry";
import type { CompactionEntryData } from "../../src/domain/session/CompactionEntry";
import type { SessionEntryData } from "../../src/domain/session/SessionSnapshot";

/** message 变体（thinking/compaction 无 role 字段，以 "role" in 判别）。 */
type MessageEntry = Extract<SessionEntryData, { role: string }>;

/**
 * T3.1 RED：ChatService 通道族编排（FakeAgentEngine 剧本）——
 * ① thinking delta 流式直达订阅方且不落盘（TR-AD-5：无领域事件/无 Entry）；
 * ② thinking.completed → ThinkingEntry 落树 + 落盘 roundtrip + 领域事件；
 * ③ compaction → CompactionEntry + compaction.completed + usage.recorded(source=compaction)；
 * ④ compaction 失败 → engine.error 可观测 + 会话无损继续。
 * 另：domain Session 快照对 thinking/compaction 条目的往返保真。
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
}

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const repo = new InMemorySessionRepository();
  const chat = new ChatService({ engine, repository: repo, events: publisher, clock: new FixedClock() });
  return { chat, publisher, repo };
}

describe("① thinking 流式直达 + 完成落 Entry（TP-AD-5 / F2.1）", () => {
  test("delta 走流式通道（thinking 频道）不产生领域事件；完成态 Entry 全字段落树", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { thinking: "先分析问题的结构，再决定切入角度。", text: "正式回答正文。", usage: { reasoning: 5 } },
      ],
    });
    const { chat, publisher, repo } = makeChat(engine);
    await chat.sendMessage("第一问");

    // 流式：thinking delta 走 publishDelta（channel=thinking），非领域事件
    const thinkingDeltas = publisher.deltas.filter((d) => d.channel === "thinking");
    expect(thinkingDeltas.length).toBeGreaterThan(0);
    expect(thinkingDeltas.map((d) => d.delta).join("")).toBe("先分析问题的结构，再决定切入角度。");
    expect(thinkingDeltas.every((d) => d.instanceId === "main")).toBe(true);

    // 完成：ThinkingEntry 落树（kind/instanceId/text/durationMs/reasoningTokens）
    const snap = chat.sessionSnapshot;
    const thinkingEntry = snap.entries.find((e): e is ThinkingEntryData => "kind" in e && e.kind === "thinking");
    expect(thinkingEntry).toBeDefined();
    expect(thinkingEntry!.instanceId).toBe("main");
    expect(thinkingEntry!.text).toBe("先分析问题的结构，再决定切入角度。");
    expect(thinkingEntry!.durationMs).toBeGreaterThanOrEqual(0);
    expect(thinkingEntry!.reasoningTokens).toBe(5);

    // 领域事件：thinking.completed（在 assistant message.completed 之前；
    // 第一个 message.completed 是 user 落账，取末位定位 assistant）
    const types = publisher.domainEvents.map((e) => e.type);
    const tIdx = types.indexOf("thinking.completed");
    const mIdx = types.lastIndexOf("message.completed");
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(mIdx).toBeGreaterThan(tIdx);
    const evt = publisher.domainEvents[tIdx] as {
      instanceId?: string;
      payload: { entry: ThinkingEntryData };
    };
    expect(evt.payload.entry.kind).toBe("thinking");
    expect(evt.instanceId).toBe("main");

    // 消息正文不受 thinking 污染
    expect(snap.entries.find((e): e is MessageEntry => "role" in e && e.role === "assistant")!.text).toBe(
      "正式回答正文。",
    );

    // 落盘 roundtrip：重启后 ThinkingEntry 可回放
    const restored = await repo.restore(chat.sessionId);
    expect(restored!.session.entries.find((e): e is ThinkingEntryData => "kind" in e && e.kind === "thinking")).toBeDefined();
  });
});

describe("② compaction 编排（F2.2 / AD-9③）", () => {
  test("compaction.completed → CompactionEntry 落树 + 事件 + usage.recorded(source=compaction)", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        {
          text: "回复一。",
          compaction: {
            tokensBefore: 340000,
            tokensAfter: 20000,
            summary: "此前对话已压缩：讨论了 MARLIN-77 代号。",
            usage: { input: 40, output: 6, totalTokens: 46, cost: 0.01 },
          },
        },
      ],
    });
    const { chat, publisher, repo } = makeChat(engine);
    await chat.sendMessage("长会话第一问");

    const snap = chat.sessionSnapshot;
    const comp = snap.entries.find((e): e is CompactionEntryData => "kind" in e && e.kind === "compaction");
    expect(comp).toBeDefined();
    expect(comp!.instanceId).toBe("main");
    expect(comp!.tokensBefore).toBe(340000);
    expect(comp!.tokensAfter).toBe(20000);
    expect(comp!.summary).toContain("MARLIN-77");
    expect(comp!.usage).toEqual({
      input: 40,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 46,
      cost: 0.01,
    });

    const compactEvt = publisher.domainEvents.find((e) => e.type === "compaction.completed") as {
      instanceId?: string;
      payload: { entry: CompactionEntryData };
    };
    expect(compactEvt).toBeDefined();
    expect(compactEvt.payload.entry.tokensBefore).toBe(340000);
    expect(compactEvt.instanceId).toBe("main");

    const usageEvt = publisher.domainEvents.find((e) => e.type === "usage.recorded") as {
      payload: { instanceId: string; source: string; usage: Record<string, number> };
    };
    expect(usageEvt).toBeDefined();
    expect(usageEvt.payload.instanceId).toBe("main");
    expect(usageEvt.payload.source).toBe("compaction");
    expect(usageEvt.payload.usage.input).toBe(40);

    // 落盘 roundtrip
    const restored = await repo.restore(chat.sessionId);
    expect(restored!.session.entries.find((e): e is CompactionEntryData => "kind" in e && e.kind === "compaction")).toBeDefined();
  });

  test("compaction 失败剧本 → engine.error 可观测 + 会话无损继续对话", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "回复一。", compactionError: "摘要调用失败：provider down" },
        { text: "压缩失败后的继续回复。" },
      ],
    });
    const { chat, publisher } = makeChat(engine);

    await chat.sendMessage("第一问");
    const errEvt = publisher.domainEvents.find((e) => e.type === "engine.error") as { payload: { message: string } };
    expect(errEvt).toBeDefined();
    expect(errEvt.payload.message).toContain("provider down");
    // 无 compaction 完成事件（失败不产生）
    expect(publisher.domainEvents.find((e) => e.type === "compaction.completed")).toBeUndefined();

    // 会话无损：turn 正常收口、后续消息正常对话
    expect(chat.agentState).toBe("idle");
    const outcome = await chat.sendMessage("第二问");
    expect(outcome.mode).toBe("turn");
    const texts = chat.sessionSnapshot.entries.filter((e): e is MessageEntry => "role" in e && e.role === "assistant");
    expect(texts.at(-1)!.text).toBe("压缩失败后的继续回复。");
  });
});

describe("③ domain Session：thinking/compaction 条目快照往返", () => {
  test("appendThinkingEntry/appendCompactionEntry → toSnapshot → restoreFrom 全字段保真", () => {
    const s = Session.create();
    const user = s.appendUserEntry("问题", new Date(0).toISOString());
    s.beginTurn(user.id, new Date(1).toISOString());
    const thinking = s.appendThinkingEntry({
      kind: "thinking",
      instanceId: "main",
      text: "思考全文",
      durationMs: 120,
      reasoningTokens: 7,
      createdAt: new Date(2).toISOString(),
    });
    const comp = s.appendCompactionEntry({
      kind: "compaction",
      instanceId: "main",
      tokensBefore: 1000,
      tokensAfter: 200,
      summary: "摘要",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3, cost: 0.01 },
      createdAt: new Date(3).toISOString(),
    });

    const snap = s.toSnapshot();
    const restored = Session.restoreFrom(snap);
    const r2 = restored.toSnapshot();
    expect(r2.entries).toHaveLength(3);
    expect(r2.entries).toContainEqual(thinking.toData());
    expect(r2.entries).toContainEqual(comp.toData());
    // 计数器延续：新 entry id 不回卷
    expect(restored.entryList().length).toBe(3);
  });
});

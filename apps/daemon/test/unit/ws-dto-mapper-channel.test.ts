import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { domainEventToEnvelope, toSnapshotDto } from "../../src/adapters/driving/ws-server/DtoMapper";
import { EventStream, type FrameSender } from "../../src/adapters/driving/ws-server/EventStream";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { ThinkingEntryData } from "../../src/domain/session/ThinkingEntry";
import type { CompactionEntryData } from "../../src/domain/session/CompactionEntry";

/**
 * T3.1 RED：DtoMapper/EventStream 通道族映射（契约 protocol-v0.1.md §5.2/§6.1）——
 * thinking.stream.delta（流式帧）/ thinking.completed / compaction.completed /
 * usage.recorded 四类 WS 帧的 payload 对齐；快照 entries 合并 thinking/compaction 变体。
 */

const base = {
  sessionId: "s-1",
  occurredAt: new Date(1000).toISOString(),
} as const;

const thinkingEntry: ThinkingEntryData = {
  kind: "thinking",
  id: "e3",
  instanceId: "main",
  text: "思考全文",
  durationMs: 120,
  createdAt: new Date(2000).toISOString(),
};

const compactionEntry: CompactionEntryData = {
  kind: "compaction",
  id: "e5",
  instanceId: "main",
  tokensBefore: 340000,
  tokensAfter: 20000,
  summary: "摘要",
  usage: { input: 40, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 46, cost: 0.01 },
  createdAt: new Date(3000).toISOString(),
};

describe("T3.1 DtoMapper：通道族事件 → WS 帧", () => {
  test("thinking.completed → ThinkingCompletedEvent（payload.entry 全字段，instanceId 挂帧）", () => {
    const frame = domainEventToEnvelope({
      ...base,
      type: "thinking.completed",
      instanceId: "main",
      payload: { entry: thinkingEntry },
    } as DomainEvent);
    expect(frame).toEqual({
      v: PROTOCOL_VERSION,
      sessionId: "s-1",
      channel: "thinking",
      type: "thinking.completed",
      instanceId: "main",
      payload: {
        entry: {
          kind: "thinking",
          id: "e3",
          instanceId: "main",
          text: "思考全文",
          durationMs: 120,
          createdAt: new Date(2000).toISOString(),
        },
      },
    });
  });

  test("compaction.completed → CompactionCompletedEvent（payload.entry 全字段）", () => {
    const frame = domainEventToEnvelope({
      ...base,
      type: "compaction.completed",
      instanceId: "main",
      payload: { entry: compactionEntry },
    } as DomainEvent);
    expect(frame!.type).toBe("compaction.completed");
    expect(frame!.instanceId).toBe("main");
    expect((frame as { payload: { entry: CompactionEntryData } }).payload.entry).toEqual(compactionEntry);
  });

  test("usage.recorded → UsageRecordedEvent（instanceId/usage/source）", () => {
    const frame = domainEventToEnvelope({
      ...base,
      type: "usage.recorded",
      instanceId: "main",
      payload: {
        instanceId: "main",
        usage: compactionEntry.usage,
        source: "compaction",
      },
    } as DomainEvent);
    expect(frame).toEqual({
      v: PROTOCOL_VERSION,
      sessionId: "s-1",
      channel: "usage",
      type: "usage.recorded",
      instanceId: "main",
      payload: {
        instanceId: "main",
        usage: { input: 40, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 46, cost: 0.01 },
        source: "compaction",
      },
    });
  });
});

describe("T3.1 EventStream：thinking delta 流式帧（不落盘通道）", () => {
  test("channel=thinking 的 delta → thinking.stream.delta 帧（payload.instanceId + delta）", () => {
    const frames: unknown[] = [];
    const sender: FrameSender = (f) => frames.push(f);
    const stream = new EventStream();
    stream.attach(sender);

    stream.publishDelta({ messageId: "t1", delta: "思", channel: "thinking", instanceId: "main" });
    stream.publishDelta({ messageId: "e2", delta: "正" });

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      v: PROTOCOL_VERSION,
      channel: "thinking",
      type: "thinking.stream.delta",
      instanceId: "main",
      payload: { instanceId: "main", delta: "思" },
    });
    expect((frames[1] as { type: string }).type).toBe("chat.stream.delta");
  });
});

describe("T3.1 快照：entries 合并 thinking/compaction 变体（重启回放数据源）", () => {
  test("toSnapshotDto 输出四类 EntryDto 混排（时间序）", () => {
    const messageEntry = {
      id: "e1",
      role: "user" as const,
      text: "问题",
      turnId: "t1",
      isSteer: false,
      instanceId: "main",
      createdAt: new Date(1000).toISOString(),
    };
    const view = {
      session: {
        sessionId: "s-1",
        createdAt: new Date(0).toISOString(),
        entries: [messageEntry, thinkingEntry, compactionEntry],
        turns: [],
        pendingSteer: [],
      },
      toolCalls: [],
    };
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");
    expect(dto.entries.map((e) => e.kind)).toEqual(["message", "thinking", "compaction"]);
    const t = dto.entries[1] as { kind: string; text: string; durationMs: number };
    expect(t.kind).toBe("thinking");
    expect(t.text).toBe("思考全文");
    const c = dto.entries[2] as { kind: string; tokensBefore: number; tokensAfter: number };
    expect(c.kind).toBe("compaction");
    expect(c.tokensBefore).toBe(340000);
    expect(c.tokensAfter).toBe(20000);
  });
});

describe("T3.2 快照：usage 聚合 + instances[].usage 小计 DTO 映射（契约 §6.2）", () => {
  test("view.usage → SessionUsageDto{total,compaction}；instances[].usage → AgentInstanceDto.usage 七字段不变形", () => {
    const usage = { input: 11, output: 26, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens: 81, cost: 0.04 };
    const view = {
      session: {
        sessionId: "s-1",
        createdAt: new Date(0).toISOString(),
        entries: [],
        turns: [],
        pendingSteer: [],
      },
      toolCalls: [],
      instances: [
        {
          instanceId: "main",
          kind: "main" as const,
          profileKind: "main-session",
          sessionId: "s-1",
          state: "running" as const,
          createdAt: new Date(0).toISOString(),
          usage,
        },
        {
          instanceId: "agent-1",
          kind: "subagent" as const,
          profileKind: "subagent-worker",
          sessionId: "s-1",
          state: "done" as const,
          createdAt: new Date(1).toISOString(),
          usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 300, cost: 0.1 },
        },
      ],
      usage: {
        total: { input: 111, output: 226, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens: 381, cost: 0.14 },
        compaction: { input: 40, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 46, cost: 0.01 },
      },
    };
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");

    expect(dto.usage).toEqual(view.usage); // SessionUsageDto 同构直映射
    expect(dto.instances).toHaveLength(2);
    expect(dto.instances![0]!.usage).toEqual(usage); // 七字段不变形
    expect(dto.instances![1]!.usage!.totalTokens).toBe(300);
  });
});

describe("轮末 token 用量：turnId/byTurn wire 面（additive）", () => {
  test("usage.recorded 帧 payload.turnId 透传（载荷携带时）；缺省不携带键", () => {
    const frame = domainEventToEnvelope({
      ...base,
      type: "usage.recorded",
      turnId: "turn-7",
      instanceId: "main",
      payload: {
        instanceId: "main",
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 30, cost: 0.01 },
        source: "turn",
        turnId: "turn-7",
      },
    } as DomainEvent);
    expect((frame as { payload: { turnId?: string } }).payload.turnId).toBe("turn-7");

    // 缺省（SubAgent/compaction 入账）不携带键（additive 旧形状）
    const frame2 = domainEventToEnvelope({
      ...base,
      type: "usage.recorded",
      instanceId: "agent-9",
      payload: {
        instanceId: "agent-9",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3, cost: 0.001 },
        source: "turn",
      },
    } as DomainEvent);
    expect("turnId" in (frame2 as { payload: object }).payload).toBe(false);
  });

  test("MessageEntryDto.turnId 透传：entry.turnId 非 null 携带；null 不携带键", () => {
    const mkEntry = (id: string, turnId: string | null) => ({
      id,
      role: "assistant" as const,
      text: "答",
      turnId,
      isSteer: false,
      instanceId: "main",
      createdAt: new Date(1000).toISOString(),
    });
    const view = {
      session: {
        sessionId: "s-1",
        createdAt: new Date(0).toISOString(),
        entries: [mkEntry("e1", "turn-1"), mkEntry("e2", null)],
        turns: [],
        pendingSteer: [],
      },
      toolCalls: [],
    };
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");
    const e1 = dto.entries.find((e) => e.id === "e1");
    const e2 = dto.entries.find((e) => e.id === "e2");
    expect(e1?.kind === "message" && e1.turnId).toBe("turn-1");
    expect(e2?.kind === "message" && "turnId" in e2).toBe(false);
  });

  test("快照 usage.byTurn 透传（非空携带；空/缺席不下发）", () => {
    const u = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 30, cost: 0.01 };
    const view = {
      session: { sessionId: "s-1", createdAt: new Date(0).toISOString(), entries: [], turns: [], pendingSteer: [] },
      toolCalls: [],
      usage: { total: u, compaction: { ...u, input: 0 }, byTurn: { "turn-1": u } },
    };
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");
    expect(dto.usage?.byTurn?.["turn-1"]).toEqual(u);

    const viewEmpty = { ...view, usage: { total: u, compaction: { ...u, input: 0 }, byTurn: {} } };
    const dtoEmpty = toSnapshotDto(viewEmpty, "anthropic/fake", "idle");
    expect(dtoEmpty.usage && "byTurn" in dtoEmpty.usage).toBe(false);
  });
});

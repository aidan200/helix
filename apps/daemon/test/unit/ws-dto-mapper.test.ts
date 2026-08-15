import { describe, expect, test } from "bun:test";
import type { SessionSnapshot } from "../../src/domain/session/SessionSnapshot";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { toSnapshotDto, domainEventToEnvelope } from "../../src/adapters/driving/ws-server/DtoMapper";

/**
 * DtoMapper 单测（AD-17.5：domain 充血 → protocol DTO 贫血，转换在 adapter）。
 * ① 快照映射：steerState（pendingSteer → queued，isSteer 已出队 → drained）、
 *    ts 线格式 number（epoch ms）、revision = entries.length；
 * ② 领域事件 → 协议事件映射：reason 词汇表（done/steerDrained → completed、
 *    turn.interrupted → aborted）、engine.error 无协议对应 → null（v0 边界）。
 */

function snap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "s-1",
    createdAt: "2026-08-15T00:00:00.000Z",
    entries: [
      { id: "e1", role: "user", text: "你好", turnId: null, isSteer: false, createdAt: "2026-08-15T00:00:01.000Z" },
      { id: "e2", role: "assistant", text: "在的", turnId: "t1", isSteer: false, createdAt: "2026-08-15T00:00:02.000Z" },
      { id: "e3", role: "user", text: "补充一下", turnId: "t2", isSteer: true, createdAt: "2026-08-15T00:00:03.000Z" },
      { id: "e4", role: "user", text: "已注入的那条", turnId: "t3", isSteer: true, createdAt: "2026-08-15T00:00:04.000Z" },
    ],
    turns: [],
    pendingSteer: [{ entryId: "e3", text: "补充一下" }],
    ...overrides,
  };
}

describe("① 快照 → SessionSnapshotDto", () => {
  test("steerState 两态 + ts 为 epoch 毫秒 + revision 基线", () => {
    const dto = toSnapshotDto(snap(), "anthropic/test-model", "running");
    expect(dto.sessionId).toBe("s-1");
    expect(dto.model).toBe("anthropic/test-model");
    expect(dto.agentState).toBe("running");
    expect(dto.revision).toBe(4);
    expect(dto.entries).toHaveLength(4);

    const [e1, e2, e3, e4] = dto.entries;
    expect(e1).toMatchObject({ kind: "message", id: "e1", role: "user", content: "你好", ts: Date.parse("2026-08-15T00:00:01.000Z") });
    expect(e1 && "steerState" in e1 ? e1.steerState : undefined).toBeUndefined(); // 普通消息不携带
    expect(e2).toMatchObject({ kind: "message", role: "assistant", content: "在的" });
    // e3 在 pendingSteer → queued；e4 isSteer 但已出队 → drained
    expect(e3 && "steerState" in e3 ? e3.steerState : undefined).toBe("queued");
    expect(e4 && "steerState" in e4 ? e4.steerState : undefined).toBe("drained");
  });

  test("首连空会话：entries 为空数组", () => {
    const dto = toSnapshotDto(
      snap({ entries: [], pendingSteer: [] }),
      "",
      "idle",
    );
    expect(dto.entries).toEqual([]);
    expect(dto.revision).toBe(0);
  });
});

describe("② 领域事件 → 协议事件帧", () => {
  const base = {
    sessionId: "s-1",
    turnId: "t1",
    occurredAt: "2026-08-15T00:00:05.000Z",
  };

  test("turn.started → chat.turn.started；done/steerDrained → completed；interrupted → aborted", () => {
    const started = domainEventToEnvelope({ ...base, type: "turn.started", payload: { turnId: "t9" } });
    expect(started).toMatchObject({ v: 0, type: "chat.turn.started", payload: { turnId: "t9" } });

    const done = domainEventToEnvelope({ ...base, type: "turn.completed", payload: { reason: "done" } });
    expect(done).toMatchObject({ type: "chat.turn.completed", payload: { turnId: "t1", reason: "completed" } });

    const drainedTurn = domainEventToEnvelope({
      ...base,
      type: "turn.completed",
      payload: { reason: "steerDrained" },
    });
    expect(drainedTurn).toMatchObject({ type: "chat.turn.completed", payload: { reason: "completed" } });

    const interrupted = domainEventToEnvelope({ ...base, type: "turn.interrupted", payload: { reason: "aborted" } });
    expect(interrupted).toMatchObject({ type: "chat.turn.completed", payload: { reason: "aborted" } });
  });

  test("turn.completed 不带 turnId 时以 fallbackTurnId 补齐（EventStream 轮次追踪）", () => {
    const ev = domainEventToEnvelope(
      { sessionId: "s-1", type: "turn.completed", payload: { reason: "done" }, occurredAt: base.occurredAt },
      { fallbackTurnId: "t-last" },
    );
    expect(ev).toMatchObject({ type: "chat.turn.completed", payload: { turnId: "t-last", reason: "completed" } });
  });

  test("message.completed → chat.message.completed（含 EntryDto；steer 消息标 queued）", () => {
    const ev = domainEventToEnvelope({
      ...base,
      type: "message.completed",
      payload: { entryId: "e5", role: "assistant", text: "回复全文", isSteer: false },
    });
    expect(ev).toMatchObject({
      type: "chat.message.completed",
      payload: { entry: { kind: "message", id: "e5", role: "assistant", content: "回复全文", ts: Date.parse(base.occurredAt) } },
    });

    const steerMsg = domainEventToEnvelope({
      ...base,
      type: "message.completed",
      payload: { entryId: "e6", role: "user", text: "运行中注入", isSteer: true },
    });
    expect(steerMsg).toMatchObject({
      type: "chat.message.completed",
      payload: { entry: { steerState: "queued" } },
    });
  });

  test("steer.queued/drained 直接映射 entryId", () => {
    const q = domainEventToEnvelope({ ...base, type: "steer.queued", payload: { entryId: "e6", text: "x" } });
    expect(q).toMatchObject({ type: "steer.queued", payload: { entryId: "e6" } });
    const d = domainEventToEnvelope({ ...base, type: "steer.drained", payload: { entryId: "e6", text: "x" } });
    expect(d).toMatchObject({ type: "steer.drained", payload: { entryId: "e6" } });
  });

  test("tool.call.started/result → ToolCallEntryDto（args JSON 串 / durationMs 注入）", () => {
    const started = domainEventToEnvelope({
      ...base,
      type: "tool.call.started",
      payload: { toolCallId: "tc-1", toolName: "run_tests", args: { cmd: "bun test" } },
    });
    expect(started).toMatchObject({
      type: "tool.call.started",
      payload: { entry: { kind: "tool-call", id: "tc-1", name: "run_tests", args: '{"cmd":"bun test"}', state: "running" } },
    });

    const result = domainEventToEnvelope(
      {
        ...base,
        type: "tool.call.result",
        payload: { toolCallId: "tc-1", toolName: "run_tests", args: { cmd: "bun test" }, isError: false, result: "ok" },
      },
      { durationMs: 42 },
    );
    expect(result).toMatchObject({
      type: "tool.call.result",
      payload: {
        entry: { kind: "tool-call", id: "tc-1", state: "done", result: "ok", durationMs: 42 },
      },
    });

    const failed = domainEventToEnvelope({
      ...base,
      type: "tool.call.result",
      payload: { toolCallId: "tc-2", toolName: "run_tests", args: {}, isError: true, result: "exit 1" },
    });
    expect(failed).toMatchObject({ payload: { entry: { state: "error" } } });
  });

  test("agent.state.changed 直接映射；engine.error 无协议对应 → null（v0 边界）", () => {
    const st = domainEventToEnvelope({ ...base, type: "agent.state.changed", payload: { state: "running" } });
    expect(st).toMatchObject({ type: "agent.state.changed", payload: { state: "running" } });

    const err = domainEventToEnvelope({ ...base, type: "engine.error", payload: { message: "x" } });
    expect(err).toBeNull();
  });
});

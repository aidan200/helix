import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { SessionSnapshot } from "../../src/domain/session/SessionSnapshot";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { toSnapshotDto, domainEventToEnvelope } from "../../src/adapters/driving/ws-server/DtoMapper";

/**
 * DtoMapper 单测（AD-17.5：domain 充血 → protocol DTO 贫血，转换在 adapter）。
 * ① 快照映射：steerState（pendingSteer → queued，isSteer 已出队 → drained）、
 *    ts 线格式 number（epoch ms）、revision = 合并后总条数；
 * ①-b D-1：SessionStateView（会话聚合 + 工具调用记录）合并映射；
 * ② 领域事件 → 协议事件映射：reason 词汇表（done/steerDrained → completed、
 *    turn.interrupted → aborted）、engine.error 无协议对应 → null（v0 边界）。
 */

function snap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "s-1",
    createdAt: "2026-08-15T00:00:00.000Z",
    entries: [
      { id: "e1", role: "user", text: "你好", turnId: null, isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:01.000Z" },
      { id: "e2", role: "assistant", text: "在的", turnId: "t1", isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:02.000Z" },
      { id: "e3", role: "user", text: "补充一下", turnId: "t2", isSteer: true, instanceId: "main", createdAt: "2026-08-15T00:00:03.000Z" },
      { id: "e4", role: "user", text: "已注入的那条", turnId: "t3", isSteer: true, instanceId: "main", createdAt: "2026-08-15T00:00:04.000Z" },
    ],
    turns: [],
    pendingSteer: [{ entryId: "e3", text: "补充一下" }],
    ...overrides,
  };
}

function view(overrides: Partial<SessionSnapshot> = {}, toolCalls: SessionStateView["toolCalls"] = []): SessionStateView {
  return { session: snap(overrides), toolCalls };
}

describe("① 快照 → SessionSnapshotDto", () => {
  // F-8 修复（thinking 批③ wire 面接通）：view.thinking additive 映射
  test("thinking：view 携带 → DTO 同构映射；缺省 → 键不携带（additive 兼容旧组装点）", () => {
    const withThinking = toSnapshotDto(
      { ...view(), thinking: { override: "high", effective: "medium" } },
      "anthropic/test-model",
      "idle",
    );
    expect(withThinking.thinking).toEqual({ override: "high", effective: "medium" });
    const without = toSnapshotDto(view(), "anthropic/test-model", "idle");
    expect("thinking" in without).toBe(false);
  });

  test("steerState 两态 + ts 为 epoch 毫秒 + revision 基线", () => {
    const dto = toSnapshotDto(view(), "anthropic/test-model", "running");
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
      view({ entries: [], pendingSteer: [] }),
      "",
      "idle",
    );
    expect(dto.entries).toEqual([]);
    expect(dto.revision).toBe(0);
  });

  test("T11a：Entry.source → MessageEntryDto.source 透传（idle closure 注入条目快照可见；缺省不携带）", () => {
    const dto = toSnapshotDto(
      view({
        entries: [
          { id: "e1", role: "user", text: "普通问题", turnId: null, isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:01.000Z" },
          { id: "e2", role: "user", text: "agent-1 closure: done — 调研完成", turnId: null, isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:02.000Z", source: "closure" },
          { id: "e3", role: "user", text: "[agent-1 进展报告 #1] …", turnId: "t2", isSteer: true, instanceId: "main", createdAt: "2026-08-15T00:00:03.000Z", source: "progress" },
        ],
        pendingSteer: [],
      }),
      "m",
      "idle",
    );
    const [e1, e2, e3] = dto.entries;
    expect(e1 && "source" in e1 ? e1.source : undefined).toBeUndefined(); // 普通消息不携带
    expect(e2).toMatchObject({ kind: "message", id: "e2", source: "closure" });
    expect(e3).toMatchObject({ kind: "message", id: "e3", source: "progress", steerState: "drained" });
  });
});

describe("①-b D-1：快照合并工具调用记录（SessionStateView → 时间序 entries）", () => {
  test("工具条目按 ts 插入正确位置（user→tool→assistant）+ revision = 合并总数 + durationMs", () => {
    const dto = toSnapshotDto(
      view(
        {
          entries: [
            { id: "e1", role: "user", text: "跑个命令", turnId: null, isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:01.000Z" },
            { id: "e2", role: "assistant", text: "结果如下。", turnId: "t1", isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:03.000Z" },
          ],
        },
        [
          {
            id: "tc-1",
            toolName: "bash",
            args: { command: "echo hi" },
            status: "completed",
            result: "hi",
            startedAt: "2026-08-15T00:00:02.000Z",
            endedAt: "2026-08-15T00:00:02.500Z",
          },
        ],
      ),
      "m",
      "idle",
    );
    expect(dto.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(["message:e1", "tool-call:tc-1", "message:e2"]);
    expect(dto.revision).toBe(3); // 合并后总条数（原为消息数 2）
    expect(dto.entries[1]).toMatchObject({
      kind: "tool-call",
      id: "tc-1",
      name: "bash",
      args: '{"command":"echo hi"}',
      state: "done",
      result: "hi",
      durationMs: 500,
      ts: Date.parse("2026-08-15T00:00:02.000Z"),
    });
  });

  test("三态映射：failed→error+result=error 文案；running→running 无 result/durationMs", () => {
    const dto = toSnapshotDto(
      view(
        { entries: [] },
        [
          { id: "tc-f", toolName: "bash", args: {}, status: "failed", error: "exit 1", startedAt: "2026-08-15T00:00:01.000Z", endedAt: "2026-08-15T00:00:01.200Z" },
          { id: "tc-r", toolName: "grep", args: {}, status: "running", startedAt: "2026-08-15T00:00:02.000Z" },
        ],
      ),
      "m",
      "running",
    );
    const failed = dto.entries[0] as Extract<(typeof dto.entries)[number], { state: string }>;
    const running = dto.entries[1] as Extract<(typeof dto.entries)[number], { state: string }>;
    expect(failed).toMatchObject({ kind: "tool-call", id: "tc-f", state: "error", result: "exit 1", durationMs: 200 });
    expect(running).toMatchObject({ kind: "tool-call", id: "tc-r", state: "running", ts: Date.parse("2026-08-15T00:00:02.000Z") });
    expect(running).not.toHaveProperty("result");
    expect(running).not.toHaveProperty("durationMs");
  });

  test("failed 且无 error 时回退 result 字段；ts 并列时消息在前、工具间保持迭代序（稳定排序）", () => {
    const dto = toSnapshotDto(
      view(
        {
          entries: [
            { id: "e1", role: "user", text: "q", turnId: null, isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:01.000Z" },
          ],
        },
        [
          { id: "tc-a", toolName: "x", args: {}, status: "failed", result: "仅 result 字段的失败", startedAt: "2026-08-15T00:00:01.000Z", endedAt: "2026-08-15T00:00:01.100Z" },
          { id: "tc-b", toolName: "y", args: {}, status: "running", startedAt: "2026-08-15T00:00:01.000Z" },
        ],
      ),
      "m",
      "idle",
    );
    expect(dto.entries.map((e) => e.id)).toEqual(["e1", "tc-a", "tc-b"]);
    expect(dto.entries[1]).toMatchObject({ state: "error", result: "仅 result 字段的失败" });
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
    expect(started).toMatchObject({ v: PROTOCOL_VERSION, type: "chat.turn.started", payload: { turnId: "t9" } });

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
    expect(q).not.toMatchObject({ payload: { source: expect.anything() } }); // 老载荷（无 source）不透传键
    const d = domainEventToEnvelope({ ...base, type: "steer.drained", payload: { entryId: "e6", text: "x" } });
    expect(d).toMatchObject({ type: "steer.drained", payload: { entryId: "e6" } });
  });

  test("T11a：steer.queued/drained 载荷 source 透传（closure/progress/user 三值）", () => {
    const q = domainEventToEnvelope({ ...base, type: "steer.queued", payload: { entryId: "e6", text: "x", source: "closure" } });
    expect(q).toMatchObject({ type: "steer.queued", payload: { entryId: "e6", source: "closure" } });
    const d = domainEventToEnvelope({ ...base, type: "steer.drained", payload: { entryId: "e6", text: "x", source: "progress" } });
    expect(d).toMatchObject({ type: "steer.drained", payload: { entryId: "e6", source: "progress" } });
  });

  test("T11b：message.completed 载荷 source → entry.source 透传（idle closure 注入实时帧区分）；缺省不带键", () => {
    const closure = domainEventToEnvelope({
      ...base,
      type: "message.completed",
      payload: { entryId: "e7", role: "user", text: "agent-1 closure: done", isSteer: false, source: "closure" },
    });
    expect(closure).toMatchObject({
      type: "chat.message.completed",
      payload: { entry: { kind: "message", id: "e7", role: "user", source: "closure" } },
    });
    const progress = domainEventToEnvelope({
      ...base,
      type: "message.completed",
      payload: { entryId: "e8", role: "user", text: "进展报告", isSteer: false, source: "progress" },
    });
    expect(progress).toMatchObject({ payload: { entry: { source: "progress" } } });
    // 缺省（普通用户消息 / 老载荷）→ entry 不携带 source 键
    const legacy = domainEventToEnvelope({
      ...base,
      type: "message.completed",
      payload: { entryId: "e9", role: "user", text: "你好", isSteer: false },
    });
    expect(legacy).not.toMatchObject({ payload: { entry: { source: expect.anything() } } });
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

  test("agent.state.changed 直接映射；engine.error 透传下发（终验热修，v0 丢弃边界作废）", () => {
    const st = domainEventToEnvelope({ ...base, type: "agent.state.changed", payload: { state: "running" } });
    expect(st).toMatchObject({ type: "agent.state.changed", payload: { state: "running" } });

    const err = domainEventToEnvelope({ ...base, type: "engine.error", payload: { message: "429: 限额已满" } });
    expect(err).toMatchObject({ type: "engine.error", payload: { message: "429: 限额已满" } });
  });

  test("engine.error SubAgent 帧守卫（T1.1/F1.1 + AF-1）：instanceId≠main → null（不广播）；main/缺省 → 帧不变", () => {
    // SubAgent 实例帧抑制：shell consumers/chat.ts 的 engine.error case 无
    // instanceId 分流，不守卫会错位弹主聊天流（AD-1 前端零改动的守护面）
    const sub = domainEventToEnvelope({
      ...base,
      type: "engine.error",
      instanceId: "agent-2",
      payload: { message: "provider boom" },
    });
    expect(sub).toBeNull();

    // 主线负例守护：instanceId = main（显式）仍产出 EngineErrorEvent
    const mainline = domainEventToEnvelope({
      ...base,
      type: "engine.error",
      instanceId: "main",
      payload: { message: "provider boom" },
    });
    expect(mainline).toMatchObject({ type: "engine.error", payload: { message: "provider boom" } });
  });

  test("engine.retrying 透传下发（P2 ⑦ 网络重试批）；SubAgent 帧守卫同 engine.error 口径", () => {
    const retrying = domainEventToEnvelope({
      ...base,
      type: "engine.retrying",
      payload: { attempt: 1, totalAttempts: 3, waitMs: 10_000, message: "fetch failed" },
    });
    expect(retrying).toMatchObject({
      type: "engine.retrying",
      payload: { attempt: 1, totalAttempts: 3, waitMs: 10_000, message: "fetch failed" },
    });

    // SubAgent 实例帧抑制（trace 落盘在 WriteQueue，不产 WS 帧不弹主聊天流）
    const sub = domainEventToEnvelope({
      ...base,
      type: "engine.retrying",
      instanceId: "agent-2",
      payload: { attempt: 2, totalAttempts: 3, waitMs: 30_000, message: "ECONNRESET" },
    });
    expect(sub).toBeNull();
  });
});

describe("③ agent.* 编排生命周期族 → 协议事件帧（T2.3，契约 §5.1）", () => {
  /** 编排事件公共底：instanceId ≡ agentId（契约 §2），四维路由/落盘同源。 */
  const agentBase = {
    sessionId: "s-1",
    instanceId: "agent-2",
    occurredAt: "2026-08-16T00:00:05.000Z",
  };

  test("spawned/queued/started/stalled 四过程事件 payload 直映射 + envelope 挂 instanceId", () => {
    const spawned = domainEventToEnvelope({
      ...agentBase,
      type: "agent.spawned",
      payload: { agentId: "agent-2", task: "调研 X", profileKind: "subagent-worker" },
    });
    expect(spawned).toMatchObject({
      v: PROTOCOL_VERSION,
      type: "agent.spawned",
      instanceId: "agent-2",
      payload: { agentId: "agent-2", task: "调研 X", profileKind: "subagent-worker" },
    });

    const queued = domainEventToEnvelope({
      ...agentBase,
      type: "agent.queued",
      payload: { agentId: "agent-2", position: 3 },
    });
    expect(queued).toMatchObject({ type: "agent.queued", instanceId: "agent-2", payload: { agentId: "agent-2", position: 3 } });

    const started = domainEventToEnvelope({ ...agentBase, type: "agent.started", payload: { agentId: "agent-2" } });
    expect(started).toMatchObject({ type: "agent.started", instanceId: "agent-2", payload: { agentId: "agent-2" } });

    const stalled = domainEventToEnvelope({
      ...agentBase,
      type: "agent.stalled",
      payload: { agentId: "agent-2", idleMs: 1200 },
    });
    expect(stalled).toMatchObject({ type: "agent.stalled", instanceId: "agent-2", payload: { agentId: "agent-2", idleMs: 1200 } });
  });

  test("park/resume 批：agent.parked/resumed 帧（原因/时刻/摘要透传；channel=agent）", () => {
    const parked = domainEventToEnvelope({
      ...agentBase,
      type: "agent.parked",
      payload: { agentId: "agent-2", reason: "taskPause", parkedAt: "2026-08-16T00:00:05.000Z", summary: { progress: "调研完成一半", next: "从实现阶段继续" } },
    });
    expect(parked).toMatchObject({
      type: "agent.parked",
      instanceId: "agent-2",
      channel: "agent",
      payload: { agentId: "agent-2", reason: "taskPause", parkedAt: "2026-08-16T00:00:05.000Z", summary: { progress: "调研完成一半", next: "从实现阶段继续" } },
    });

    const parkedNoSummary = domainEventToEnvelope({
      ...agentBase,
      type: "agent.parked",
      payload: { agentId: "agent-2", reason: "user", parkedAt: "2026-08-16T00:00:05.000Z" },
    });
    expect(parkedNoSummary?.payload).toEqual({ agentId: "agent-2", reason: "user", parkedAt: "2026-08-16T00:00:05.000Z" }); // 摘要缺席不携带

    const resumed = domainEventToEnvelope({ ...agentBase, type: "agent.resumed", payload: { agentId: "agent-2" } });
    expect(resumed).toMatchObject({ type: "agent.resumed", instanceId: "agent-2", channel: "agent", payload: { agentId: "agent-2" } });
  });

  test("三终态事件携带五字段 ClosureDto（缺失字段显式 null）+ envelope 挂 instanceId", () => {
    const closure = { status: "done" as const, summary: "任务完成", reportPath: null, findings: [{ kind: "sediment" }], taskId: null };
    const completed = domainEventToEnvelope({
      ...agentBase,
      type: "agent.completed",
      payload: { agentId: "agent-2", closure },
    });
    expect(completed).toMatchObject({ type: "agent.completed", instanceId: "agent-2" });
    expect(completed?.payload).toEqual({ agentId: "agent-2", closure });

    const failed = domainEventToEnvelope({
      ...agentBase,
      type: "agent.failed",
      payload: { agentId: "agent-2", error: "引擎崩溃", closure: { ...closure, status: "failed" } },
    });
    expect(failed?.payload).toEqual({
      agentId: "agent-2",
      error: "引擎崩溃",
      closure: { status: "failed", summary: "任务完成", reportPath: null, findings: [{ kind: "sediment" }], taskId: null },
    });

    const killed = domainEventToEnvelope({
      ...agentBase,
      type: "agent.killed",
      payload: { agentId: "agent-2", closure: { status: "failed", summary: "已由用户终止（kill）", reportPath: null, findings: null, taskId: null } },
    });
    expect(killed).toMatchObject({ type: "agent.killed", instanceId: "agent-2" });
    expect(killed?.payload).toEqual({
      agentId: "agent-2",
      closure: { status: "failed", summary: "已由用户终止（kill）", reportPath: null, findings: null, taskId: null },
    });
  });

  test("SubAgent 工具事件（tool.call.* 挂 instanceId）→ 帧挂 instanceId；主线事件不挂（缺省 main）", () => {
    const sub = domainEventToEnvelope({
      ...agentBase,
      type: "tool.call.started",
      payload: { toolCallId: "tc-9", toolName: "grep", args: { pattern: "x" } },
    });
    expect(sub).toMatchObject({ type: "tool.call.started", instanceId: "agent-2", payload: { entry: { id: "tc-9" } } });

    const mainline = domainEventToEnvelope({
      sessionId: "s-1",
      type: "tool.call.started",
      payload: { toolCallId: "tc-1", toolName: "grep", args: {} },
      occurredAt: agentBase.occurredAt,
    });
    expect(mainline?.instanceId).toBeUndefined(); // 缺省 = 主实例（契约 §1）
  });
});

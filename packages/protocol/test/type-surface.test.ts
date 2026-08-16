import { describe, expect, test } from "bun:test";
import {
  COMMAND_TYPES,
  EVENT_TYPES,
  PROTOCOL_VERSION,
  type AgentCompletedEvent,
  type AgentFailedEvent,
  type AgentInstanceDto,
  type AgentKillCommand,
  type AgentKilledEvent,
  type AgentQueuedEvent,
  type AgentSpawnedEvent,
  type AgentStartedEvent,
  type AgentStalledEvent,
  type AgentSubscribeCommand,
  type AgentUnsubscribeCommand,
  type ChatSendCommand,
  type ClosureDto,
  type CommandEnvelope,
  type CompactionCompletedEvent,
  type CompactionEntryDto,
  type EntryDto,
  type EventEnvelope,
  type HelloCommand,
  type InstanceState,
  type MessageEntryDto,
  type SessionSnapshotDto,
  type SessionUsageDto,
  type ThinkingCompletedEvent,
  type ThinkingEntryDto,
  type ThinkingStreamDeltaEvent,
  type ToolCallEntryDto,
  type UsageDto,
  type UsageRecordedEvent,
  type UsageRecordedPayload,
  type WorkspaceRoute,
} from "../src/index";

/**
 * TP-CL2-1（U）：协议 v0 类型完备性（CL-2 / F(2).1 标准 1/2）。
 *
 * ① 样例帧构造：hello/welcome/snapshot/delta/工具卡/steer 徽标事件以契约类型
 *    构造并通过类型检查（tsc 守护）+ 结构断言（运行时）。
 * ② 信封 v 位 = 字面量 0；workspace 预留字段位可携带可省略（AD-7：仅类型，
 *    零路由行为）。
 * ③ 命令目录 5 个 / 事件目录 12 个 type 全覆盖，且与信封联合一一对应
 *    （COMMAND_TYPES/EVENT_TYPES 常量目录 ↔ 联合 type 提取双向一致）。
 * ④ 判别式联合窄化：switch(event.type) 各分支 payload 窄化正确；
 *    switch(entry.kind) 两分支窄化正确；steerState 仅 message 变体携带。
 *
 * v0.1 扩展（iter-20260816-uzvg T1.1；契约 contracts/protocol-v0.1.md）：
 * ⑤ 命令目录 5 → 8（+agent.kill/subscribe/unsubscribe）；事件目录 12 → 23
 *    （+编排族 7 + 通道族 4）；三层一致性同步扩（类型级 Equal 双向 +
 *    switch 穷尽 never + 运行时目录恰等）。
 * ⑥ EntryDto 四成员（+thinking/compaction）；既有成员 +instanceId?（缺省 =
 *    主实例）；快照 +instances?/usage?。
 *
 * 类型级断言（Equal/Expect/@ts-expect-error）由 `tsc --noEmit` 守护：
 * 窄化失效或字段缺失 → 编译失败；运行时断言验证样例帧行为。
 */

// ── 类型级断言工具（仅编译期） ────────────────────────────────
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
/** 从信封联合提取全部 type 字面量 */
type EnvelopeTypeOf<U> = U extends { type: infer T } ? T : never;

// ── 样例帧（构造本身即类型检查：字段缺失/多余/拼写错 → tsc 失败） ──
const helloFrame: HelloCommand = {
  v: PROTOCOL_VERSION,
  type: "hello",
  payload: { token: "dev-token-xyz", protocolVersion: 0 },
};

const chatSendWithRoute: ChatSendCommand = {
  v: 0,
  type: "chat.send",
  payload: { text: "帮我看看 protocol 包的类型" },
  workspace: { workspaceId: "ws-main" }, // 预留字段位：可携带（当前无路由语义）
};
const chatSendPlain: ChatSendCommand = {
  v: 0,
  type: "chat.send",
  payload: { text: "hi" }, // workspace 可省略
};

const snapshot: SessionSnapshotDto = {
  sessionId: "sess-1",
  model: "kimi-k2",
  agentState: "idle",
  revision: 42,
  entries: [
    { kind: "message", id: "e1", role: "user", content: "跑一下单测", ts: 1760000000000 },
    {
      kind: "message",
      id: "e2",
      role: "user",
      content: "先别动，改用方案 B",
      ts: 1760000001000,
      steerState: "queued", // 仅 chat.steer 产生的用户消息携带
    },
    {
      kind: "tool-call",
      id: "e3",
      name: "run_tests",
      args: '{"scope":"unit"}',
      result: "3 passed",
      state: "done",
      durationMs: 1200,
      ts: 1760000002000,
    },
  ],
};

const sampleEvents: EventEnvelope[] = [
  { v: 0, type: "connection.welcome", payload: { sessionId: "sess-1", model: "kimi-k2", agentState: "running" } },
  { v: 0, type: "connection.error", payload: { code: "auth.missing_token", message: "握手缺少 token" } },
  { v: 0, type: "session.snapshot", payload: { snapshot } },
  { v: 0, type: "chat.stream.delta", payload: { messageId: "e5", delta: "流式半句" } },
  { v: 0, type: "chat.turn.started", payload: { turnId: "turn-7" } },
  { v: 0, type: "chat.turn.completed", payload: { turnId: "turn-7", reason: "aborted" } },
  {
    v: 0,
    type: "chat.message.completed",
    payload: { entry: { kind: "message", id: "e5", role: "assistant", content: "完整回答", ts: 1760000003000 } },
  },
  { v: 0, type: "steer.queued", payload: { entryId: "e2" } },
  { v: 0, type: "steer.drained", payload: { entryId: "e2" } },
  {
    v: 0,
    type: "tool.call.started",
    payload: { entry: { kind: "tool-call", id: "e6", name: "read_file", args: '{"path":"a.ts"}', state: "running", ts: 1760000004000 } },
  },
  {
    v: 0,
    type: "tool.call.result",
    payload: { entry: { kind: "tool-call", id: "e6", name: "read_file", args: '{"path":"a.ts"}', state: "error", result: "ENOENT", durationMs: 5, ts: 1760000004001 } },
  },
  { v: 0, type: "agent.state.changed", payload: { state: "steering" } },
];

const sampleCommands: CommandEnvelope[] = [
  chatSendPlain,
  { v: 0, type: "chat.steer", payload: { text: "改用方案 B" } },
  { v: 0, type: "chat.abort", payload: {} },
  { v: 0, type: "session.subscribe", payload: {} },
  { v: 0, type: "session.unsubscribe", payload: {} },
];

// ── v0.1 新增样例帧（契约 protocol-v0.1.md §3–§6；构造即类型检查） ──

/** closure 样例：全字段必发纪律（缺失字段显式 null，契约 §5.3） */
const sampleClosure: ClosureDto = {
  status: "done",
  summary: "任务收口：3 个守护断言已扩",
  reportPath: null,
  findings: null,
  taskId: null,
};

/** usage 样例：七字段防腐映射（pi Usage → 拍平 cost: number，契约 §6.2） */
const sampleUsage: UsageDto = {
  input: 1_200,
  output: 340,
  cacheRead: 8_000,
  cacheWrite: 1_200,
  reasoning: 900,
  totalTokens: 11_640,
  cost: 0.0213,
};

const thinkingEntry: ThinkingEntryDto = {
  kind: "thinking",
  id: "tk-1",
  instanceId: "main",
  text: "先查类型面，再扩事件目录",
  durationMs: 4_200,
  reasoningTokens: 900,
  createdAt: "2026-08-16T12:00:00.000Z",
};

const compactionEntry: CompactionEntryDto = {
  kind: "compaction",
  id: "cp-1",
  instanceId: "main",
  tokensBefore: 340_000,
  tokensAfter: 20_000, // 原型「340k→20k」的 20k（压缩后上下文 tokens）
  summary: "会话前半程压缩摘要",
  usage: sampleUsage, // 摘要调用成本入账（AD-9③）
  createdAt: "2026-08-16T12:05:00.000Z",
};

const v01Commands: CommandEnvelope[] = [
  { v: 0, type: "agent.kill", payload: { agentId: "agent-2" } },
  { v: 0, type: "agent.subscribe", payload: { agentId: "agent-2" } },
  { v: 0, type: "agent.unsubscribe", payload: { agentId: "agent-2" } },
];

const v01Events: EventEnvelope[] = [
  // 编排生命周期族（7）
  {
    v: 0,
    type: "agent.spawned",
    payload: { agentId: "agent-1", task: "修协议守护测试", profileKind: "subagent-worker", model: "moonshot/kimi-k2" },
  },
  { v: 0, type: "agent.queued", payload: { agentId: "agent-1", position: 2 } },
  { v: 0, type: "agent.started", payload: { agentId: "agent-1" } },
  { v: 0, type: "agent.stalled", payload: { agentId: "agent-1", idleMs: 330_000 } },
  { v: 0, type: "agent.completed", payload: { agentId: "agent-1", closure: sampleClosure } },
  {
    v: 0,
    type: "agent.failed",
    payload: { agentId: "agent-1", error: "provider 5xx", closure: { ...sampleClosure, status: "failed" } },
  },
  {
    v: 0,
    type: "agent.killed",
    payload: { agentId: "agent-1", closure: { ...sampleClosure, status: "failed" } },
  },
  // 通道族（4）
  { v: 0, type: "thinking.stream.delta", payload: { instanceId: "agent-1", delta: "思考增量半句" } },
  { v: 0, type: "thinking.completed", payload: { entry: thinkingEntry } },
  { v: 0, type: "compaction.completed", payload: { entry: compactionEntry } },
  { v: 0, type: "usage.recorded", payload: { instanceId: "main", usage: sampleUsage, source: "turn" } },
];

/** 信封 instanceId（v0.1 新增可选，AD-3）：事件侧可携带；既有帧缺省 = 主实例 */
const subAgentDelta: EventEnvelope = {
  v: 0,
  type: "chat.stream.delta",
  payload: { messageId: "e9", delta: "SubAgent 流式增量" },
  instanceId: "agent-1",
};

/** v0.1 快照 additive 字段样例：instances?（实例清单）+ usage?（账目聚合） */
const snapshotV01: SessionSnapshotDto = {
  sessionId: "sess-1",
  model: "kimi-k2",
  agentState: "running",
  revision: 43,
  entries: [
    { kind: "message", id: "m1", role: "assistant", content: "委托完成", ts: 1760000100000, instanceId: "agent-1" },
    thinkingEntry,
    compactionEntry,
  ],
  instances: [
    { instanceId: "main", kind: "main", profileKind: "main-session", state: "running", createdAt: "2026-08-16T11:00:00.000Z" },
    {
      instanceId: "agent-0",
      kind: "subagent",
      profileKind: "subagent-worker",
      state: "done",
      task: "先修守护测试",
      model: "moonshot/kimi-k2",
      createdAt: "2026-08-16T11:30:00.000Z",
      closure: sampleClosure,
      usage: sampleUsage,
    },
    {
      instanceId: "agent-1",
      kind: "subagent",
      profileKind: "subagent-worker",
      state: "queued",
      task: "修协议守护测试",
      queuedPosition: 2, // 仅 state=queued
      createdAt: "2026-08-16T12:00:00.000Z",
    },
  ],
  usage: { total: sampleUsage, compaction: sampleUsage },
};

// ── 窄化函数：每个分支访问该分支 payload 独有字段（窄化失效 → tsc 失败） ──
function summarizeEvent(event: EventEnvelope): string {
  switch (event.type) {
    case "connection.welcome":
      return `welcome:${event.payload.sessionId}:${event.payload.model}:${event.payload.agentState}`;
    case "connection.error":
      return `error:${event.payload.code}:${event.payload.message}`;
    case "session.snapshot":
      return `snapshot:${event.payload.snapshot.sessionId}:${event.payload.snapshot.entries.length}:${event.payload.snapshot.revision}`;
    case "chat.stream.delta":
      return `delta:${event.payload.messageId}:${event.payload.delta}`;
    case "chat.turn.started":
      return `turn-start:${event.payload.turnId}`;
    case "chat.turn.completed":
      return `turn-end:${event.payload.turnId}:${event.payload.reason}`;
    case "chat.message.completed":
      return `msg:${event.payload.entry.id}`;
    case "steer.queued":
      return `steer-q:${event.payload.entryId}`;
    case "steer.drained":
      return `steer-d:${event.payload.entryId}`;
    case "tool.call.started":
      return `tool-start:${event.payload.entry.id}`;
    case "tool.call.result":
      return `tool-result:${event.payload.entry.id}`;
    case "agent.state.changed":
      return `state:${event.payload.state}`;
    // ── v0.1 编排生命周期族 ──
    case "agent.spawned":
      return `spawned:${event.payload.agentId}:${event.payload.task}:${event.payload.profileKind}:${event.payload.model ?? "inherit"}`;
    case "agent.queued":
      return `queued:${event.payload.agentId}:${event.payload.position}`;
    case "agent.started":
      return `started:${event.payload.agentId}`;
    case "agent.stalled":
      return `stalled:${event.payload.agentId}:${event.payload.idleMs}`;
    case "agent.completed":
      return `completed:${event.payload.agentId}:${event.payload.closure.status}`;
    case "agent.failed":
      return `failed:${event.payload.agentId}:${event.payload.error}:${event.payload.closure.status}`;
    case "agent.killed":
      return `killed:${event.payload.agentId}:${event.payload.closure.status}`;
    // ── v0.1 通道族 ──
    case "thinking.stream.delta":
      return `think-delta:${event.payload.instanceId}:${event.payload.delta}`;
    case "thinking.completed":
      return `think-done:${event.payload.entry.id}:${event.payload.entry.reasoningTokens}`;
    case "compaction.completed":
      return `compaction:${event.payload.entry.id}:${event.payload.entry.tokensBefore}:${event.payload.entry.tokensAfter}`;
    case "usage.recorded":
      return `usage:${event.payload.instanceId}:${event.payload.usage.totalTokens}:${event.payload.source}`;
    default: {
      const _exhaustive: never = event; // 目录外事件 → 编译失败（穷尽性守护）
      return `unhandled:${String(_exhaustive)}`;
    }
  }
}

function dispatchCommand(cmd: CommandEnvelope): string {
  switch (cmd.type) {
    case "chat.send":
      return `send:${cmd.payload.text}`;
    case "chat.steer":
      return `steer:${cmd.payload.text}`;
    case "chat.abort":
      return "abort";
    case "session.subscribe":
      return "subscribe";
    case "session.unsubscribe":
      return "unsubscribe";
    // ── v0.1 编排命令 ──
    case "agent.kill":
      return `kill:${cmd.payload.agentId}`;
    case "agent.subscribe":
      return `agent-sub:${cmd.payload.agentId}`;
    case "agent.unsubscribe":
      return `agent-unsub:${cmd.payload.agentId}`;
    default: {
      const _exhaustive: never = cmd;
      return `unhandled:${String(_exhaustive)}`;
    }
  }
}

function describeEntry(entry: EntryDto): string {
  switch (entry.kind) {
    case "message":
      return `msg:${entry.role}:${entry.content}${entry.steerState ? `:${entry.steerState}` : ""}`;
    case "tool-call":
      return `tool:${entry.name}:${entry.state}${entry.durationMs ? `:${entry.durationMs}ms` : ""}`;
    case "thinking":
      return `thinking:${entry.instanceId}:${entry.reasoningTokens}`;
    case "compaction":
      return `compaction:${entry.instanceId}:${entry.tokensBefore}:${entry.tokensAfter}:${entry.usage.cost}`;
  }
}

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
// 信封 v 位为字面量 0（版本位内建，AD-9）
type _VIsZero = Expect<Equal<HelloCommand["v"], 0>>;
// 命令目录常量 ↔ 命令信封联合 type 集合双向一致（v0.1：8 个）
type _CommandSync = Expect<Equal<EnvelopeTypeOf<CommandEnvelope>, (typeof COMMAND_TYPES)[number]>>;
// 事件目录常量 ↔ 事件信封联合 type 集合双向一致（v0.1：23 个）
type _EventSync = Expect<Equal<EnvelopeTypeOf<EventEnvelope>, (typeof EVENT_TYPES)[number]>>;
// EntryDto 判别式联合两分支即 message / tool-call 变体
type _EntryMessage = Expect<Equal<Extract<EntryDto, { kind: "message" }>, MessageEntryDto>>;
type _EntryTool = Expect<Equal<Extract<EntryDto, { kind: "tool-call" }>, ToolCallEntryDto>>;

// ── v0.1 类型级断言（契约 protocol-v0.1.md §5/§6） ──
// EntryDto 判别式联合四分支：+thinking / +compaction 变体
type _EntryThinking = Expect<Equal<Extract<EntryDto, { kind: "thinking" }>, ThinkingEntryDto>>;
type _EntryCompaction = Expect<Equal<Extract<EntryDto, { kind: "compaction" }>, CompactionEntryDto>>;
// InstanceState 五态恰等（cancelled 仅重启时 queued 收口，AD-10）
type _InstanceState = Expect<
  Equal<InstanceState, "queued" | "running" | "done" | "failed" | "cancelled">
>;
// UsageDto 七字段恰等（pi Usage 防腐映射，cost 拍平 number）
type _UsageFields = Expect<
  Equal<
    keyof UsageDto,
    "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "totalTokens" | "cost"
  >
>;
// UsageDto / SessionUsageDto 字段类型为 number（cost 拍平，非对象）
type _UsageCostNumber = Expect<Equal<UsageDto["cost"], number>>;
type _SessionUsageShape = Expect<Equal<keyof SessionUsageDto, "total" | "compaction">>;
// ClosureDto：status 二值；全字段名恰等（reportPath/findings/taskId 显式 null 语义）
type _ClosureStatus = Expect<Equal<ClosureDto["status"], "done" | "failed">>;
type _ClosureFields = Expect<
  Equal<keyof ClosureDto, "status" | "summary" | "reportPath" | "findings" | "taskId">
>;
// 新 3 命令 type 字面量全部在命令联合中（漏任一 → Extract 不等）
type V01CommandTypes = "agent.kill" | "agent.subscribe" | "agent.unsubscribe";
type _V01CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V01CommandTypes>, V01CommandTypes>
>;
// 新 11 事件 type 字面量全部在事件联合中（漏任一 → Extract 不等）
type V01EventTypes =
  | "agent.spawned"
  | "agent.queued"
  | "agent.started"
  | "agent.stalled"
  | "agent.completed"
  | "agent.failed"
  | "agent.killed"
  | "thinking.stream.delta"
  | "thinking.completed"
  | "compaction.completed"
  | "usage.recorded";
type _V01EventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V01EventTypes>, V01EventTypes>
>;
// 信封 instanceId 可选（缺省 = 主实例）：string | undefined
type _EnvelopeInstanceIdOptional = Expect<
  Equal<EventEnvelope["instanceId"], string | undefined>
>;
// 快照 additive 字段可选（旧剧本不带仍合法）
type _SnapshotInstances = Expect<Equal<SessionSnapshotDto["instances"], AgentInstanceDto[] | undefined>>;
type _SnapshotUsage = Expect<Equal<SessionSnapshotDto["usage"], SessionUsageDto | undefined>>;

// 负向断言：tool-call 变体不携带 steerState（仅 chat.steer 用户消息变体）
// @ts-expect-error steerState 不存在于 ToolCallEntryDto
const badToolEntry: ToolCallEntryDto = { kind: "tool-call", id: "x", name: "n", args: "{}", state: "done", ts: 1, steerState: "queued" };
// 负向断言：v 位不接受非 0 版本
// @ts-expect-error v 位必须是 0
const badVersion: HelloCommand = { v: 1, type: "hello", payload: { token: "t", protocolVersion: 0 } };
// 负向断言（v0.1）：thinking 变体不携带 steerState
// @ts-expect-error steerState 不存在于 ThinkingEntryDto
const badThinkingEntry: ThinkingEntryDto = { kind: "thinking", id: "x", instanceId: "main", text: "t", durationMs: 1, reasoningTokens: 1, createdAt: "t", steerState: "queued" };
// 负向断言（v0.1）：usage.source 只接受 turn|compaction
// @ts-expect-error source 不接受其他字面量
const badSource: UsageRecordedPayload = { instanceId: "main", usage: sampleUsage, source: "stream" };

// ── 运行时断言 ────────────────────────────────────────────────
describe("TP-CL2-① 样例帧构造（契约 §2–§6）", () => {
  test("hello/welcome/snapshot/delta/工具卡/steer 徽标样例帧结构正确", () => {
    expect(helloFrame.v).toBe(0);
    expect(helloFrame.type).toBe("hello");
    expect(helloFrame.payload.token).toBe("dev-token-xyz");
    expect(helloFrame.payload.protocolVersion).toBe(0);

    const byType = new Map(sampleEvents.map((e) => [e.type, e] as const));
    const welcome = byType.get("connection.welcome");
    expect(welcome?.type === "connection.welcome" && welcome.payload.model).toBe("kimi-k2");
    const snap = byType.get("session.snapshot");
    expect(
      snap?.type === "session.snapshot" && snap.payload.snapshot.entries.length,
    ).toBe(3);
    const delta = byType.get("chat.stream.delta");
    expect(delta?.type === "chat.stream.delta" && delta.payload.delta).toBe("流式半句");
    const toolStart = byType.get("tool.call.started");
    expect(
      toolStart?.type === "tool.call.started" && toolStart.payload.entry.kind,
    ).toBe("tool-call");
    // steer 徽标两事件（review.md 徽标语义的依据）
    expect(byType.get("steer.queued")?.type === "steer.queued").toBe(true);
    expect(byType.get("steer.drained")?.type === "steer.drained").toBe(true);
  });

  test("信封 workspace 预留字段位：可携带（含 WorkspaceRoute）可省略", () => {
    expect(chatSendWithRoute.workspace?.workspaceId).toBe("ws-main");
    expect(chatSendPlain.workspace).toBeUndefined();
    const route: WorkspaceRoute = { workspaceId: "ws-1" };
    expect(route.workspaceId).toBe("ws-1");
    const bareRoute: WorkspaceRoute = {}; // workspaceId 本身可选
    expect(bareRoute.workspaceId).toBeUndefined();
  });
});

describe("TP-CL2-③ 命令/事件目录完备性（契约 §4/§5）", () => {
  test("命令目录恰为 8 个 type（v0 5 + v0.1 3）", () => {
    expect([...COMMAND_TYPES].sort()).toEqual(
      [
        "agent.kill",
        "agent.subscribe",
        "agent.unsubscribe",
        "chat.abort",
        "chat.send",
        "chat.steer",
        "session.subscribe",
        "session.unsubscribe",
      ],
    );
  });

  test("事件目录恰为 23 个 type（v0 12 + v0.1 11）", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "agent.completed",
        "agent.failed",
        "agent.killed",
        "agent.queued",
        "agent.spawned",
        "agent.stalled",
        "agent.started",
        "agent.state.changed",
        "chat.message.completed",
        "chat.stream.delta",
        "chat.turn.completed",
        "chat.turn.started",
        "compaction.completed",
        "connection.error",
        "connection.welcome",
        "session.snapshot",
        "steer.drained",
        "steer.queued",
        "thinking.completed",
        "thinking.stream.delta",
        "tool.call.result",
        "tool.call.started",
        "usage.recorded",
      ],
    );
  });

  test("全部 8 个命令信封可构造且可分发", () => {
    const out = [...sampleCommands, ...v01Commands].map(dispatchCommand);
    expect(out).toEqual([
      "send:hi",
      "steer:改用方案 B",
      "abort",
      "subscribe",
      "unsubscribe",
      "kill:agent-2",
      "agent-sub:agent-2",
      "agent-unsub:agent-2",
    ]);
  });

  test("全部 23 个事件信封可构造且窄化分发正确", () => {
    const out = [...sampleEvents, ...v01Events].map(summarizeEvent);
    expect(out).toEqual([
      "welcome:sess-1:kimi-k2:running",
      "error:auth.missing_token:握手缺少 token",
      "snapshot:sess-1:3:42",
      "delta:e5:流式半句",
      "turn-start:turn-7",
      "turn-end:turn-7:aborted",
      "msg:e5",
      "steer-q:e2",
      "steer-d:e2",
      "tool-start:e6",
      "tool-result:e6",
      "state:steering",
      // v0.1 编排生命周期族
      "spawned:agent-1:修协议守护测试:subagent-worker:moonshot/kimi-k2",
      "queued:agent-1:2",
      "started:agent-1",
      "stalled:agent-1:330000",
      "completed:agent-1:done",
      "failed:agent-1:provider 5xx:failed",
      "killed:agent-1:failed",
      // v0.1 通道族
      "think-delta:agent-1:思考增量半句",
      "think-done:tk-1:900",
      "compaction:cp-1:340000:20000",
      "usage:main:11640:turn",
    ]);
  });
});

describe("TP-CL2-④ EntryDto 判别式联合（契约 §6）", () => {
  test("switch(entry.kind) 两分支窄化：steerState 仅 message 变体", () => {
    expect(snapshot.entries.map(describeEntry)).toEqual([
      "msg:user:跑一下单测",
      "msg:user:先别动，改用方案 B:queued",
      "tool:run_tests:done:1200ms",
    ]);
    // 负向样例（badToolEntry）由上方 @ts-expect-error 在编译期守护：
    // tool-call 变体携带 steerState → tsc 失败
    expect(badToolEntry.state).toBe("done"); // 运行时仅访问合法字段
    expect(badVersion.payload.protocolVersion).toBe(0);
  });
});

describe("TP-CL2-② 信封 v 位与版本常量", () => {
  test("PROTOCOL_VERSION = 0，样例帧 v 位全为 0（v0.1 不 bump）", () => {
    expect(PROTOCOL_VERSION).toBe(0);
    for (const frame of [helloFrame, ...sampleEvents, ...sampleCommands, ...v01Commands, ...v01Events]) {
      expect(frame.v).toBe(0);
      expect(typeof frame.type).toBe("string");
    }
  });
});

// ── v0.1 运行时断言（契约 protocol-v0.1.md §3–§6） ────────────
describe("TP-v0.1-① 新增样例帧结构（契约 §4/§5）", () => {
  test("编排族 7 事件 payload 字段结构正确", () => {
    const byType = new Map(v01Events.map((e) => [e.type, e] as const));

    const spawned = byType.get("agent.spawned");
    expect(
      spawned?.type === "agent.spawned" && spawned.payload.profileKind,
    ).toBe("subagent-worker");

    const queued = byType.get("agent.queued");
    expect(queued?.type === "agent.queued" && queued.payload.position).toBe(2);

    const stalled = byType.get("agent.stalled");
    expect(stalled?.type === "agent.stalled" && stalled.payload.idleMs).toBe(330_000);

    const completed = byType.get("agent.completed");
    expect(
      completed?.type === "agent.completed" && completed.payload.closure.status,
    ).toBe("done");
    // 全字段必发纪律：缺失字段显式 null（契约 §5.3）
    expect(
      completed?.type === "agent.completed" && completed.payload.closure.reportPath,
    ).toBeNull();

    const failed = byType.get("agent.failed");
    expect(
      failed?.type === "agent.failed" && failed.payload.error,
    ).toBe("provider 5xx");
    expect(
      failed?.type === "agent.failed" && failed.payload.closure.status,
    ).toBe("failed");

    // kill 收口：closure.status="failed"（契约 §5.1 / §8.2）
    const killed = byType.get("agent.killed");
    expect(
      killed?.type === "agent.killed" && killed.payload.closure.status,
    ).toBe("failed");
  });

  test("通道族 4 事件 payload 字段结构正确", () => {
    const byType = new Map(v01Events.map((e) => [e.type, e] as const));

    const thinkDelta = byType.get("thinking.stream.delta");
    expect(
      thinkDelta?.type === "thinking.stream.delta" && thinkDelta.payload.instanceId,
    ).toBe("agent-1");

    const thinkDone = byType.get("thinking.completed");
    expect(
      thinkDone?.type === "thinking.completed" &&
        thinkDone.payload.entry.kind === "thinking" &&
        thinkDone.payload.entry.reasoningTokens,
    ).toBe(900);

    const compaction = byType.get("compaction.completed");
    expect(
      compaction?.type === "compaction.completed" &&
        compaction.payload.entry.kind === "compaction" &&
        [compaction.payload.entry.tokensBefore, compaction.payload.entry.tokensAfter],
    ).toEqual([340_000, 20_000]);
    // 摘要调用成本入账（AD-9③）：compaction entry 携带 usage
    expect(
      compaction?.type === "compaction.completed" &&
        compaction.payload.entry.usage.totalTokens,
    ).toBe(11_640);

    const usage = byType.get("usage.recorded");
    expect(
      usage?.type === "usage.recorded" && usage.payload.source,
    ).toBe("turn");
    expect(
      usage?.type === "usage.recorded" && usage.payload.usage.cost,
    ).toBe(0.0213);
  });

  test("信封 instanceId：事件侧可携带；缺省 = 主实例（AD-3）", () => {
    expect(subAgentDelta.instanceId).toBe("agent-1");
    // 既有 v0 帧不带 instanceId 仍合法（additive 兼容），缺省语义 = main
    expect(sampleEvents[0]?.instanceId).toBeUndefined();
  });
});

describe("TP-v0.1-② EntryDto 四成员与快照 additive 字段（契约 §6）", () => {
  test("switch(entry.kind) 四分支窄化：thinking/compaction 变体可描述", () => {
    expect(snapshotV01.entries.map(describeEntry)).toEqual([
      "msg:assistant:委托完成",
      "thinking:main:900",
      "compaction:main:340000:20000:0.0213",
    ]);
    // 负向样例（badThinkingEntry / badSource）由上方 @ts-expect-error 编译期守护
    expect(badThinkingEntry.kind).toBe("thinking");
    expect(badSource.usage.cost).toBe(0.0213);
  });

  test("快照 instances/usage 结构正确（重启恢复骨架）", () => {
    const instances = snapshotV01.instances;
    expect(instances?.length).toBe(3);
    const [main, doneSub, queuedSub] = instances ?? [];
    expect(main?.instanceId).toBe("main");
    expect(main?.kind).toBe("main");
    expect(main?.state).toBe("running");
    // 终态实例携带 closure + usage
    expect(doneSub?.state).toBe("done");
    expect(doneSub?.closure?.status).toBe("done");
    expect(doneSub?.usage?.totalTokens).toBe(11_640);
    // 仅 state=queued 携带 queuedPosition
    expect(queuedSub?.state).toBe("queued");
    expect(queuedSub?.queuedPosition).toBe(2);
    expect(main?.queuedPosition).toBeUndefined();

    expect(snapshotV01.usage?.total.totalTokens).toBe(11_640);
    expect(snapshotV01.usage?.compaction.cost).toBe(0.0213);
    // 既有 v0 快照不带 instances/usage 仍合法（additive 兼容）
    expect(snapshot.instances).toBeUndefined();
    expect(snapshot.usage).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  COMMAND_TYPES,
  EVENT_CHANNELS,
  EVENT_TYPES,
  PROTOCOL_VERSION,
  type AgentInstanceDto,
  type AgentInstantiatedEvent,
  type AgentModelChangedEvent,
  type AgentSpawnedPayload,
  type AuthDeleteKeyResultEvent,
  type AuthListResultEvent,
  type AuthSetKeyCommand,
  type AuthSetKeyResultEvent,
  type AuthVerifyResult,
  type AuthVerifyResultEvent,
  type CatalogModel,
  type ChatSendCommand,
  type ChatSteerCommand,
  type ChatSteerPayload,
  type Channel,
  type ClosureDto,
  type CommandEnvelope,
  type CommandFrame,
  type CompactionCompletedEvent,
  type CompactionCompletedPayload,
  type CompactionEntryDto,
  type EmptyPayload,
  type EntryDto,
  type EventEnvelope,
  type EventFrame,
  type FrameVersion,
  type HelloCommand,
  type HelloPayload,
  type InstanceChannelHistory,
  type InstanceState,
  type MessageEntryDto,
  type ModelCatalogRefreshResultEvent,
  type ModelCatalogResult,
  type ModelCatalogResultEvent,
  type ModelChangedEvent,
  type ModelGetDefaultResultEvent,
  type ModelGetResultEvent,
  type ModelSetDefaultResultEvent,
  type SessionListChangedEvent,
  type SessionListResult,
  type SessionLoadHistoryCommand,
  type SessionLoadHistoryResult,
  type SessionMeta,
  type SessionSnapshotDto,
  type SessionSubscribeCommand,
  type SessionSubscribePayload,
  type SessionUnsubscribeCommand,
  type SessionUsageDto,
  type ThinkingEntryDto,
  type ToolCallEntryDto,
  type TraceQueryCommand,
  type TraceQueryResultEvent,
  type UsageDto,
  type UsageRecordedPayload,
  type WorkspaceRoute,
} from "../src/index";

/**
 * TP-CL2-1（U）：协议类型完备性（CL-2 / F(2.1) 标准 1/2）。
 *
 * ① 样例帧构造：hello/welcome/snapshot/delta/工具卡/steer 徽标事件以契约类型
 *    构造并通过类型检查（tsc 守护）+ 结构断言（运行时）。
 * ② 信封 v 位取值域（v0.2：FrameVersion = 0 | "0.2"）；workspace 预留字段位
 *    可携带可省略（AD-7：仅类型，零路由行为）。
 * ③ 命令/事件目录 type 全覆盖，且与信封联合一一对应
 *    （COMMAND_TYPES/EVENT_TYPES 常量目录 ↔ 联合 type 提取双向一致）。
 * ④ 判别式联合窄化：switch(event.type) 各分支 payload 窄化正确；
 *    v0.2 switch(event.channel) 分族窄化（八族类型学判别，契约 A §2）。
 *
 * v0.1 扩展（iter-20260816-uzvg T1.1）：命令 5→8、事件 12→24；EntryDto 四成员；
 * 快照 instances?/usage? additive。
 *
 * v0.2 扩展（iter-20260816-6q6f T1.2，契约 A/B/C）：
 * ⑤ 帧信封分型 CommandFrame/EventFrame + sessionId 路由位 + channel 类型学；
 *    命令目录 8 → 21（+session 族 3 / model 族 6 / auth 族 4）；事件目录
 *    24 → 26（+session.list_changed / model.changed）；T2.2：+2 命令结果
 *    （session.list.result / session.loadHistory.result）；T2.3-result-frames
 *    微批：+9 model/auth 命令结果帧（契约 C §2.2，26 → 37）。
 * ⑥ 信封兼容红线：v0/v0.1 形态帧（v: 0、不带 sessionId/channel）在新类型下
 *    零修改合法（可选性设计）；hello protocolVersion 严格 "0.2" 单值。
 * ⑦ EVENT_CHANNELS 登记目录 ↔ 契约 A §2 映射表恰等（含 interaction 占位族
 *    无事件挂靠）。
 *
 * v0.3 扩展（契约 = PROTOCOL.md §12；AD-5 三合一
 * additive 一次定形）：
 * ⑧ CL-1 spawn 锚点：AgentInstanceDto / AgentSpawnedPayload 增可选
 *    anchorEntryId?: string | null（null = 流首有效值；缺省 = 主实例不携带）。
 * ⑨ CL-2 monitor 档：session.subscribe payload 从 EmptyPayload 换
 *    SessionSubscribePayload { tier?: "full" | "monitor" }（缺省 full；
 *    session.unsubscribe 保持 EmptyPayload 不动）。
 * ⑩ CL-3 steer 定向寻址：ChatSteerPayload 增可选 instanceId（缺省 = 主实例）。
 *    PROTOCOL_VERSION "0.2" → "0.3"（批次标记非协商位，Q-1c 单仓同发一步
 *    替换）；EVENT_TYPES(37) / EVENT_CHANNELS / COMMAND_TYPES(21) 计数不动
 *    断言保持（零新增守护，TR-AD-23①/②）。
 */

// ── 类型级断言工具（仅编译期） ────────────────────────────────
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
/** 从信封联合提取全部 type 字面量 */
type EnvelopeTypeOf<U> = U extends { type: infer T } ? T : never;
/** 通道 C 分族的 type 联合（channel 可选判别字段的 Extract 过滤） */
type TypeOfChannel<C extends Channel> = Extract<EventEnvelope, { channel?: C }>["type"];

// ── 样例帧（构造本身即类型检查：字段缺失/多余/拼写错 → tsc 失败） ──
const helloFrame: HelloCommand = {
  v: PROTOCOL_VERSION,
  type: "hello",
  payload: { token: "dev-token-xyz", protocolVersion: PROTOCOL_VERSION },
};

const chatSendWithRoute: ChatSendCommand = {
  v: "0.4",
  type: "chat.send",
  payload: { text: "帮我看看 protocol 包的类型" },
  workspace: { workspaceId: "ws-main" }, // 预留字段位：可携带（当前无路由语义）
};
const chatSendPlain: ChatSendCommand = {
  v: 0, // v0 历史形态样本（FrameVersion 兼容读；workspace 同样可省略）
  type: "chat.send",
  payload: { text: "hi" },
};
/** v0.2 会话路由位：会话作用域命令携带信封 sessionId（AD-4） */
const chatSendRouted: ChatSendCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "chat.send",
  payload: { text: "发给 sess-1" },
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

// ── 兼容样本（v0/v0.1 形态：v: 0 字面量 + 不带 sessionId/channel）──
// 信封兼容红线（契约 A §5）：历史形态帧在新类型下零修改合法。
const legacyEvents: EventEnvelope[] = [
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
  { v: 0, type: "engine.error", payload: { message: "429: 已达到 5 小时的使用上限" } },
];

const legacyCommands: CommandEnvelope[] = [
  chatSendPlain,
  { v: 0, type: "chat.steer", payload: { text: "改用方案 B" } },
  { v: 0, type: "chat.abort", payload: {} },
  { v: 0, type: "session.subscribe", payload: {} }, // v0.2 升级后 payload 仍空（路由位在信封）
  { v: 0, type: "session.unsubscribe", payload: {} },
];

// ── v0.1 样例帧（契约 protocol-v0.1.md §3–§6；构造即类型检查） ──

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

// ── v0.2 样例帧（契约 A §1/§2、B §1/§2、C §1/§2；构造即类型检查） ──

/** 会话元数据样例（SessionMeta：session.list / session.list_changed 同源） */
const sampleSessionMeta: SessionMeta = {
  sessionId: "sess-1",
  title: "帮我看看 protocol 包的类型",
  lastActivityAt: 1760000099999,
  runState: "streaming",
  loaded: true,
};

/** 全章印信封样例：v="0.4"（随 PROTOCOL_VERSION bump，当前 v0.4）+ sessionId 必发 + channel 判别 */
const listChangedV02: SessionListChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "session", // 契约 A §2：session 族（系统级广播 sessionId 占位）
  type: "session.list_changed",
  payload: { kind: "created", sessionId: "sess-1", session: sampleSessionMeta },
};
const modelChangedV02: ModelChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "model",
  type: "model.changed",
  payload: { sessionId: "sess-1", model: "moonshot/kimi-k2", previous: "kimi-k2", effective: "next-turn" },
};
const v02Events: EventEnvelope[] = [listChangedV02, modelChangedV02];

/** v0.2 新命令族样例：会话作用域走信封 sessionId，全局命令省略 */
const v02Commands: CommandEnvelope[] = [
  chatSendRouted,
  { v: PROTOCOL_VERSION, type: "session.list", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.loadHistory", payload: { beforeEntryId: "e1" } },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.loadHistory", payload: { beforeEntryId: "e1", limit: 100 } },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.delete", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.subscribe", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "model.set", payload: { model: "moonshot/kimi-k2" } },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "model.get", payload: {} },
  { v: PROTOCOL_VERSION, type: "model.catalog", payload: {} },
  { v: PROTOCOL_VERSION, type: "model.catalog_refresh", payload: {} },
  { v: PROTOCOL_VERSION, type: "model.set_default", payload: { model: "moonshot/kimi-k2" } },
  { v: PROTOCOL_VERSION, type: "model.get_default", payload: {} },
  { v: PROTOCOL_VERSION, type: "auth.list", payload: {} },
  { v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "moonshot", apiKey: "sk-xxx" } },
  { v: PROTOCOL_VERSION, type: "auth.delete_key", payload: { providerId: "moonshot" } },
  { v: PROTOCOL_VERSION, type: "auth.verify", payload: { providerId: "moonshot" } },
];

/** v0.2 结果载荷样例（类型级登记；daemon 行为 T2.x 落地） */
const sampleCatalogModel: CatalogModel = {
  id: "moonshot/kimi-k2",
  providerId: "moonshot",
  contextWindow: 131_072,
  cost: { input: 4, output: 16, cacheRead: 1, cacheWrite: 8 },
  source: "builtin",
};
const _sessionListResult: SessionListResult = { sessions: [sampleSessionMeta] };
const _loadHistoryResult: SessionLoadHistoryResult = { entries: [], hasMore: true, nextCursor: "e1" };
const _catalogResult: ModelCatalogResult = { models: [sampleCatalogModel], refreshedAt: 1760000100000, source: "cache" };
const _authVerifyOk: AuthVerifyResult = { status: "ok", latencyMs: 120 };
const _authVerifyFail: AuthVerifyResult = { status: "fail", reason: "401 Unauthorized" };

/**
 * v0.2 model/auth 命令结果帧样例（T2.3-result-frames 微批；点对点回执 +
 * channel=model；model.get.result 信封 sessionId = 目标会话 id，全局命令 =
 * SYSTEM_SESSION_ID——与 session 族结果帧同构，契约 C §2.2）。
 */
const v02ResultEvents: EventEnvelope[] = [
  { v: PROTOCOL_VERSION, sessionId: "sess-1", channel: "model", type: "model.get.result", payload: { model: "moonshot/kimi-k2", isDefault: false, defaultModel: "anthropic/claude-sonnet-4-5" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.catalog.result", payload: { models: [sampleCatalogModel], refreshedAt: 1_760_000_100_000, source: "builtin" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.catalog_refresh.result", payload: { models: [sampleCatalogModel], refreshedAt: 1_760_000_100_000, source: "builtin", degraded: ["moonshot: 拉取失败：ENOTFOUND"] } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.set_default.result", payload: { previous: "anthropic/claude-sonnet-4-5" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.get_default.result", payload: { model: "anthropic/claude-sonnet-4-5" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.list.result", payload: { providers: [{ providerId: "moonshot", configured: true, keyMasked: "····7f3a" }] } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.set_key.result", payload: { keyMasked: "····7f3a" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.delete_key.result", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.verify.result", payload: { status: "fail", reason: "provider \"moonshot\" 未录入 API key" } },
];

/** v0.2 compaction 扩字段样例（tailKept / filesCompacted 命名定稿） */
const compactionCompletedV02: CompactionCompletedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "compaction",
  type: "compaction.completed",
  payload: { entry: compactionEntry, tailKept: 30, filesCompacted: 12 },
};

/** v0.2 快照尾窗 additive 样例：tail / totalEntries / tailStartCursor + instances[].channels */
const snapshotV02: SessionSnapshotDto = {
  ...snapshotV01,
  tail: snapshotV01.entries.slice(0, 2), // 主时间轴尾窗（默认 30，G-1；样例取 2）
  totalEntries: 128,
  tailStartCursor: "m1", // null = 已含全部历史
  instances: [
    ...(snapshotV01.instances ?? []).map((i) =>
      i.instanceId === "agent-0"
        ? { ...i, channels: { thinking: [thinkingEntry], messages: snapshotV01.entries.filter((e) => e.kind === "message") } }
        : i,
    ),
  ],
};

// ── v0.3 样例帧（契约 = PROTOCOL.md §12.1/§12.2/§12.3；构造即类型检查） ──

/** CL-1 spawn 锚点：agent.spawned 增量帧三形态（string 锚 / null 流首 / 缺省主实例） */
const spawnedAnchored: EventEnvelope = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.spawned",
  payload: { agentId: "agent-1", task: "契约 v0.3 定形", profileKind: "subagent-worker", anchorEntryId: "e12" },
};
const spawnedStreamHead: EventEnvelope = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.spawned",
  payload: { agentId: "agent-0", task: "流首锚点", profileKind: "subagent-worker", anchorEntryId: null }, // null = 流首（有效值）
};
/** CL-1 快照面：instances[].anchorEntryId（与 agent.spawned 增量帧同源供给） */
const instanceAnchored: AgentInstanceDto = {
  instanceId: "agent-1",
  kind: "subagent",
  profileKind: "subagent-worker",
  state: "running",
  createdAt: "2026-08-18T12:00:00.000Z",
  anchorEntryId: "e12",
};
const instanceMainNoAnchor: AgentInstanceDto = {
  instanceId: "main",
  kind: "main",
  profileKind: "main-session",
  state: "running",
  createdAt: "2026-08-18T11:00:00.000Z", // 主实例：缺省不携带（undefined）
};

/** CL-2 monitor 档订阅：payload 从 EmptyPayload 换 SessionSubscribePayload（tier 可选；缺省 full） */
const subscribeMonitor: SessionSubscribeCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "session.subscribe",
  payload: { tier: "monitor" },
};
const subscribeTierDefault: SessionSubscribeCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "session.subscribe",
  payload: {}, // 缺省 full（既有语义不变；空 payload 仍合法）
};
/** session.unsubscribe 不动：payload 保持 EmptyPayload */
const unsubscribeUnchanged: SessionUnsubscribeCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "session.unsubscribe",
  payload: {},
};

/** CL-3 steer 定向寻址：可选 instanceId（缺省 = 主实例） */
const steerTargeted: ChatSteerCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "chat.steer",
  payload: { text: "定向注入 agent-1", instanceId: "agent-1" },
};
const steerMainDefault: ChatSteerCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "chat.steer",
  payload: { text: "主实例缺省路径" },
};

const v03Commands: CommandEnvelope[] = [subscribeMonitor, subscribeTierDefault, steerTargeted];
const v03Events: EventEnvelope[] = [spawnedAnchored, spawnedStreamHead];

// ── v0.4 样例帧（契约 v0.4 §1/§2/§3；iter-20260819-erio T2.1；构造即类型检查） ──

/** trace.query：全过滤维形态 + 缺省形态（缺省 = 全部实例/全部类型/limit 50） */
const traceQueryFull: TraceQueryCommand = {
  v: PROTOCOL_VERSION,
  type: "trace.query",
  payload: {
    sessionId: "sess-1",
    instanceIds: ["main", "agent-1"],
    agentKind: "main",
    types: ["message.completed", "agent.instantiated"],
    timeRange: { from: "2026-08-19T00:00:00.000Z", to: "2026-08-19T23:59:59.999Z" },
    page: { limit: 100, beforeId: 428 },
  },
};
const traceQueryDefault: TraceQueryCommand = {
  v: PROTOCOL_VERSION,
  type: "trace.query",
  payload: { sessionId: "sess-1" }, // 全缺省（可选字段带缺省语义，TR-AD-18）
};

/** trace.query.result：点对点结果帧（filterEcho 缺省维归一 null；instances 面板块） */
const traceQueryResult: TraceQueryResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "trace",
  type: "trace.query.result",
  payload: {
    filterEcho: {
      sessionId: "sess-1",
      instanceIds: null,
      agentKind: null,
      types: null,
      timeRange: null,
      page: { limit: 50, beforeId: null },
    },
    instances: [
      {
        instanceId: "main",
        agentKind: "main",
        profileKind: "main-session",
        model: "zhipu/glm-4.6",
        status: "running",
        startedAt: "2026-08-19T13:47:57.802Z",
        eventCount: 12,
        snapshot: {
          systemPrompt: "你是 helix 的主会话助手。",
          tools: ["bash", "read"],
          model: "zhipu/glm-4.6",
          compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        snapshotMissing: false,
        modelTimeline: [{ from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat", at: "2026-08-19T14:27:05.310Z" }],
        currentModel: "deepseek/deepseek-chat",
      },
    ],
    events: [
      {
        id: 428,
        ts: "2026-08-19T14:27:05.310Z",
        sessionId: "sess-1",
        instanceId: "main",
        agentKind: "main",
        type: "agent.model.changed",
        payload: { instanceId: "main", from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat" },
      },
    ],
    page: { loaded: 1, total: 12, hasMore: false },
  },
};

/** agent.instantiated：实例化快照（只落盘不广播；channel = agent 族，AF-6） */
const agentInstantiated: AgentInstantiatedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.instantiated",
  instanceId: "agent-1",
  payload: {
    instanceId: "agent-1",
    profileKind: "subagent-worker",
    profileSnapshot: {
      systemPrompt: "你是 helix 的 SubAgent worker。",
      tools: ["bash", "read", "write", "edit", "grep"],
      model: "zai/glm-5.3", // 三级链解析结果（AD-3 联动，spawn 时刻求值）
    },
  },
};

/** agent.model.changed：模型时间线落盘（只落盘不广播；channel = agent 族） */
const agentModelChanged: AgentModelChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.model.changed",
  instanceId: "main",
  payload: { instanceId: "main", from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat" },
};

const v04Commands: CommandEnvelope[] = [traceQueryFull, traceQueryDefault];
const v04Events: EventEnvelope[] = [traceQueryResult, agentInstantiated, agentModelChanged];

// ── 窄化函数：每个分支访问该分支 payload 独有字段（窄化失效 → tsc 失败） ──
function summarizeEvent(event: EventEnvelope): string {
  switch (event.type) {
    case "connection.welcome":
      return `welcome:${event.payload.sessionId}:${event.payload.model}:${event.payload.agentState}`;
    case "connection.error":
      return `error:${event.payload.code}:${event.payload.message}`;
    case "session.snapshot":
      return `snapshot:${event.payload.snapshot.sessionId}:${event.payload.snapshot.entries.length}:${event.payload.snapshot.revision}`;
    case "session.list_changed":
      return `list-changed:${event.payload.kind}:${event.payload.sessionId ?? "-"}:${event.payload.session?.runState ?? "-"}`;
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
      return `compaction:${event.payload.entry.id}:${event.payload.entry.tokensBefore}:${event.payload.entry.tokensAfter}:${event.payload.tailKept ?? "-"}:${event.payload.filesCompacted ?? "-"}`;
    case "usage.recorded":
      return `usage:${event.payload.instanceId}:${event.payload.usage.totalTokens}:${event.payload.source}`;
    case "engine.error":
      return `engine-error:${event.payload.message.slice(0, 20)}`;
    // ── v0.2 model 族 ──
    case "model.changed":
      return `model-changed:${event.payload.sessionId}:${event.payload.model}:${event.payload.previous}:${event.payload.effective}`;
    // ── v0.2 session 族命令结果（T2.2 点对点回执）──
    case "session.list.result":
      return `list-result:${event.payload.sessions.length}:${event.payload.sessions[0]?.sessionId ?? "-"}`;
    case "session.loadHistory.result":
      return `history-result:${event.payload.entries.length}:${event.payload.hasMore}:${event.payload.nextCursor ?? "-"}`;
    // ── v0.2 model/auth 命令结果帧（T2.3-result-frames 微批，契约 C §2.2）──
    case "model.get.result":
      return `model-get-result:${event.payload.model}:${event.payload.isDefault}:${event.payload.defaultModel}`;
    case "model.catalog.result":
      return `model-catalog-result:${event.payload.models.length}:${event.payload.source}`;
    case "model.catalog_refresh.result":
      return `model-catalog-refresh-result:${event.payload.models.length}:${event.payload.source}:${event.payload.degraded.length}`;
    case "model.set_default.result":
      return `model-set-default-result:${event.payload.previous}`;
    case "model.get_default.result":
      return `model-get-default-result:${event.payload.model}`;
    case "auth.list.result":
      return `auth-list-result:${event.payload.providers.length}:${event.payload.providers[0]?.configured ?? "-"}`;
    case "auth.set_key.result":
      return `auth-set-key-result:${event.payload.keyMasked}`;
    case "auth.delete_key.result":
      return "auth-delete-key-result";
    case "auth.verify.result":
      return `auth-verify-result:${event.payload.status}:${event.payload.status === "ok" ? event.payload.latencyMs : event.payload.reason}`;
    // ── v0.4 trace 命令族 + agent 执行上下文面 ──
    case "trace.query.result":
      return `trace-result:${event.payload.events.length}:${event.payload.instances.length}:${event.payload.page.loaded}:${event.payload.page.total}:${event.payload.page.hasMore}`;
    case "agent.instantiated":
      return `instantiated:${event.payload.instanceId}:${event.payload.profileKind}:${event.payload.profileSnapshot.model}`;
    case "agent.model.changed":
      return `model-timeline:${event.payload.instanceId}:${event.payload.from}:${event.payload.to}`;
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
      return `steer:${cmd.payload.text}:${cmd.payload.instanceId ?? "main"}`; // v0.3：可选定向（缺省 = 主实例）
    case "chat.abort":
      return "abort";
    case "session.subscribe":
      return `subscribe:${cmd.sessionId ?? "-"}:${cmd.payload.tier ?? "full"}`; // v0.2 信封路由 + v0.3 tier（缺省 full）
    case "session.unsubscribe":
      return "unsubscribe";
    // ── v0.1 编排命令 ──
    case "agent.kill":
      return `kill:${cmd.payload.agentId}`;
    case "agent.subscribe":
      return `agent-sub:${cmd.payload.agentId}`;
    case "agent.unsubscribe":
      return `agent-unsub:${cmd.payload.agentId}`;
    // ── v0.2 session 族 ──
    case "session.list":
      return `session-list`;
    case "session.loadHistory":
      return `load-history:${cmd.sessionId ?? "-"}:${cmd.payload.beforeEntryId}:${cmd.payload.limit ?? 50}`;
    case "session.delete":
      return `session-delete:${cmd.sessionId ?? "-"}`;
    // ── v0.2 model 族 ──
    case "model.set":
      return `model-set:${cmd.sessionId ?? "-"}:${cmd.payload.model}`;
    case "model.get":
      return `model-get:${cmd.sessionId ?? "-"}`;
    case "model.catalog":
      return "model-catalog";
    case "model.catalog_refresh":
      return "model-catalog-refresh";
    case "model.set_default":
      return `model-set-default:${cmd.payload.model}`;
    case "model.get_default":
      return "model-get-default";
    // ── v0.2 auth 族 ──
    case "auth.list":
      return "auth-list";
    case "auth.set_key":
      return `auth-set-key:${cmd.payload.providerId}`;
    case "auth.delete_key":
      return `auth-delete-key:${cmd.payload.providerId}`;
    case "auth.verify":
      return `auth-verify:${cmd.payload.providerId}`;
    // ── v0.4 trace 族 ──
    case "trace.query":
      return `trace-query:${cmd.payload.sessionId}:${cmd.payload.instanceIds?.length ?? "all"}:${cmd.payload.page?.limit ?? 50}:${cmd.payload.page?.beforeId ?? "-"}`;
    default: {
      const _exhaustive: never = cmd;
      return `unhandled:${String(_exhaustive)}`;
    }
  }
}

/**
 * v0.2 八族类型学判别窄化（契约 A §2 机械判据）：switch(channel) 各分支内
 * type 联合窄化到本族（分支内以 TypeOfChannel<C> 收窄赋值证明——宽化即 tsc 失败）。
 */
function familyOf(event: EventEnvelope): string {
  switch (event.channel) {
    case "chat": {
      const t: TypeOfChannel<"chat"> = event.type;
      return `chat/${t}`;
    }
    case "agent": {
      const t: TypeOfChannel<"agent"> = event.type;
      return `agent/${t}`;
    }
    case "thinking": {
      const t: TypeOfChannel<"thinking"> = event.type;
      return `thinking/${t}`;
    }
    case "usage": {
      const t: TypeOfChannel<"usage"> = event.type;
      return `usage/${t}`;
    }
    case "compaction": {
      const t: TypeOfChannel<"compaction"> = event.type;
      return `compaction/${t}`;
    }
    case "session": {
      const t: TypeOfChannel<"session"> = event.type;
      return `session/${t}`;
    }
    case "model": {
      const t: TypeOfChannel<"model"> = event.type;
      return `model/${t}`;
    }
    case "trace": {
      const t: TypeOfChannel<"trace"> = event.type;
      return `trace/${t}`;
    }
    // interaction 占位族无事件挂靠（_InteractionFamily = never 类型断言守护）：
    // 事件联合中无成员声明 channel: "interaction"，本分支不可达、无需 case。
    case "notification": {
      const t: TypeOfChannel<"notification"> = event.type;
      return `notification/${t}`;
    }
    default:
      // channel 缺省 = v0/v0.1 历史帧（信封兼容读；按 type 走既有消费路径）
      return `legacy/${event.type}`;
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
// 帧版本位取值域（v0.4：0 = v0/v0.1 历史帧兼容读，"0.4" = 当前批帧）
type _VIsVersion = Expect<Equal<HelloCommand["v"], FrameVersion>>;
type _FrameVersionDomain = Expect<Equal<FrameVersion, 0 | "0.4">>;
// hello 协商位严格 "0.4" 单值（不取 FrameVersion 联合；fail-fast）
type _HelloVersion = Expect<Equal<HelloPayload["protocolVersion"], "0.4">>;
// 命令目录常量 ↔ 命令信封联合 type 集合双向一致（v0.4：22 个）
type _CommandSync = Expect<Equal<EnvelopeTypeOf<CommandEnvelope>, (typeof COMMAND_TYPES)[number]>>;
// 事件目录常量 ↔ 事件信封联合 type 集合双向一致（v0.4 口径：40 个）
type _EventSync = Expect<Equal<EnvelopeTypeOf<EventEnvelope>, (typeof EVENT_TYPES)[number]>>;
// v0.4 trace 族帧构造即类型检查（样例帧见上方 v04Commands/v04Events）
// EntryDto 判别式联合四分支
type _EntryMessage = Expect<Equal<Extract<EntryDto, { kind: "message" }>, MessageEntryDto>>;
type _EntryTool = Expect<Equal<Extract<EntryDto, { kind: "tool-call" }>, ToolCallEntryDto>>;
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
type _UsageCostNumber = Expect<Equal<UsageDto["cost"], number>>;
type _SessionUsageShape = Expect<Equal<keyof SessionUsageDto, "total" | "compaction">>;
// ClosureDto：status 二值；全字段名恰等
type _ClosureStatus = Expect<Equal<ClosureDto["status"], "done" | "failed">>;
type _ClosureFields = Expect<
  Equal<keyof ClosureDto, "status" | "summary" | "reportPath" | "findings" | "taskId">
>;

// ── v0.1 类型级断言（契约 protocol-v0.1.md §5/§6） ──
type V01CommandTypes = "agent.kill" | "agent.subscribe" | "agent.unsubscribe";
type _V01CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V01CommandTypes>, V01CommandTypes>
>;
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
type _EnvelopeInstanceIdOptional = Expect<
  Equal<EventEnvelope["instanceId"], string | undefined>
>;
type _SnapshotInstances = Expect<Equal<SessionSnapshotDto["instances"], AgentInstanceDto[] | undefined>>;
type _SnapshotUsage = Expect<Equal<SessionSnapshotDto["usage"], SessionUsageDto | undefined>>;

// ── v0.2 类型级断言（契约 A §1/§2/§3、B §2.2、C §1/§2） ──
// 信封新字段可选（信封兼容红线：历史帧不带仍合法）
type _CommandFrameSessionIdOptional = Expect<Equal<CommandFrame["sessionId"], string | undefined>>;
type _EventFrameSessionIdOptional = Expect<Equal<EventFrame["sessionId"], string | undefined>>;
type _EventFrameChannelOptional = Expect<Equal<EventFrame["channel"], Channel | undefined>>;
// 新 13 命令 type 字面量全部在命令联合中（漏任一 → Extract 不等）
type V02CommandTypes =
  | "session.list"
  | "session.loadHistory"
  | "session.delete"
  | "model.set"
  | "model.get"
  | "model.catalog"
  | "model.catalog_refresh"
  | "model.set_default"
  | "model.get_default"
  | "auth.list"
  | "auth.set_key"
  | "auth.delete_key"
  | "auth.verify";
type _V02CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V02CommandTypes>, V02CommandTypes>
>;
// 新 4 事件 type 字面量全部在事件联合中（T2.2 定稿：+session.list.result / session.loadHistory.result）
type V02EventTypes =
  | "session.list_changed"
  | "model.changed"
  | "session.list.result"
  | "session.loadHistory.result";
type _V02EventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V02EventTypes>, V02EventTypes>
>;
// 微批 9 结果事件 type 字面量全部在事件联合中（T2.3-result-frames；漏任一 → Extract 不等）
type V02ResultEventTypes =
  | "model.get.result"
  | "model.catalog.result"
  | "model.catalog_refresh.result"
  | "model.set_default.result"
  | "model.get_default.result"
  | "auth.list.result"
  | "auth.set_key.result"
  | "auth.delete_key.result"
  | "auth.verify.result";
type _V02ResultEventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V02ResultEventTypes>, V02ResultEventTypes>
>;
// 八族类型学：各 channel 分族 type 联合恰等（契约 A §2 映射表）
type _ChatFamily = Expect<
  Equal<
    TypeOfChannel<"chat">,
    | "chat.stream.delta"
    | "chat.turn.started"
    | "chat.turn.completed"
    | "chat.message.completed"
    | "steer.queued"
    | "steer.drained"
    | "tool.call.started"
    | "tool.call.result"
    | "agent.state.changed"
    | "engine.error"
  >
>;
type _AgentFamily = Expect<
  Equal<
    TypeOfChannel<"agent">,
    | "agent.spawned"
    | "agent.queued"
    | "agent.started"
    | "agent.stalled"
    | "agent.completed"
    | "agent.failed"
    | "agent.killed"
    | "agent.instantiated"
    | "agent.model.changed"
  >
>;
type _TraceFamily = Expect<Equal<TypeOfChannel<"trace">, "trace.query.result">>;
type _ThinkingFamily = Expect<
  Equal<TypeOfChannel<"thinking">, "thinking.stream.delta" | "thinking.completed">
>;
type _UsageFamily = Expect<Equal<TypeOfChannel<"usage">, "usage.recorded">>;
type _CompactionFamily = Expect<Equal<TypeOfChannel<"compaction">, "compaction.completed">>;
type _SessionFamily = Expect<
  Equal<
    TypeOfChannel<"session">,
    "session.snapshot" | "session.list_changed" | "session.list.result" | "session.loadHistory.result"
  >
>;
type _ModelFamily = Expect<
  Equal<
    TypeOfChannel<"model">,
    | "model.changed"
    | "model.get.result"
    | "model.catalog.result"
    | "model.catalog_refresh.result"
    | "model.set_default.result"
    | "model.get_default.result"
    | "auth.list.result"
    | "auth.set_key.result"
    | "auth.delete_key.result"
    | "auth.verify.result"
  >
>;
type _InteractionFamily = Expect<Equal<TypeOfChannel<"interaction">, never>>; // 占位族：无事件挂靠
type _NotificationFamily = Expect<
  Equal<TypeOfChannel<"notification">, "connection.welcome" | "connection.error">
>;
// 快照尾窗 additive 字段可选（AD-1 尾窗口径）
type _SnapshotTail = Expect<Equal<SessionSnapshotDto["tail"], EntryDto[] | undefined>>;
type _SnapshotTotalEntries = Expect<Equal<SessionSnapshotDto["totalEntries"], number | undefined>>;
type _SnapshotTailStartCursor = Expect<Equal<SessionSnapshotDto["tailStartCursor"], string | null | undefined>>;
// per-instance channel 历史分组（F-14⑤：不随尾窗截断）
type _InstanceChannels = Expect<Equal<AgentInstanceDto["channels"], InstanceChannelHistory | undefined>>;
// compaction 扩字段（命名定稿：tailKept / filesCompacted）
type _CompactionTailKept = Expect<Equal<CompactionCompletedPayload["tailKept"], number | undefined>>;
type _CompactionFilesCompacted = Expect<Equal<CompactionCompletedPayload["filesCompacted"], number | undefined>>;

// ── v0.3 类型级断言（契约 = PROTOCOL.md §12；三合一 additive） ──
// CL-1 spawn 锚点：可选 string | null（null = 流首有效值；缺省 = 主实例不携带）
type _InstanceAnchorOptional = Expect<
  Equal<AgentInstanceDto["anchorEntryId"], string | null | undefined>
>;
type _SpawnedAnchorOptional = Expect<
  Equal<AgentSpawnedPayload["anchorEntryId"], string | null | undefined>
>;
// CL-2 subscribe payload 换 SessionSubscribePayload（tier 二值可选；缺省 full）
type _SubscribeTierDomain = Expect<
  Equal<SessionSubscribePayload["tier"], "full" | "monitor" | undefined>
>;
type _SubscribePayloadSwapped = Expect<
  Equal<SessionSubscribeCommand["payload"], SessionSubscribePayload>
>;
type _UnsubscribePayloadKeptEmpty = Expect<
  Equal<SessionUnsubscribeCommand["payload"], EmptyPayload>
>;
// CL-3 steer 定向寻址：可选 instanceId（缺省 = 主实例）
type _SteerInstanceOptional = Expect<
  Equal<ChatSteerPayload["instanceId"], string | undefined>
>;
// ④ 版本位批次标记："0.4"（typeof PROTOCOL_VERSION 单值；FrameVersion / hello 联动见上）
type _ProtocolVersionV03 = Expect<Equal<typeof PROTOCOL_VERSION, "0.4">>;

// 负向断言：tool-call 变体不携带 steerState（仅 chat.steer 用户消息变体）
// @ts-expect-error steerState 不存在于 ToolCallEntryDto
const badToolEntry: ToolCallEntryDto = { kind: "tool-call", id: "x", name: "n", args: "{}", state: "done", ts: 1, steerState: "queued" };
// 负向断言：v 位不接受目录外版本（0/"0.4" 之外）
// @ts-expect-error v 位必须是 FrameVersion（0 | "0.4"）
const badVersion: HelloCommand = { v: 1, type: "hello", payload: { token: "t", protocolVersion: "0.4" } };
// 负向断言（v0.2 起保持）：hello 协商位不接受 v0 数值（严格 "0.4" 单值）
// @ts-expect-error protocolVersion 必须是 "0.4"
const badHelloLegacy: HelloCommand = { v: "0.4", type: "hello", payload: { token: "t", protocolVersion: 0 } };
// 负向断言（v0.3）：tier 只接受 full | monitor 两档
// @ts-expect-error tier 目录外字面量
const badTier: SessionSubscribeCommand = { v: PROTOCOL_VERSION, sessionId: "s", type: "session.subscribe", payload: { tier: "lite" } };
// 负向断言（v0.3）：unsubscribe 不接受 tier（保持 EmptyPayload 不动）
// @ts-expect-error unsubscribe payload 仍为 EmptyPayload
const badUnsubscribeTier: SessionUnsubscribeCommand = { v: PROTOCOL_VERSION, sessionId: "s", type: "session.unsubscribe", payload: { tier: "monitor" } };
// 负向断言（v0.3）：anchorEntryId 必须是 string | null
// @ts-expect-error anchorEntryId 不接受数值
const badAnchor: AgentInstanceDto = { instanceId: "agent-1", kind: "subagent", profileKind: "subagent-worker", state: "running", createdAt: "t", anchorEntryId: 12 };
// 负向断言（v0.3）：steer instanceId 必须是 string
// @ts-expect-error instanceId 不接受数值
const badSteerTarget: ChatSteerCommand = { v: PROTOCOL_VERSION, sessionId: "s", type: "chat.steer", payload: { text: "t", instanceId: 3 } };
// 负向断言（v0.2）：thinking 变体不携带 steerState
// @ts-expect-error steerState 不存在于 ThinkingEntryDto
const badThinkingEntry: ThinkingEntryDto = { kind: "thinking", id: "x", instanceId: "main", text: "t", durationMs: 1, reasoningTokens: 1, createdAt: "t", steerState: "queued" };
// 负向断言（v0.1）：usage.source 只接受 turn|compaction
// @ts-expect-error source 不接受其他字面量
const badSource: UsageRecordedPayload = { instanceId: "main", usage: sampleUsage, source: "stream" };
// 负向断言（v0.2）：channel 字面量与事件类型不符（session.list_changed 归 session 族）
// @ts-expect-error channel 必须是 "session"
const badChannel: SessionListChangedEvent = { v: "0.4", sessionId: "s", channel: "chat", type: "session.list_changed", payload: { kind: "created" } };
// 负向断言（v0.2）：session.loadHistory 缺游标
// @ts-expect-error beforeEntryId 必填
const badLoadHistory: SessionLoadHistoryCommand = { v: "0.4", sessionId: "s", type: "session.loadHistory", payload: {} };
// 负向断言（v0.2）：auth.set_key 缺 apiKey
// @ts-expect-error apiKey 必填
const badSetKey: AuthSetKeyCommand = { v: "0.4", type: "auth.set_key", payload: { providerId: "moonshot" } };

// ── 运行时断言 ────────────────────────────────────────────────
describe("TP-CL2-① 样例帧构造（契约 §2–§6）", () => {
  test("hello/welcome/snapshot/delta/工具卡/steer 徽标样例帧结构正确", () => {
    expect(helloFrame.v).toBe("0.4");
    expect(helloFrame.type).toBe("hello");
    expect(helloFrame.payload.token).toBe("dev-token-xyz");
    expect(helloFrame.payload.protocolVersion).toBe("0.4");

    const byType = new Map(legacyEvents.map((e) => [e.type, e] as const));
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

  test("v0.2 会话路由位：会话作用域命令携带信封 sessionId（AD-4）", () => {
    expect(chatSendRouted.sessionId).toBe("sess-1");
    expect(chatSendPlain.sessionId).toBeUndefined(); // 全局/未路由仍合法（可选）
  });
});

describe("TP-CL2-③ 命令/事件目录完备性（契约 §4/§5）", () => {
  test("命令目录恰为 22 个 type（v0 5 + v0.1 3 + v0.2 13 + v0.4 1）", () => {
    expect([...COMMAND_TYPES].sort()).toEqual(
      [
        "agent.kill",
        "agent.subscribe",
        "agent.unsubscribe",
        "auth.delete_key",
        "auth.list",
        "auth.set_key",
        "auth.verify",
        "chat.abort",
        "chat.send",
        "chat.steer",
        "model.catalog",
        "model.catalog_refresh",
        "model.get",
        "model.get_default",
        "model.set",
        "model.set_default",
        "session.delete",
        "session.list",
        "session.loadHistory",
        "session.subscribe",
        "session.unsubscribe",
        "trace.query",
      ],
    );
  });

  test("事件目录恰为 40 个 type（v0 12 + v0.1 11 + 热修 1 + v0.2 2 + T2.2 命令结果 2 + 微批结果帧 9 + v0.4 3）", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "agent.completed",
        "agent.failed",
        "agent.instantiated",
        "agent.killed",
        "agent.model.changed",
        "agent.queued",
        "agent.spawned",
        "agent.stalled",
        "agent.started",
        "agent.state.changed",
        "auth.delete_key.result",
        "auth.list.result",
        "auth.set_key.result",
        "auth.verify.result",
        "chat.message.completed",
        "chat.stream.delta",
        "chat.turn.completed",
        "chat.turn.started",
        "compaction.completed",
        "connection.error",
        "connection.welcome",
        "engine.error",
        "model.catalog.result",
        "model.catalog_refresh.result",
        "model.changed",
        "model.get.result",
        "model.get_default.result",
        "model.set_default.result",
        "session.list.result",
        "session.list_changed",
        "session.loadHistory.result",
        "session.snapshot",
        "steer.drained",
        "steer.queued",
        "thinking.completed",
        "thinking.stream.delta",
        "tool.call.result",
        "tool.call.started",
        "trace.query.result",
        "usage.recorded",
      ],
    );
  });

  test("全部 22 个命令信封可构造且可分发（含 v0.3/v0.4 扩展形态）", () => {
    const out = [...legacyCommands, ...v01Commands, ...v02Commands, ...v03Commands, ...v04Commands].map(dispatchCommand);
    expect(out).toEqual([
      "send:hi",
      "steer:改用方案 B:main",
      "abort",
      "subscribe:-:full", // v0 历史帧：不带信封 sessionId / tier 仍合法（可选缺省）
      "unsubscribe",
      "kill:agent-2",
      "agent-sub:agent-2",
      "agent-unsub:agent-2",
      // v0.2 样例
      "send:发给 sess-1",
      "session-list",
      "load-history:sess-1:e1:50", // limit 缺省 50（G-1）
      "load-history:sess-1:e1:100",
      "session-delete:sess-1",
      "subscribe:sess-1:full", // v0.2 信封 sessionId 路由 + v0.3 tier 缺省 full
      "model-set:sess-1:moonshot/kimi-k2",
      "model-get:sess-1",
      "model-catalog",
      "model-catalog-refresh",
      "model-set-default:moonshot/kimi-k2",
      "model-get-default",
      "auth-list",
      "auth-set-key:moonshot",
      "auth-delete-key:moonshot",
      "auth-verify:moonshot",
      // v0.3 样例（tier / instanceId 扩展形态）
      "subscribe:sess-1:monitor",
      "subscribe:sess-1:full",
      "steer:定向注入 agent-1:agent-1",
      // v0.4 样例（trace.query 全过滤维 / 全缺省）
      "trace-query:sess-1:2:100:428",
      "trace-query:sess-1:all:50:-",
    ]);
  });

  test("全部 35 个事件信封可构造且窄化分发正确", () => {
    const out = [...legacyEvents, ...v01Events, ...v02Events, ...v02ResultEvents].map(summarizeEvent);
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
      "engine-error:429: 已达到 5 小时的使用上限",
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
      "compaction:cp-1:340000:20000:-:-", // v0.1 帧不带扩字段（additive 兼容）
      "usage:main:11640:turn",
      // v0.2 新增
      "list-changed:created:sess-1:streaming",
      "model-changed:sess-1:moonshot/kimi-k2:kimi-k2:next-turn",
      // 微批 9 结果帧（T2.3-result-frames）
      "model-get-result:moonshot/kimi-k2:false:anthropic/claude-sonnet-4-5",
      "model-catalog-result:1:builtin",
      "model-catalog-refresh-result:1:builtin:1",
      "model-set-default-result:anthropic/claude-sonnet-4-5",
      "model-get-default-result:anthropic/claude-sonnet-4-5",
      "auth-list-result:1:true",
      "auth-set-key-result:····7f3a",
      "auth-delete-key-result",
      "auth-verify-result:fail:provider \"moonshot\" 未录入 API key",
    ]);
  });
});

describe("TP-CL2-④ EntryDto 判别式联合（契约 §6）", () => {
  test("switch(entry.kind) 四分支窄化：steerState 仅 message 变体", () => {
    expect(snapshot.entries.map(describeEntry)).toEqual([
      "msg:user:跑一下单测",
      "msg:user:先别动，改用方案 B:queued",
      "tool:run_tests:done:1200ms",
    ]);
    // 负向样例由上方 @ts-expect-error 在编译期守护
    expect(badToolEntry.state).toBe("done");
    expect(badVersion.payload.protocolVersion).toBe("0.4");
    expect(badHelloLegacy.type).toBe("hello");
  });
});

describe("TP-CL2-② 信封版本位与常量（v0.2 bump）", () => {
  test("PROTOCOL_VERSION = \"0.4\"；当前批帧 v 位全为 \"0.4\"，历史帧 v=0 合法（兼容读）", () => {
    expect(PROTOCOL_VERSION).toBe("0.4");
    for (const frame of [...v02Events, ...v02ResultEvents, ...v02Commands, ...v03Commands, ...v03Events, helloFrame]) {
      expect(frame.v).toBe("0.4");
    }
    for (const frame of [...legacyEvents, ...legacyCommands, ...v01Commands, ...v01Events]) {
      expect(frame.v).toBe(0); // v0/v0.1 历史帧：FrameVersion 取值域内合法
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
    expect(
      completed?.type === "agent.completed" && completed.payload.closure.reportPath,
    ).toBeNull();

    const failed = byType.get("agent.failed");
    expect(
      failed?.type === "agent.failed" && failed.payload.error,
    ).toBe("provider 5xx");

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

    const compaction = byType.get("compaction.completed");
    expect(
      compaction?.type === "compaction.completed" &&
        compaction.payload.entry.kind === "compaction" &&
        [compaction.payload.entry.tokensBefore, compaction.payload.entry.tokensAfter],
    ).toEqual([340_000, 20_000]);

    const usage = byType.get("usage.recorded");
    expect(
      usage?.type === "usage.recorded" && usage.payload.source,
    ).toBe("turn");
  });

  test("信封 instanceId：事件侧可携带；缺省 = 主实例（AD-3）", () => {
    expect(subAgentDelta.instanceId).toBe("agent-1");
    expect(legacyEvents[0]?.instanceId).toBeUndefined();
  });
});

describe("TP-v0.1-② EntryDto 四成员与快照 additive 字段（契约 §6）", () => {
  test("switch(entry.kind) 四分支窄化：thinking/compaction 变体可描述", () => {
    expect(snapshotV01.entries.map(describeEntry)).toEqual([
      "msg:assistant:委托完成",
      "thinking:main:900",
      "compaction:main:340000:20000:0.0213",
    ]);
    expect(badThinkingEntry.kind).toBe("thinking");
    expect(badSource.usage.cost).toBe(0.0213);
  });

  test("快照 instances/usage 结构正确（重启恢复骨架）", () => {
    const instances = snapshotV01.instances;
    expect(instances?.length).toBe(3);
    const [main, doneSub, queuedSub] = instances ?? [];
    expect(main?.instanceId).toBe("main");
    expect(main?.queuedPosition).toBeUndefined();
    expect(queuedSub?.state).toBe("queued");
    expect(queuedSub?.queuedPosition).toBe(2);
    expect(snapshotV01.usage?.total.totalTokens).toBe(11_640);
    expect(snapshotV01.tail).toBeUndefined(); // v0.1 快照不带尾窗字段仍合法
  });
});

// ── v0.2 运行时断言（契约 A/B/C） ─────────────────────────────
describe("TP-v0.2-① 常量导出与信封分型（契约 A §1/§3）", () => {
  test("PROTOCOL_VERSION / MAIN_INSTANCE_ID / SYSTEM_SESSION_ID 导出就位", () => {
    expect(PROTOCOL_VERSION).toBe("0.4");
    // 常量断言经模块命名空间在 exports.test.ts 全量守护，此处锚定语义值
    expect(typeof PROTOCOL_VERSION).toBe("string");
  });

  test("v0.2 事件信封：sessionId + channel 章印；命令信封：sessionId 路由位", () => {
    expect(listChangedV02.channel).toBe("session");
    expect(listChangedV02.sessionId).toBe("__system__"); // 系统级事件占位
    expect(modelChangedV02.channel).toBe("model");
    expect(modelChangedV02.payload.effective).toBe("next-turn");
    expect(chatSendRouted.sessionId).toBe("sess-1");
  });

  test("compaction 扩字段（tailKept / filesCompacted，命名定稿）", () => {
    expect(compactionCompletedV02.payload.tailKept).toBe(30);
    expect(compactionCompletedV02.payload.filesCompacted).toBe(12);
    const legacy = v01Events.find((e) => e.type === "compaction.completed") as CompactionCompletedEvent;
    expect(legacy.payload.tailKept).toBeUndefined(); // v0.1 帧不带仍合法（additive）
  });
});

describe("TP-v0.2-② 八族类型学与登记目录（契约 A §2）", () => {
  test("switch(channel) 分族窄化：各族 type 联合窄化正确（占位族不可达）", () => {
    expect(familyOf(v02Events[0]!)).toBe("session/session.list_changed");
    expect(familyOf(v02Events[1]!)).toBe("model/model.changed");
    expect(familyOf(legacyEvents[0]!)).toBe("legacy/connection.welcome"); // 兼容读缺省路径
    expect(familyOf(compactionCompletedV02)).toBe("compaction/compaction.completed");
    expect(familyOf(traceQueryResult)).toBe("trace/trace.query.result"); // v0.4 新族窄化
  });

  test("EVENT_CHANNELS 登记目录与契约 A §2 映射表恰等", () => {
    expect(Object.keys(EVENT_CHANNELS).sort()).toEqual([...EVENT_TYPES].sort());
    const roster = (c: string): string[] =>
      [...EVENT_TYPES].filter((t) => EVENT_CHANNELS[t] === c).sort();
    expect(roster("chat")).toEqual(
      [
        "agent.state.changed",
        "chat.message.completed",
        "chat.stream.delta",
        "chat.turn.completed",
        "chat.turn.started",
        "engine.error",
        "steer.drained",
        "steer.queued",
        "tool.call.result",
        "tool.call.started",
      ],
    );
    expect(roster("agent")).toEqual([
      "agent.completed",
      "agent.failed",
      "agent.instantiated",
      "agent.killed",
      "agent.model.changed",
      "agent.queued",
      "agent.spawned",
      "agent.stalled",
      "agent.started",
    ]);
    expect(roster("thinking")).toEqual(["thinking.completed", "thinking.stream.delta"]);
    expect(roster("usage")).toEqual(["usage.recorded"]);
    expect(roster("compaction")).toEqual(["compaction.completed"]);
    expect(roster("session")).toEqual([
      "session.list.result",
      "session.list_changed",
      "session.loadHistory.result",
      "session.snapshot",
    ]);
    expect(roster("model")).toEqual([
      "auth.delete_key.result",
      "auth.list.result",
      "auth.set_key.result",
      "auth.verify.result",
      "model.catalog.result",
      "model.catalog_refresh.result",
      "model.changed",
      "model.get.result",
      "model.get_default.result",
      "model.set_default.result",
    ]);
    expect(roster("interaction")).toEqual([]); // 占位族：无事件挂靠
    expect(roster("trace")).toEqual(["trace.query.result"]); // v0.4 新族（点对点结果帧）
    expect(roster("notification")).toEqual(["connection.error", "connection.welcome"]);
  });
});

describe("TP-v0.2-③ 快照尾窗 additive 字段（契约 B §2.2，AD-1）", () => {
  test("tail / totalEntries / tailStartCursor / instances[].channels 可携带可缺省", () => {
    expect(snapshotV02.tail?.length).toBe(2);
    expect(snapshotV02.totalEntries).toBe(128);
    expect(snapshotV02.tailStartCursor).toBe("m1");
    const agent0 = snapshotV02.instances?.find((i) => i.instanceId === "agent-0");
    expect(agent0?.channels?.thinking?.length).toBe(1); // F-14⑤：不随尾窗截断
    expect(agent0?.channels?.messages?.length).toBe(1);
    expect(snapshot.instances).toBeUndefined(); // v0 快照不带仍合法
  });
});

// ── v0.3 运行时断言（契约 = PROTOCOL.md §12） ──────────
describe("TP-v0.3-① 三合一 additive 字段形态（契约 v0.3 §1/§2/§3）", () => {
  test("CL-1 anchorEntryId：agent.spawned 增量帧携带锚（string / null 流首）", () => {
    expect(spawnedAnchored.channel).toBe("agent");
    expect(
      spawnedAnchored.type === "agent.spawned" && spawnedAnchored.payload.anchorEntryId,
    ).toBe("e12");
    expect(
      spawnedStreamHead.type === "agent.spawned" && spawnedStreamHead.payload.anchorEntryId,
    ).toBeNull(); // null = 流首锚点（有效值，非缺失）
  });

  test("CL-1 anchorEntryId：instances DTO 快照面同源供给（主实例缺省不携带）", () => {
    expect(instanceAnchored.anchorEntryId).toBe("e12");
    expect(instanceMainNoAnchor.anchorEntryId).toBeUndefined(); // kind=main：无卡片无锚
    expect(instanceMainNoAnchor.kind).toBe("main");
  });

  test("CL-2 tier：monitor / 缺省 full 两形态；unsubscribe payload 保持空不动", () => {
    expect(subscribeMonitor.payload.tier).toBe("monitor");
    expect(subscribeTierDefault.payload.tier).toBeUndefined(); // 缺省 = full（既有语义不变）
    expect(unsubscribeUnchanged.payload).toEqual({}); // EmptyPayload 不动
    expect(unsubscribeUnchanged.sessionId).toBe("sess-1"); // 信封路由位不变
  });

  test("CL-3 instanceId：定向寻址 / 缺省主实例两形态（dispatch 窄化消费）", () => {
    expect(steerTargeted.payload.instanceId).toBe("agent-1");
    expect(steerMainDefault.payload.instanceId).toBeUndefined(); // 缺省 = 主实例
    expect(dispatchCommand(steerTargeted)).toBe("steer:定向注入 agent-1:agent-1");
    expect(dispatchCommand(steerMainDefault)).toBe("steer:主实例缺省路径:main");
  });

  test("负向样例仅以 @ts-expect-error 守护（运行时字面量回读，读取侧宽化转型）", () => {
    expect((badTier.payload as Record<string, unknown>).tier).toBe("lite");
    expect((badUnsubscribeTier.payload as Record<string, unknown>).tier).toBe("monitor");
    expect(badAnchor.anchorEntryId as unknown).toBe(12);
    expect((badSteerTarget.payload as unknown as Record<string, unknown>).instanceId).toBe(3);
  });
});

describe("TP-v0.3-② 版本位 bump 与目录计数（v0.4 批次升位收口，T3.2）", () => {
  test("PROTOCOL_VERSION = \"0.4\"；hello 协商位单值联动；当前批帧 v 位全 \"0.4\"", () => {
    expect(PROTOCOL_VERSION).toBe("0.4");
    expect(helloFrame.payload.protocolVersion).toBe("0.4");
    for (const frame of [...v03Commands, ...v03Events]) {
      expect(frame.v).toBe("0.4");
    }
    for (const frame of v03Events) {
      expect(frame.channel).toBe("agent"); // 增量帧仍走 agent 族（零新增事件类型）
    }
  });

  test("v0.4 目录计数：EVENT_TYPES 40 / EVENT_CHANNELS 40 键 / COMMAND_TYPES 22（trace 族 + agent 执行上下文面）", () => {
    expect(EVENT_TYPES.length).toBe(40); // v0.4：+3（trace.query.result / agent.instantiated / agent.model.changed）
    expect(new Set(EVENT_TYPES).size).toBe(40); // 无重复
    expect(Object.keys(EVENT_CHANNELS).length).toBe(40); // 登记目录恰等
    expect(COMMAND_TYPES.length).toBe(22); // v0.4：+1（trace.query）
  });
});

describe("TP-v0.4-① trace 命令族 + agent 执行上下文面样例帧（契约 v0.4）", () => {
  test("trace.query 命令两形态（全过滤维 / 全缺省）经 dispatchCommand 窄化", () => {
    expect(v04Commands.map(dispatchCommand)).toEqual([
      "trace-query:sess-1:2:100:428",
      "trace-query:sess-1:all:50:-",
    ]);
  });

  test("trace.query.result / agent.instantiated / agent.model.changed 经 summarizeEvent 窄化", () => {
    expect(v04Events.map(summarizeEvent)).toEqual([
      "trace-result:1:1:1:12:false",
      "instantiated:agent-1:subagent-worker:zai/glm-5.3",
      "model-timeline:main:zhipu/glm-4.6:deepseek/deepseek-chat",
    ]);
  });

  test("v0.4 帧 v 位与 channel 章印（trace 新族 / agent 族挂两新事件）", () => {
    for (const frame of [...v04Commands, ...v04Events]) {
      expect(frame.v).toBe("0.4"); // T3.2 统一升位 v0.4（批次集合标记）
    }
    expect(traceQueryResult.channel).toBe("trace");
    expect(agentInstantiated.channel).toBe("agent");
    expect(agentModelChanged.channel).toBe("agent");
    expect(EVENT_CHANNELS["trace.query.result"]).toBe("trace");
    expect(EVENT_CHANNELS["agent.instantiated"]).toBe("agent");
    expect(EVENT_CHANNELS["agent.model.changed"]).toBe("agent");
  });

  test("结果帧形状：filterEcho 缺省维归一 null + instances 面板块 + page 三字段", () => {
    if (traceQueryResult.type !== "trace.query.result") throw new Error("窄化失败");
    const p = traceQueryResult.payload;
    expect(p.filterEcho).toEqual({
      sessionId: "sess-1",
      instanceIds: null,
      agentKind: null,
      types: null,
      timeRange: null,
      page: { limit: 50, beforeId: null },
    });
    expect(p.instances[0]?.snapshotMissing).toBe(false);
    expect(p.instances[0]?.modelTimeline?.[0]?.to).toBe("deepseek/deepseek-chat");
    expect(p.instances[0]?.currentModel).toBe("deepseek/deepseek-chat");
    expect(p.events[0]?.id).toBe(428); // id 游标锚
    expect(p.page).toEqual({ loaded: 1, total: 12, hasMore: false });
  });
});

/**
 * 协议 v0.1 帧构造器（e2e 剧本回放用；T4.4 扩：v0.1 事件/DTO 全集）。
 *
 * 全部形状直接 import @helix/protocol 源类型（AG-13 两端同源；契约等价
 * mock —— mock 帧与真实 daemon 帧不得漂移，TS 类型即守护；TR-TEST-3 纪律②）。
 */
import type {
  AgentInstanceDto,
  AgentStateDto,
  CatalogModel,
  ChatRole,
  ClosureDto,
  CompactionEntryDto,
  EntryDto,
  EventEnvelope,
  MessageEntryDto,
  ModelChangedEvent,
  SessionListChangedEvent,
  SessionListResultEvent,
  SessionLoadHistoryResultEvent,
  SessionMeta,
  SessionSnapshotDto,
  SessionUsageDto,
  SteerState,
  ThinkingEntryDto,
  ToolCallEntryDto,
  ToolCallState,
  UsageDto,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";

/** 帧版本位单点（F-2⑭ 收口：v0.2 起改引协议常量，零字面量） */
const V = PROTOCOL_VERSION;

// ── entry 构造 ──────────────────────────────────────────────

export function msgEntry(
  id: string,
  role: ChatRole,
  content: string,
  opts: { ts?: number; steerState?: SteerState; instanceId?: string } = {},
): MessageEntryDto {
  return {
    kind: "message",
    id,
    role,
    content,
    ts: opts.ts ?? Date.now(),
    ...(opts.steerState ? { steerState: opts.steerState } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

export function toolEntry(
  id: string,
  name: string,
  args: string,
  state: ToolCallState,
  opts: { result?: string; durationMs?: number; ts?: number; instanceId?: string } = {},
): ToolCallEntryDto {
  return {
    kind: "tool-call",
    id,
    name,
    args,
    state,
    ts: opts.ts ?? Date.now(),
    ...(opts.result !== undefined ? { result: opts.result } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

// ── 事件帧构造（S→C）────────────────────────────────────────

export function welcome(
  opts: { sessionId?: string; model?: string; agentState?: AgentStateDto } = {},
): EventEnvelope {
  return {
    v: V,
    type: "connection.welcome",
    payload: {
      sessionId: opts.sessionId ?? "sess-e2e",
      model: opts.model ?? "claude-sonnet-4-5",
      agentState: opts.agentState ?? "idle",
    },
  };
}

export function snapshot(
  entries: EntryDto[],
  opts: {
    model?: string;
    agentState?: AgentStateDto;
    /** v0.1 additive：实例清单（卡片/channel/账目行重建） */
    instances?: AgentInstanceDto[];
    /** v0.1 additive：账目聚合（徽标/popover 重建权威） */
    usage?: SessionUsageDto;
  } = {},
): EventEnvelope {
  const snap: SessionSnapshotDto = {
    sessionId: "sess-e2e",
    model: opts.model ?? "claude-sonnet-4-5",
    agentState: opts.agentState ?? "idle",
    revision: entries.length,
    entries,
    ...(opts.instances !== undefined ? { instances: opts.instances } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
  return { v: V, type: "session.snapshot", payload: { snapshot: snap } };
}

export function streamDelta(
  messageId: string,
  delta: string,
  opts: { instanceId?: string } = {},
): EventEnvelope {
  return {
    v: V,
    type: "chat.stream.delta",
    payload: { messageId, delta },
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

export function messageCompleted(entry: MessageEntryDto, opts: { instanceId?: string } = {}): EventEnvelope {
  return {
    v: V,
    type: "chat.message.completed",
    payload: { entry },
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

export function steerQueued(entryId: string): EventEnvelope {
  return { v: V, type: "steer.queued", payload: { entryId } };
}

export function steerDrained(entryId: string): EventEnvelope {
  return { v: V, type: "steer.drained", payload: { entryId } };
}

export function toolStarted(entry: ToolCallEntryDto): EventEnvelope {
  return { v: V, type: "tool.call.started", payload: { entry } };
}

export function toolResult(entry: ToolCallEntryDto): EventEnvelope {
  return { v: V, type: "tool.call.result", payload: { entry } };
}

export function agentStateChanged(state: AgentStateDto): EventEnvelope {
  return { v: V, type: "agent.state.changed", payload: { state } };
}

// ── v0.1 DTO 构造（剧本数据纪律 test-design §4.3：全字段必发）────

/** ClosureDto 五字段（缺失字段显式 null，不省略 key）。 */
export function closure(
  status: "done" | "failed",
  summary: string,
  opts: { reportPath?: string | null; findings?: unknown[] | null; taskId?: string | null } = {},
): ClosureDto {
  return {
    status,
    summary,
    reportPath: opts.reportPath ?? null,
    findings: opts.findings ?? null,
    taskId: opts.taskId ?? null,
  };
}

/** UsageDto 七字段全发（cost 拍平 number；未指定字段缺省 0，key 不省略）。 */
export function usageDto(
  totalTokens: number,
  cost: number,
  opts: Partial<Omit<UsageDto, "totalTokens" | "cost">> = {},
): UsageDto {
  return {
    input: opts.input ?? 0,
    output: opts.output ?? 0,
    cacheRead: opts.cacheRead ?? 0,
    cacheWrite: opts.cacheWrite ?? 0,
    reasoning: opts.reasoning ?? 0,
    totalTokens,
    cost,
  };
}

/** ThinkingEntryDto（完成态全文；durationMs/reasoningTokens 驱动折叠条文案）。 */
export function thinkingEntry(
  id: string,
  text: string,
  opts: { instanceId?: string; durationMs?: number; reasoningTokens?: number; createdAt?: string } = {},
): ThinkingEntryDto {
  return {
    kind: "thinking",
    id,
    instanceId: opts.instanceId ?? "main",
    text,
    durationMs: opts.durationMs ?? 3_000,
    reasoningTokens: opts.reasoningTokens ?? 1_200,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/** CompactionEntryDto（usage 七字段必发；tokensBefore/After 驱动里程碑条文案）。 */
export function compactionEntry(
  id: string,
  opts: {
    instanceId?: string;
    tokensBefore?: number;
    tokensAfter?: number;
    summary?: string;
    usage?: UsageDto;
    createdAt?: string;
  } = {},
): CompactionEntryDto {
  return {
    kind: "compaction",
    id,
    instanceId: opts.instanceId ?? "main",
    tokensBefore: opts.tokensBefore ?? 340_000,
    tokensAfter: opts.tokensAfter ?? 20_000,
    summary: opts.summary ?? "会话上下文已压缩：保留最近任务的关键结论与工具产出。",
    usage: opts.usage ?? usageDto(1_800, 0.02),
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/** AgentInstanceDto（快照实例清单；main/subagent + 状态/账目/closure）。 */
export function agentInstance(
  instanceId: string,
  opts: {
    kind?: "main" | "subagent";
    profileKind?: string;
    state?: AgentInstanceDto["state"];
    task?: string;
    model?: string;
    queuedPosition?: number;
    closure?: ClosureDto;
    usage?: UsageDto;
  } = {},
): AgentInstanceDto {
  return {
    instanceId,
    kind: opts.kind ?? "subagent",
    profileKind: opts.profileKind ?? "subagent-worker",
    state: opts.state ?? "running",
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.queuedPosition !== undefined ? { queuedPosition: opts.queuedPosition } : {}),
    ...(opts.closure !== undefined ? { closure: opts.closure } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    createdAt: new Date().toISOString(),
  };
}

// ── v0.1 事件帧构造（编排生命周期族 + 通道族；契约 §5）──────

export function agentSpawned(
  agentId: string,
  task: string,
  opts: { profileKind?: string; model?: string } = {},
): EventEnvelope {
  return {
    v: V,
    type: "agent.spawned",
    payload: {
      agentId,
      task,
      profileKind: opts.profileKind ?? "subagent-worker",
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    },
  };
}

export function agentQueued(agentId: string, position: number): EventEnvelope {
  return { v: V, type: "agent.queued", payload: { agentId, position } };
}

export function agentStarted(agentId: string): EventEnvelope {
  return { v: V, type: "agent.started", payload: { agentId } };
}

export function agentStalled(agentId: string, idleMs: number): EventEnvelope {
  return { v: V, type: "agent.stalled", payload: { agentId, idleMs } };
}

export function agentCompleted(agentId: string, closureDto: ClosureDto): EventEnvelope {
  return { v: V, type: "agent.completed", payload: { agentId, closure: closureDto } };
}

export function agentFailed(agentId: string, error: string, closureDto: ClosureDto): EventEnvelope {
  return { v: V, type: "agent.failed", payload: { agentId, error, closure: closureDto } };
}

export function agentKilled(agentId: string, closureDto: ClosureDto): EventEnvelope {
  return { v: V, type: "agent.killed", payload: { agentId, closure: closureDto } };
}

export function thinkingDelta(instanceId: string, delta: string): EventEnvelope {
  return { v: V, type: "thinking.stream.delta", payload: { instanceId, delta } };
}

export function thinkingCompleted(entry: ThinkingEntryDto): EventEnvelope {
  return { v: V, type: "thinking.completed", payload: { entry } };
}

export function compactionCompleted(entry: CompactionEntryDto): EventEnvelope {
  return { v: V, type: "compaction.completed", payload: { entry } };
}

export function usageRecorded(
  instanceId: string,
  usage: UsageDto,
  source: "turn" | "compaction" = "turn",
): EventEnvelope {
  return { v: V, type: "usage.recorded", payload: { instanceId, usage, source } };
}

// ── v0.2 多会话/模型族构造（T3.1；信封 sessionId/channel 章印与 daemon 下发侧同构）──

/** 会话清单元数据（session.list / list_changed 元素；契约 B §1.1）。 */
export function sessionMeta(
  sessionId: string,
  opts: { title?: string; lastActivityAt?: number; runState?: SessionMeta["runState"]; loaded?: boolean } = {},
): SessionMeta {
  return {
    sessionId,
    title: opts.title ?? sessionId,
    lastActivityAt: opts.lastActivityAt ?? 1_000,
    runState: opts.runState ?? "idle",
    loaded: opts.loaded ?? true,
  };
}

/** session.list.result（点对点回执；信封 sessionId = SYSTEM_SESSION_ID）。 */
export function sessionListResult(sessions: SessionMeta[]): SessionListResultEvent {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "session",
    type: "session.list.result",
    payload: { sessions },
  };
}

/** session.list_changed（系统级广播；契约 B §2.1）。 */
export function sessionListChanged(
  kind: "created" | "deleted" | "state_changed",
  opts: { sessionId?: string; session?: SessionMeta } = {},
): SessionListChangedEvent {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "session",
    type: "session.list_changed",
    payload: { kind, ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}), ...(opts.session !== undefined ? { session: opts.session } : {}) },
  };
}

/**
 * v0.2 尾窗快照（AD-1，契约 B §2.2）：信封章印 + 尾窗分页指示
 * （totalEntries/tailStartCursor）+ 可选 instances[].channels（F-14⑤）。
 */
export function v02Snapshot(
  sessionId: string,
  opts: {
    model?: string;
    agentState?: AgentStateDto;
    /** 主时间轴尾窗条目（快照 entries 与 tail 同源，契约 B §2.2） */
    tail?: EntryDto[];
    /** 全量计数（分页指示） */
    totalEntries?: number;
    /** 尾窗最早 entry id；null = 已含全部历史（禁用加载更早） */
    tailStartCursor?: string | null;
    instances?: AgentInstanceDto[];
    usage?: SessionUsageDto;
  } = {},
): EventEnvelope {
  const tail = opts.tail ?? [];
  const snap: SessionSnapshotDto = {
    sessionId,
    model: opts.model ?? "claude-sonnet-4-5",
    agentState: opts.agentState ?? "idle",
    revision: tail.length,
    entries: tail,
    tail,
    ...(opts.totalEntries !== undefined ? { totalEntries: opts.totalEntries } : {}),
    ...(opts.tailStartCursor !== undefined ? { tailStartCursor: opts.tailStartCursor } : {}),
    ...(opts.instances !== undefined ? { instances: opts.instances } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
  return {
    v: V,
    sessionId,
    channel: "session",
    type: "session.snapshot",
    payload: { snapshot: snap },
  };
}

/** session.loadHistory.result（点对点回执；信封 sessionId = 目标会话）。 */
export function loadHistoryResult(
  sessionId: string,
  payload: { entries: EntryDto[]; hasMore: boolean; nextCursor: string | null },
): SessionLoadHistoryResultEvent {
  return {
    v: V,
    sessionId,
    channel: "session",
    type: "session.loadHistory.result",
    payload,
  };
}

/** model.changed（运行期换模生效广播；契约 C §2.1）。 */
export function modelChanged(sessionId: string, model: string, previous: string): ModelChangedEvent {
  return {
    v: V,
    sessionId,
    channel: "model",
    type: "model.changed",
    payload: { sessionId, model, previous, effective: "next-turn" },
  };
}

// ── model / auth 命令结果帧（契约 C §1/§2.2；T3.3 P-3/P-4 剧本回放面）────
// 信封惯例：全局命令结果 sessionId = SYSTEM_SESSION_ID；model.get.result
// 例外（会话级——信封 sessionId = 目标会话，与 loadHistoryResult 同构）。

/** model.get.result（会话当前模型 + 与全局默认关系；信封 sessionId = 目标会话）。 */
export function modelGetResult(
  sessionId: string,
  payload: { model: string; isDefault: boolean; defaultModel: string },
): EventEnvelope {
  return { v: V, sessionId, channel: "model", type: "model.get.result", payload };
}

/** model.catalog.result（目录快照；4h 缓存口径）。 */
export function modelCatalogResult(
  models: CatalogModel[],
  opts: { refreshedAt?: number; source?: "cache" | "builtin" | "remote" } = {},
): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "model.catalog.result",
    payload: { models, refreshedAt: opts.refreshedAt ?? Date.now(), source: opts.source ?? "builtin" },
  };
}

/** model.catalog_refresh.result（强制刷新快照 + degraded 降级明细）。 */
export function modelCatalogRefreshResult(
  models: CatalogModel[],
  opts: { refreshedAt?: number; source?: "cache" | "builtin" | "remote"; degraded?: string[] } = {},
): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "model.catalog_refresh.result",
    payload: {
      models,
      refreshedAt: opts.refreshedAt ?? Date.now(),
      source: opts.source ?? "remote",
      degraded: opts.degraded ?? [],
    },
  };
}

/** model.get_default.result（全局默认读面；SQLite）。 */
export function modelGetDefaultResult(model: string): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "model.get_default.result",
    payload: { model },
  };
}

/** model.set_default.result（全局默认变更回执；previous = 变更前默认）。 */
export function modelSetDefaultResult(previous: string): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "model.set_default.result",
    payload: { previous },
  };
}

/** auth.list.result（provider 凭据清单；脱敏）。 */
export function authListResult(
  providers: { providerId: string; configured: boolean; keyMasked?: string; verifyStatus?: "ok" | "fail" | "unverified" }[],
): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "auth.list.result",
    payload: { providers },
  };
}

/** auth.set_key.result（写入回执；掩码形式）。 */
export function authSetKeyResult(keyMasked: string): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "auth.set_key.result",
    payload: { keyMasked },
  };
}

/** auth.delete_key.result（无数据体）。 */
export function authDeleteKeyResult(): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "auth.delete_key.result",
    payload: {},
  };
}

/** auth.verify.result（连通验证；fail 为正常结果非 error）。 */
export function authVerifyResult(
  result: { status: "ok"; latencyMs: number } | { status: "fail"; reason: string },
): EventEnvelope {
  return {
    v: V,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "auth.verify.result",
    payload: result,
  };
}

/** 后台会话流式帧（chat.stream.delta 带信封 sessionId 章印——未读跳动驱动面）。 */
export function backgroundStreamDelta(sessionId: string, messageId: string, delta: string): EventEnvelope {
  return {
    v: V,
    sessionId,
    channel: "chat",
    type: "chat.stream.delta",
    payload: { messageId, delta },
  };
}

/** 模型目录剧本数据构造（契约 C §1.2 CatalogModel 字段结构；P-3/P-4 载体）。 */
export function catalogModel(
  id: string,
  contextWindow: number,
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  source: "builtin" | "overlay" = "builtin",
): CatalogModel {
  const [providerId, ...rest] = id.split("/");
  return {
    id,
    providerId: rest.length > 0 ? providerId! : id,
    contextWindow,
    cost: {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    },
    source,
  };
}

// ── C→S 命令帧形状（断言 hello / chat.send / chat.steer / session.* 用）────

export interface ClientFrame {
  v: number;
  type: string;
  payload: unknown;
  /** 会话路由位（v0.2，AD-4）：会话作用域命令必填；全局命令缺省 */
  sessionId?: string;
}

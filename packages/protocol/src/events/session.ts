import type { EventFrame } from "../envelope";
import type {
  EntryDto,
  SessionMeta,
  SessionSnapshotDto,
} from "../types/session";
import type { TaskBatchLedgerDto, WorkItemDto } from "../types/task";
import type { InstanceChannelHistory } from "../types/agent";

// ── payload ──────────────────────────────────────────────────

/** session.snapshot：全量快照（握手后/重连后；AD-16 快照+增量；v0.2 尾窗口径 additive） */
export interface SessionSnapshotPayload {
  snapshot: SessionSnapshotDto;
}

/**
 * session.plan.changed：主会话工作台账变更广播（main-session plan 批）。
 * 触发：主会话 plan 三工具（plan_create/plan_update/plan_read）执行成功后
 * 由 daemon 装配层发布（信封 sessionId = 台账归属会话，per-session 订阅
 * 路由）；plan/ledger 复用 task 域批次 DTO 形状（WorkItemDto/
 * TaskBatchLedgerDto，对齐批次 DTO 口径），ledger 服务端从 plan 行组装
 * （前端零拼装）；无台账 = 双 null（null 语义与 task 批次行同构）。
 *
 * 实例台账增型（SubAgent 抽屉 plan 面）：instanceId 携带时该帧为 SubAgent
 * 实例台账——信封 sessionId 仍 = 归属会话（订阅路由维度），payload.
 * instanceId = 台账归属实例（agent-N）；缺省 = 主会话台账（instanceId 维度
 * = sessionId，既有口径零变化）。
 */
export interface SessionPlanChangedPayload {
  sessionId: string;
  /** 台账归属实例（agent-N）；缺省 = 主会话台账。观测链单源见 E-181。 */
  instanceId?: string;
  /** 台账全行（seq 升序）；null = 无台账。 */
  plan: WorkItemDto[] | null;
  /** 计数摘要（与 plan 同源同 null 语义）。 */
  ledger: TaskBatchLedgerDto | null;
}

// ── v0.2 新增 payload：session/model 族（契约 B §2 / 契约 C §2） ──

/**
 * session.list_changed：会话清单变化（v0.2 新增，AD-4）。
 *
 * 触发 → kind 映射（新增触发源先落本映射再实现）：
 * - created：首条消息建聚合 / 新会话入清单；
 * - deleted：会话删除；
 * - state_changed：运行态变化（idle↔streaming↔subagent_running）**与标题/
 *   主题更新**——标题演进复用 state_changed 出海，**无独立 kind**（要感知
 *   标题变化请读 payload.session 的 title，勿等新 kind）。
 *
 * sessionId 在 daemon 现实现**恒携带**；「列表级批量变化可省略」是类型层
 * 预留（当前零生产者）——消费端勿依赖省略形态；真要加批量生产者，先裁掉
 * 该可选位。
 */
export interface SessionListChangedPayload {
  kind: "created" | "deleted" | "state_changed";
  /** created/deleted/state_changed 均带；列表级批量变化可省略 */
  sessionId?: string;
  /** created/state_changed 携带最新元数据（同 session.list 元素形状） */
  session?: SessionMeta;
}

// ── 信封 ──────────────────────────────────────────────────

export interface SessionSnapshotEvent
  extends EventFrame<SessionSnapshotPayload> {
  channel?: "session";
  type: "session.snapshot";
}
export interface SessionListChangedEvent
  extends EventFrame<SessionListChangedPayload> {
  channel?: "session";
  type: "session.list_changed";
}
/** session.plan.changed 广播（main-session plan 批；信封 sessionId = 台账归属会话）。 */
export interface SessionPlanChangedEvent
  extends EventFrame<SessionPlanChangedPayload> {
  channel?: "session";
  type: "session.plan.changed";
}
/**
 * session.list.result：会话清单命令结果（v0.2 新增，契约 B §1.1 定稿）。
 * 点对点回执——仅发给发起 session.list 命令的连接（不经 EventStream 广播）；
 * 信封 sessionId = SYSTEM_SESSION_ID（全局命令，无会话归属）。
 */
export interface SessionListResultPayload {
  /** 按 lastActivityAt 降序 */
  sessions: SessionMeta[];
}
export interface SessionListResultEvent
  extends EventFrame<SessionListResultPayload> {
  channel?: "session";
  type: "session.list.result";
}
/**
 * session.loadHistory.result：分页历史命令结果（v0.2 新增，AD-1 定稿）。
 * 点对点回执——仅发给发起 session.loadHistory 命令的连接；信封 sessionId =
 * 目标会话 id。
 */
export interface SessionLoadHistoryResultEventPayload {
  /** beforeEntryId 之前的更早历史（时间升序） */
  entries: EntryDto[];
  hasMore: boolean;
  nextCursor: string | null;
}
export interface SessionLoadHistoryResultEvent
  extends EventFrame<SessionLoadHistoryResultEventPayload> {
  channel?: "session";
  type: "session.loadHistory.result";
}

/**
 * session.instanceChannels.result：实例通道历史按需拉取结果（channels
 * 惰性化批）。点对点回执——仅发给发起命令的连接；信封 sessionId = 目标
 * 会话 id。channels 三槽各自保最新分页；任一槽被字节预算裁 → truncated
 * 标记 + nextCursor 游标（ InstanceChannelHistory.truncated 语义同快照）。
 */
export interface SessionInstanceChannelsResultEventPayload {
  instanceId: string;
  /** 三槽分组（tools/messages/thinking），各自升序 */
  channels: InstanceChannelHistory;
  hasMore: boolean;
  /** 下页游标（任一槽仍有更早条目时 = 三槽最早 entry id）；无更早 = null */
  nextCursor: string | null;
}
export interface SessionInstanceChannelsResultEvent
  extends EventFrame<SessionInstanceChannelsResultEventPayload> {
  channel?: "session";
  type: "session.instanceChannels.result";
}

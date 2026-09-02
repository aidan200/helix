import type { SessionSnapshot } from "../../../domain/session/SessionSnapshot";
import type { AgentLifecycleState } from "../../../domain/agent/AgentLifecycle";
import type { InstanceState } from "../../../domain/agent/AgentInstance";
import type { DomainEvent, InstanceClosurePayload } from "../../../domain/events/DomainEvent";
import type { ToolCallRecordData } from "../../../domain/tools/ToolCallRecord";

export type { InstanceState };

/**
 * 领域状态持久化出口端口（outbound，architecture.md §3.4 / §5.2）。
 *
 * write-through 单写队列的出口：service 在每个里程碑领域事件后 save
 * 领域状态整体；恢复时 restore。真实实现在 adapters/driven/sqlite-session
 * （SQLite WAL + 单写队列）；单测用 InMemory 假实现（test/mocks）。
 * 本文件只有接口/类型定义（AG-01）。
 */

/**
 * 持久化对象 = 领域状态整体（标准 1，AD-16）：会话聚合快照 +
 * agent 生命周期状态 + 工具调用记录（steer 队列在会话快照 pendingSteer 内）。
 * 纯数据值对象——充血聚合的重建在 domain（Session.restoreFrom /
 * ToolCallRecord.restore），贫血↔贫血转换在 sqlite-session 适配器。
 */
export interface PersistedDomainState {
  readonly session: SessionSnapshot;
  readonly agentState: AgentLifecycleState;
  readonly toolCalls: readonly ToolCallRecordData[];
}

export interface SessionRepositoryPort {
  /** 保存领域状态整体（幂等覆盖，同 sessionId）。 */
  save(state: PersistedDomainState): Promise<void>;
  /** 按 id 读取；不存在返回 undefined。 */
  restore(sessionId: string): Promise<PersistedDomainState | undefined>;
  /** 已持久化的会话 id 列表（恢复入口用，按创建序）。 */
  listSessionIds(): Promise<string[]>;
  /**
   * 会话元数据轻量读面（AD-4，session.list 数据源）：全部会话的
   * id/创建时间/最后更新时间/首条用户消息文本（title 推导源）；不加载聚合。
   */
  listSessionMetadata(): Promise<readonly SessionMetadataRow[]>;
  /**
   * 会话删除（AD-4，删除收口链的删库步）：六表按 session_id 清行，
   * 经单写通道串行（同会话仓内 FIFO——先于本调用的写全部先落盘）。
   */
  deleteSession(sessionId: string): Promise<void>;
  /**
   * 实例生命周期投影行落盘（agent_lifecycle upsert：
   * 调度器对实例状态迁移的 write-through；经单写通道串行保序）。
   */
  saveAgentLifecycle(sessionId: string, instanceId: string, state: InstanceState): Promise<void>;
  /**
   * closure 记录行落盘（closure_records 追加行，O-5：任务报告本体 =
   * SQLite 行 + findings JSON；经单写通道串行保序，抗重启）。
   */
  saveClosureRecord(
    sessionId: string,
    agentId: string,
    result: "done" | "failed" | "killed",
    closure: InstanceClosurePayload,
  ): Promise<void>;
  /**
   * 任务报告文件产物落盘（O-5：<home>/reports/<session>/<agentId>.md；
   * TR-AD-13 同一 WriteQueue 队列原子写——报告文件与 SQLite 写同链串行）。
   */
  saveReportFile(reportPath: string, content: string): Promise<void>;
  // ── 读面扩展（重启恢复消费；AD-10 恢复语义树） ──────────────
  /**
   * 实例生命周期行读面（agent_lifecycle 每实例行，含 main）：重启时
   * RestoreService 重建实例注册表 / 判定 running/queued 收口的数据源。
   */
  queryAgentLifecycles(sessionId: string): Promise<readonly AgentLifecycleRowData[]>;
  /**
   * closure 记录行读面（按会话/实例过滤，落盘序；终态实例 closure 恢复源）。
   */
  queryClosureRecords(sessionId: string, agentId?: string): readonly ClosureRecordData[];
  /**
   * 事件流四维过滤读面（重启恢复消费事件流——如实例 task 从
   * agent.spawned 载荷重建；仍不对协议/前端暴露，仅内部恢复/trace 用）。
   */
  queryEvents(query?: DomainEventQuery): readonly DomainEvent[];
  // ── W2-D pending_sync 变更追踪（R13/R22） ─────────────────
  /**
   * 写类工具成功调用判定（闭环记录点机械判据；v1 口径：仅 edit/write
   * 工具名 + status=completed——bash 写操作难判定不算，口径注释见实现）。
   */
  hasSuccessfulWriteToolCall(sessionId: string): boolean;
  /**
   * pending_sync upsert（闭环记录点：同主键单行——新变更 changed_at 刷新
   * + notified 复位 0；经单写通道串行）。
   */
  savePendingSync(sessionId: string, jobId: string | null, changedAt: string): Promise<void>;
  /**
   * pending_sync 未提示行读面（job 终态扫描：任务会话 sessionId 或 job_id
   * 双径命中，notified=0；确定性序 = session_id 序）。
   */
  queryUnnotifiedPendingSync(sessionId: string, jobId: string): readonly PendingSyncRowData[];
  /** pending_sync 置已提示（提示发出后置位；重复置位幂等）。 */
  markPendingSyncNotified(sessionIds: readonly string[]): Promise<void>;
}

/** pending_sync 行读面形状（notified=0 过滤后故不含标记列）。 */
export interface PendingSyncRowData {
  readonly sessionId: string;
  readonly jobId: string | null;
  readonly changedAt: string;
}

/** agent_lifecycle 投影行的读面形状（instanceId 维；state 含 main 的会话运行态与 SubAgent 的实例态）。 */
export interface AgentLifecycleRowData {
  readonly instanceId: string;
  readonly state: string;
  readonly updatedAt: string;
}

/** 会话元数据行（session_state 轻量读面，title = firstUserText 截 20 码点推导）。 */
export interface SessionMetadataRow {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 首条用户消息全文（title 推导源）；无用户消息的持久化会话为 null。 */
  readonly firstUserText: string | null;
}

/** 领域事件四维过滤查询（trace 数据面；v0 无对外 API——内部能力 + 测试证明）。 */
export interface DomainEventQuery {
  readonly sessionId?: string;
  readonly agentKind?: string;
  /** 实例维（trace 四维 session × instance × type × time）。 */
  readonly instanceId?: string;
  readonly type?: string;
  /** 多类型单次查询（水位重建：usage.recorded + compaction.completed 需全局序合并重放；与 type 五斥，同给优先 types）。 */
  readonly types?: readonly string[];
  /** ISO 8601 下界（含）。 */
  readonly since?: string;
  /** ISO 8601 上界（含）。 */
  readonly until?: string;
}

/** closure 记录行的读面形状（findings 已解析为值；全字段必发语义同 InstanceClosurePayload）。 */
export interface ClosureRecordData {
  readonly agentId: string;
  readonly result: "done" | "failed" | "killed";
  readonly status: "done" | "failed";
  readonly summary: string;
  readonly reportPath: string | null;
  readonly findings: unknown[] | null;
  readonly taskId: string | null;
  readonly createdAt: string;
}

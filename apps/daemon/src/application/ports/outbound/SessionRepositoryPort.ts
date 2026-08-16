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
 * （SQLite WAL + 单写队列，T1.8）；单测用 InMemory 假实现（test/mocks）。
 * 本文件只有接口/类型定义（AG-01）。
 */

/**
 * 持久化对象 = 领域状态整体（F(8).1 标准 1，AD-16）：会话聚合快照 +
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
   * 实例生命周期投影行落盘（agent_lifecycle upsert，iter-20260816-uzvg T2.1：
   * 调度器对实例状态迁移的 write-through；经单写通道串行保序）。
   */
  saveAgentLifecycle(sessionId: string, instanceId: string, state: InstanceState): Promise<void>;
  /**
   * closure 记录行落盘（closure_records 追加行，T2.3 O-5：任务报告本体 =
   * SQLite 行 + findings JSON；经单写通道串行保序，抗重启）。
   */
  saveClosureRecord(
    sessionId: string,
    agentId: string,
    result: "done" | "failed" | "killed",
    closure: InstanceClosurePayload,
  ): Promise<void>;
  /**
   * 任务报告文件产物落盘（T2.3 O-5：<home>/reports/<session>/<agentId>.md；
   * TR-AD-13 同一 WriteQueue 队列原子写——报告文件与 SQLite 写同链串行）。
   */
  saveReportFile(reportPath: string, content: string): Promise<void>;
  // ── 读面扩展（T2.4 重启恢复消费；AD-10 恢复语义树） ──────────────
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
   * 事件流四维过滤读面（T2.4 提升：重启恢复消费事件流——如实例 task 从
   * agent.spawned 载荷重建；仍不对协议/前端暴露，仅内部恢复/trace 用）。
   */
  queryEvents(query?: DomainEventQuery): readonly DomainEvent[];
}

/** agent_lifecycle 投影行的读面形状（instanceId 维；state 含 main 的会话运行态与 SubAgent 的实例态）。 */
export interface AgentLifecycleRowData {
  readonly instanceId: string;
  readonly state: string;
  readonly updatedAt: string;
}

/** 领域事件四维过滤查询（trace 数据面；v0 无对外 API——内部能力 + 测试证明）。 */
export interface DomainEventQuery {
  readonly sessionId?: string;
  readonly agentKind?: string;
  /** 实例维（F1.7：trace 四维 session × instance × type × time）。 */
  readonly instanceId?: string;
  readonly type?: string;
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

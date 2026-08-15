import type { SessionSnapshot } from "../../../domain/session/SessionSnapshot";
import type { AgentLifecycleState } from "../../../domain/agent/AgentLifecycle";
import type { ToolCallRecordData } from "../../../domain/tools/ToolCallRecord";

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
}

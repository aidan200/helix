import type { SessionSnapshot, SessionUsageSummary, UsageSummary } from "../../../domain/session/SessionSnapshot";
import type { AgentLifecycleState } from "../../../domain/agent/AgentLifecycle";
import type { ToolCallRecordData } from "../../../domain/tools/ToolCallRecord";
import type { DomainEvent, InstanceClosurePayload } from "../../../domain/events/DomainEvent";
import type { StreamDelta } from "../outbound/EventPublisherPort";
import type { AgentInstanceData } from "../../../domain/agent/AgentInstance";

/**
 * 会话状态入口端口（inbound，architecture.md §3.4）。
 *
 * 重连/重启恢复的统一取数面：快照（全量）+ 增量事件流（AD-16：快照+增量）。
 * 本文件只有接口定义（AG-01）。
 */
export type SessionStreamEvent = DomainEvent | StreamDelta;

/**
 * 会话状态视图（D-1 修复）：会话聚合快照 + 工具调用记录（合并进协议快照
 * entries，时间序）。工具记录归属 ChatService.toolCalls（既有设计），
 * 不搬进 Session 聚合——本视图只是取数面组合。
 *
 * T2.4 快照 additive（契约 protocol-v0.1.md §6.2）：instances（实例清单，
 * 重启恢复卡片/抽屉骨架）+ usage（账目聚合）。两者均可选——旧组装点不
 * 携带时快照不带（additive 演进）；T3.2 后由 UsageLedger 真值装配。
 */
export interface SessionStateView {
  readonly session: SessionSnapshot;
  readonly toolCalls: readonly ToolCallRecordData[];
  /** 实例清单（运行时注册表组装；缺省 = 未携带）。 */
  readonly instances?: readonly InstanceSnapshotEntry[];
  /** 会话账目聚合（T3.2：UsageLedger 投影；缺省 = 未携带）。 */
  readonly usage?: SessionUsageSummary;
  /**
   * 会话自身运行态（T5.1 热修，AD-2/AD-4：per-session 盖章数据源）——快照
   * agentState 由组装面（注册表 buildView）从目标会话 runtime 直读，不再经
   * system.getStatus() 全局最近活跃投影（多会话下 current ≠ 目标会话 →
   * 串台，RCA debug/session-switch-state-overwrite-root-cause.md）。
   * 缺省 = 旧组装点未携带（additive 演进）。
   */
  readonly agentState?: AgentLifecycleState;
  /** 会话当前模型（per-session，AD-2；undefined = 引擎未暴露 → 调用方回退全局默认）。 */
  readonly model?: string;
}

/** 实例快照条目（AgentInstanceData + task/closure/usage/model；契约 AgentInstanceDto 的 domain 侧镜像）。 */
export interface InstanceSnapshotEntry extends AgentInstanceData {
  readonly task?: string;
  readonly closure?: InstanceClosurePayload;
  /** 该实例账目小计（T3.2：UsageLedger per-instance 投影；缺省 = 未携带）。 */
  readonly usage?: UsageSummary;
  /** spawn 时刻模型（T2.3：AgentInstanceDto.model 空槽位填充链；主实例 = 会话当前模型）。 */
  readonly model?: string;
}

export interface SessionPort {
  /** 当前会话全量快照视图（会话聚合 + 工具调用记录；握手后/重连后先推快照）。 */
  getSnapshot(): SessionStateView;
  /** 订阅会话事件流（领域事件 + 流式增量）；返回退订函数。 */
  subscribe(listener: (event: SessionStreamEvent) => void): () => void;
}

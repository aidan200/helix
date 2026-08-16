import type { SessionSnapshot, SessionUsageSummary } from "../../../domain/session/SessionSnapshot";
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
 * 重启恢复卡片/抽屉骨架）+ usage（账目聚合，T3.2 入账链路前空聚合占位）。
 * 两者均可选——旧组装点不携带时快照不带（additive 演进）。
 */
export interface SessionStateView {
  readonly session: SessionSnapshot;
  readonly toolCalls: readonly ToolCallRecordData[];
  /** 实例清单（运行时注册表组装；缺省 = 未携带）。 */
  readonly instances?: readonly InstanceSnapshotEntry[];
  /** 会话账目聚合（缺省 = 未携带；下发组装时空聚合占位）。 */
  readonly usage?: SessionUsageSummary;
}

/** 实例快照条目（AgentInstanceData + task/closure；契约 AgentInstanceDto 的 domain 侧镜像）。 */
export interface InstanceSnapshotEntry extends AgentInstanceData {
  readonly task?: string;
  readonly closure?: InstanceClosurePayload;
}

export interface SessionPort {
  /** 当前会话全量快照视图（会话聚合 + 工具调用记录；握手后/重连后先推快照）。 */
  getSnapshot(): SessionStateView;
  /** 订阅会话事件流（领域事件 + 流式增量）；返回退订函数。 */
  subscribe(listener: (event: SessionStreamEvent) => void): () => void;
}

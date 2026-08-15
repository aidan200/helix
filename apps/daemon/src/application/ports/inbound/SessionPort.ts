import type { SessionSnapshot } from "../../../domain/session/SessionSnapshot";
import type { ToolCallRecordData } from "../../../domain/tools/ToolCallRecord";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { StreamDelta } from "../outbound/EventPublisherPort";

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
 */
export interface SessionStateView {
  readonly session: SessionSnapshot;
  readonly toolCalls: readonly ToolCallRecordData[];
}

export interface SessionPort {
  /** 当前会话全量快照视图（会话聚合 + 工具调用记录；握手后/重连后先推快照）。 */
  getSnapshot(): SessionStateView;
  /** 订阅会话事件流（领域事件 + 流式增量）；返回退订函数。 */
  subscribe(listener: (event: SessionStreamEvent) => void): () => void;
}

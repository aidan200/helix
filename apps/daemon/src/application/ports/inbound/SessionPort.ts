import type { SessionSnapshot } from "../../../domain/session/SessionSnapshot";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { StreamDelta } from "../outbound/EventPublisherPort";

/**
 * 会话状态入口端口（inbound，architecture.md §3.4）。
 *
 * 重连/重启恢复的统一取数面：快照（全量）+ 增量事件流（AD-16：快照+增量）。
 * 本文件只有接口定义（AG-01）。
 */
export type SessionStreamEvent = DomainEvent | StreamDelta;

export interface SessionPort {
  /** 当前会话全量快照（握手后/重连后先推快照）。 */
  getSnapshot(): SessionSnapshot;
  /** 订阅会话事件流（领域事件 + 流式增量）；返回退订函数。 */
  subscribe(listener: (event: SessionStreamEvent) => void): () => void;
}

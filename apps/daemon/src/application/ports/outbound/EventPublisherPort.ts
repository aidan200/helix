import type { DomainEvent } from "../../../domain/events/DomainEvent";

/**
 * 事件流发布出口端口（outbound，architecture.md §3.4）。
 *
 * 通知方向的标准形态：service 发事件 → driving 侧实现本端口转推送
 * （CLI → stdout 流式打印；T1.6 ws-server → 协议事件帧）。
 * 本文件只有类型/接口定义（AG-01）。
 */

/**
 * 流式中间态（token 级 delta）——**不是领域事件**，不落盘（AD-16 §5.3），
 * 只走本端口直达前端/终端。messageId 为流式分组键（当前轮次 id）。
 * T3.1 通道扩展：channel="thinking" 的增量走 thinking 流式通道（同样不落盘，
 * TR-AD-5）；instanceId 缺省 = 主实例（契约 §1）。
 */
export interface StreamDelta {
  readonly messageId: string;
  readonly delta: string;
  /** 流式通道（缺省 "message" = 对话文本；"thinking" = thinking 块流）。 */
  readonly channel?: "message" | "thinking";
  /** 实例归属（thinking 通道携带；缺省主实例）。 */
  readonly instanceId?: string;
}

export interface EventPublisherPort {
  /** 发布领域事件（里程碑：write-through 落盘源 + 前端投影源）。 */
  publish(event: DomainEvent): void;
  /** 发布流式增量（中间态，不落盘）。 */
  publishDelta(delta: StreamDelta): void;
}

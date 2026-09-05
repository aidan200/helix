import type { DomainEvent } from "../../../domain/events/DomainEvent";

/**
 * 事件流发布出口端口（outbound，architecture.md §3.4）。
 *
 * 通知方向的标准形态：service 发事件 → driving 侧实现本端口转推送
 * （CLI → stdout 流式打印；WS 侧 → 协议事件帧）。
 * 本文件只有类型/接口定义（AG-01）。
 */

/**
 * 流式中间态（token 级 delta）——**不是领域事件**，不落盘（AD-16 §5.3），
 * 只走本端口直达前端/终端。messageId 为流式分组键（当前轮次 id）。
 * 通道扩展：channel="thinking" 的增量走 thinking 流式通道（同样不落盘，
 * TR-AD-5）；instanceId 缺省 = 主实例（契约 §1）。channel="diff" 为轮次
 * diff 状态瞬态推送（T3：结构化载荷经 diff 字段携带——同样不落盘不投影；
 * 文本两字段不参与）。
 */
export interface StreamDelta {
  readonly messageId: string;
  readonly delta: string;
  /** 流式通道（缺省 "message" = 对话文本；"thinking" = thinking 块流；"diff" = 轮次 diff 状态推送）。 */
  readonly channel?: "message" | "thinking" | "diff";
  /** 实例归属（thinking 通道携带；缺省主实例）。 */
  readonly instanceId?: string;
  /**
   * diff 通道结构化载荷（channel="diff" 必携带；sessionId 必携带——路由位）。
   * 形状 = 轮次 diff 状态三态快照（AG-01：ports 零包外 import，故此处
   * 内联结构形状——与 @helix/protocol DiffChangedPayload 结构兼容，赋值
   * 方向 application → driving 单向，帧翻译单点在 EnvelopeMapper）。
   */
  readonly diff?: {
    readonly turnId: string;
    readonly phase: "active" | "frozen" | "cleared";
    readonly adds: number;
    readonly dels: number;
    readonly fileCount: number;
  };
  /**
   * 会话归属（v0.2 信封 sessionId 必发纪律）：生产侧携带，WS 推送侧
   * 章印进帧（EventStream defaultSessionId 兑底）；类型层可选与信封兼容
   * 红线同口径（契约 A §1.2）。
   */
  readonly sessionId?: string;
}

export interface EventPublisherPort {
  /** 发布领域事件（里程碑：write-through 落盘源 + 前端投影源）。 */
  publish(event: DomainEvent): void;
  /** 发布流式增量（中间态，不落盘）。 */
  publishDelta(delta: StreamDelta): void;
}

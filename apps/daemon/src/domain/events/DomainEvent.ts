/**
 * 领域事件（architecture.md §3.3 / §5）：里程碑状态变更的值对象——
 * write-through 落盘与前端投影的统一事件源。
 *
 * 边界（AD-16）：流式中间态（token 级 delta）**不是**领域事件，
 * 不进本类型、不落盘（走 EventPublisherPort 的流式通道直达前端）。
 */
export type DomainEventType =
  | "turn.started"
  | "turn.completed"
  | "turn.interrupted"
  | "message.completed"
  | "steer.queued"
  | "steer.drained"
  | "tool.call.started"
  | "tool.call.result"
  | "agent.state.changed"
  | "engine.error";

export interface DomainEvent<P = unknown> {
  readonly type: DomainEventType;
  readonly sessionId: string;
  /** 关联轮次（轮次级事件必填；会话级可空）。 */
  readonly turnId?: string;
  /**
   * 实例归属（AD-3，iter-20260816-uzvg T1.2）：缺省 = 主实例（协议同语义，
   * 契约 §1）。SubAgent 实例事件携带 agent-N；发布侧挂 id 由 T2.3/T3.x 接。
   */
  readonly instanceId?: string;
  readonly payload: P;
  /** 发生时刻（ISO 8601，来自 ClockPort——测试可控）。 */
  readonly occurredAt: string;
}

// ── 常用载荷形状（纯数据，供 service 构造事件时复用） ─────────

export interface MessageCompletedPayload {
  readonly entryId: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly isSteer: boolean;
}

export interface SteerPayload {
  readonly entryId: string;
  readonly text: string;
}

export interface TurnCompletedPayload {
  readonly reason: "done" | "aborted" | "steerDrained";
  readonly replyEntryId?: string;
}

export interface ToolCallPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface ToolResultPayload extends ToolCallPayload {
  readonly isError: boolean;
  readonly result: string;
}

export interface AgentStateChangedPayload {
  readonly state: "idle" | "running" | "steering" | "aborting" | "stopped";
}

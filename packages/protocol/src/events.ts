/**
 * 事件目录（S→C，契约 §5；architecture.md §6.3）。
 *
 * 共 12 个事件；`EventEnvelope` 为判别式联合，前端 switch(event.type)
 * 窄化各分支 payload（投影 reducer，T1.7）。steer.queued / steer.drained
 * 为细化阶段自 review.md steer 徽标两态反推补充（架构 §6.3 目录未列，
 * 契约 §5 注记，T1.2 定稿纳入）。
 */
import type { Envelope } from "./envelope";
import type { AgentStateDto } from "./types/agent";
import type { TurnCompletionReason } from "./types/chat";
import type { ErrorCode } from "./types/error";
import type { EntryDto, SessionSnapshotDto } from "./types/session";

// ── payload ──────────────────────────────────────────────────

/** connection.welcome：握手通过回执 */
export interface ConnectionWelcomePayload {
  sessionId: string;
  model: string;
  agentState: AgentStateDto;
}

/** connection.error：握手拒绝 / 命令错误回执 */
export interface ConnectionErrorPayload {
  code: ErrorCode;
  message: string;
}

/** session.snapshot：全量快照（握手后/重连后；AD-16 快照+增量） */
export interface SessionSnapshotPayload {
  snapshot: SessionSnapshotDto;
}

/** chat.stream.delta：流式增量（中间态，不落盘，AD-16） */
export interface ChatStreamDeltaPayload {
  messageId: string;
  delta: string;
}

export interface ChatTurnStartedPayload {
  turnId: string;
}

/** 轮次结束；reason 区分正常完成与中断 */
export interface ChatTurnCompletedPayload {
  turnId: string;
  reason: TurnCompletionReason;
}

/** 一条消息完成（落盘事件；entry 为 kind="message" 且含最终 content） */
export interface ChatMessageCompletedPayload {
  entry: EntryDto;
}

/** 消息入 steer 队列（前端徽标「STEER·已入队」依据） */
export interface SteerQueuedPayload {
  entryId: string;
}

/** turn 边界 drain 注入（徽标转「已注入·本轮结束」依据） */
export interface SteerDrainedPayload {
  entryId: string;
}

/** 工具调用开始（entry 为 tool-call 变体，state="running"） */
export interface ToolCallStartedPayload {
  entry: EntryDto;
}

/** 工具调用结果（entry 为 tool-call 变体，state="done"|"error"，含 result 与 durationMs） */
export interface ToolCallResultPayload {
  entry: EntryDto;
}

/** agent 生命周期状态变更 */
export interface AgentStateChangedPayload {
  state: AgentStateDto;
}

// ── 信封（判别式联合成员） ────────────────────────────────────

export interface ConnectionWelcomeEvent
  extends Envelope<ConnectionWelcomePayload> {
  type: "connection.welcome";
}
export interface ConnectionErrorEvent extends Envelope<ConnectionErrorPayload> {
  type: "connection.error";
}
export interface SessionSnapshotEvent
  extends Envelope<SessionSnapshotPayload> {
  type: "session.snapshot";
}
export interface ChatStreamDeltaEvent
  extends Envelope<ChatStreamDeltaPayload> {
  type: "chat.stream.delta";
}
export interface ChatTurnStartedEvent
  extends Envelope<ChatTurnStartedPayload> {
  type: "chat.turn.started";
}
export interface ChatTurnCompletedEvent
  extends Envelope<ChatTurnCompletedPayload> {
  type: "chat.turn.completed";
}
export interface ChatMessageCompletedEvent
  extends Envelope<ChatMessageCompletedPayload> {
  type: "chat.message.completed";
}
export interface SteerQueuedEvent extends Envelope<SteerQueuedPayload> {
  type: "steer.queued";
}
export interface SteerDrainedEvent extends Envelope<SteerDrainedPayload> {
  type: "steer.drained";
}
export interface ToolCallStartedEvent
  extends Envelope<ToolCallStartedPayload> {
  type: "tool.call.started";
}
export interface ToolCallResultEvent
  extends Envelope<ToolCallResultPayload> {
  type: "tool.call.result";
}
export interface AgentStateChangedEvent
  extends Envelope<AgentStateChangedPayload> {
  type: "agent.state.changed";
}

/** 事件信封联合（判别式：type 字段窄化） */
export type EventEnvelope =
  | ConnectionWelcomeEvent
  | ConnectionErrorEvent
  | SessionSnapshotEvent
  | ChatStreamDeltaEvent
  | ChatTurnStartedEvent
  | ChatTurnCompletedEvent
  | ChatMessageCompletedEvent
  | SteerQueuedEvent
  | SteerDrainedEvent
  | ToolCallStartedEvent
  | ToolCallResultEvent
  | AgentStateChangedEvent;

/** 事件目录常量（运行时可用；与 EventEnvelope 联合由测试双向一致性守护） */
export const EVENT_TYPES = [
  "connection.welcome",
  "connection.error",
  "session.snapshot",
  "chat.stream.delta",
  "chat.turn.started",
  "chat.turn.completed",
  "chat.message.completed",
  "steer.queued",
  "steer.drained",
  "tool.call.started",
  "tool.call.result",
  "agent.state.changed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

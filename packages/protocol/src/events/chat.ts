import type { EventFrame } from "../envelope";
import type { AgentStateDto } from "../types/agent";
import type { SteerSource, TurnCompletionReason } from "../types/chat";
import type { EntryDto } from "../types/session";

// ── payload ──────────────────────────────────────────────────

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

/** 引擎/模型调用失败（终验热修：provider 错误透传——stopReason=error 的模型调用失败经此帧下发，不崩会话）。 */
export interface EngineErrorPayload {
  /** 错误描述（provider 原文透传，如 429 限额/鉴权失败；前端错误卡片正文） */
  message: string;
}

/**
 * LLM 瞬时失败进入退避重试（P2 ⑦ 网络重试批）：等待期可见反馈帧——
 * 前端状态行「网络重试中（第 N/3 次，约 Xs 后）」数据源。瞬态帧不落盘：
 * 流恢复（chat.stream.delta）/engine.error/轮次终制即清除；退避耗尽仍走
 * 既有 engine.error 语义，本帧不改变任何收口语义。
 */
export interface EngineRetryingPayload {
  /** 即将执行的重试序号（1 起，最大 = totalAttempts）。 */
  attempt: number;
  /** 重试总次数（退避序列长度）。 */
  totalAttempts: number;
  /** 本次重试前等待毫秒数。 */
  waitMs: number;
  /** 触发重试的 provider 错误原文（领域数据不 i18n）。 */
  message: string;
}

/** 一条消息完成（落盘事件；entry 为 kind="message" 且含最终 content） */
export interface ChatMessageCompletedPayload {
  entry: EntryDto;
}

/** 消息入 steer 队列（前端徽标「STEER·已入队」依据） */
export interface SteerQueuedPayload {
  entryId: string;
  /** 注入来源（v0.11 批内补登 T11a）：user/closure/progress；缺省 = 老事件按 user */
  source?: SteerSource;
}

/** turn 边界 drain 注入（徽标转「已注入·本轮结束」依据） */
export interface SteerDrainedPayload {
  entryId: string;
  /** 注入来源（v0.11 批内补登 T11a）：与入队时同源透传 */
  source?: SteerSource;
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

// ── 信封 ──────────────────────────────────────────────────

export interface ChatStreamDeltaEvent
  extends EventFrame<ChatStreamDeltaPayload> {
  channel?: "chat";
  type: "chat.stream.delta";
}
export interface ChatTurnStartedEvent
  extends EventFrame<ChatTurnStartedPayload> {
  channel?: "chat";
  type: "chat.turn.started";
}
export interface ChatTurnCompletedEvent
  extends EventFrame<ChatTurnCompletedPayload> {
  channel?: "chat";
  type: "chat.turn.completed";
}
export interface ChatMessageCompletedEvent
  extends EventFrame<ChatMessageCompletedPayload> {
  channel?: "chat";
  type: "chat.message.completed";
}
export interface SteerQueuedEvent extends EventFrame<SteerQueuedPayload> {
  channel?: "chat";
  type: "steer.queued";
}
export interface SteerDrainedEvent extends EventFrame<SteerDrainedPayload> {
  channel?: "chat";
  type: "steer.drained";
}
export interface ToolCallStartedEvent
  extends EventFrame<ToolCallStartedPayload> {
  channel?: "chat";
  type: "tool.call.started";
}
export interface ToolCallResultEvent
  extends EventFrame<ToolCallResultPayload> {
  channel?: "chat";
  type: "tool.call.result";
}
export interface AgentStateChangedEvent
  extends EventFrame<AgentStateChangedPayload> {
  channel?: "chat";
  type: "agent.state.changed";
}
export interface EngineErrorEvent extends EventFrame<EngineErrorPayload> {
  /** chat（reducer 现归类：热修透传链路走 chat 消费路径） */
  channel?: "chat";
  type: "engine.error";
}
export interface EngineRetryingEvent extends EventFrame<EngineRetryingPayload> {
  /** chat（与 engine.error 同族：瞬态反馈归 chat 消费路径） */
  channel?: "chat";
  type: "engine.retrying";
}

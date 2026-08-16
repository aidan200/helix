/**
 * 事件目录（S→C，契约 §5；architecture.md §6.3）。
 *
 * 共 12 个事件；`EventEnvelope` 为判别式联合，前端 switch(event.type)
 * 窄化各分支 payload（投影 reducer，T1.7）。steer.queued / steer.drained
 * 为细化阶段自 review.md steer 徽标两态反推补充（架构 §6.3 目录未列，
 * 契约 §5 注记，T1.2 定稿纳入）。
 */
import type { Envelope } from "./envelope";
import type { AgentStateDto, ClosureDto } from "./types/agent";
import type { TurnCompletionReason } from "./types/chat";
import type { ErrorCode } from "./types/error";
import type {
  CompactionEntryDto,
  EntryDto,
  SessionSnapshotDto,
  ThinkingEntryDto,
} from "./types/session";
import type { UsageDto } from "./types/usage";

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

/** 引擎/模型调用失败（终验热修：provider 错误透传——stopReason=error 的模型调用失败经此帧下发，不崩会话）。 */
export interface EngineErrorPayload {
  /** 错误描述（provider 原文透传，如 429 限额/鉴权失败；前端错误卡片正文） */
  message: string;
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

// ── v0.1 新增 payload：编排生命周期族（契约 protocol-v0.1.md §5.1；AD-7） ──

/** agent.spawned：spawn 工具秒回出卡（不等执行，AD-8 异步交付） */
export interface AgentSpawnedPayload {
  agentId: string;
  task: string;
  profileKind: string;
  /** "provider/model-id"；未声明时缺省继承当前模型（AD-6） */
  model?: string;
}

/** agent.queued：超限 FIFO 入队（AD-7②）；position 随出队递减重发 */
export interface AgentQueuedPayload {
  agentId: string;
  position: number;
}

/** agent.started：出队/预算内直跑（卡片 running 态） */
export interface AgentStartedPayload {
  agentId: string;
}

/** agent.stalled：idle 超阈值无事件增量（AD-7④ 警示不自动杀；可再次发生，非状态迁移） */
export interface AgentStalledPayload {
  agentId: string;
  idleMs: number;
}

/** agent.completed：自然收口 done（closure 同源卡片/抽屉，AD-8） */
export interface AgentCompletedPayload {
  agentId: string;
  closure: ClosureDto;
}

/** agent.failed：崩溃/异常收口 failed（closure.status="failed"） */
export interface AgentFailedPayload {
  agentId: string;
  error: string;
  closure: ClosureDto;
}

/** agent.killed：用户 kill 收口（closure.status="failed"，lifecycle terminated） */
export interface AgentKilledPayload {
  agentId: string;
  closure: ClosureDto;
}

// ── v0.1 新增 payload：通道族（契约 protocol-v0.1.md §5.2；AD-3/AD-9） ──

/** thinking.stream.delta：thinking 流式增量（中间态不落盘，TR-AD-5） */
export interface ThinkingStreamDeltaPayload {
  instanceId: string;
  delta: string;
}

/** thinking.completed：thinking 完成落 Entry */
export interface ThinkingCompletedPayload {
  entry: ThinkingEntryDto;
}

/** compaction.completed：compaction 完成（含 usage，AD-9③） */
export interface CompactionCompletedPayload {
  entry: CompactionEntryDto;
}

/** usage.recorded：turn 完成 / compaction 摘要调用完成（流式中不发，AD-4） */
export interface UsageRecordedPayload {
  instanceId: string;
  usage: UsageDto;
  source: "turn" | "compaction";
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

// ── v0.1 新增信封（契约 protocol-v0.1.md §5） ──

export interface AgentSpawnedEvent extends Envelope<AgentSpawnedPayload> {
  type: "agent.spawned";
}
export interface AgentQueuedEvent extends Envelope<AgentQueuedPayload> {
  type: "agent.queued";
}
export interface AgentStartedEvent extends Envelope<AgentStartedPayload> {
  type: "agent.started";
}
export interface AgentStalledEvent extends Envelope<AgentStalledPayload> {
  type: "agent.stalled";
}
export interface AgentCompletedEvent extends Envelope<AgentCompletedPayload> {
  type: "agent.completed";
}
export interface AgentFailedEvent extends Envelope<AgentFailedPayload> {
  type: "agent.failed";
}
export interface AgentKilledEvent extends Envelope<AgentKilledPayload> {
  type: "agent.killed";
}
export interface ThinkingStreamDeltaEvent
  extends Envelope<ThinkingStreamDeltaPayload> {
  type: "thinking.stream.delta";
}
export interface ThinkingCompletedEvent
  extends Envelope<ThinkingCompletedPayload> {
  type: "thinking.completed";
}
export interface CompactionCompletedEvent
  extends Envelope<CompactionCompletedPayload> {
  type: "compaction.completed";
}
export interface UsageRecordedEvent extends Envelope<UsageRecordedPayload> {
  type: "usage.recorded";
}
export interface EngineErrorEvent extends Envelope<EngineErrorPayload> {
  type: "engine.error";
}

/** 事件信封联合（判别式：type 字段窄化；v0.1：12 → 23） */
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
  | AgentStateChangedEvent
  | AgentSpawnedEvent
  | AgentQueuedEvent
  | AgentStartedEvent
  | AgentStalledEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentKilledEvent
  | ThinkingStreamDeltaEvent
  | ThinkingCompletedEvent
  | CompactionCompletedEvent
  | UsageRecordedEvent
  | EngineErrorEvent;

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
  "agent.spawned",
  "agent.queued",
  "agent.started",
  "agent.stalled",
  "agent.completed",
  "agent.failed",
  "agent.killed",
  "thinking.stream.delta",
  "thinking.completed",
  "compaction.completed",
  "usage.recorded",
  "engine.error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * 事件目录（S→C，契约 A §2；architecture.md §6.3）。
 *
 * 共 28 个事件：v0 12 + v0.1 编排族 7 + v0.1 通道族 4 + 热修 engine.error 1
 * + v0.2 新增 2（session.list_changed / model.changed）。`EventEnvelope` 为
 * 判别式联合，前端 switch(event.type) 窄化各分支 payload（投影 reducer）。
 *
 * v0.2 事件类型学（AD-3，契约 A §2）：每事件以 `channel` 字面量登记所属通道
 * （八族数据/会话通道 + notification 系统通道；见 envelope.ts Channel），
 * EVENT_CHANNELS 为运行时登记目录（daemon 下发侧单点消费，T2.x）。
 * channel 类型层可选（信封兼容红线：v0/v0.1 帧不带仍合法）。
 */
import type { Channel, EventFrame } from "./envelope";
import type { AgentStateDto, ClosureDto } from "./types/agent";
import type { TurnCompletionReason } from "./types/chat";
import type { ErrorCode } from "./types/error";
import type {
  CompactionEntryDto,
  EntryDto,
  SessionMeta,
  SessionSnapshotDto,
  ThinkingEntryDto,
} from "./types/session";
import type { UsageDto } from "./types/usage";

// ── payload ──────────────────────────────────────────────────

/** connection.welcome：握手通过回执（notification 通道，sessionId = SYSTEM_SESSION_ID） */
export interface ConnectionWelcomePayload {
  sessionId: string;
  model: string;
  agentState: AgentStateDto;
}

/** connection.error：握手拒绝 / 命令错误回执（notification 通道） */
export interface ConnectionErrorPayload {
  code: ErrorCode;
  message: string;
}

/** session.snapshot：全量快照（握手后/重连后；AD-16 快照+增量；v0.2 尾窗口径 additive） */
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

/**
 * compaction.completed：compaction 完成（含 usage，AD-9③）。
 * v0.2 additive（契约 A §4-4，OI 收口）：`tailKept` / `filesCompacted`
 * 尾部/文件计数（命名定稿）；缺省 = 未携带（v0/v0.1 帧兼容）。
 */
export interface CompactionCompletedPayload {
  entry: CompactionEntryDto;
  /** 压缩后保留的尾部条目数（尾窗口径对账） */
  tailKept?: number;
  /** 纳入压缩的上下文文件数 */
  filesCompacted?: number;
}

/** usage.recorded：turn 完成 / compaction 摘要调用完成（流式中不发，AD-4） */
export interface UsageRecordedPayload {
  instanceId: string;
  usage: UsageDto;
  source: "turn" | "compaction";
}

// ── v0.2 新增 payload：session/model 族（契约 B §2 / 契约 C §2） ──

/**
 * session.list_changed：会话清单变化（v0.2 新增，AD-4）。
 * 触发：新建（首条消息建聚合）/ 删除 / 运行态变化（idle↔streaming↔
 * subagent_running）/ 标题更新。
 */
export interface SessionListChangedPayload {
  kind: "created" | "deleted" | "state_changed";
  /** created/deleted/state_changed 均带；列表级批量变化可省略 */
  sessionId?: string;
  /** created/state_changed 携带最新元数据（同 session.list 元素形状） */
  session?: SessionMeta;
}

/** model.changed：运行期换模生效广播（v0.2 新增，契约 C §2.1；下一 turn 生效） */
export interface ModelChangedPayload {
  /** 信封 sessionId 同步携带；payload 内嵌一份供消费者免读信封 */
  sessionId: string;
  /** 新模型（"provider/model-id"，下一 turn 生效） */
  model: string;
  previous: string;
  effective: "next-turn";
}

// ── 信封（判别式联合成员；channel 字面量 = 事件类型学登记，契约 A §2） ──

export interface ConnectionWelcomeEvent
  extends EventFrame<ConnectionWelcomePayload> {
  /** notification：会话无关系统事件（信封 sessionId = SYSTEM_SESSION_ID） */
  channel?: "notification";
  type: "connection.welcome";
}
export interface ConnectionErrorEvent extends EventFrame<ConnectionErrorPayload> {
  /** notification：会话无关系统事件（信封 sessionId = SYSTEM_SESSION_ID） */
  channel?: "notification";
  type: "connection.error";
}
export interface SessionSnapshotEvent
  extends EventFrame<SessionSnapshotPayload> {
  channel?: "session";
  type: "session.snapshot";
}
export interface SessionListChangedEvent
  extends EventFrame<SessionListChangedPayload> {
  channel?: "session";
  type: "session.list_changed";
}
/**
 * session.list.result：会话清单命令结果（v0.2 新增，契约 B §1.1 定稿）。
 * 点对点回执——仅发给发起 session.list 命令的连接（不经 EventStream 广播）；
 * 信封 sessionId = SYSTEM_SESSION_ID（全局命令，无会话归属）。
 */
export interface SessionListResultPayload {
  /** 按 lastActivityAt 降序 */
  sessions: SessionMeta[];
}
export interface SessionListResultEvent
  extends EventFrame<SessionListResultPayload> {
  channel?: "session";
  type: "session.list.result";
}
/**
 * session.loadHistory.result：分页历史命令结果（v0.2 新增，AD-1 定稿）。
 * 点对点回执——仅发给发起 session.loadHistory 命令的连接；信封 sessionId =
 * 目标会话 id。
 */
export interface SessionLoadHistoryResultEventPayload {
  /** beforeEntryId 之前的更早历史（时间升序） */
  entries: EntryDto[];
  hasMore: boolean;
  nextCursor: string | null;
}
export interface SessionLoadHistoryResultEvent
  extends EventFrame<SessionLoadHistoryResultEventPayload> {
  channel?: "session";
  type: "session.loadHistory.result";
}
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

// ── v0.1 新增信封（契约 protocol-v0.1.md §5） ──

export interface AgentSpawnedEvent extends EventFrame<AgentSpawnedPayload> {
  channel?: "agent";
  type: "agent.spawned";
}
export interface AgentQueuedEvent extends EventFrame<AgentQueuedPayload> {
  channel?: "agent";
  type: "agent.queued";
}
export interface AgentStartedEvent extends EventFrame<AgentStartedPayload> {
  channel?: "agent";
  type: "agent.started";
}
export interface AgentStalledEvent extends EventFrame<AgentStalledPayload> {
  channel?: "agent";
  type: "agent.stalled";
}
export interface AgentCompletedEvent extends EventFrame<AgentCompletedPayload> {
  channel?: "agent";
  type: "agent.completed";
}
export interface AgentFailedEvent extends EventFrame<AgentFailedPayload> {
  channel?: "agent";
  type: "agent.failed";
}
export interface AgentKilledEvent extends EventFrame<AgentKilledPayload> {
  channel?: "agent";
  type: "agent.killed";
}
export interface ThinkingStreamDeltaEvent
  extends EventFrame<ThinkingStreamDeltaPayload> {
  channel?: "thinking";
  type: "thinking.stream.delta";
}
export interface ThinkingCompletedEvent
  extends EventFrame<ThinkingCompletedPayload> {
  channel?: "thinking";
  type: "thinking.completed";
}
export interface CompactionCompletedEvent
  extends EventFrame<CompactionCompletedPayload> {
  channel?: "compaction";
  type: "compaction.completed";
}
export interface UsageRecordedEvent extends EventFrame<UsageRecordedPayload> {
  channel?: "usage";
  type: "usage.recorded";
}

// ── v0.2 新增信封（契约 B §2 / 契约 C §2） ──

export interface ModelChangedEvent extends EventFrame<ModelChangedPayload> {
  channel?: "model";
  type: "model.changed";
}

/** 事件信封联合（判别式：type 字段窄化；channel 分族窄化见守护测试） */
export type EventEnvelope =
  | ConnectionWelcomeEvent
  | ConnectionErrorEvent
  | SessionSnapshotEvent
  | SessionListChangedEvent
  | SessionListResultEvent
  | SessionLoadHistoryResultEvent
  | ChatStreamDeltaEvent
  | ChatTurnStartedEvent
  | ChatTurnCompletedEvent
  | ChatMessageCompletedEvent
  | SteerQueuedEvent
  | SteerDrainedEvent
  | ToolCallStartedEvent
  | ToolCallResultEvent
  | AgentStateChangedEvent
  | EngineErrorEvent
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
  | ModelChangedEvent;

/** 事件目录常量（运行时可用；与 EventEnvelope 联合由测试双向一致性守护） */
export const EVENT_TYPES = [
  "connection.welcome",
  "connection.error",
  "session.snapshot",
  "session.list_changed",
  "session.list.result",
  "session.loadHistory.result",
  "chat.stream.delta",
  "chat.turn.started",
  "chat.turn.completed",
  "chat.message.completed",
  "steer.queued",
  "steer.drained",
  "tool.call.started",
  "tool.call.result",
  "agent.state.changed",
  "engine.error",
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
  "model.changed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * 事件 → 通道登记目录（v0.2 新增，契约 A §2 映射表；运行时单点）。
 * daemon 下发侧按此为事件帧盖章 channel（T2.x）；`satisfies` 保证与
 * EventType 目录恰等（缺/多一键 = 编译失败）。interaction 为占位族，
 * 无事件挂靠（notification 仅承载 connection.* 两事件）。
 */
export const EVENT_CHANNELS = {
  "connection.welcome": "notification",
  "connection.error": "notification",
  "session.snapshot": "session",
  "session.list_changed": "session",
  "session.list.result": "session",
  "session.loadHistory.result": "session",
  "chat.stream.delta": "chat",
  "chat.turn.started": "chat",
  "chat.turn.completed": "chat",
  "chat.message.completed": "chat",
  "steer.queued": "chat",
  "steer.drained": "chat",
  "tool.call.started": "chat",
  "tool.call.result": "chat",
  "agent.state.changed": "chat",
  "engine.error": "chat",
  "agent.spawned": "agent",
  "agent.queued": "agent",
  "agent.started": "agent",
  "agent.stalled": "agent",
  "agent.completed": "agent",
  "agent.failed": "agent",
  "agent.killed": "agent",
  "thinking.stream.delta": "thinking",
  "thinking.completed": "thinking",
  "compaction.completed": "compaction",
  "usage.recorded": "usage",
  "model.changed": "model",
} as const satisfies Record<EventType, Channel>;

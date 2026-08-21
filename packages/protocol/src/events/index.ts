/**
 * 事件目录（S→C，契约 A §2；目录文档见同包 PROTOCOL.md）。
 *
 * 共 43 个事件：v0 12 + v0.1 编排族 7 + v0.1 通道族 4 + 热修 engine.error 1
 * + v0.2 新增 2（session.list_changed / model.changed）+ T2.2 命令结果 2
 * （session.list.result / session.loadHistory.result）+ T2.3-result-frames
 * 微批 9（model/auth 命令结果帧，契约 C §2.2）+ v0.4 新增 3
 * （trace.query.result / agent.instantiated / agent.model.changed，契约 v0.4，
 * iter-20260819-erio T2.1）+ v0.6 新增 3（agent.config.changed /
 * agent.config.list.result / agent.config.set_enabled.result，M6 T3）。`EventEnvelope` 为
 * 判别式联合，前端 switch(event.type) 窄化各分支 payload（投影 reducer）。
 *
 * v0.2 事件类型学（AD-3，契约 A §2）：每事件以 `channel` 字面量登记所属通道
 * （八族数据/会话通道 + notification 系统通道；见 envelope.ts Channel），
 * EVENT_CHANNELS 为运行时登记目录（daemon 下发侧单点消费，T2.x）。
 * channel 类型层可选（信封兼容红线：v0/v0.1 帧不带仍合法）。
 */
import type { Channel } from "../envelope";
import type {
  ConnectionErrorEvent,
  ConnectionWelcomeEvent,
} from "./notification";
import type {
  SessionListChangedEvent,
  SessionListResultEvent,
  SessionLoadHistoryResultEvent,
  SessionSnapshotEvent,
} from "./session";
import type {
  AgentStateChangedEvent,
  ChatMessageCompletedEvent,
  ChatStreamDeltaEvent,
  ChatTurnCompletedEvent,
  ChatTurnStartedEvent,
  EngineErrorEvent,
  SteerDrainedEvent,
  SteerQueuedEvent,
  ToolCallResultEvent,
  ToolCallStartedEvent,
} from "./chat";
import type {
  AgentCompletedEvent,
  AgentConfigChangedEvent,
  AgentConfigListResultEvent,
  AgentConfigSetEnabledResultEvent,
  AgentFailedEvent,
  AgentInstantiatedEvent,
  AgentKilledEvent,
  AgentModelChangedEvent,
  AgentQueuedEvent,
  AgentSpawnedEvent,
  AgentStalledEvent,
  AgentStartedEvent,
} from "./agent";
import type {
  CompactionCompletedEvent,
  ThinkingCompletedEvent,
  ThinkingStreamDeltaEvent,
  UsageRecordedEvent,
} from "./channels";
import type {
  AuthDeleteKeyResultEvent,
  AuthListResultEvent,
  AuthSetKeyResultEvent,
  AuthVerifyResultEvent,
  ModelCatalogRefreshResultEvent,
  ModelCatalogResultEvent,
  ModelChangedEvent,
  ModelGetDefaultResultEvent,
  ModelGetResultEvent,
  ModelSetDefaultResultEvent,
} from "./model";
import type { TraceQueryResultEvent } from "./trace";

export * from "./notification";
export * from "./session";
export * from "./chat";
export * from "./agent";
export * from "./channels";
export * from "./model";
export * from "./trace";

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
  | ModelChangedEvent
  | ModelGetResultEvent
  | ModelCatalogResultEvent
  | ModelCatalogRefreshResultEvent
  | ModelSetDefaultResultEvent
  | ModelGetDefaultResultEvent
  | AuthListResultEvent
  | AuthSetKeyResultEvent
  | AuthDeleteKeyResultEvent
  | AuthVerifyResultEvent
  | TraceQueryResultEvent
  | AgentInstantiatedEvent
  | AgentModelChangedEvent
  | AgentConfigListResultEvent
  | AgentConfigChangedEvent
  | AgentConfigSetEnabledResultEvent;

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
  "model.get.result",
  "model.catalog.result",
  "model.catalog_refresh.result",
  "model.set_default.result",
  "model.get_default.result",
  "auth.list.result",
  "auth.set_key.result",
  "auth.delete_key.result",
  "auth.verify.result",
  "trace.query.result",
  "agent.instantiated",
  "agent.model.changed",
  "agent.config.changed",
  "agent.config.list.result",
  "agent.config.set_enabled.result",
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
  "model.get.result": "model",
  "model.catalog.result": "model",
  "model.catalog_refresh.result": "model",
  "model.set_default.result": "model",
  "model.get_default.result": "model",
  "auth.list.result": "model",
  "auth.set_key.result": "model",
  "auth.delete_key.result": "model",
  "auth.verify.result": "model",
  "trace.query.result": "trace",
  "agent.instantiated": "agent",
  "agent.model.changed": "agent",
  "agent.config.changed": "agent",
  "agent.config.list.result": "agent",
  "agent.config.set_enabled.result": "agent",
} as const satisfies Record<EventType, Channel>;

/**
 * 事件目录（S→C，契约 A §2；目录文档见同包 PROTOCOL.md）。
 *
 * 事件全集以 EVENT_TYPES 常量为准——头注释不记硬计数（易腐，曾与实际
 * 严重漂移），计数由机械断言守护（PROTOCOL.md §17.3 断言③：文档计数声明 ==
 * 常量目录长度；catalog.test.ts：EVENT_TYPES ↔ EventEnvelope 双向一致）。
 * 批次演进史见 PROTOCOL-CHANGELOG.md。
 *
 * 口径要点（非计数）：点对点命令结果帧仅发发起命令的连接（TR-AD-21）；
 * 其中 task 族十结果帧与 diff.get.result 不入本目录（types/task.ts /
 * types/diff.ts 窄化接口供出），登记判据见 PROTOCOL.md §16 头注。
 * `EventEnvelope` 为判别式联合，前端 switch(event.type) 窄化各分支
 * payload（投影 reducer）。
 *
 * 事件类型学（AD-3，契约 A §2）：每事件以 `channel` 字面量登记所属通道
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
  SessionPlanChangedEvent,
  SessionSnapshotEvent,
} from "./session";
import type {
  AgentStateChangedEvent,
  ChatMessageCompletedEvent,
  ChatStreamDeltaEvent,
  ChatTurnCompletedEvent,
  ChatTurnStartedEvent,
  EngineErrorEvent,
  EngineRetryingEvent,
  ErrorEntryEvent,
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
  AgentBasePromptGetResultEvent,
  AgentSkillContentGetResultEvent,
  AgentSkillCreateResultEvent,
  AgentFailedEvent,
  AgentInstantiatedEvent,
  AgentKilledEvent,
  AgentModelChangedEvent,
  AgentParkedEvent,
  AgentQueuedEvent,
  AgentResumedEvent,
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
  ModelSetThinkingDefaultResultEvent,
} from "./model";
import type {
  ConfigGetCompactionResultEvent,
  ConfigSetCompactionResultEvent,
  ConfigGetSchedulingResultEvent,
  ConfigSetSchedulingResultEvent,
  ConfigGetPortResultEvent,
  ConfigSetPortResultEvent,
} from "./config";
import type { TraceQueryResultEvent } from "./trace";
import type { ThinkingChangedEvent } from "./thinking";
import type {
  WebStartResultEvent,
  WebStatusChangedEvent,
  WebStatusResultEvent,
  WebStopResultEvent,
} from "./web";
import type {
  KgBootstrapCreateResultEvent,
  KgBootstrapImpactResultEvent,
  KgBootstrapProduceResultEvent,
  KgChangeReportResultEvent,
  KgGraphPurgeResultEvent,
  KgHealthResultEvent,
  KgIndexDeleteResultEvent,
  KgIndexStatusResultEvent,
  KgListResultEvent,
  KgNodeConfirmResultEvent,
  KgNodeDetailResultEvent,
  KgNodeSupersedeResultEvent,
  KgNodeUpdateResultEvent,
  KgProjectsResultEvent,
  KgReviewCreateResultEvent,
  KgCandidatesListResultEvent,
  CodeReviewCreateResultEvent,
} from "./kg";
import type {
  WorkspaceChangedEvent,
  WorkspaceGetResultEvent,
  WorkspaceOpenResultEvent,
} from "./workspace";
import type { TaskChangedEvent } from "../types/task";
import type { DiffChangedEvent } from "./diff";
import type {
  McpServersListResultEvent,
  McpServersAddResultEvent,
  McpServersUpdateResultEvent,
  McpServersRemoveResultEvent,
  McpServersTestResultEvent,
  McpToolsListResultEvent,
  McpStatusChangedEvent,
} from "./mcp";

export * from "./notification";
export * from "./session";
export * from "./chat";
export * from "./agent";
export * from "./channels";
export * from "./model";
export * from "./config";
export * from "./trace";
export * from "./thinking";
export * from "./web";
export * from "./kg";
export * from "./workspace";
export * from "./diff";
export * from "./mcp";

/** 事件信封联合（判别式：type 字段窄化；channel 分族窄化见守护测试） */
export type EventEnvelope =
  | ConnectionWelcomeEvent
  | ConnectionErrorEvent
  | SessionSnapshotEvent
  | SessionListChangedEvent
  | SessionPlanChangedEvent
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
  | EngineRetryingEvent
  | ErrorEntryEvent
  | AgentSpawnedEvent
  | AgentQueuedEvent
  | AgentStartedEvent
  | AgentStalledEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentKilledEvent
  | AgentParkedEvent
  | AgentResumedEvent
  | ThinkingStreamDeltaEvent
  | ThinkingCompletedEvent
  | CompactionCompletedEvent
  | UsageRecordedEvent
  | ModelChangedEvent
  | ModelGetResultEvent
  | ModelCatalogResultEvent
  | ModelCatalogRefreshResultEvent
  | ModelSetDefaultResultEvent
  | ModelSetThinkingDefaultResultEvent
  | ModelGetDefaultResultEvent
  | ConfigGetCompactionResultEvent
  | ConfigSetCompactionResultEvent
  | ConfigGetSchedulingResultEvent
  | ConfigSetSchedulingResultEvent
  | ConfigGetPortResultEvent
  | ConfigSetPortResultEvent
  | AuthListResultEvent
  | AuthSetKeyResultEvent
  | AuthDeleteKeyResultEvent
  | AuthVerifyResultEvent
  | TraceQueryResultEvent
  | AgentInstantiatedEvent
  | AgentModelChangedEvent
  | AgentConfigListResultEvent
  | AgentConfigChangedEvent
  | AgentConfigSetEnabledResultEvent
  | AgentBasePromptGetResultEvent
  | AgentSkillContentGetResultEvent
  | AgentSkillCreateResultEvent
  | WebStatusResultEvent
  | WebStopResultEvent
  | WebStatusChangedEvent
  | WebStartResultEvent
  | ThinkingChangedEvent
  | KgProjectsResultEvent
  | KgListResultEvent
  | KgNodeDetailResultEvent
  | KgChangeReportResultEvent
  | KgNodeConfirmResultEvent
  | KgIndexStatusResultEvent
  | KgBootstrapCreateResultEvent
  | KgBootstrapProduceResultEvent
  | KgNodeUpdateResultEvent
  | KgNodeSupersedeResultEvent
  | KgBootstrapImpactResultEvent
  | KgGraphPurgeResultEvent
  | KgIndexDeleteResultEvent
  | KgHealthResultEvent
  | KgReviewCreateResultEvent
  | CodeReviewCreateResultEvent
  | KgCandidatesListResultEvent
  | WorkspaceGetResultEvent
  | WorkspaceOpenResultEvent
  | WorkspaceChangedEvent
  | TaskChangedEvent
  | DiffChangedEvent
  | McpServersListResultEvent
  | McpServersAddResultEvent
  | McpServersUpdateResultEvent
  | McpServersRemoveResultEvent
  | McpServersTestResultEvent
  | McpToolsListResultEvent
  | McpStatusChangedEvent;

/** 事件目录常量（运行时可用；与 EventEnvelope 联合由测试双向一致性守护） */
export const EVENT_TYPES = [
  "connection.welcome",
  "connection.error",
  "session.snapshot",
  "session.list_changed",
  "session.plan.changed",
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
  "engine.retrying",
  "error.entry",
  "agent.spawned",
  "agent.queued",
  "agent.started",
  "agent.stalled",
  "agent.completed",
  "agent.failed",
  "agent.killed",
  "agent.parked",
  "agent.resumed",
  "thinking.stream.delta",
  "thinking.completed",
  "compaction.completed",
  "usage.recorded",
  "model.changed",
  "model.get.result",
  "model.catalog.result",
  "model.catalog_refresh.result",
  "model.set_default.result",
  "model.set_thinking_default.result",
  "model.get_default.result",
  "config.get_compaction.result",
  "config.set_compaction.result",
  "config.get_scheduling.result",
  "config.set_scheduling.result",
  "config.get_port.result",
  "config.set_port.result",
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
  "agent.base_prompt.get.result",
  "agent.skill_content.get.result",
  "agent.skill.create.result",
  "web.status.result",
  "web.stop.result",
  "web.status.changed",
  "web.start.result",
  "thinking.changed",
  "kg.projects.result",
  "kg.list.result",
  "kg.node.detail.result",
  "kg.change.report.result",
  "kg.node.confirm.result",
  "kg.index.status.result",
  "kg.bootstrap.create.result",
  "kg.bootstrap.produce.result",
  "kg.node.update.result",
  "kg.node.supersede.result",
  "kg.bootstrap.impact.result",
  "kg.graph.purge.result",
  "kg.index.delete.result",
  "kg.health.result",
  "kg.review.create.result",
  "code.review.create.result",
  "kg.candidates.list.result",
  "workspace.get.result",
  "workspace.open.result",
  "workspace_changed",
  "task.changed",
  "diff.changed",
  "mcp.servers.list.result",
  "mcp.servers.add.result",
  "mcp.servers.update.result",
  "mcp.servers.remove.result",
  "mcp.servers.test.result",
  "mcp.tools.list.result",
  "mcp.status.changed",
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
  "session.plan.changed": "session",
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
  "engine.retrying": "chat",
  "error.entry": "chat",
  "agent.spawned": "agent",
  "agent.queued": "agent",
  "agent.started": "agent",
  "agent.stalled": "agent",
  "agent.completed": "agent",
  "agent.failed": "agent",
  "agent.killed": "agent",
  "agent.parked": "agent",
  "agent.resumed": "agent",
  "thinking.stream.delta": "thinking",
  "thinking.completed": "thinking",
  "compaction.completed": "compaction",
  "usage.recorded": "usage",
  "model.changed": "model",
  "model.get.result": "model",
  "model.catalog.result": "model",
  "model.catalog_refresh.result": "model",
  "model.set_default.result": "model",
  "model.set_thinking_default.result": "model",
  "model.get_default.result": "model",
  "config.get_compaction.result": "model",
  "config.set_compaction.result": "model",
  "config.get_scheduling.result": "model",
  "config.set_scheduling.result": "model",
  "config.get_port.result": "model",
  "config.set_port.result": "model",
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
  "agent.base_prompt.get.result": "agent",
  "agent.skill_content.get.result": "agent",
  "agent.skill.create.result": "agent",
  "web.status.result": "web",
  "web.stop.result": "web",
  "web.status.changed": "web",
  "web.start.result": "web",
  "thinking.changed": "thinking",
  "kg.projects.result": "kg",
  "kg.list.result": "kg",
  "kg.node.detail.result": "kg",
  "kg.change.report.result": "kg",
  "kg.node.confirm.result": "kg",
  "kg.index.status.result": "kg",
  "kg.bootstrap.create.result": "kg",
  "kg.bootstrap.produce.result": "kg",
  "kg.node.update.result": "kg",
  "kg.node.supersede.result": "kg",
  "kg.bootstrap.impact.result": "kg",
  "kg.graph.purge.result": "kg",
  "kg.index.delete.result": "kg",
  "kg.health.result": "kg",
  "kg.review.create.result": "kg",
  "code.review.create.result": "kg",
  "kg.candidates.list.result": "kg",
  "workspace.get.result": "workspace",
  "workspace.open.result": "workspace",
  "workspace_changed": "workspace",
  "task.changed": "notification",
  "diff.changed": "session",
  "mcp.servers.list.result": "mcp",
  "mcp.servers.add.result": "mcp",
  "mcp.servers.update.result": "mcp",
  "mcp.servers.remove.result": "mcp",
  "mcp.servers.test.result": "mcp",
  "mcp.tools.list.result": "mcp",
  "mcp.status.changed": "mcp",
} as const satisfies Record<EventType, Channel>;

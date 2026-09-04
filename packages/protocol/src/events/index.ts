/**
 * 事件目录（S→C，契约 A §2；目录文档见同包 PROTOCOL.md）。
 *
 * 共 59 个事件：v0 12 + v0.1 编排族 7 + v0.1 通道族 4 + 热修 engine.error 1
 * + v0.2 新增 2（session.list_changed / model.changed）+ T2.2 命令结果 2
 * （session.list.result / session.loadHistory.result）+ T2.3-result-frames
 * 微批 9（model/auth 命令结果帧，契约 C §2.2）+ v0.4 新增 3
 * （trace.query.result / agent.instantiated / agent.model.changed，契约 v0.4，
 * iter-20260819-erio T2.1）+ v0.6 新增 3（agent.config.changed /
 * agent.config.list.result / agent.config.set_enabled.result，M6 T3）+
 * v0.7 新增 3（web.status.result / web.stop.result / web.status.changed，
 * T4 联网状态图标，web 新族）+ v0.9 新增 1（web.start.result，T7 CDP 显式
 * 启动通路）+ v0.11 新增 1（thinking.changed，thinking 批①，
 * iter-20260823-6ps5 T1.1）+ kg 批新增 6（kg.*.result 点对点回执，
 * iter-20260825-11fo T5.3：P-1 六命令族；O-6 轮询裁决零推送事件）+
 * kg-bootstrap 批新增 5（iter-20260829-ys7q T3.2：/project 页 bootstrap 入口
 * 与产出呈现五命令点对点回执，零广播同规）+ workspace
 * 批新增 3（两结果帧 + workspace_changed 广播，W1）+ task 批新增 1
 *（task.changed 逐迁移轻负载广播，iter-20260829-ys7q T1.5：P-2 任务页九
 * 命令族——挂既有 notification 通道不新增 Channel 值，契约 task-api §0/§3；
 * 九命令结果帧为点对点回执不入目录，types/task.ts）+ 网络重试批新增 1
 *（engine.retrying，P2 ⑦：LLM 瞬时失败退避等待可见反馈，瞬态帧归 chat
 * 通道）+ park/resume 批新增 2（agent.parked/agent.resumed，⑤ 挂起恢复
 * 原语广播帧，挂 agent 族——InstanceState 同批 additive 扩 parked）+ main-session
 * plan 批新增 1（session.plan.changed，主会话工作台账广播——挂既有 session
 * 通道不新增 Channel 值；快照 plan/ledger 同批 additive 字段）+ error entry
 * 批新增 1（error.entry：引擎/模型失败的错误条目落时间轴原位红条——挂既
 * 有 chat 通道不新增 Channel 值；EntryDto 同批 additive 第五变体 error）+ base
 * prompt 批新增 1（agent.base_prompt.get.result：agent 页 base 段系统提示词
 * 懒查询点对点回执，挂 agent 族）。`EventEnvelope` 为
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
  | TaskChangedEvent;

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
} as const satisfies Record<EventType, Channel>;

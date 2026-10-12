/**
 * 事件目录（S→C，契约 A §2；目录文档见同包 PROTOCOL.md）。
 *
 * 事件全集以 EVENT_TYPES 常量为准——头注释不记硬计数（易腐，曾与实际
 * 严重漂移），计数 = 代码自证（catalog.test.ts：EVENT_TYPES ↔
 * EventEnvelope 双向一致）——协议文档收口批（PROTOCOL-CHANGELOG.md §39）
 * 起文档不再承载计数声明（原 sot 断言③随 §16 登记面退役）。
 * 批次演进史见 PROTOCOL-CHANGELOG.md。
 *
 * 口径要点（非计数）：点对点命令结果帧仅发发起命令的连接（TR-AD-21）；
 * 其中 task 族十结果帧与 diff.get.result 不入本目录（types/task.ts /
 * types/diff.ts 窄化接口供出），窄化接口轨为已登记历史例外（PROTOCOL.md
 * §17.2③ 结果帧单轨律：不得效仿扩展）。
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
  SessionInstanceChannelsResultEvent,
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
  SteerDiscardedEvent,
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
  AgentStewardProfileGetResultEvent,
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
  ConfigGetSandboxResultEvent,
  ConfigGetKgResultEvent,
  ConfigGetSummaryResultEvent,
  ConfigGetVoiceModelsResultEvent,
  ConfigSetSandboxResultEvent,
  ConfigSetKgResultEvent,
  ConfigSetSummaryResultEvent,
  ConfigSetVoiceModelsResultEvent,
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
  KgNodeDiscardResultEvent,
  KgNodeDetailResultEvent,
  KgNodeSupersedeResultEvent,
  KgNodeUpdateResultEvent,
  KgProjectsResultEvent,
  KgReviewCreateResultEvent,
  KgCandidatesListResultEvent,
  CodeReviewCreateResultEvent,
  KgTriageCreateResultEvent,
  KgAutoAuditResultEvent,
} from "./kg";
import type {
  WorkspaceChangedEvent,
  WorkspaceGetResultEvent,
  WorkspaceOpenResultEvent,
} from "./workspace";
import type { TaskChangedEvent } from "../types/task";
import type { DiffChangedEvent } from "./diff";
import type { CoordChangedEvent } from "./coord";
import type {
  McpServersListResultEvent,
  McpServersAddResultEvent,
  McpServersUpdateResultEvent,
  McpServersRemoveResultEvent,
  McpServersTestResultEvent,
  McpToolsListResultEvent,
  McpStatusChangedEvent,
} from "./mcp";
import type { AskResolvedEvent, AskStartedEvent } from "./interaction";
import type { SttStreamFinalEvent, SttStreamInterimEvent, SttStreamStartedEvent, SttTranscribeResultEvent } from "./stt";
import type {
  VoiceBroadcastEvent,
  VoiceSynthesizeChunkEvent,
  VoiceSynthesizeDoneEvent,
  VoiceSynthesizeErrorEvent,
  VoiceSynthesizeResultEvent,
} from "./voice";
import type {
  StewardAskResultEvent,
  StewardAskDeltaEvent,
  StewardConfirmResultEvent,
  StewardFeedEvent,
  StewardConfigResultEvent,
  StewardHistoryResultEvent,
  StewardToolEvent,
  StewardThinkingEvent,
  StewardNavigateEvent,
  StewardMemoryWrittenEvent,
  StewardMemoryListResultEvent,
  StewardJudgeStopIntentResultEvent,
  StewardNotifyEvent,
  StewardHealthEvent,
  StewardProactiveEvent,
  StewardActionCompletedEvent,
  StewardPendingSnapshotEvent,
  StewardActivityResultEvent,
  StewardActivityEvent,
} from "./steward";
import type {
  SurfaceActionEvent,
  SurfaceRegisteredEvent,
  SurfaceDescriptor,
  SurfaceEvent,
  SurfaceEventUplinkPayload,
} from "./surface";
import type {
  EmbeddingListResultEvent,
  EmbeddingVerifyResultEvent,
} from "./embedding";
import type { ProviderListResultEvent } from "./provider";
import type {
  LoopRunStartedEvent,
  LoopRunFinishedEvent,
  LoopTurnStartedEvent,
  LoopTurnFinishedEvent,
  LoopMessageStartedEvent,
  LoopMessageDeltaEvent,
  LoopMessageFinishedEvent,
  LoopToolStartedEvent,
  LoopToolProgressEvent,
  LoopToolFinishedEvent,
  LoopRunErrorEvent,
  LoopRunPausedEvent,
  LoopRunResumedEvent,
  LoopRunInterruptedEvent,
  LoopDuplexWakeEvent,
  LoopContextCompactedEvent,
} from "./loop";

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
export * from "./coord";
export * from "./mcp";
export * from "./interaction";
export * from "./stt";
export * from "./voice";
export * from "./steward";
export * from "./surface";
export * from "./embedding";
export * from "./loop";
export * from "./provider";

/** 事件信封联合（判别式：type 字段窄化；channel 分族窄化见守护测试） */
export type EventEnvelope =
  | ConnectionWelcomeEvent
  | ConnectionErrorEvent
  | SessionSnapshotEvent
  | SessionListChangedEvent
  | SessionPlanChangedEvent
  | SessionListResultEvent
  | SessionLoadHistoryResultEvent
  | SessionInstanceChannelsResultEvent
  | ChatStreamDeltaEvent
  | ChatTurnStartedEvent
  | ChatTurnCompletedEvent
  | ChatMessageCompletedEvent
  | SteerQueuedEvent
  | SteerDrainedEvent
  | SteerDiscardedEvent
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
  | ConfigGetSandboxResultEvent
  | ConfigGetKgResultEvent
  | ConfigGetSummaryResultEvent
  | ConfigSetSandboxResultEvent
  | ConfigSetKgResultEvent
  | ConfigSetSummaryResultEvent
  | ConfigGetVoiceModelsResultEvent
  | ConfigSetVoiceModelsResultEvent
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
  | AgentStewardProfileGetResultEvent
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
  | KgNodeDiscardResultEvent
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
  | KgTriageCreateResultEvent
  | KgAutoAuditResultEvent
  | KgCandidatesListResultEvent
  | WorkspaceGetResultEvent
  | WorkspaceOpenResultEvent
  | WorkspaceChangedEvent
  | TaskChangedEvent
  | DiffChangedEvent
  | CoordChangedEvent
  | McpServersListResultEvent
  | McpServersAddResultEvent
  | McpServersUpdateResultEvent
  | McpServersRemoveResultEvent
  | McpServersTestResultEvent
  | McpToolsListResultEvent
  | McpStatusChangedEvent
  | SttTranscribeResultEvent
  | SttStreamStartedEvent
  | SttStreamInterimEvent
  | SttStreamFinalEvent
  | VoiceBroadcastEvent
  | VoiceSynthesizeChunkEvent
  | VoiceSynthesizeDoneEvent
  | VoiceSynthesizeErrorEvent
  | VoiceSynthesizeResultEvent
  | StewardAskResultEvent
  | StewardAskDeltaEvent
  | StewardConfirmResultEvent
  | StewardActionCompletedEvent
  | StewardFeedEvent
  | StewardConfigResultEvent
  | StewardHistoryResultEvent
  | StewardToolEvent
  | StewardThinkingEvent
  | StewardNavigateEvent
  | StewardMemoryWrittenEvent
  | StewardMemoryListResultEvent
  | StewardJudgeStopIntentResultEvent
  | SurfaceActionEvent
  | SurfaceRegisteredEvent
  | StewardNotifyEvent
  | StewardHealthEvent
  | StewardProactiveEvent
  | StewardPendingSnapshotEvent
  | StewardActivityResultEvent
  | StewardActivityEvent
  | EmbeddingListResultEvent
  | EmbeddingVerifyResultEvent
  | ProviderListResultEvent
  | LoopRunStartedEvent
  | LoopRunFinishedEvent
  | LoopTurnStartedEvent
  | LoopTurnFinishedEvent
  | LoopMessageStartedEvent
  | LoopMessageDeltaEvent
  | LoopMessageFinishedEvent
  | LoopToolStartedEvent
  | LoopToolProgressEvent
  | LoopToolFinishedEvent
  | LoopRunErrorEvent
  | LoopRunPausedEvent
  | LoopRunResumedEvent
  | LoopRunInterruptedEvent
  | LoopDuplexWakeEvent
  | LoopContextCompactedEvent
  | AskStartedEvent
  | AskResolvedEvent;

/** 事件目录常量（运行时可用；与 EventEnvelope 联合由测试双向一致性守护） */
export const EVENT_TYPES = [
  "connection.welcome",
  "connection.error",
  "session.snapshot",
  "session.list_changed",
  "session.plan.changed",
  "session.list.result",
  "session.loadHistory.result",
  "session.instanceChannels.result",
  "chat.stream.delta",
  "chat.turn.started",
  "chat.turn.completed",
  "chat.message.completed",
  "steer.queued",
  "steer.drained",
  "steer.discarded",
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
  "config.get_sandbox.result",
  "config.set_sandbox.result",
  "config.get_kg.result",
  "config.set_kg.result",
  "config.get_summary.result",
  "config.set_summary.result",
  "config.get_voice_models.result",
  "config.set_voice_models.result",
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
  // 管家公民权批：管家只读档案回执（点对点）
  "agent.steward_profile.get.result",
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
  "kg.node.discard.result",
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
  "kg.triage.create.result",
  "kg.auto.audit.result",
  "workspace.get.result",
  "workspace.open.result",
  "workspace_changed",
  "task.changed",
  "diff.changed",
  "coord.changed",
  "mcp.servers.list.result",
  "mcp.servers.add.result",
  "mcp.servers.update.result",
  "mcp.servers.remove.result",
  "mcp.servers.test.result",
  "mcp.tools.list.result",
  "mcp.status.changed",
  "ask.started",
  "ask.resolved",
  "stt.transcribe.result",
  "voice.broadcast",
  "voice.synthesize.chunk",
  "voice.synthesize.done",
  "voice.synthesize.error",
  "voice.synthesize.result",
  // 文本管家批（V2.5 steward 族）：对话回执/确认回执/feed 文本行/设置回执；
  // 流式体验批 +steward.ask.delta（增量帧——终态 ask.result 权威覆盖）；
  // A1 工作记忆批 +steward.history.result/tool/thinking（回放 + 过程可见）；
  // 管家驾驶舱批 +steward.navigate（投递/建会话成功后的页面切换指令帧）
  "steward.ask.result",
  "steward.ask.delta",
  "steward.confirm.result",
  "steward.feed",
  "steward.config.result",
  "steward.history.result",
  "steward.tool",
  "steward.thinking",
  "steward.navigate",
  // 管家记忆 B5 批 +steward.memory_written（记忆落盘通知——静默入库后广播，与 feed 同订阅闸）
  "steward.memory_written",
  // 表面协议地基批（M0）：统一动作指令帧（D8 指令帧恒一种——管家→页面）
  // + 注册回执（点对点）；channel "surface"
  "surface.action",
  "surface.registered",
  // B1 两段式确认批 +steward.action.completed（确认动作执行完成帧——
  // confirm 受理即回后异步执行体收口时点对点下发）
  "steward.action.completed",
  // 流式转写批（V3b-1）：开流回执/实时中间帧/终帧（点对点；streamId 门控）
  "stt.stream.started",
  "stt.stream.interim",
  "stt.stream.final",
  // helix-loop L0 批（loop 族 15 型）：自有 agent loop 事件族——pi 11 型
  // 同构 + 4 扩展（run_paused/run_resumed/run_interrupted/duplex_wake；后
  // 两者 L0 只定义协议不实现触发）。L0 消费面 = domain_events 投影（追踪
  // 可见性），广播面不接（屏幕通道 steward.* 帧覆盖）；L3 替换 pi 主会话
  // 引擎时 shell 消费面按本协议零改动。
  "loop.run.started",
  "loop.run.finished",
  "loop.turn.started",
  "loop.turn.finished",
  "loop.message.started",
  "loop.message.delta",
  "loop.message.finished",
  "loop.tool.started",
  "loop.tool.progress",
  "loop.tool.finished",
  "loop.run.error",
  "loop.run.paused",
  "loop.run.resumed",
  "loop.run.interrupted",
  "loop.duplex.wake",
  // helix-loop L1 批：上下文压缩里程碑（tokensBefore/After + 摘要；
  // failed 同型记错——压缩失败降级粗裁剪不阻塞对话，追踪页可见）
  "loop.context.compacted",
  // 管家感知批 M0.5：steward.notify（主动通知帧——分诊呈现轨载体，与 feed
  // 同订阅闸；事件帧非指令帧）
  "steward.notify",
  // 光球健康角标批：steward.health（子系统降级/恢复广播——光球呈现面信号
  // 源；状态变化才发，与 feed 同订阅闸）
  "steward.health",
  // M3-a 批：steward.proactive（对话内主动汇报实时帧——CAND-601 闭环：
  // reportProactive 写工作记忆同时广播，开着的面板实时冒条目；旧壳忽略零破坏）
  "steward.proactive",
  // 确认链路修复批：steward.pending.snapshot（在途确认卡快照——订阅对账/
  // 跨重启清场帧，E-206 预留帧位落地）
  "steward.pending.snapshot",
  // 管家活动账批 M3-d1：steward.activity.result（时间线查询/清理回执）+
  // steward.activity（实时活动条目广播——落账即发，与 feed/notify 同闸门）
  "steward.activity.result",
  "steward.activity",
  // 管家记忆 B2：steward 记忆条目清单回执（memory_list/append/update/delete
  // 四命令共用）+ embedding 配置域两帧（新族 channel "embedding"——端点
  // 清单回执与连通测试回执）
  "steward.memory_list.result",
  // Jev 停止判定单轨批：停止意图判定回执（steward.judge_stop_intent 命令
  // 专属——判官 noul 语义判定；停止词表退役后停止判定单源）
  "steward.judge_stop_intent.result",
  "embedding.list.result",
  "embedding.verify.result",
  // 三方平台（自定义 provider）族：平台清单回执（provider.list/set/delete
  // 三命令共用）
  "provider.list.result",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * 已退役事件登记面（机械可检验 deprecated 标记；M0 表面协议地基批起）：
 * 兼容期在册双发、新消费面禁用；删除点 = M1 前检查点（D8 存量收编③）。
 * - steward.navigate：单需求专用指令帧 → 迁 surface.action {verb:"navigate"}
 *   （兼容期 daemon 双发；shell 消费面已切新帧——旧帧零消费）。
 */
export const DEPRECATED_EVENT_TYPES = ["steward.navigate"] as const;

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
  "session.instanceChannels.result": "session",
  "chat.stream.delta": "chat",
  "chat.turn.started": "chat",
  "chat.turn.completed": "chat",
  "chat.message.completed": "chat",
  "steer.queued": "chat",
  "steer.drained": "chat",
  "steer.discarded": "chat",
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
  "config.get_sandbox.result": "model",
  "config.set_sandbox.result": "model",
  "config.get_kg.result": "model",
  "config.set_kg.result": "model",
  "config.get_summary.result": "model",
  "config.set_summary.result": "model",
  "config.get_voice_models.result": "model",
  "config.set_voice_models.result": "model",
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
  "agent.steward_profile.get.result": "agent",
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
  "kg.node.discard.result": "kg",
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
  "kg.triage.create.result": "kg",
  "kg.auto.audit.result": "kg",
  "workspace.get.result": "workspace",
  "workspace.open.result": "workspace",
  "workspace_changed": "workspace",
  "task.changed": "notification",
  "coord.changed": "notification",
  "diff.changed": "session",
  "mcp.servers.list.result": "mcp",
  "mcp.servers.add.result": "mcp",
  "mcp.servers.update.result": "mcp",
  "mcp.servers.remove.result": "mcp",
  "mcp.servers.test.result": "mcp",
  "mcp.tools.list.result": "mcp",
  "mcp.status.changed": "mcp",
  "ask.started": "interaction",
  "ask.resolved": "interaction",
  "stt.transcribe.result": "stt",
  "stt.stream.started": "stt",
  "stt.stream.interim": "stt",
  "stt.stream.final": "stt",
  "voice.broadcast": "voice",
  "voice.synthesize.chunk": "voice",
  "voice.synthesize.done": "voice",
  "voice.synthesize.error": "voice",
  "voice.synthesize.result": "voice",
  "steward.ask.result": "steward",
  "steward.ask.delta": "steward",
  "steward.confirm.result": "steward",
  "steward.feed": "steward",
  "steward.config.result": "steward",
  "steward.history.result": "steward",
  "steward.tool": "steward",
  "steward.thinking": "steward",
  "steward.navigate": "steward",
  "steward.memory_written": "steward",
  "steward.action.completed": "steward",
  "steward.memory_list.result": "steward",
  "steward.judge_stop_intent.result": "steward",
  "surface.action": "surface",
  "surface.registered": "surface",
  "steward.notify": "steward",
  "steward.health": "steward",
  "steward.proactive": "steward",
  "steward.pending.snapshot": "steward",
  "steward.activity.result": "steward",
  "steward.activity": "steward",
  "embedding.list.result": "embedding",
  "embedding.verify.result": "embedding",
  "provider.list.result": "provider",
  "loop.run.started": "loop",
  "loop.run.finished": "loop",
  "loop.turn.started": "loop",
  "loop.turn.finished": "loop",
  "loop.message.started": "loop",
  "loop.message.delta": "loop",
  "loop.message.finished": "loop",
  "loop.tool.started": "loop",
  "loop.tool.progress": "loop",
  "loop.tool.finished": "loop",
  "loop.run.error": "loop",
  "loop.run.paused": "loop",
  "loop.run.resumed": "loop",
  "loop.run.interrupted": "loop",
  "loop.duplex.wake": "loop",
  "loop.context.compacted": "loop",
} as const satisfies Record<EventType, Channel>;

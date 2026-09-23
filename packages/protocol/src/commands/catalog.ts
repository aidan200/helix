/**
 * 命令信封联合与命令目录常量（判别式：type 字段窄化）。成员与
 * COMMAND_TYPES 常量一一对应，由 catalog.test.ts 双向一致性断言机械
 * 守护——不记手维护批次计数链（曾漂移失真）；批次史见
 * PROTOCOL-CHANGELOG.md。
 */
import type { CommandFrame } from "../envelope";
import type {
  ChatSendCommand,
  ChatSteerCommand,
  ChatAbortCommand,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
  AgentKillCommand,
  AgentSubscribeCommand,
  AgentUnsubscribeCommand,
  SessionListCommand,
  SessionLoadHistoryCommand,
  SessionInstanceChannelsCommand,
  SessionDeleteCommand,
  AskAnswerCommand,
} from "./session";
import type {
  ModelSetCommand,
  ModelGetCommand,
  ModelCatalogCommand,
  ModelCatalogRefreshCommand,
  ModelSetDefaultCommand,
  ModelSetThinkingDefaultCommand,
  ModelGetDefaultCommand,
  ConfigSetCompactionCommand,
  ConfigGetCompactionCommand,
  ConfigSetSchedulingCommand,
  ConfigGetSchedulingCommand,
  ConfigSetPortCommand,
  ConfigGetPortCommand,
  ConfigSetSandboxCommand,
  ConfigGetSandboxCommand,
  ConfigSetTopicCommand,
  ConfigGetTopicCommand,
  AuthListCommand,
  AuthSetKeyCommand,
  AuthDeleteKeyCommand,
  AuthVerifyCommand,
  ThinkingSetCommand,
} from "./model-config";
import type {
  TraceQueryCommand,
  AgentConfigListCommand,
  AgentConfigSetEnabledCommand,
  AgentBasePromptGetCommand,
  AgentSkillContentGetCommand,
  AgentSkillCreateCommand,
  AgentStewardProfileGetCommand,
  WebStatusCommand,
  WebStopCommand,
  WebStartCommand,
} from "./resource";
import type {
  KgProjectsCommand,
  KgListCommand,
  KgNodeDetailCommand,
  KgChangeReportCommand,
  KgNodeConfirmCommand,
  KgIndexStatusCommand,
  KgBootstrapCreateCommand,
  KgBootstrapProduceCommand,
  KgNodeUpdateCommand,
  KgNodeSupersedeCommand,
  KgBootstrapImpactCommand,
  KgGraphPurgeCommand,
  KgIndexDeleteCommand,
  KgHealthCommand,
  KgCandidatesListCommand,
  KgReviewCreateCommand,
  CodeReviewCreateCommand,
} from "./kg";
import type {
  WorkspaceGetCommand,
  WorkspaceOpenCommand,
  TaskListCommand,
  TaskDetailCommand,
  TaskArtifactsCommand,
  TaskSubscribeCommand,
  TaskUnsubscribeCommand,
  TaskPauseCommand,
  TaskResumeCommand,
  TaskCancelCommand,
  TaskRetryCommand,
  TaskDeleteCommand,
  DiffGetCommand,
} from "./task";
import type {
  McpServersListCommand,
  McpServersAddCommand,
  McpServersUpdateCommand,
  McpServersRemoveCommand,
  McpServersTestCommand,
  McpToolsListCommand,
} from "./mcp";
import type { SttStreamChunkCommand, SttStreamFinishCommand, SttStreamStartCommand, SttStreamStopCommand, SttTranscribeCommand } from "./stt";
import type {
  VoiceSubscribeCommand,
  VoiceSynthesizeCommand,
  VoiceSynthesizeStreamCommand,
  VoiceSynthesizeStopCommand,
  VoiceUnsubscribeCommand,
} from "./voice";
import type {
  StewardAskCommand,
  StewardConfirmCommand,
  StewardSubscribeCommand,
  StewardUnsubscribeCommand,
  StewardGetConfigCommand,
  StewardSetConfigCommand,
  StewardHistoryCommand,
  StewardInterruptCommand,
  StewardCancelCommand,
  StewardMemoryListCommand,
  StewardMemoryAppendCommand,
  StewardMemoryUpdateCommand,
  StewardMemoryDeleteCommand,
} from "./steward";
import type {
  EmbeddingListCommand,
  EmbeddingSetCommand,
  EmbeddingDeleteCommand,
  EmbeddingVerifyCommand,
} from "./embedding";
import type {
  ProviderListCommand,
  ProviderSetCommand,
  ProviderDeleteCommand,
} from "./provider";

export type CommandEnvelope =
  | ChatSendCommand
  | ChatSteerCommand
  | ChatAbortCommand
  | SessionSubscribeCommand
  | SessionUnsubscribeCommand
  | AgentKillCommand
  | AgentSubscribeCommand
  | AgentUnsubscribeCommand
  | SessionListCommand
  | SessionLoadHistoryCommand
  | SessionInstanceChannelsCommand
  | SessionDeleteCommand
  | ModelSetCommand
  | ModelGetCommand
  | ModelCatalogCommand
  | ModelCatalogRefreshCommand
  | ModelSetDefaultCommand
  | ModelSetThinkingDefaultCommand
  | ModelGetDefaultCommand
  | ConfigSetCompactionCommand
  | ConfigGetCompactionCommand
  | ConfigSetSchedulingCommand
  | ConfigGetSchedulingCommand
  | ConfigSetPortCommand
  | ConfigGetPortCommand
  | ConfigSetSandboxCommand
  | ConfigGetSandboxCommand
  | ConfigSetTopicCommand
  | ConfigGetTopicCommand
  | AuthListCommand
  | AuthSetKeyCommand
  | AuthDeleteKeyCommand
  | AuthVerifyCommand
  | TraceQueryCommand
  | AgentConfigListCommand
  | AgentConfigSetEnabledCommand
  | AgentBasePromptGetCommand
  | AgentSkillContentGetCommand
  | AgentSkillCreateCommand
  | AgentStewardProfileGetCommand
  | WebStatusCommand
  | WebStopCommand
  | WebStartCommand
  | ThinkingSetCommand
  | KgListCommand
  | KgNodeDetailCommand
  | KgChangeReportCommand
  | KgNodeConfirmCommand
  | KgIndexStatusCommand
  | KgProjectsCommand
  | KgBootstrapCreateCommand
  | KgBootstrapProduceCommand
  | KgNodeUpdateCommand
  | KgNodeSupersedeCommand
  | KgBootstrapImpactCommand
  | KgGraphPurgeCommand
  | KgIndexDeleteCommand
  | KgHealthCommand
  | KgReviewCreateCommand
  | CodeReviewCreateCommand
  | KgCandidatesListCommand
  | WorkspaceGetCommand
  | WorkspaceOpenCommand
  | TaskListCommand
  | TaskDetailCommand
  | TaskArtifactsCommand
  | TaskSubscribeCommand
  | TaskUnsubscribeCommand
  | TaskPauseCommand
  | TaskResumeCommand
  | TaskCancelCommand
  | TaskRetryCommand
  | TaskDeleteCommand
  | DiffGetCommand
  | McpServersListCommand
  | McpServersAddCommand
  | McpServersUpdateCommand
  | McpServersRemoveCommand
  | McpServersTestCommand
  | McpToolsListCommand
  | SttTranscribeCommand
  | SttStreamStartCommand
  | SttStreamChunkCommand
  | SttStreamFinishCommand
  | SttStreamStopCommand
  | VoiceSynthesizeCommand
  | VoiceSynthesizeStreamCommand
  | VoiceSynthesizeStopCommand
  | VoiceSubscribeCommand
  | VoiceUnsubscribeCommand
  | StewardAskCommand
  | StewardConfirmCommand
  | StewardSubscribeCommand
  | StewardUnsubscribeCommand
  | StewardGetConfigCommand
  | StewardSetConfigCommand
  | StewardHistoryCommand
  | StewardInterruptCommand
  | StewardCancelCommand
  | StewardMemoryListCommand
  | StewardMemoryAppendCommand
  | StewardMemoryUpdateCommand
  | StewardMemoryDeleteCommand
  | EmbeddingListCommand
  | EmbeddingSetCommand
  | EmbeddingDeleteCommand
  | EmbeddingVerifyCommand
  | ProviderListCommand
  | ProviderSetCommand
  | ProviderDeleteCommand
  | AskAnswerCommand;

/** 命令目录常量（运行时可用；与 CommandEnvelope 联合由测试双向一致性守护） */
export const COMMAND_TYPES = [
  "chat.send",
  "chat.steer",
  "chat.abort",
  "ask.answer",
  // 语音输入批（V1 云转写）：一次性音频转写（点对点回执）
  "stt.transcribe",
  // 流式转写批（V3b-1）：边说边转写（开流/音频块上行/正常收口/中止）
  "stt.stream.start",
  "stt.stream.chunk",
  "stt.stream.finish",
  "stt.stream.stop",
  // 语音播报批（V2 TTS）：一次性合成（试听）+ 连接级订阅闸门；
  // 流式 TTS 批（V3b-2）：单句流式合成 + 中止（管家回答边出边播）
  "voice.synthesize",
  "voice.synthesize.stream",
  "voice.synthesize.stop",
  "voice.subscribe",
  "voice.unsubscribe",
  // 文本管家批（V2.5）：对话（LLM 循环）+ 确认闸 + feed 订阅 + 设置面；
  // A1 工作记忆批 +steward.history（读/清同命令，回放链路）
  "steward.ask",
  "steward.confirm",
  "steward.subscribe",
  "steward.unsubscribe",
  "steward.get_config",
  "steward.set_config",
  "steward.history",
  // B2 barge-in 批：在途轮打断（V3b-3 全双工触发面；无回执——事件面已够）
  "steward.interrupt",
  // B1 两段式确认批：确认卡作废（无回执——放弃是本地即时收场，作废是
  // daemon 侧簿记同步，interrupt 同构先例）
  "steward.cancel",
  // 管家记忆 B2：长期记忆条目管理（读/人工新增/重嵌更新/行级删除）
  "steward.memory_list",
  "steward.memory_append",
  "steward.memory_update",
  "steward.memory_delete",
  // embedding 配置域（管家记忆 B2）：向量端点 CRUD + 连通测试（独立配置域，
  // 模型页向量 tab 消费；apiKey 只进不出）
  "embedding.list",
  "embedding.set",
  "embedding.delete",
  "embedding.verify",
  "provider.list",
  "provider.set",
  "provider.delete",
  "session.subscribe",
  "session.unsubscribe",
  "agent.kill",
  "agent.subscribe",
  "agent.unsubscribe",
  "session.list",
  "session.loadHistory",
  "session.instanceChannels",
  "session.delete",
  "model.set",
  "model.get",
  "model.catalog",
  "model.catalog_refresh",
  "model.set_default",
  "model.set_thinking_default",
  "model.get_default",
  "config.set_compaction",
  "config.get_compaction",
  "config.set_scheduling",
  "config.get_scheduling",
  "config.set_port",
  "config.get_port",
  "config.set_sandbox",
  "config.get_sandbox",
  "config.set_topic",
  "config.get_topic",
  "auth.list",
  "auth.set_key",
  "auth.delete_key",
  "auth.verify",
  "trace.query",
  "agent.config.list",
  "agent.config.set_enabled",
  "agent.base_prompt.get",
  "agent.skill_content.get",
  "agent.skill.create",
  // 管家公民权批：管家只读档案读面（独立命令——不进 agent.config.list 五 kind 语义）
  "agent.steward_profile.get",
  "web.status",
  "web.stop",
  "web.start",
  "thinking.set",
  "kg.list",
  "kg.node.detail",
  "kg.change.report",
  "kg.node.confirm",
  "kg.index.status",
  "kg.projects",
  "kg.bootstrap.create",
  "kg.bootstrap.produce",
  "kg.node.update",
  "kg.node.supersede",
  "kg.bootstrap.impact",
  "kg.graph.purge",
  "kg.index.delete",
  "kg.health",
  "kg.review.create",
  "code.review.create",
  "kg.candidates.list",
  "workspace.get",
  "workspace.open",
  "task.list",
  "task.detail",
  "task.artifacts",
  "task.subscribe",
  "task.unsubscribe",
  "task.pause",
  "task.resume",
  "task.cancel",
  "task.retry",
  "task.delete",
  "diff.get",
  "mcp.servers.list",
  "mcp.servers.add",
  "mcp.servers.update",
  "mcp.servers.remove",
  "mcp.servers.test",
  "mcp.tools.list",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

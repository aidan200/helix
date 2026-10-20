/**
 * shared/api/commands —— C→S 命令帧构造器 barrel（v0.2 信封；契约 A §1.1 /
 * B §1 / C §1）。形状直引 @helix/protocol（AG-13；harness 断言与真实
 * 发送共用本面，不手写帧字面量）；信封 sessionId 纪律（会话作用域必填 /
 * 全局命令省略 / chat.steer 可省略 / stt 两条会话作用域可选）与各族纪律
 * 见 E-84 与对应域模块头注释；草稿首条 = 无 sessionId + payload.draft:true。
 *
 * 单源面（E-84 修订 · 体量门 P3）：构造器实现按命令域落在 commands/ 目录
 * （<domain>.ts），本文件 = 原路径 barrel，精确再导出全族符号（消费方
 * import "@/shared/api/commands" 零改动）。新增/修改构造器改对应域模块，
 * barrel 只加导出行；清单以 commands/ 目录为单源。
 */

export { chatSendCommand, chatSendDraftCommand, chatSteerCommand,
  askAnswerCommand, chatAbortCommand } from "./commands/chat";
export { agentKillCommand, agentSubscribeCommand,
  agentUnsubscribeCommand, agentConfigListCommand,
  agentConfigSetEnabledCommand, agentBasePromptGetCommand,
  agentSkillContentGetCommand, agentSkillCreateCommand,
  agentStewardProfileGetCommand } from "./commands/agent";
export { sessionSubscribeCommand, sessionUnsubscribeCommand,
  sessionListCommand, sessionDeleteCommand, sessionLoadHistoryCommand,
  sessionInstanceChannelsCommand } from "./commands/session";
export { workspaceGetCommand, workspaceOpenCommand } from "./commands/workspace";
export { modelSetCommand, thinkingSetCommand, modelCatalogCommand,
  modelCatalogRefreshCommand, modelGetDefaultCommand,
  modelSetThinkingDefaultCommand, modelSetDefaultCommand } from "./commands/model";
export { configGetCompactionCommand, configSetCompactionCommand,
  configGetSchedulingCommand, configSetSchedulingCommand,
  configGetPortCommand, configSetPortCommand, configGetSandboxCommand,
  configSetSandboxCommand, configGetSummaryCommand, configGetKgCommand,
  configSetKgCommand, configSetSummaryCommand,
  configGetVoiceModelsCommand, configSetVoiceModelsCommand } from "./commands/config";
export { authListCommand, authSetKeyCommand, authDeleteKeyCommand,
  authVerifyCommand } from "./commands/auth";
export { traceQueryCommand } from "./commands/trace";
export { webStatusCommand, webStopCommand, webStartCommand } from "./commands/web";
export { sttTranscribeCommand, sttStreamStartCommand,
  sttStreamChunkCommand, sttStreamFinishCommand, sttStreamStopCommand } from "./commands/stt";
export { voiceSynthesizeCommand, voiceSubscribeCommand,
  voiceUnsubscribeCommand, voiceSynthesizeStreamCommand,
  voiceSynthesizeStopCommand } from "./commands/voice";
export { surfaceRegisterCommand, surfaceUnregisterCommand,
  surfaceEventCommand, surfaceActionResultCommand } from "./commands/surface";
export { stewardAskCommand, stewardConfirmCommand,
  stewardCancelCommand, stewardSubscribeCommand,
  stewardUnsubscribeCommand, stewardGetConfigCommand,
  stewardSetConfigCommand, stewardHistoryCommand,
  stewardInterruptCommand, stewardJudgeStopIntentCommand,
  stewardMemoryListCommand, stewardMemoryAppendCommand,
  stewardMemoryUpdateCommand, stewardMemoryDeleteCommand,
  stewardMemoryPinCommand, stewardMemoryRestoreCommand,
  stewardActivityListCommand, stewardActivityClearCommand } from "./commands/steward";
export { embeddingListCommand, embeddingSetCommand,
  embeddingDeleteCommand, embeddingSetDefaultCommand,
  embeddingVerifyCommand } from "./commands/embedding";
export { providerListCommand, providerSetCommand,
  providerDeleteCommand } from "./commands/provider";
export { mcpServersListCommand, mcpServersAddCommand,
  mcpServersUpdateCommand, mcpServersRemoveCommand, mcpServersTestCommand,
  mcpToolsListCommand } from "./commands/mcp";
export { kgProjectsCommand, kgListCommand, kgNodeDetailCommand,
  kgChangeReportCommand, kgNodeConfirmCommand, kgNodeDiscardCommand,
  kgIndexStatusCommand, kgBootstrapCreateCommand, kgGraphPurgeCommand,
  kgIndexDeleteCommand, kgHealthCommand, kgCandidatesListCommand,
  kgTriageCreateCommand, kgAutoAuditCommand, kgReviewCreateCommand } from "./commands/kg";
export { codeReviewCreateCommand } from "./commands/code";
export { taskListCommand, taskDetailCommand, taskArtifactsCommand,
  taskSubscribeCommand, taskUnsubscribeCommand, taskPauseCommand,
  taskResumeCommand, taskCancelCommand, taskRetryCommand,
  taskDeleteCommand } from "./commands/task";
export { diffGetCommand } from "./commands/diff";

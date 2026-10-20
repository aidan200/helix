/**
 * shared/api/commands —— C→S 命令帧构造器（v0.2 信封；契约 A §1.1 / 契约 B §1 /
 * 契约 C §1；T3.1）。
 *
 * 全部形状直引 @helix/protocol（AG-13 两端同源；TR-TEST 纪律②——harness
 * 断言与真实发送共用本面，避免手写帧字面量漂移）。会话作用域命令的信封
 * sessionId 必填（AD-4 路由位）；全局命令（session.list / model.set_default
 * 等）省略——类型层可选、本构造器纪律保证。
 * 草稿首条消息（契约 B §1.5）：chat.send 信封省略 sessionId + payload
 * draft:true（daemon 建聚合 + 回推 list_changed{created} + 订阅切换 + 快照）。
 *
 * 单源面（E-84 修订 · 体量门 P3）：构造器实现按命令域落在 commands/ 目录
 * （commands/<domain>.ts），本文件（原路径 shared/api/commands.ts）为
 * barrel——精确再导出全族符号，公共 API 面与拆分前逐符号一致（消费方
 * import 路径 "@/shared/api/commands" 零改动）。新增/修改构造器改对应域
 * 模块，barrel 只加导出行；清单以 commands/ 目录为单源。
 */

import { DEFAULT_MODE_ID, PROTOCOL_VERSION } from "@helix/protocol";
import type {
  AgentBasePromptGetCommand,
  AgentBasePromptGetPayload,
  AgentConfigListCommand,
  AgentKillCommand,
  AgentSubscribeCommand,
  AgentUnsubscribeCommand,
  AgentConfigSetEnabledCommand,
  AgentConfigSetEnabledPayload,
  AgentSkillContentGetCommand,
  AgentSkillContentGetPayload,
  AgentSkillCreateCommand,
  AgentSkillCreatePayload,
  AgentStewardProfileGetCommand,
  AuthDeleteKeyCommand,
  AuthListCommand,
  AuthSetKeyCommand,
  AuthVerifyCommand,
  ChatAbortCommand,
  ChatSendCommand,
  ChatSteerCommand,
  ChatSteerPayload,
  ConfigGetCompactionCommand,
  ConfigSetCompactionCommand,
  ConfigGetSchedulingCommand,
  ConfigSetSchedulingCommand,
  ConfigGetPortCommand,
  ConfigSetPortCommand,
  ConfigGetSandboxCommand,
  ConfigGetSummaryCommand,
  ConfigSetSummaryCommand,
  ConfigGetKgCommand,
  ConfigSetKgCommand,
  ConfigGetVoiceModelsCommand,
  ConfigSetVoiceModelsCommand,
  ConfigSetSandboxCommand,
  KgAutoAuditCommand,
  KgAutoAuditPayload,
  KgBootstrapCreateCommand,
  KgBootstrapCreatePayload,
  KgCandidatesListCommand,
  KgCandidatesListPayload,
  KgChangeReportCommand,
  KgChangeReportPayload,
  KgGraphPurgeCommand,
  KgGraphPurgePayload,
  KgHealthCommand,
  KgHealthPayload,
  KgIndexDeleteCommand,
  KgIndexDeletePayload,
  KgIndexStatusCommand,
  KgIndexStatusPayload,
  KgListCommand,
  KgListPayload,
  KgNodeConfirmCommand,
  KgNodeConfirmPayload,
  KgNodeDiscardCommand,
  KgNodeDiscardPayload,
  KgNodeDetailCommand,
  KgNodeDetailPayload,
  KgProjectsCommand,
  KgReviewCreateCommand,
  KgReviewCreatePayload,
  KgTriageCreateCommand,
  KgTriageCreatePayload,
  CodeReviewCreateCommand,
  CodeReviewCreatePayload,
  ModelCatalogCommand,
  ModelCatalogRefreshCommand,
  ModelGetDefaultCommand,
  ModelSetCommand,
  ModelSetDefaultCommand,
  ModelSetThinkingDefaultCommand,
  SessionDeleteCommand,
  SessionListCommand,
  SessionLoadHistoryCommand,
  SessionInstanceChannelsCommand,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
  TaskArtifactsCommand,
  TaskArtifactsPayload,
  DiffGetCommand,
  DiffGetPayload,
  TaskCancelCommand,
  TaskDeleteCommand,
  TaskDetailCommand,
  TaskDetailPayload,
  TaskListCommand,
  TaskListPayload,
  TaskPauseCommand,
  TaskResumeCommand,
  TaskRetryCommand,
  TaskSubscribeCommand,
  TaskSubscribePayload,
  TaskUnsubscribeCommand,
  TaskUnsubscribePayload,
  TraceQueryCommand,
  TraceQueryPayload,
  ThinkingSetCommand,
  WebStartCommand,
  McpServerInput,
  McpServersAddCommand,
  McpServersListCommand,
  McpServersRemoveCommand,
  McpServersTestCommand,
  McpServersUpdateCommand,
  McpToolsListCommand,
  WebStatusCommand,
  SttStreamChunkCommand,
  SttStreamFinishCommand,
  SttStreamStartCommand,
  SttStreamStopCommand,
  SttTranscribeCommand,
  StewardAskCommand,
  StewardAskSource,
  SurfaceActionResultCommand,
  SurfaceDescriptor,
  SurfaceEventCommand,
  SurfaceEventUplinkPayload,
  SurfaceRegisterCommand,
  SurfaceUnregisterCommand,
  StewardCancelCommand,
  StewardConfirmCommand,
  StewardGetConfigCommand,
  StewardHistoryCommand,
  StewardInterruptCommand,
  StewardJudgeStopIntentCommand,
  StewardMemoryAppendCommand,
  StewardMemoryDeleteCommand,
  StewardMemoryDomain,
  StewardMemoryListCommand,
  StewardMemoryPinCommand,
  StewardMemoryRestoreCommand,
  StewardMemoryUpdateCommand,
  StewardSetConfigCommand,
  StewardSetConfigPayload,
  StewardSubscribeCommand,
  StewardUnsubscribeCommand,
  StewardActivityListCommand,
  StewardActivityClearCommand,
  StewardActivityRange,
  EmbeddingDeleteCommand,
  EmbeddingListCommand,
  EmbeddingSetCommand,
  EmbeddingSetDefaultCommand,
  EmbeddingVerifyCommand,
  ProviderDeleteCommand,
  ProviderListCommand,
  ProviderSetCommand,
  ProviderSetPayload,
  VoiceSubscribeCommand,
  VoiceSynthesizeCommand,
  VoiceSynthesizeStopCommand,
  VoiceSynthesizeStreamCommand,
  VoiceUnsubscribeCommand,
  WebStopCommand,
  WorkspaceGetCommand,
  WorkspaceOpenCommand,
  AskAnswerCommand,
} from "@helix/protocol";

export {
  chatSendCommand,
  chatSendDraftCommand,
  chatSteerCommand,
  askAnswerCommand,
  chatAbortCommand,
} from "./commands/chat";
export {
  agentKillCommand,
  agentSubscribeCommand,
  agentUnsubscribeCommand,
  agentConfigListCommand,
  agentConfigSetEnabledCommand,
  agentBasePromptGetCommand,
  agentSkillContentGetCommand,
  agentSkillCreateCommand,
  agentStewardProfileGetCommand,
} from "./commands/agent";
export {
  sessionSubscribeCommand,
  sessionUnsubscribeCommand,
  sessionListCommand,
  sessionDeleteCommand,
  sessionLoadHistoryCommand,
  sessionInstanceChannelsCommand,
} from "./commands/session";
export { workspaceGetCommand, workspaceOpenCommand } from "./commands/workspace";
export {
  modelSetCommand,
  thinkingSetCommand,
  modelCatalogCommand,
  modelCatalogRefreshCommand,
  modelGetDefaultCommand,
  modelSetThinkingDefaultCommand,
  modelSetDefaultCommand,
} from "./commands/model";
export {
  configGetCompactionCommand,
  configSetCompactionCommand,
  configGetSchedulingCommand,
  configSetSchedulingCommand,
  configGetPortCommand,
  configSetPortCommand,
  configGetSandboxCommand,
  configSetSandboxCommand,
  configGetSummaryCommand,
  configGetKgCommand,
  configSetKgCommand,
  configSetSummaryCommand,
  configGetVoiceModelsCommand,
  configSetVoiceModelsCommand,
} from "./commands/config";
export {
  authListCommand,
  authSetKeyCommand,
  authDeleteKeyCommand,
  authVerifyCommand,
} from "./commands/auth";
export { traceQueryCommand } from "./commands/trace";
export { webStatusCommand, webStopCommand, webStartCommand } from "./commands/web";
export {
  sttTranscribeCommand,
  sttStreamStartCommand,
  sttStreamChunkCommand,
  sttStreamFinishCommand,
  sttStreamStopCommand,
} from "./commands/stt";
export {
  voiceSynthesizeCommand,
  voiceSubscribeCommand,
  voiceUnsubscribeCommand,
  voiceSynthesizeStreamCommand,
  voiceSynthesizeStopCommand,
} from "./commands/voice";
export {
  surfaceRegisterCommand,
  surfaceUnregisterCommand,
  surfaceEventCommand,
  surfaceActionResultCommand,
} from "./commands/surface";
export {
  stewardAskCommand,
  stewardConfirmCommand,
  stewardCancelCommand,
  stewardSubscribeCommand,
  stewardUnsubscribeCommand,
  stewardGetConfigCommand,
  stewardSetConfigCommand,
  stewardHistoryCommand,
  stewardInterruptCommand,
  stewardJudgeStopIntentCommand,
  stewardMemoryListCommand,
  stewardMemoryAppendCommand,
  stewardMemoryUpdateCommand,
  stewardMemoryDeleteCommand,
  stewardMemoryPinCommand,
  stewardMemoryRestoreCommand,
  stewardActivityListCommand,
  stewardActivityClearCommand,
} from "./commands/steward";
export {
  embeddingListCommand,
  embeddingSetCommand,
  embeddingDeleteCommand,
  embeddingSetDefaultCommand,
  embeddingVerifyCommand,
} from "./commands/embedding";
export {
  providerListCommand,
  providerSetCommand,
  providerDeleteCommand,
} from "./commands/provider";
export {
  mcpServersListCommand,
  mcpServersAddCommand,
  mcpServersUpdateCommand,
  mcpServersRemoveCommand,
  mcpServersTestCommand,
  mcpToolsListCommand,
} from "./commands/mcp";
export {
  kgProjectsCommand,
  kgListCommand,
  kgNodeDetailCommand,
  kgChangeReportCommand,
  kgNodeConfirmCommand,
  kgNodeDiscardCommand,
  kgIndexStatusCommand,
  kgBootstrapCreateCommand,
  kgGraphPurgeCommand,
  kgIndexDeleteCommand,
  kgHealthCommand,
  kgCandidatesListCommand,
  kgTriageCreateCommand,
  kgAutoAuditCommand,
  kgReviewCreateCommand,
} from "./commands/kg";

// ── 未迁域实现（P3 分批迁移中；迁出后本段删除、改为上方导出行）──

/** code.review.create：发起代码评审任务（code-review v1.5；准入从简——无索引门槛，允许反复发起）。 */
export function codeReviewCreateCommand(payload: CodeReviewCreatePayload): CodeReviewCreateCommand {
  return { v: PROTOCOL_VERSION, type: "code.review.create", payload };
}

// ── task 族命令（T3.1；契约 contracts/task-api.md §2；iter-20260829-ys7q）──
// 本族全部为全局命令（信封 sessionId 省略——任务为 daemon 级实体）；回执 =
// task.*.result 点对点帧（SessionContext 转发层 → P-2 页面私有 reducer；
// 错误走 connection.error，生命周期词表 = 契约 §4）。零内容干预（AD-2）：
// 无 steer 命令（不给在跑任务插话改内容）；**人工复活 = task.retry**（仅
// failed→running，非内容干预）。命令清单以本文件构造器为单源（正文不写
// 计数快照——TR-206）。

/** task.list：全局平铺列表（服务端排序 = 运行中置顶+创建时间倒序；
 *  过滤器入参服务端生效，页面另持客户端镜像派生）。 */
export function taskListCommand(payload: TaskListPayload = {}): TaskListCommand {
  return { v: PROTOCOL_VERSION, type: "task.list", payload };
}

/** task.detail：阶段条 + 当前阶段批次 + 实例 plan + 叙述句（R-4~R-8）。 */
export function taskDetailCommand(payload: TaskDetailPayload): TaskDetailCommand {
  return { v: PROTOCOL_VERSION, type: "task.detail", payload };
}

/** task.artifacts：阶段产物只读投影（F3.4；节点修正转 /project 页 AD-10）。 */
export function taskArtifactsCommand(payload: TaskArtifactsPayload): TaskArtifactsCommand {
  return { v: PROTOCOL_VERSION, type: "task.artifacts", payload };
}

/** task.subscribe：连接级订阅（缺省 jobId = 订阅全部变更；重连重发）。 */
export function taskSubscribeCommand(payload: TaskSubscribePayload = {}): TaskSubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "task.subscribe", payload };
}

/** task.unsubscribe：清空订阅集（对称语义）。 */
export function taskUnsubscribeCommand(payload: TaskUnsubscribePayload = {}): TaskUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "task.unsubscribe", payload };
}

/** task.pause：仅 running→paused（O-2 停派新批次+在跑自然收口）。 */
export function taskPauseCommand(jobId: string): TaskPauseCommand {
  return { v: PROTOCOL_VERSION, type: "task.pause", payload: { jobId } };
}

/** task.resume：仅 paused→running（断点恢复同路径）。 */
export function taskResumeCommand(jobId: string): TaskResumeCommand {
  return { v: PROTOCOL_VERSION, type: "task.resume", payload: { jobId } };
}

/** task.cancel：pending/running/paused→cancelled 终态（在跑批次 SIGTERM）。 */
export function taskCancelCommand(jobId: string): TaskCancelCommand {
  return { v: PROTOCOL_VERSION, type: "task.cancel", payload: { jobId } };
}

/** task.retry：仅 failed→running 人工复活（批次预算归零留痕 + failed 阶段重开 + 重开编排）。 */
export function taskRetryCommand(jobId: string): TaskRetryCommand {
  return { v: PROTOCOL_VERSION, type: "task.retry", payload: { jobId } };
}

/** task.delete：仅终态可删；清任务域全部记录不触 kg 产出（F3.6）。 */
export function taskDeleteCommand(jobId: string): TaskDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "task.delete", payload: { jobId } };
}

// ── diff 族命令（T3+T4 diff 批；契约 PROTOCOL.md §15 diff 域）────────────

/** diff.get：轮次 diff 详情查询（session 作用域——信封 sessionId 必填；
 *  turnId 缺省 = 最近冻结轮 / live:true = 进行中轮实时视图；点对点回执
 *  diff.get.result 经 subscribeDiffFrames 转发）。 */
export function diffGetCommand(payload: DiffGetPayload, sessionId: string): DiffGetCommand {
  return { v: PROTOCOL_VERSION, type: "diff.get", sessionId, payload };
}

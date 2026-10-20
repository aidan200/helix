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

// ── 未迁域实现（P3 分批迁移中；迁出后本段删除、改为上方导出行）──

// ── embedding 配置域（管家记忆 B2）：端点 CRUD + 连通测试（向量模型 tab）──
// 回执 = embedding.list.result（list/set/delete 共用）/ embedding.verify.result。

/** embedding.list：端点清单读面（凭据卫生视图——行含 hasApiKey/verifiedAt）。 */
export function embeddingListCommand(): EmbeddingListCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.list", payload: {} };
}

/** embedding.set：新增（id 缺省）/更新端点（apiKey 空串 = 清除；kind
 *  可选——缺省 embedding，classifier = 分类判官端点，更新缺省不动）。 */
export function embeddingSetCommand(payload: {
  id?: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  kind?: "embedding" | "classifier";
  variant?: string;
}): EmbeddingSetCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.set", payload };
}

/** embedding.delete：删除端点（回执新清单）。 */
export function embeddingDeleteCommand(id: string): EmbeddingDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.delete", payload: { id } };
}

/** embedding.set_default：设置全局默认端点（批1 向量默认；D1 泛化 kind 维度
 *  ——kind 缺省 = embedding，"classifier" = 默认分类端点；单选语义，
 *  校验三拒（不存在/kind 不吻合/未 verify）在 daemon，回执新清单）。 */
export function embeddingSetDefaultCommand(id: string, kind?: "embedding" | "classifier"): EmbeddingSetDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.set_default", payload: { id, ...(kind !== undefined ? { kind } : {}) } };
}

/** embedding.verify：连通测试（回执 embedding.verify.result 两判别，id 回携）。 */
export function embeddingVerifyCommand(id: string): EmbeddingVerifyCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.verify", payload: { id } };
}

// ── provider 族命令（三方平台批：自定义 OpenAI 兼容平台 CRUD；全局命令）
// 回执 = provider.list.result 点对点（list/set/delete 三命令共用——写后
// 即刷新清单）；key 录入/连通验证走既有 auth 族（不另设通路）。

/** provider.list：三方平台清单读面。 */
export function providerListCommand(): ProviderListCommand {
  return { v: PROTOCOL_VERSION, type: "provider.list", payload: {} };
}

/** provider.set：新增/更新平台（按 id upsert；id = 模型字符串前缀）。 */
export function providerSetCommand(payload: ProviderSetPayload): ProviderSetCommand {
  return { v: PROTOCOL_VERSION, type: "provider.set", payload };
}

/** provider.delete：删除平台（回执新清单）。 */
export function providerDeleteCommand(id: string): ProviderDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "provider.delete", payload: { id } };
}

// ── mcp 族命令（mcp 批：MCP server 标准接入；六命令全全局命令）────
// 回执 = mcp.*.result 点对点；状态迁移经 mcp.status.changed 全局广播
//（设置页 server 徽标实时数据源）。

/** mcp.servers.list：全部 server 配置+运行态读面。 */
export function mcpServersListCommand(): McpServersListCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.list", payload: {} };
}

/** mcp.servers.add：新增 server（落盘+连接+发现；applied/connect_failed 两判别）。 */
export function mcpServersAddCommand(payload: McpServerInput): McpServersAddCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.add", payload };
}

/** mcp.servers.update：按 name 覆盖配置（断旧连重连）。 */
export function mcpServersUpdateCommand(payload: McpServerInput): McpServersUpdateCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.update", payload };
}

/** mcp.servers.remove：断连+摘工具+落盘。 */
export function mcpServersRemoveCommand(payload: { name: string }): McpServersRemoveCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.remove", payload };
}

/** mcp.servers.test：试连（不落盘不接入；applied/failed 两判别）——配置
 *  页「测试连接」。 */
export function mcpServersTestCommand(payload: McpServerInput): McpServersTestCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.test", payload };
}

/** mcp.tools.list：指定 server 已发现工具清单（命名空间后全名）。 */
export function mcpToolsListCommand(payload: { server: string }): McpToolsListCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.tools.list", payload };
}

// ── kg 族命令（契约 v0.11 kg 批，contracts/kg-viewer-api.md；T5.4）────
// 六命令全部全局命令（信封 sessionId 省略）；五个图谱命令 payload 必填
// project（名称或绝对路径，daemon 单点解析）；kg.projects 无参。回执 =
// kg.*.result 点对点帧（O-6 轮询裁决零推送事件）。

/** kg.projects：workspace 项目列表（F5.0 左栏数据源；宽松口径含 absent）。 */
export function kgProjectsCommand(): KgProjectsCommand {
  return { v: PROTOCOL_VERSION, type: "kg.projects", payload: {} };
}

/** kg.list：节点列表+搜索（F5.1；q×kind×status 三路过滤可叠加，均可省略）。 */
export function kgListCommand(payload: KgListPayload): KgListCommand {
  return { v: PROTOCOL_VERSION, type: "kg.list", payload };
}

/** kg.node.detail：节点详情六段聚合（F5.2）。 */
export function kgNodeDetailCommand(payload: KgNodeDetailPayload): KgNodeDetailCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.detail", payload };
}

/** kg.change.report：知识变化报告（F5.3；iterationId 缺省 = 当前迭代）。 */
export function kgChangeReportCommand(payload: KgChangeReportPayload): KgChangeReportCommand {
  return { v: PROTOCOL_VERSION, type: "kg.change.report", payload };
}

/** kg.node.confirm：draft 审阅转正（F5.4 页面唯一写动作；仅 draft 可转正）。 */
export function kgNodeConfirmCommand(payload: KgNodeConfirmPayload): KgNodeConfirmCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.confirm", payload };
}

/** kg.node.discard：草稿人审驳回（P5 裁决动作集之二——supersede 无 replacement 留审计链，仅 draft 可驳回）。 */
export function kgNodeDiscardCommand(payload: KgNodeDiscardPayload): KgNodeDiscardCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.discard", payload };
}

/** kg.index.status：索引状态四态面板（F5.5；rebuild:true = 触发构建/重建，
 *  absent 态触发即首次构建 B1；O-6 前端轮询本命令获取进度）。 */
export function kgIndexStatusCommand(payload: KgIndexStatusPayload): KgIndexStatusCommand {
  return { v: PROTOCOL_VERSION, type: "kg.index.status", payload };
}

// ── kg-bootstrap 批五命令（iter-20260829-ys7q T3.2；契约 contracts/kg-bootstrap-api.md）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。
// V-1：产出即 confirmed 无草稿；修正 = update/supersede（理由必填）；连带 =
// impact 只读推导（不落库零自动写）。

/** kg.bootstrap.create：发起 bootstrap 任务（CL-1；后端准入机械复核 + createTask 同源）。 */
export function kgBootstrapCreateCommand(payload: KgBootstrapCreatePayload): KgBootstrapCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.bootstrap.create", payload };
}

// ── kg 维护批两命令（C1；契约 PROTOCOL-CHANGELOG.md §22）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。
// 职责分层：purge 清 kg 库全部内容（不动 .codegraph）；index.delete 删索引
// 目录（不动知识层）。

/** kg.graph.purge：清空图谱（危险操作——UI 两步确认；daemon 门禁：运行中 kg-bootstrap 任务拒绝）。 */
export function kgGraphPurgeCommand(payload: KgGraphPurgePayload): KgGraphPurgeCommand {
  return { v: PROTOCOL_VERSION, type: "kg.graph.purge", payload };
}

/** kg.index.delete：删除索引（停 watcher + 删 .codegraph + 状态复位 absent；可重建）。 */
export function kgIndexDeleteCommand(payload: KgIndexDeletePayload): KgIndexDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "kg.index.delete", payload };
}

// ── kg.health 批 + kg 评审批命令（W2-E 体检看板 / W2-F 轨二；契约 PROTOCOL.md §15.9/§23）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。

/** kg.health：结构体检五项读面聚合（只列不修零写路径；absent 短路空态不建库）。 */
export function kgHealthCommand(payload: KgHealthPayload): KgHealthCommand {
  return { v: PROTOCOL_VERSION, type: "kg.health", payload };
}

/** kg.candidates.list：候选台账列表（status 四态过滤 + 分页；行含 body 全文；只读零裁决）。 */
export function kgCandidatesListCommand(payload: KgCandidatesListPayload): KgCandidatesListCommand {
  return { v: PROTOCOL_VERSION, type: "kg.candidates.list", payload };
}

/** kg.triage.create：发起待办面裁决任务（kg-triage；准入 = 索引存在 + 待办非空 + 仅禁并发）。 */
export function kgTriageCreateCommand(payload: KgTriageCreatePayload): KgTriageCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.triage.create", payload };
}

/** kg.auto.audit：自动裁决审计读面（auto: 前缀聚合 + 抽查条目；只读）。 */
export function kgAutoAuditCommand(payload: KgAutoAuditPayload): KgAutoAuditCommand {
  return { v: PROTOCOL_VERSION, type: "kg.auto.audit", payload };
}

/** kg.review.create：发起语义体检任务（准入从简 = 索引存在即可，允许反复发起）。 */
export function kgReviewCreateCommand(payload: KgReviewCreatePayload): KgReviewCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.review.create", payload };
}

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

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

// ── 未迁域实现（P3 分批迁移中；迁出后本段删除、改为上方导出行）──

/** config.get_compaction：压缩参数读面（全局命令）。 */
export function configGetCompactionCommand(): ConfigGetCompactionCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_compaction", payload: {} };
}

/** config.set_compaction：压缩参数写面（全局命令；token 绝对值）。 */
export function configSetCompactionCommand(reserveTokens: number, keepRecentTokens: number): ConfigSetCompactionCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_compaction", payload: { reserveTokens, keepRecentTokens } };
}

/** config.get_scheduling：SubAgent 调度预算读面（全局命令；config 瘦身批）。 */
export function configGetSchedulingCommand(): ConfigGetSchedulingCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_scheduling", payload: {} };
}

/** config.set_scheduling：调度预算写面（全局命令；运行期可调）。 */
export function configSetSchedulingCommand(maxConcurrent: number, maxQueued: number): ConfigSetSchedulingCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_scheduling", payload: { maxConcurrent, maxQueued } };
}

/** config.get_port：WS 端口读面（全局命令；含 argv 覆盖信息）。 */
export function configGetPortCommand(): ConfigGetPortCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_port", payload: {} };
}

/** config.set_port：WS 端口写面（全局命令；下次启动生效）。 */
export function configSetPortCommand(port: number): ConfigSetPortCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_port", payload: { port } };
}

/** config.get_sandbox：沙箱开关读面（全局命令；沙箱开关批）。 */
export function configGetSandboxCommand(): ConfigGetSandboxCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_sandbox", payload: {} };
}

/** config.set_sandbox：沙箱配置写面（全局命令；enabled/extraRoots 新会话/新任务生效，autoApprove 立即生效）。
 * 部分更新语义：enabled/extraRoots/autoApprove 任选至少一项，未携带项保留现值。 */
export function configSetSandboxCommand(patch: { enabled?: boolean; extraRoots?: string[]; autoApprove?: boolean }): ConfigSetSandboxCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_sandbox", payload: patch };
}

/** config.get_summary：总结配置读面（全局命令；总结器独立化批①）。 */
export function configGetSummaryCommand(): ConfigGetSummaryCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_summary", payload: {} };
}

/** config.get_kg：知识库配置读面（全局命令；批2 WP-C「知识库」配置组——查重阈值）。 */
export function configGetKgCommand(): ConfigGetKgCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_kg", payload: {} };
}

/** config.set_kg：查重阈值写面（全局命令；运行期即热）。
 * 部分更新语义：携带项写入，未携带项保留现值；回执恒回生效值。 */
export function configSetKgCommand(patch: {
  similarityWarn?: number;
  similarityDup?: number;
}): ConfigSetKgCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_kg", payload: patch };
}

/** config.set_summary：总结配置写面（全局命令；运行期即热）。
 * 部分更新语义：携带项写入，未携带项保留现值。 */
export function configSetSummaryCommand(patch: {
  enabled?: boolean;
  everyTurns?: number;
  model?: string | null;
  task?: { enabled?: boolean; model?: string | null };
}): ConfigSetSummaryCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_summary", payload: patch };
}

/** config.get_voice_models：ASR/TTS 模型配置读面（全局命令；模型配置接入 P0）。 */
export function configGetVoiceModelsCommand(): ConfigGetVoiceModelsCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_voice_models", payload: {} };
}

/** config.set_voice_models：ASR/TTS 模型配置写面（运行期即热）。
 * 部分更新语义：携带项写入，未携带项保留现值；字段空串 = 回落默认值。 */
export function configSetVoiceModelsCommand(patch: {
  sttModel?: string;
  sttSiliconflowModel?: string;
  sttRealtimeModel?: string;
  ttsModel?: string;
  ttsStreamModel?: string;
}): ConfigSetVoiceModelsCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_voice_models", payload: patch };
}

/** auth.list：provider 凭据清单（全局命令；P-4 列表数据）。 */
export function authListCommand(): AuthListCommand {
  return { v: PROTOCOL_VERSION, type: "auth.list", payload: {} };
}

/** auth.set_key：写 ~/.helix/auth.json（全局命令；P-4 key 弹层保存）。 */
export function authSetKeyCommand(providerId: string, apiKey: string): AuthSetKeyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId, apiKey } };
}

/** auth.delete_key：删 key（全局命令；P-4 两段式删除二击）。 */
export function authDeleteKeyCommand(providerId: string): AuthDeleteKeyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.delete_key", payload: { providerId } };
}

/** auth.verify：连通验证（全局命令；P-4 测试连通）。 */
export function authVerifyCommand(providerId: string): AuthVerifyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.verify", payload: { providerId } };
}

// ── trace 命令族（契约 v0.4 §1；T2.2 P-1 TracePage）────────

/** trace.query：会话历史事件查询（连接私有读面；信封 sessionId 位不消费，
 *  目标会话在 payload.sessionId；结果 = trace.query.result 点对点回执）。 */
export function traceQueryCommand(payload: TraceQueryPayload): TraceQueryCommand {
  return { v: PROTOCOL_VERSION, type: "trace.query", payload };
}

/** web.status：CDP 连接状态读面（全局命令；回执 = web.status.result 点对点）。 */
export function webStatusCommand(): WebStatusCommand {
  return { v: PROTOCOL_VERSION, type: "web.status", payload: {} };
}

/** web.stop：手动停止写面（全局命令；回执 = web.stop.result 点对点 +
 *  状态回 idle 经 web.status.changed 全局广播）。 */
export function webStopCommand(): WebStopCommand {
  return { v: PROTOCOL_VERSION, type: "web.stop", payload: {} };
}

/** web.start：显式启动写面（v0.9，T7；全局命令；回执 = web.start.result
 *  点对点 applied/skipped + 状态回流经 web.status.changed 全局广播）。 */
export function webStartCommand(): WebStartCommand {
  return { v: PROTOCOL_VERSION, type: "web.start", payload: {} };
}

/**
 * stt.transcribe：一次性音频转写（语音输入批 V1；回执 =
 * stt.transcribe.result 点对点两判别）。会话作用域可选：信封 sessionId
 * 携带时 daemon 组装会话词汇表（P1 源）+ 归属自查；省略 = 裸转写。
 */
export function sttTranscribeCommand(
  audio: string,
  opts?: { language?: string; provider?: string },
  sessionId?: string,
): SttTranscribeCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "stt.transcribe",
    ...(sessionId !== undefined ? { sessionId } : {}),
    payload: { audio, ...(opts?.language !== undefined ? { language: opts.language } : {}), ...(opts?.provider !== undefined ? { provider: opts.provider } : {}) },
  };
}

// ── stt.stream 族命令（V3b-1 流式转写）：开流/音频块上行/收口/中止 ──
// 回执/帧 = stt.stream.started / .interim / .final 点对点（streamId 门控）。

/** stt.stream.start：开流（语言提示可选；provider 缺省 = daemon 自动选择）。 */
export function sttStreamStartCommand(opts?: { language?: string; provider?: string }): SttStreamStartCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "stt.stream.start",
    payload: {
      ...(opts?.language !== undefined ? { language: opts.language } : {}),
      ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
    },
  };
}

/** stt.stream.chunk：音频块上行（base64 PCM 16k mono ~100ms；无 ack）。 */
export function sttStreamChunkCommand(audio: string): SttStreamChunkCommand {
  return { v: PROTOCOL_VERSION, type: "stt.stream.chunk", payload: { audio } };
}

/** stt.stream.finish：正常收口（终帧经 stt.stream.final）。 */
export function sttStreamFinishCommand(): SttStreamFinishCommand {
  return { v: PROTOCOL_VERSION, type: "stt.stream.finish", payload: {} };
}

/** stt.stream.stop：中止（不期终帧；面板卸载/废弃流）。 */
export function sttStreamStopCommand(): SttStreamStopCommand {
  return { v: PROTOCOL_VERSION, type: "stt.stream.stop", payload: {} };
}

// ── voice 族命令（语音播报批 V2 TTS）：试听合成 + 连接级订阅闸门 ────
// 回执 = voice.synthesize.result 点对点；广播经 voice.broadcast
//（仅已订阅连接收）。偏好存 localStorage（voice-pref.ts，V1 STT 同构）。

/** voice.synthesize：一次性合成（设置页试听；全局命令）。 */
export function voiceSynthesizeCommand(text: string, opts?: { voice?: string; language?: string }): VoiceSynthesizeCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "voice.synthesize",
    payload: { text, ...(opts?.voice !== undefined ? { voice: opts.voice } : {}), ...(opts?.language !== undefined ? { language: opts.language } : {}) },
  };
}

/** voice.subscribe：播报订阅（音色偏好随命令携带；全局命令）。 */
export function voiceSubscribeCommand(voice?: string): VoiceSubscribeCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "voice.subscribe",
    payload: { ...(voice !== undefined ? { voice } : {}) },
  };
}

/** voice.unsubscribe：播报退订（断连自动等效；全局命令）。 */
export function voiceUnsubscribeCommand(): VoiceUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "voice.unsubscribe", payload: {} };
}

// ── 流式 TTS 批（V3b-2 接线：管家回答边出边合成边播；帧回推 chunk/done/error
//    无命令回执——回退链第一级失败面）──

/** voice.synthesize.stream：单句流式合成（全局命令；utterId 连接内唯一单调）。 */
export function voiceSynthesizeStreamCommand(utterId: string, text: string, opts?: { voice?: string }): VoiceSynthesizeStreamCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "voice.synthesize.stream",
    payload: { utterId, text, ...(opts?.voice !== undefined ? { voice: opts.voice } : {}) },
  };
}

/** voice.synthesize.stop：中正在途流式合成（utterId 省略 = 全部在途句）。 */
export function voiceSynthesizeStopCommand(utterId?: string): VoiceSynthesizeStopCommand {
  return { v: PROTOCOL_VERSION, type: "voice.synthesize.stop", payload: { ...(utterId !== undefined ? { utterId } : {}) } };
}

// ── surface 族命令（M0 表面协议地基批）：注册/事件上行/动作回执 ──
// 全局命令（信封省略 sessionId——表面是连接级概念，E-84）；上行 = 表面→
// daemon（SurfaceRegistry 归一/路由/销账）。

/** surface.register：表面自述注册（幂等；回执 surface.registered 点对点）。 */
export function surfaceRegisterCommand(descriptor: SurfaceDescriptor): SurfaceRegisterCommand {
  return { v: PROTOCOL_VERSION, type: "surface.register", payload: { descriptor } };
}

/** surface.unregister：注销（断连自动等效）。 */
export function surfaceUnregisterCommand(): SurfaceUnregisterCommand {
  return { v: PROTOCOL_VERSION, type: "surface.unregister", payload: {} };
}

/** surface.event：页面级事件上行（感知开关默认 off——off 时 adapter 不发）。 */
export function surfaceEventCommand(payload: SurfaceEventUplinkPayload): SurfaceEventCommand {
  return { v: PROTOCOL_VERSION, type: "surface.event", payload };
}

/** surface.action.result：动作执行回执（D7-1 seq 对账；呈现即回）。 */
export function surfaceActionResultCommand(seq: number, ok: boolean, detail?: string): SurfaceActionResultCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "surface.action.result",
    payload: { seq, ok, ...(detail !== undefined ? { detail } : {}) },
  };
}

// ── steward 族命令（V2.5 文本管家）：对话 + 确认闸 + feed 订阅 + 设置面 ──
// 回执 = steward.ask.result / confirm.result / config.result 点对点；
// feed 文本行经 steward.feed 广播（仅已订阅连接收）。

/** steward.ask：对话一轮（全局命令；五判别回执 answer/confirm_required/queued/dropped/error）。 */
export function stewardAskCommand(text: string, source?: StewardAskSource): StewardAskCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.ask",
    payload: { text, ...(source !== undefined ? { source } : {}) },
  };
}

/** steward.confirm：确认闸放行（actionId 单次消费；全局命令）。 */
export function stewardConfirmCommand(actionId: string): StewardConfirmCommand {
  return { v: PROTOCOL_VERSION, type: "steward.confirm", payload: { actionId } };
}

/** steward.cancel：确认卡作废（B1 两段式确认批；全局命令；无回执帧——
 *  放弃是本地即时收场，daemon 侧 pending 簿记同步，interrupt 同构先例）。 */
export function stewardCancelCommand(actionId: string): StewardCancelCommand {
  return { v: PROTOCOL_VERSION, type: "steward.cancel", payload: { actionId } };
}

/** steward.subscribe：事件 feed 连接级订阅登记（全局命令）。 */
export function stewardSubscribeCommand(): StewardSubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "steward.subscribe", payload: {} };
}

/** steward.unsubscribe：feed 退订（断连自动等效；全局命令）。 */
export function stewardUnsubscribeCommand(): StewardUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "steward.unsubscribe", payload: {} };
}

/** steward.get_config：设置读面（全局命令；回执 steward.config.result）。 */
export function stewardGetConfigCommand(): StewardGetConfigCommand {
  return { v: PROTOCOL_VERSION, type: "steward.get_config", payload: {} };
}

/** 槽位载荷 undefined 键剥离（缺省不携带键——帧噪音最小化）：手维护逐字段
 * 白名单的泛化替身。白名单坑型两复发（memory B2 批 / summary 语音播报摘要
 * 批）：新增槽位漏进白名单即出门被剥成 {}，daemon 收空补丁回执原样，UI
 * 受控勾选框点了弹回；透传变量逃过 TS 超属性检查编译零报错——TR-159
 * 命令路径实例。SoT 载荷类型直收 + 本替身后新增配置组自动透传零维护。 */
function stripUndefinedSlots<T extends object>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as T;
}

/** steward.set_config：设置写面（槽位均可选——只更新携带位；全局命令；
 * 管家记忆 B2 memory 组瘦身——{enabled?,endpointId?}（端点 CRUD 收编
 * embedding 配置域，endpointId 引用其条目）；B4a +judgeEndpointId
 * （classifier 端点引用——判官自动沉淀）；语音播报摘要批 +summary
 * {enabled?,model?}（独立槽位——无默认模型）。参数直收协议 SoT 载荷类型。 */
export function stewardSetConfigCommand(patch: StewardSetConfigPayload): StewardSetConfigCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.set_config",
    payload: stripUndefinedSlots(patch),
  };
}

/** steward.history：工作记忆读/清（A1 批；clear=true 新对话三处同清；
 *  回执 steward.history.result 携完整记录数组——回放同源）。 */
export function stewardHistoryCommand(clear?: boolean): StewardHistoryCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.history",
    payload: clear === true ? { clear: true } : {},
  };
}

/** steward.interrupt：在途轮打断（B2 barge-in 批；批 3b 增 scope——缺省
 *  current 轻停只停当前轮；all = 全停 abort 当前 + 清空 daemon ask 队列，
 *  语音停止判定通道；无回执帧，事件面 loop.run.interrupted + ask 终态已够）。 */
export function stewardInterruptCommand(reason?: string, scope?: "current" | "all"): StewardInterruptCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.interrupt",
    payload: {
      ...(reason === undefined ? {} : { reason }),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

/** steward.judge_stop_intent：停止意图判定（Jev 单轨——停止词表退役批，
 *  回执 steward.judge_stop_intent.result 点对点）。判定语义归 daemon 判官
 *  （零生成 token 分类判定）；判不出（降级/超时/不可达）的 fail-stop 归
 *  消费面（shell 打断链判不出=真停）。 */
export function stewardJudgeStopIntentCommand(text: string): StewardJudgeStopIntentCommand {
  return { v: PROTOCOL_VERSION, type: "steward.judge_stop_intent", payload: { text } };
}

// ── 管家记忆 B2：长期记忆条目管理（读/人工新增/重嵌更新/行级删除；四命令
//    共用回执 steward.memory_list.result——写后即回新清单）────────────

/** steward.memory_list：条目读面（全局命令；回执 steward.memory_list.result）。 */
export function stewardMemoryListCommand(): StewardMemoryListCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_list", payload: {} };
}

/** steward.memory_append：人工新增（embed 入库；kind 缺省 fact；domain
 *  缺省按 kind 推导（preference→habit、fact→general），projectScope =
 *  项目名显式通道（与 domain=project 配对）——逐字段透传 TR-159）。 */
export function stewardMemoryAppendCommand(
  text: string,
  kind?: "fact" | "preference",
  domain?: StewardMemoryDomain,
  projectScope?: string,
): StewardMemoryAppendCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.memory_append",
    payload: {
      text,
      ...(kind !== undefined ? { kind } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(projectScope !== undefined && projectScope.trim() !== "" ? { projectScope } : {}),
    },
  };
}

/** steward.memory_update：条目文本更新（重嵌；回执新清单）。 */
export function stewardMemoryUpdateCommand(id: number, text: string): StewardMemoryUpdateCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_update", payload: { id, text } };
}

/** steward.memory_delete：行级删除（回执新清单）。 */
export function stewardMemoryDeleteCommand(id: number): StewardMemoryDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_delete", payload: { id } };
}

/** steward.memory_pin：置顶切换（遗忘机制批；置顶永不淡忘永不 GC；
 *  置顶隐含解除淡忘 + 刷 updatedAt 浮顶；回执新清单）。 */
export function stewardMemoryPinCommand(id: number, pinned: boolean): StewardMemoryPinCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_pin", payload: { id, pinned } };
}

/** steward.memory_restore：淡忘条目恢复（遗忘机制批；active 条目幂等
 *  no-op；回执新清单）。 */
export function stewardMemoryRestoreCommand(id: number): StewardMemoryRestoreCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_restore", payload: { id } };
}

// ── 管家活动账（M3-d1 感知兑现批）：时间线页数据源 ──────────────────
// 回执 = steward.activity.result（list/clear 两命令共用）；实时帧
// steward.activity 经 subscribeStewardFrames 消费。

/** steward.activity.list：时间窗查询（range 缺省 today；limit 缺省 200）。 */
export function stewardActivityListCommand(range?: StewardActivityRange, limit?: number): StewardActivityListCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.activity.list",
    payload: {
      ...(range !== undefined ? { range } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  };
}

/** steward.activity.clear：落盘条目全清（回执空窗新态；幂等）。 */
export function stewardActivityClearCommand(): StewardActivityClearCommand {
  return { v: PROTOCOL_VERSION, type: "steward.activity.clear", payload: {} };
}

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

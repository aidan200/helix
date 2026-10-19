/**
 * StewardService —— V2.5 文本管家 application service（设计 §2 三分法 /
 * §5.2 权限分级 / §5.3 ①②层；文本形态架构验证——语音版 V3 直接套壳）。
 *
 * 三类能力（任务 brief 口径）：
 * ① 只读状态问答直达：LLM 循环（flash 级槽位独立配置）经 list_instances /
 *    list_tasks 只读工具取数 → answer 直答（决策收口 application 层，E-19
 *    handlers 只转发）；
 * ② 写注入唯一原语 = propose_send（agent_send 等价——AgentOrchestrationPort
 *    .send steer 注入通道）：**必须过确认闸**——LLM 只能提案（confirm_required
 *    回执携带 actionId + 全文），面板确认按钮 → confirm(actionId) 单次消费执行；
 *    未确认 = 零执行（§5.2 防火墙）；
 * ③ 事件 feed：agent 生命周期事件（wireEventFanout steward-feed-bridge 装配）
 *    → ①层粗筛（生命周期子集）→ ②层模板直出（中文文本行，不进 LLM——
 *    BroadcastService 先例同构）→ steward.feed 帧（仅已订阅连接，连接级闸门）。
 *
 * money gate（服务端权威）：steward.enabled ≠ "1" → ask 直接 error 判别，
 * 零 LLM 调用（RuntimeConfigPort KV 持久化，steward.set_config 写面）。
 *
 * 防自激循环（TR-169/TR-173 族纪律）：本服务订阅事件流只产出协议帧
 * （steward.feed——不 publish 领域事件），写注入只由离散用户动作（面板确认
 * 按钮）驱动——事件订阅面与写面无反馈边，结构上无环。
 *
 * 对话状态仅会话内（不持久化——任务范围钳制）：滚动窗口截尾，daemon 重启
 * 即清（与「不是第二个大脑」的上下文不分裂原则一致：只持全局状态摘要 +
 * 自身对话状态，工作上下文留在各 session/agent）。
 */
import type { DomainEvent } from "../../domain/events/DomainEvent";
import { STEWARD_TUNING_DEFAULTS, type StewardTuning } from "../../domain/steward/tuning/StewardTuning";
import type { StewardComponent } from "./StewardComponent";
import {
  ProposalLedger,
  pendingKeyOf,
  type PendingAction,
  type PendingEntry,
} from "../../domain/steward/confirmation/ProposalLedger";
import { StewardRun } from "../../domain/steward/run/StewardRun";
import { judgeOrFallback } from "../../domain/steward/utterance/JudgePolicy";
import { judgeRunWatchdog } from "../../domain/steward/run/RunWatchdog";
import { AskQueue } from "../../domain/steward/run/AskQueue";
import { StewardToolKit } from "./tools/StewardToolKit";

// 确认闸聚合域 re-export（批 1：定义已迁 domain/steward/confirmation——
// 兼容既有引用面；行为零变更）
export { pendingKeyOf } from "../../domain/steward/confirmation/ProposalLedger";
export type { PendingAction, PendingEntry } from "../../domain/steward/confirmation/ProposalLedger";
import type {
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
  AgentParkedPayload,
  AgentResumedPayload,
  AgentSpawnedPayload,
} from "../../domain/events/DomainEvent";
import type {
  StewardLlmPort,
  StewardLlmMessage,
  StewardLlmTool,
  StewardLlmContentBlock,
} from "../ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { AgentOrchestrationPort } from "../ports/inbound/AgentOrchestrationPort";
import type {
  StewardActionCompletedPayload,
  StewardAskErrorKind,
  StewardAskResultPayload,
  StewardConfirmResultPayload,
  StewardFeedPayload,
  StewardHistoryRecord,
  StewardNavigatePayload,
  StewardMemoryWrittenPayload,
  StewardNotifyPayload,
  StewardProactivePayload,
  StewardAskSource,
} from "@helix/protocol";
import { matchStewardConfirmPhrase, matchStewardCancelPhrase } from "@helix/protocol";
import { StewardDialogMemory } from "./StewardDialogMemory";
import type { StewardMemoryService } from "./StewardMemoryService";
import type { TriageJudgeFace, TriageJudgeState } from "./StewardTriageJudge";
import {
  STEWARD_ADDRESSEE_QUESTION,  STEWARD_INTENT_JUDGE_CANCEL_QUESTION,
  STEWARD_INTENT_JUDGE_CONFIRM_QUESTION,
  STEWARD_INTENT_JUDGE_REVISE_QUESTION,
  buildIntentJudgeState,
  buildIntentReviseAskText,
  isAmbientSpeech,
  STEWARD_STOP_QUESTION,
  isStopIntent,
  pickIntentByScores,
  type IntentJudgeFace,
} from "./StewardIntentJudge";
import type { AgentEngineEvent, AgentEngineListener, AgentEnginePort } from "../ports/outbound/AgentEnginePort";
import type { StewardToolSpec } from "../ports/outbound/StewardToolSpec";
import type { StewardSurfacePort, StewardSurfaceActRequest } from "../ports/outbound/StewardSurfacePort";
import { evaluateSurfaceRisk, surfaceRiskRank } from "../surface/SurfaceRiskGate";
import {
  isSurfaceNamespaceKind,
  isSurfaceVerb,
  surfaceVerbRisk,
  validateSurfaceActArgs,
  type SurfaceRisk,
} from "@helix/protocol";
import { STEWARD_COMPACTION_SUMMARY_PROMPT } from "./stewardPrompts";
import { readSummaryConfig } from "../summary/summaryConfig";

/** 挂闸校验上下文（中立——原 GateToolContext 的 application 形态）。 */
export interface GateToolContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/** 挂闸校验结果（中立——原 {pause, outcome} 判别：result/terminate 两出口）。 */
export type GateToolOutcome =
  | { readonly kind: "result"; readonly text: string; readonly isError?: boolean }
  | { readonly kind: "terminate"; readonly reason: string };

/** args 摘要（feed 帧面——JSON 截断 120 字符）。 */
export function summarizeArgsLite(args: unknown): string {
  try {
    const json = JSON.stringify(args) ?? "null";
    return json.length > 120 ? `${json.slice(0, 120)}…` : json;
  } catch {
    return "(unserializable)";
  }
}

/** 豁免旗标嗅探（M2 突变面）：任何「免确认」企图位——闸面整单拒绝。 */
export function hasExemptionAffordance(args: Record<string, unknown>): boolean {
  for (const key of ["exempt", "auto_confirm", "autoConfirm", "skip_confirmation", "skipConfirm", "confirmed"]) {
    if (args[key] === true) return true;
  }
  return false;
}

/** act 回执文本（带序列号回流——D7-1）。 */
export function formatActReceipt(result: { ok: boolean; seq: number; detail: string }): string {
  return `动作回执（seq=${result.seq}）：${result.ok ? "成功" : "失败"}——${result.detail}`;
}

/** 块集文本派生（port 块模型——text 块拼接；原 loopBlocksText 的 port 形态）。 */
function portBlocksText(blocks: readonly import("../ports/outbound/StewardLlmPort").StewardLlmContentBlock[]): string {
  return blocks.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
}

/** feed ①层粗筛集合单源（agent 生命周期事件流子集；扩集合改此处 + 测试同步）。 */
export const STEWARD_FEED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.spawned",
  "agent.completed",
  "agent.failed",
  "agent.killed",
  "agent.parked",
  "agent.resumed",
]);

/** 工具轮上限（成本护栏：连环工具调用熔断——超限 error 判别，不无限循环）。 */
export const STEWARD_MAX_TOOL_ROUNDS = 6;

/** feed 文本行摘要截断上限（~80 字符——BroadcastService 先例同构）。 */
export const FEED_SUMMARY_MAX_CHARS = 80;

/** 会话内对话滚动窗口（旧制；A1 批被工作记忆 KV token 预算闸取代——
 *  常量保留供历史注释面参照，不再参与裁剪）。 */
export const HISTORY_WINDOW = 24;

/** 工具结果送 LLM 前的体量上限（A1-hotfix；生产实证单条 list_instances
 *  toolResult 可达 537,026 字符 ≈ 27 万 token = 16k 预算的 17 倍——病理体量
 *  直达上下文会挤掉全部对话并触发裁剪而毒孤儿）。 */
export const TOOL_RESULT_MAX_CHARS = 4000;

/** 截断标记（用户可见面：完整结果体积看过程帧摘要）。 */
export const TOOL_RESULT_TRUNCATION_MARK = "…（已截断，完整结果见过程帧）";

/** list_instances 紧凑投影：active 实例 task/summary 截断上限。 */
export const INSTANCE_TASK_MAX_CHARS = 120;

/** list_instances 紧凑投影：非 active 实例 summary 截断上限。 */
export const INSTANCE_SUMMARY_MAX_CHARS = 80;

/** 合成 toolResult 文本（A1-hotfix：assistant 含 toolCall 但结果缺席——
 *  窗口裁剪切掉结果/确认闸挂起无结果，OpenAI 兼容 API 同样 400 拒）。 */
export const STEWARD_MISSING_TOOL_RESULT_TEXT = "（工作记忆窗口裁剪致结果缺失）";

/** 管家开关 KV 键（RuntimeConfigPort；"1" = 开，其余 = 关——默认关）。 */
export const STEWARD_ENABLED_KEY = "steward.enabled";

/** 管家模型槽位 KV 键（"provider/model-id"；未设置 = adapter 默认）。 */
export const STEWARD_MODEL_KEY = "steward.model";

/** 总结配置域（summary.*——三产物开关/锚点节奏/总结模型 + 任务总结两键）
 *  已收编通用域：键位/解析/迁移单源 ../summary/summaryConfig.ts（管家配置
 *  零总结项——steward.set_config 摘除 summary/sessionMemory 组，写面在
 *  config.set_summary）。 */

/** L1 件一：压缩触发阈值（token 估算口径与 estimateLoopTokens 同族；
 *  任务书默认 12k——低于工作记忆 16k 预算闸，压缩先于粗裁剪接管）。 */
export const STEWARD_COMPACTION_THRESHOLD_TOKENS = 12_288;

/** L1 件一：压缩尾部滚动窗（条数——TR-47：压的是历史不是工作集）。 */
export const STEWARD_COMPACTION_KEEP_RECENT = 6;

/** L1 件二：输入缓冲 pending 队列上限（忙碌态入队不拒绝；超限提示）。
 *  批 0（DDD 重构）起：缺省单源 StewardTuning（KV steward.tuning.ask.queueMax
 *  可改）——此处 re-export 兼容既有引用，值不双写。 */
export const STEWARD_PENDING_ASKS_MAX = STEWARD_TUNING_DEFAULTS.ask.queueMax;

/** ── 管家可靠性批时间参数（批 0 起全部进 StewardTuning 配置域——KV
 *  steward.tuning.* 运行期可改、非法静默回退缺省；下列导出为缺省值 re-export
 *  （兼容既有引用，值不双写）。原「配置面不做——M4 统一做」裁决已被 DDD
 *  重构批 0 推翻（设计文档 §3.3：语音/文字双场景容忍度不同，阈值须可配）。 ──
 *  事故链：write 档挂闸无人确认 → runActive 永真 → finishRun 永不执行 →
 *  后续 ask 永远 queued → 管家对一切输入装死且零日志。三要素对三参数： */

/** run 看门狗阈值：run 内无事件推进持续此时长 → abort 在途轮 + 挂起通知
 *  （缺省 180s——事故中 20 分钟装死的兑底上限；活跃 run 每事件重置计时）。 */
export const STEWARD_RUN_WATCHDOG_MS = STEWARD_TUNING_DEFAULTS.run.watchdogMs;

/** run 看门狗巡检间隔（生产 interval；测试直接调 reliabilityTick 注入时钟）。 */
export const STEWARD_RUN_WATCHDOG_TICK_MS = STEWARD_TUNING_DEFAULTS.run.watchdogTickMs;

/** 看门狗 abort 宽限窗：abort 后仍 runActive 持续此时长 → 强制收口 + 引擎
 *  重建（pi EventStream 不竞速 abort signal——挂死的 provider 流 abort 后
 *  run promise 仍永悬，必须弃引擎重建；缺省 180+15=195s < 5 分钟自愈口径）。 */
export const STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS = STEWARD_TUNING_DEFAULTS.run.watchdogAbortGraceMs;

/** 手动 abort 快进宽限（手动停止批）：abortInFlight 后此时长仍 runActive
 *  （挂死流 abort 打不醒——E-240 实测）→ 快进强制收口（弃引擎重建）。被动
 *  看门狗 195s 对语音交互太慢（2026-10-09 事故）；缺省 8s 恢复。 */
export const STEWARD_MANUAL_ABORT_GRACE_MS = STEWARD_TUNING_DEFAULTS.run.manualAbortGraceMs;

/** 确认卡 TTL：pending 挂闸无人 confirm/cancel 持续此时长 → 自动作废（复用
 *  cancel 内部语义——删除即作废；缺省 300s）。 */
export const STEWARD_CONFIRM_TTL_MS = STEWARD_TUNING_DEFAULTS.confirm.ttlMs;

/** 确认卡可达性提醒：confirm_required 发出后无人消费持续此时长 → 提醒帧
 *  （缺省 30s——事故中确认卡入口不可见，提醒是第二入口）。 */
export const STEWARD_CONFIRM_REMIND_AFTER_MS = STEWARD_TUNING_DEFAULTS.confirm.remindAfterMs;

/** 确认超时作废的 action.completed detail 文案（用户与 LLM 共同可见）。 */
export const STEWARD_CONFIRM_TIMEOUT_DETAIL = "确认超时（超时无人确认，已自动作废——如仍需要请重新提出）";

/** ── 确认链路修复批（2026-10-06 12:13-12:28 事故）：口令路由词表 + 登记簿 ──
 * 事故定性：用户每次重述 → 管家新提案 → 新卡（六卡并存）；「确认了很多遍」
 * 被当新指令又弹卡；已送达后又陆续弹失效通知。三件根治：在途提案登记簿
 * （弹卡出口唯一）、确认口令路由（词表绑定最近 pending 卡）、终局收敛
 * （同 key 其余卡静默撤除）。 */

// ── 确认类/取消类口令词表已单源化至 @helix/protocol stewardPhrases（闸门
// 对应修复批：双端词族同源——STEWARD_CONFIRM_PHRASES 8 词 / STEWARD_CANCEL_
// PHRASES 3 词，历史文案见 git；扩改词表双端同改不再手工同步）。在途 run
// 判官判停 → 全停（abort 当前 + 清空排队，回执携丢弃条数；停止判定单源
// = Jev 停止意图判官——停止词表已退役）；无在途原样走 LLM（停止判定仅
// 在场触发——TR-240 同款纪律）；与确认口令词表互斥：「取消」是卡作废口令，
// 判官判停是 run 全停，语义分层不互吞。

/** 口令判定（极轻纯函数，零 LLM；非词表全等 → undefined 原样走 LLM）。 */
export function matchStewardCommandPhrase(text: string): "confirm" | "cancel" | undefined {
  if (matchStewardConfirmPhrase(text)) return "confirm";
  if (matchStewardCancelPhrase(text)) return "cancel";
  return undefined;
}

// 登记簿 key 计算（pendingKeyOf）与终局登记簿上限（STEWARD_PROPOSAL_REGISTRY_MAX）
// 已迁确认闸聚合域（domain/steward/confirmation/ProposalLedger.ts——批 1）。

/** ── A2 批：动态情景快照段 ───────────────────────────────
 *  内容预算（字符级硬顶；中文 ~600 字符 ≈ 400-600 token，满足 brief
 *  ≤600 token 口径）：当前时间一行 + 活跃 agent/会话计数两行 + 最近
 *  1-2 个会话主题一行。 */
export const CONTEXT_SNAPSHOT_MAX_CHARS = 600;

/** 快照段内会话主题标题截断上限（标题级——不进正文）。 */
export const SNAPSHOT_TITLE_MAX_CHARS = 16;

/** 快照段「最近会话」行数上限。 */
export const SNAPSHOT_RECENT_SESSIONS = 2;

/** ── M3-d1：ask 对话投影（活动段常量）──────────────────────────
 *  ring 最近活动条目（账本白话行）→ context_snapshot 活动段；行数在
 *  brief 建议 8~12 区间取中，字符预算独立于基础段（双预算防截断互他）。 */

/** 活动段条数上限（8~12 建议区间取中——感知现场够用且不挤占上下文）。 */
export const SNAPSHOT_ACTIVITY_MAX_ENTRIES = 10;

/** 活动段单行截断上限（白话句一行密度面）。 */
export const SNAPSHOT_ACTIVITY_LINE_MAX_CHARS = 46;

/** 活动段整体字符预算（防御性硬顶——与基础段 600 双预算分轨）。 */
export const SNAPSHOT_ACTIVITY_MAX_CHARS = 480;

/** 活动域标签（域枚举 → 中文短词——投影行文与时间线同源）。 */
export const SNAPSHOT_ACTIVITY_DOMAIN_LABELS: Record<string, string> = {
  task: "任务",
  session: "会话",
  agent: "帮手",
  surface: "界面",
  cli: "终端",
  notify: "通知",
};

/** query_recent_work 单类行数上限（体量自律：A1-hotfix 4000 护栏之外再
 *  自律——多行时尾部「另有 N 个未列出」收口）。 */
export const RECENT_WORK_LINES_MAX = 8;

/** query_recent_work 会话主题/任务标题截断上限（每条一行紧凑口径）。 */
export const RECENT_WORK_TITLE_MAX_CHARS = 20;

/**
 * 系统提示词骨架（§2 三分法 + 拒绝清单——任务 brief 口径）。
 * 导出为常量供测试断言（prompt 骨架即行为契约的一部分）。
 */
export const STEWARD_SYSTEM_PROMPT = `你是 helix 的文本管家（Steward）——常驻的全局监控与对话助手，不是第二个有工作上下文的大脑。

职责三分法：
① 快问快答：全局状态问答（agent 实例清单/状态、任务清单与结果摘要）——先用工具取数，再直接回答。
② 递话（SubAgent 补充通道）：用户明确想给正在运行的 agent 实例（agent-xxx）补充指示/催进度时——调用 propose_send 工具提案；系统会向用户请求确认（确认按钮），用户确认后才执行。每次只提案一条递话。向会话传达消息不走本通道——用 deliver_to_session（见意图路由）。
③ 拒绝越权：
- 不代答工作上下文问题（如「就按刚才聊的改」）——工作上下文留在各会话/agent，请建议用户把话投递到持有该上下文的会话（可提议 deliver_to_session）或递给该 agent（可提议 propose_send）。
- 不执行未过闸的写操作：唯一写原语 = propose_send / deliver_to_session / create_session / start_session / spawn_review_task，且必须等用户在面板确认后才执行。
- 不伪装用户身份、不代替用户做决策。

意图路由（每次用户输入先分类再行动；判据 = 目标语义，不是目标是否在运行）：
- 问管家：关于全局状态/近期工作的问题 → 直接回答（可用 list_instances / list_tasks / query_recent_work 取数；追问某会话具体聊了什么/进展细节时用 read_session 深读尾部消息——记忆召回行的「[进展]…（sid: xxx）」可直接作 read_session 的 sessionId）。
- 问项目知识（规则/约束/架构/术语/历史决策，如「这个项目的规则是什么」「XX 是怎么设计的」）→ 用 kg_search 检索项目知识库，命中后用 kg_get 读节点全文（nodeId 取自返回行的「kg get <id>」指针，不要自造 id）；知识库只读不写，查不到就如实说并建议用户补充知识条目。project 参数：用户已点名项目或上下文已明确项目时务必显式传 project（workspace 一级目录名）；缺省=当前项目（单项目 workspace），多项目 workspace 缺省聚合检索各项目知识、结果按【项目 名】分块标注——问「这个项目的规则」时若 workspace 多项目，先从上下文确认指哪个项目再显式传 project，避免混入其他项目结果。
- 开新会话（双工具分工，看用户话里有没有「要做的事」）：用户**只要空会话**（如「开个新会话」「新开一个」）→ create_session 提案；用户话里**带着要做的事/话题**（如「开个会话设计光球效果」）→ **必须** start_session 提案，initial_message = 用户原话（不改写、不总结——建成即作为首条消息投递到新会话并开始工作，不要把话题塞进 title 就完事，也不要让用户去空会话里重新输入）。例：用户「创建一个新会话，设计一下光球效果，现在的光有点一言难尽」→ start_session(title="光球视觉效果设计", initial_message="设计一下光球的效果，现在的光有点一言难尽")。两个工具建成后界面都会自动切到新会话。
- 记忆沉淀：用户明确表达偏好/习惯（「以后都…」「我喜欢…」「记住…」）或对话中确认了跨会话有价值的事实 → 调用 remember（立即静默入库并弹通知卡，无需确认——text 要提炼成一句简单易懂、主题明确的记忆句，不要照搬用户原话口语）。只沉淀认知增量：一次性上下文/本轮临时信息/寒暄不记。系统也会在轮末自动提炼记忆，你主动记得准就轮不到自动提炼。
- 对会话说（用户意图主通道）：用户说「发到那个会话/对 XX 会话说/继续那个话题」等指向某个会话 → deliver_to_session 提案——**无论目标会话是否空闲**（空闲会话投递会自动开新轮次，运行中会话自动注入队列，两者都是正常路径）。不确定 sessionId 时先用 query_recent_work 查（结果含 sessionId）；投递成功后界面会自动切到该会话。
- 给运行中的 agent 实例递话（SubAgent 补充通道）：用户明确点名某个正在跑的 agent-xxx（补充指示/催进度）→ propose_send 提案（agentId 必须运行中）。用户没点名具体 agent 实例时不要走本通道。

路由反判例行（覆盖历史判例）：不要以「没有运行中的 agent 实例」为由拒绝会话投递——投递目标可以是任何存在的会话，空闲会话投递会自动开新轮次，这是正常路径；也不要建议用户「自己去会话页输入」来替代投递。历史对话中你对投递能力的自述（如「我不能直发」「只能递给运行中的 agent」）如有与本规则冲突，以本规则为准。

你只持有全局状态摘要与自身对话状态；回答用中文，简洁直答。

长期记忆纪律（判断前必查）：回答、路由或提案前，先用 memory_search 检索相关长期记忆——query 用你自己对用户话语的理解与提炼（语音转写常生硬、有错别字，不要拿转写原文直接当 query，相当于先做一次问题重写），再综合作答或行动，不能只看当前问题不看用户既往习惯。命中记忆与本轮指令冲突时以本轮指令为准，涉及代码/项目现实以知识图谱为准；零命中即正常作答。记忆结果中的「[进展]…（sid: xxx）」行可直接作 read_session 的 sessionId。用户纠正你时，若纠正内容有跨会话价值，用 remember 沉淀更新后的认知（语义重复会自动覆盖更新原条目）。`;

/** 会话显示标题单源（TR-207：title > topic > firstUserText > 兜底——
 *  快照/清单/read_session 三消费面共用，不得另写推导链）。 */
export function displayTitleOf(r: StewardSessionMetaRow): string {
  return r.title ?? r.topic ?? r.firstUserText ?? "（无主题）";
}

function truncateSummary(summary: string): string {
  if (summary.length <= FEED_SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, FEED_SUMMARY_MAX_CHARS)}…`;
}

/**
 * feed ②层模板直出（纯函数，测试单点）：生命周期六事件 → 中文文本行。
 * 非粗筛集合事件返回 undefined。
 */
export function buildFeedText(event: DomainEvent): string | undefined {
  switch (event.type) {
    case "agent.spawned": {
      const p = event.payload as AgentSpawnedPayload;
      return `${p.agentId} 已启动：${truncateSummary(p.task)}`;
    }
    case "agent.completed": {
      const p = event.payload as AgentCompletedPayload;
      return `${p.agentId} 已完成：${truncateSummary(p.closure.summary ?? "")}`;
    }
    case "agent.failed": {
      const p = event.payload as AgentFailedPayload;
      const reason = p.error !== undefined && p.error !== "" ? p.error : (p.closure.summary ?? "");
      return `${p.agentId} 失败：${truncateSummary(reason)}`;
    }
    case "agent.killed": {
      const p = event.payload as AgentKilledPayload;
      return `${p.agentId} 已终止：${truncateSummary(p.closure.summary ?? "")}`;
    }
    case "agent.parked": {
      const p = event.payload as AgentParkedPayload;
      return `${p.agentId} 已挂起（${p.reason === "user" ? "用户" : "任务暂停"}）`;
    }
    case "agent.resumed": {
      const p = event.payload as AgentResumedPayload;
      return `${p.agentId} 已恢复执行`;
    }
    default:
      return undefined;
  }
}

/** 工作记忆记录 → LLM 消息（同源映射：记录携带 at，LLM 面不含时间戳；
 *  Phase 1 块模型：投影记录（text/thinking/toolCall 三可选）→ assistant
 *  content 块数组——翻译层单点，投影面形状稳定不随块模型变）。 */
function recordToMessage(record: StewardHistoryRecord): StewardLlmMessage {
  if (record.kind === "user") return { role: "user", text: record.text };
  // 压缩摘要记录（事故热修批⑤）：LLM 窗口重建仍转换为 user 形态摘要消息注入
  // 上下文（压缩机制语义不变——摘要是最早上下文）；仅落库形态与 UI 回放退出
  // user 轮域。旧存量（kind=user + compaction:true）同构兼容。
  if (record.kind === "compaction") return { role: "user", text: record.text };
  if (record.kind === "toolResult") {
    return { role: "toolResult", toolCallId: record.toolCallId, name: record.name, text: record.text };
  }
  const content: StewardLlmContentBlock[] = [];
  if (record.thinking !== undefined && record.thinking.text !== "") {
    content.push({
      type: "thinking",
      text: record.thinking.text,
      ...(record.thinking.signature !== undefined ? { signature: record.thinking.signature } : {}),
    });
  }
  if (record.text !== undefined && record.text !== "") content.push({ type: "text", text: record.text });
  if (record.toolCall !== undefined) {
    content.push({ type: "toolCall", id: record.toolCall.id, name: record.toolCall.name, args: record.toolCall.args });
  }
  return { role: "assistant", content };
}

/** 字段级截断（紧凑投影用；超限截断加省略号）。 */
export function capChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** ── 管家语音交互闭环批 ④ 投递反馈简化（用户第 10 项设计决策） ─────────
 *  回执查表直拼零 LLM：投递前查目标会话短标题（title > topic > firstUserText
 *  ——displayTitleOf 同优先级），回执/确认卡/口令回执念人类可读短名，不念
 *  sessionId；标题缺失回退现文案（含 sessionId——不空指针不空串）。 */

/** 投递回执短标题截断上限（码点）。 */
export const DELIVER_TITLE_MAX_CHARS = 24;

/** 投递回执组装（纯函数导出供单测+组合根消费——回执文案单源）：
 *  标题在场 → 「已投递到『<标题>』会话」（idle 新轮次）/「已加入『<标题>』
 *  执行队列」（steered 入队）；标题缺席 → 维持旧文案（含 sessionId）。 */
export function formatDeliverReceipt(
  title: string | undefined,
  mode: "steered" | "new",
  sessionId: string,
): string {
  if (title !== undefined && title !== "") {
    const short = capChars(title, DELIVER_TITLE_MAX_CHARS);
    return mode === "steered" ? `已加入「${short}」执行队列` : `已投递到「${short}」会话`;
  }
  return mode === "steered"
    ? `已注入会话 ${sessionId} 的 steer 队列（turn 边界生效）`
    : `已送达会话 ${sessionId}（空闲会话——作为新轮次开启）`;
}

/** 提案期短标题解析（sessionTitleOf 轻量单会话查询；查询失败/面缺席 →
 *  undefined 回退 sessionId——标题是增强面，绝不阻断提案链；截断在消费点）。 */

/** ── A2：时间档窗口（本地时区；纯函数导出供单测） ───────── */
export type TimeRange = "today" | "yesterday" | "this_week" | "last_week";

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  today: "今天",
  yesterday: "昨天",
  this_week: "本周",
  last_week: "上周",
};

/** 本地时区某时刻的当日零点。 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地时区所在周的周一零点（ISO 周：周一为首日）。 */
function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const day = d.getDay(); // 0=周日
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d.getTime();
}

/** 时间档 → [since, until) 毫秒窗口（today/this_week 右端 = now 开区间上含；
 *  label = 枚举原文（LLM 参数面机械口径），中文展示标签见 zhLabel）。 */
export function timeRangeWindow(range: TimeRange, nowMs: number): { sinceMs: number; untilMs: number; label: string; zhLabel: string } {
  const today0 = startOfDay(nowMs);
  const thisWeek0 = startOfWeek(nowMs);
  switch (range) {
    case "today":
      return { sinceMs: today0, untilMs: nowMs, label: "today", zhLabel: TIME_RANGE_LABELS.today };
    case "yesterday":
      return { sinceMs: today0 - 86_400_000, untilMs: today0, label: "yesterday", zhLabel: TIME_RANGE_LABELS.yesterday };
    case "this_week":
      return { sinceMs: thisWeek0, untilMs: nowMs, label: "this_week", zhLabel: TIME_RANGE_LABELS.this_week };
    case "last_week":
      return { sinceMs: thisWeek0 - 7 * 86_400_000, untilMs: thisWeek0, label: "last_week", zhLabel: TIME_RANGE_LABELS.last_week };
  }
}

/** 查询行时间格式化（MM-DD HH:mm；纯函数）。 */
export function fmtWhen(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "?";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 快照段行文（纯函数导出供单测）：<context_snapshot> XML 包裹的情景快照。
 *  行序：当前时间 → 活跃 agent → 会话计数 → 最近 1-2 个会话主题 →
 *  （M3-d1）最近活动白话行。硬预算：基础段与活动段双预算分轨截断
 *  （CONTEXT_SNAPSHOT_MAX_CHARS / SNAPSHOT_ACTIVITY_MAX_CHARS——防御性
 *  截断互不挤占；活动段缺席 = 与既有形态逐字节同形）。 */
export function buildContextSnapshot(input: {
  nowMs: number;
  activeAgents: number;
  totalAgents: number;
  sessionCount: number;
  recentSessions: readonly { title: string; updatedAt: string }[];
  /** M3-d1：最近活动条目（活动账白话行——最旧→最新；缺席/空 = 零活动段）。 */
  recentActivity?: readonly { at: number; domain: string; attribution: string; text: string }[];
}): string {
  const now = new Date(input.nowMs);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const lines: string[] = [
    `当前时间：${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}（${WEEKDAY_NAMES[now.getDay()]}）${p2(now.getHours())}:${p2(now.getMinutes())}`,
    `活跃 agent：${input.activeAgents}${input.totalAgents > input.activeAgents ? `（在册 ${input.totalAgents}）` : ""}`,
    `会话：${input.sessionCount} 个`,
  ];
  const recent = input.recentSessions.slice(0, SNAPSHOT_RECENT_SESSIONS);
  if (recent.length > 0) {
    lines.push(
      `最近会话：${recent.map((s) => `「${capChars(s.title, SNAPSHOT_TITLE_MAX_CHARS)}」（${fmtWhen(s.updatedAt).slice(0, 5)}）`).join("、")}`,
    );
  }
  const budget = CONTEXT_SNAPSHOT_MAX_CHARS - "<context_snapshot>\n".length - "</context_snapshot>".length;
  let body = capChars(lines.join("\n"), budget);
  // M3-d1：活动段（独立预算——感知现场投影，失败/缺席零段）
  const activity = input.recentActivity ?? [];
  if (activity.length > 0) {
    const activityLines = [
      "最近的活动：",
      ...activity.slice(-SNAPSHOT_ACTIVITY_MAX_ENTRIES).map((e) => {
        const label = SNAPSHOT_ACTIVITY_DOMAIN_LABELS[e.domain] ?? "动态";
        return `- ${label}：${capChars(e.text, SNAPSHOT_ACTIVITY_LINE_MAX_CHARS)}`;
      }),
    ];
    body = `${body}\n${capChars(activityLines.join("\n"), SNAPSHOT_ACTIVITY_MAX_CHARS)}`;
  }
  return `<context_snapshot>\n${body}\n</context_snapshot>`;
}

/** 动态 system prompt 组装（纯函数导出供单测）：静态人格段 + 快照段 +
 *  在途提案段（语音闭环批 ①——LLM 路径上下文增强）；附加段缺席（感知
 *  失败静默降级）= 原样静态段。记忆批（同轨换轨）：机械召回注入段退役
 *  ——管家记忆消费改走 memory_search 工具（LLM 按纪律主动检索，query
 *  自提炼重写），与编码 agent 同轨。 */
export function assembleStewardSystemPrompt(
  snapshot: string | undefined,
  pendingSection?: string | undefined,
): string {
  let prompt = STEWARD_SYSTEM_PROMPT;
  if (snapshot !== undefined) prompt = `${prompt}\n\n${snapshot}`;
  if (pendingSection !== undefined) prompt = `${prompt}\n\n${pendingSection}`;
  return prompt;
}

/** 在途提案段行数上限（体量自律——多卡时尾部「另有 N 个」收口）。 */
export const PENDING_PROPOSALS_MAX_ITEMS = 4;

/** 提案动词短述（在途摘要行文——每 kind 一句人类可读短名）。 */
function pendingActionPhrase(action: { kind: PendingAction["kind"]; displayTarget: string }): string {
  switch (action.kind) {
    case "send":
      return `递话给「${action.displayTarget}」`;
    case "deliverSession":
      return `投递到「${action.displayTarget}」`;
    case "createSession":
      return `创建会话「${action.displayTarget}」`;
    case "spawnReview":
      return `评审「${action.displayTarget}」`;
    case "surfaceAct":
      return `表面动作「${action.displayTarget}」`;
  }
}

/** 在途提案段（语音闭环批 ① 纯函数导出供单测——治「补充话语被当新指令」）：
 *  pending 非空时告知 LLM 在途确认卡及其目标，引导把用户后续话语优先对齐
 *  确认/取消/目标修正，对齐失败才按新指令理解；空集 → undefined 零段注入。
 *  与口令词表（TR-240）层次：词表是零 LLM 快路径（ask 入口先行），本段是
 *  LLM 路径的上下文增强——两者叠加不冲突。 */
export function buildPendingProposalsSection(
  actions: readonly { kind: PendingAction["kind"]; displayTarget: string }[],
): string | undefined {
  if (actions.length === 0) return undefined;
  const shown = actions.slice(0, PENDING_PROPOSALS_MAX_ITEMS);
  const rest = actions.length - shown.length;
  const lines = shown.map((a) => `- ${pendingActionPhrase(a)}`);
  if (rest > 0) lines.push(`- 另有 ${rest} 个在途提案`);
  return [
    "<pending_proposals>",
    `当前有 ${actions.length} 个在途提案等你（用户）确认（未确认零执行）：`,
    ...lines,
    "判断优先级：用户接下来这句话若是对在途提案的确认（如「确认」「对，就是它」）、取消（如「不要了」）或目标/内容修正（如「投到另一个会话」「改成……」），优先按该语义回应或更新提案——不要把这类补充话语当新指令再发起新提案；只有对齐失败才按新指令理解。",
    "</pending_proposals>",
  ].join("\n");
}

/** 工具结果送 LLM 前体量护栏（A1-hotfix 纯函数，导出供单测）：超
 *  TOOL_RESULT_MAX_CHARS 截断 + 标记（防任何工具的病理体量直达上下文）。 */
export function capToolResultText(text: string): string {
  return text.length <= TOOL_RESULT_MAX_CHARS ? text : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}${TOOL_RESULT_TRUNCATION_MARK}`;
}

/** list_instances 结果紧凑投影（A1-hotfix 纯函数，导出供单测）：根因实证
 *  orchestration.status() 全量携带完整 task brief 文本与全部历史实例。瘦身：
 *  active 保 id/state/task(≤INSTANCE_TASK_MAX_CHARS)/summary；非 active
 *  （done/failed/killed 等）仅 id/state/summary(≤INSTANCE_SUMMARY_MAX_CHARS)
 *  ——displayState 与终态实例的 task 无决策价值，弃。取舍：专用投影而非
 *  通用 JSON 字段级截断——哪些字段对管家 LLM 有用是领域知识，专用更准；
 *  任意工具的体积上限由 capToolResultText 4000 兑底。 */
export function compactInstanceRows(
  statuses: readonly {
    agentId: string;
    state: string;
    displayState?: string;
    task?: string | null;
    summary?: string | null;
  }[],
): Record<string, string>[] {
  return statuses.map((s) => {
    if (s.state === "running") {
      return {
        agentId: s.agentId,
        state: s.state,
        ...(s.task ? { task: capChars(s.task, INSTANCE_TASK_MAX_CHARS) } : {}),
        ...(s.summary ? { summary: capChars(s.summary, INSTANCE_TASK_MAX_CHARS) } : {}),
      };
    }
    return {
      agentId: s.agentId,
      state: s.state,
      ...(s.summary ? { summary: capChars(s.summary, INSTANCE_SUMMARY_MAX_CHARS) } : {}),
    };
  });
}

/** 工作记忆记录 → LLM 消息窗口（A1-hotfix 配对防御，纯函数导出供单测）：
 *  ① 孤儿 toolResult（配对 assistant toolCall 不在窗内——脏 KV/裁剪残留）
 *    丢弃；② assistant toolCall 无后续结果 → 追加合成 toolResult 占位
 *    （STEWARD_MISSING_TOOL_RESULT_TEXT）紧随其后。仅作用于送 LLM 的窗口，
 *    不改 KV 存储与 history 回放读面（UI 显示照旧）。 */
export function buildLlmWindow(records: readonly StewardHistoryRecord[]): StewardLlmMessage[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const r of records) {
    if (r.kind === "assistant" && r.toolCall !== undefined) callIds.add(r.toolCall.id);
    else if (r.kind === "toolResult") resultIds.add(r.toolCallId);
  }
  const messages: StewardLlmMessage[] = [];
  for (const r of records) {
    if (r.kind === "toolResult") {
      if (!callIds.has(r.toolCallId)) continue; // 孤儿：丢弃（自愈脏 KV，零迁移）
      messages.push(recordToMessage(r));
      continue;
    }
    messages.push(recordToMessage(r));
    if (r.kind === "assistant" && r.toolCall !== undefined && !resultIds.has(r.toolCall.id)) {
      messages.push({
        role: "toolResult",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        text: STEWARD_MISSING_TOOL_RESULT_TEXT,
      });
    }
  }
  return messages;
}

/** ask 过程事件面（A1 批：工具/thinking 过程对屏幕通道可见；由 handler 层
 *  接帧——点对点仅发发起连接。TTS 播报链路零接入（耳朵只听 assistant 结论）。 */
export interface StewardAskEvents {
  /** 文本生成段增量（V2.5 体验批）。 */
  readonly onDelta?: (chunk: string) => void;
  /** thinking 段级（一个完成态块一帧全量文本）。 */
  readonly onThinking?: (block: string) => void;
  /** 工具开始（name + 参数摘要）。 */
  readonly onToolStart?: (name: string, argsSummary: string) => void;
  /** 工具结束（name + 结果摘要）。 */
  readonly onToolEnd?: (name: string, resultSummary: string) => void;
}

/** 任务清单读面窄接口（TaskQueryService.listTasks 注入）。 */
export interface StewardTasksSource {
  listTasks(filter: { status?: string }): readonly {
    jobId: string;
    title: string;
    status: string;
    progress: { stageName: string | null; batchesDone: number; batchesTotal: number; percent: number } | null;
    error: string | null;
  }[];
}

/** A2：会话元数据行（session_state 轻量读面——SessionRepositoryPort
 *  .listSessionMetadata 同形，additive entryCount 消息量级 + title 显式标题列）。 */
export interface StewardSessionMetaRow {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 首条用户消息全文（title 推导源）；无用户消息的持久化会话为 null。 */
  readonly firstUserText: string | null;
  /** 显式会话标题（L1 投影修复批：createTitledSession 定格；投影优先于
   * firstUserText 推导；additive——旧数据源缺省不携带）。 */
  readonly title?: string;
  /** 阶段演进主题（动态主题批：轮次锚点矫正产生；displayTitle 优先级
   * title > topic > firstUserText；additive——旧数据源缺省不携带）。 */
  readonly topic?: string;
  /** 消息条目量级（json_array_length(entries)；查询面不可得 = null）。 */
  readonly entryCount: number | null;
}

/** A2：L1 感知面（情景快照 + query_recent_work 数据源；快照降级容忍缺席）。 */
export interface StewardSessionsSource {
  /** 会话元数据轻量读面（updated_at 倒序）。 */
  listSessionMetadata(): Promise<readonly StewardSessionMetaRow[]>;
  /** 会话创建（SessionDirectoryPort.startDraftSession 同款窄面——与 shell
   *  新建会话同一条服务路径；text = 首条消息文本兼 title 推导源）。 */
  startDraftSession(text: string, mode?: string): Promise<{ sessionId: string }>;
  /** 显式建标题会话（修复批① 死锁链）：同轨不同入口——createFresh 同一
   *  构造路径，但不发送任何消息不点火引擎；零条目即 INSERT 一等可见，
   *  title 进 meta 列（首条消息派生不覆盖）。createSession 执行体改调本面
   *  （对照事故：startDraftSession(title) 把 title 当首条用户消息发送，
   *  触发完整幽灵 agent run）。 */
  createTitledSession(title: string): Promise<{ sessionId: string }>;
  /** 会话存在性（驾驶舱批：deliver_to_session 提案前引导式校验——不存在
   *  即拒绝提案，引导 LLM 用 query_recent_work 重查）。 */
  sessionExists(sessionId: string): Promise<boolean>;
  /** 轻量单会话标题查询（语音闭环批 ④：投递提案/回执念短标题——title >
   *  topic > firstUserText，缺席 = undefined 回退 sessionId；避免全量
   *  listSessionMetadata 拉表）。 */
  sessionTitleOf?(sessionId: string): Promise<string | undefined>;
  /** session 级投递执行面（驾驶舱批；确认闸后调用）：把用户输入投进目标
   *  会话——复用主会话 steer 机制（运行中 → steer 队列；空闲 → 新轮次，
   *  与用户在该会话页直接输入同语义）。delivered=false = 拒绝（detail 含
   *  引导）；成功后由调用方广播 steward.navigate 切页。 */
  deliverToSession(sessionId: string, text: string): Promise<{ delivered: boolean; detail: string }>;
  /** 尾部消息投影读面（progress 批 M3——read_session 工具数据源）：单会话
   *  最后 N 条 {role, text}（旧→新；opts 参数化批——entryOffset 翻页 /
   *  maxEntryChars 单条截断覆盖，缺省 repo 层截 300）；sessionId 不存在
   *  = undefined（引导层判据）。 */
  readSessionTail(
    sessionId: string,
    tailEntries: number,
    opts?: { entryOffset?: number; maxEntryChars?: number },
  ): Promise<readonly { role: string; text: string }[] | undefined>;
}

/** A2：kg 项目解析面（KgProjectService 同款窄接口——spawn_review_task
 *  前置校验：项目存在性 + .kg 索引判定）。 */
export interface StewardProjectsSource {
  /** 项目名/绝对路径 → projectRoot；不在 workspace 扫描全集 = undefined。 */
  resolve(project: string): string | undefined;
  /** projectRoot 有 .helix-kg/kg.db（读面绝不新建库）。 */
  hasIndex(projectRoot: string): boolean;
}

/** 批A（管家开放 kg 只读工具）：项目知识只读检索面——实现体 = adapters/
 *  driven/tools/kg/StewardKgTool.ts createStewardKgSource（复用 createKgTool
 *  语义：search = digest+指针形态摘要行 / get = 节点全量；全链路零写——
 *  本域不提供任何 kg 写原语，写面不进管家工具面）。渲染文本直接过
 *  capToolResultText 体量护栏。 */
export interface StewardKgSource {
  /** 当前 kg 项目域（已建 .helix-kg 的项目根列表，workspace-scan/scanProjects
   *  口径；空集 = absent 判定源——引导式降级，读面绝不新建库文件）。 */
  kgProjects(): readonly string[];
  /** 关键词检索（渲染文本）：projectRoot 缺省 = kg 项目域聚合（多项目分块
   *  带【项目】头——调用方 resolveKgScope 已按当前项目口径先行解析，缺省
   *  仅多项目/未绑定时到达）；指定 = 单项目范围。 */
  search(q: string, projectRoot?: string): Promise<string>;
  /** 节点全量读取（渲染文本）：nodeId 形态校验/查无节点在实现体抛中文引导
   *  错，执行体兜底转文本不抛错不炸轮。 */
  get(nodeId: string, projectRoot?: string): Promise<string>;
}

export interface StewardServiceDeps {
  readonly llm: StewardLlmPort;
  /** 编排面（status 只读 + send 写注入——agent_send 等价 steer 通道）。 */
  readonly orchestration: Pick<AgentOrchestrationPort, "status" | "send">;
  /** 任务清单只读面（TaskQueryService 注入）。 */
  readonly tasks: StewardTasksSource;
  /** 运行时配置 KV（开关 + 模型槽位持久化；缺省时同时充当工作记忆底座）。 */
  readonly config: RuntimeConfigPort;
  /** 工作记忆 KV（缺省 = StewardDialogMemory(config)——A1 批完整记录持久化）。 */
  readonly dialog?: StewardDialogMemory;
  /** 时钟（记录 at 时间戳；缺省 Date.now）。 */
  readonly clock?: () => number;
  /** 行为阈值现拍面（批 0 配置域：组合根接 resolveStewardTuning(runtimeConfig)
   *  运行期即热；缺省 = STEWARD_TUNING_DEFAULTS 即原硬编码常量——零注入零
   *  行为变化）。测试注入字面量免 mock 时钟跳拍。 */
  readonly tuningOf?: () => StewardTuning;
  /** feed 闸门读面（EventStream 连接级 steward 订阅表窄接口）。 */
  readonly feedGate: { hasStewardSubscribers(): boolean };
  /** feed 帧出口（组合根接 EventStream.broadcastStewardFeed）。 */
  readonly emitFeed: (payload: StewardFeedPayload) => void;
  /** 记忆落盘通知帧出口（memory_written 通知卡链；组合根接 EventStream
   *  .broadcastStewardMemoryWritten——与 feed 同订阅闸；缺席 = 落盘零通知
   *  （语义面零降级，仅通知缺席）。 */
  readonly emitMemoryWritten?: (payload: StewardMemoryWrittenPayload) => void;
  /** 页面导航出口（M0 表面协议地基批收编：组合根接 SurfaceRegistry
   *  .act("navigate")——deliver_to_session 受理 / create_session 建成后
   *  路由 surface.action {verb:"navigate"}；旧 steward.navigate 帧由 Registry
   *  兼容镜像双发，M1 前检查点删除。域层纯 payload 端口零组帧。
   *  缺席 = 无切页指令（语义面零降级，仅行为缺席）。 */
  readonly emitNavigate?: (payload: StewardNavigatePayload) => void;
  /** M2 表面消费面（四泛型工具 surface_list/snapshot/read/act 执行体——
   *  StewardSurfacePort；act 经确认闸后走同一动作管道）。缺席 = 四工具
   *  引导式降级（零抛错，对话主链路不受影响）。 */
  readonly surfaces?: StewardSurfacePort;
  /** A2：L1 感知面（快照 + query_recent_work + create_session 执行面）。
   *  缺席 = 无快照段/query_recent_work 降级提示/create_session 引导式不可用
   *  ——感知查询绝不能挡住对话主链路（缺席零抛错）。 */
  readonly sessions?: StewardSessionsSource;
  /** A2：kg 项目解析面（spawn_review_task 前置校验；缺席 = 项目校验降级
   *  为存在性未知，直接进确认闸）。 */
  readonly projects?: StewardProjectsSource;
  /** 批A：kg 只读检索面（kg_search/kg_get 执行体——StewardKgSource；
   *  缺席 = 引导式降级（零抛错），对话主链路零影响。 */
  readonly kg?: StewardKgSource;
  /** A2：任务创建面（task_create 同款引擎通道——paramsSchema 校验在引擎，
   *  TaskError message 原样透传；method 语法容忍 CreateTaskInput 逆变）。 */
  readonly taskEngine?: {
    createTask(input: {
      type: string;
      projects: readonly string[];
      params: Record<string, unknown>;
      createdBy: "page" | "chat" | "auto";
    }): Promise<{ jobId: string }>;
  };
  /** A2：code-review 前置校验——项目 git 仓存在性（组合根 fs 注入；
   *  application 零直接 IO）。 */
  readonly hasGitRepo?: (projectRoot: string) => boolean;
  /** 引擎构造工厂（段B翻转：唯一配方 buildStewardEngine 的 application 面——
   *  生产装配（组合根）与测试（剧本 streamFnOverride）共用同一 driven 配方；
   *  首问时懒调用（dialog 回填 initialMessages 需懒加载后取）。 */
  readonly createEngine: (opts: StewardEngineAssemblyOptions) => AgentEnginePort;
  /** 引擎事件出口（追踪可见性——组合根接 domain_events 投影：
   *  AgentEngineEvent → DomainEvent{instanceId:"steward"} 落库；缺席 =
   *  零落库零广播，对话主链路零降级）。 */
  readonly emitEngineEvent?: (event: AgentEngineEvent) => void;
  /** 压缩参数覆盖（thresholdTokens/keepRecent 缺省回落导出常量；本体能力
   *  = pi CompactionHook（turn 边界）经 createEngine 装配——同轨共享钩子）。 */
  readonly compaction?: { readonly thresholdTokens?: number; readonly keepRecent?: number };
  /** 管家记忆 B1：长期记忆编排面（召回段注入 + remember 执行体 + 配置读写）。
 *  缺席 = 记忆整体降级不可用（recall 零段/remember 引导拒/配置面
 *  available=false）——对话主链路零影响。 */
  readonly memory?: StewardMemoryService;
  /** 分诊判官配置与判定面（分诊判官接入批：steward.set_config {triage}
 *  组读写 + 感知服务判定依赖同源真体；缺席 = triage 组读写降级不可用
 *  + 判定面不启用——回退现行 LLM JSON 路径）。 */
  readonly triageJudge?: TriageJudgeFace;
  /** M3-a 意图判别判定面（判官第五消费面——词表未命中 ∧ pending 卡在场
   *  时的泛化判定：确认/取消/修正三问 noul 分流；缺席/关闭/未配/抛错 →
   *  回退词表后行为（原样走 LLM），零劣化。与分诊判官共享开关与端点
   *  （组合根 makeIntentJudgeFace 单源闭包）。 */
  readonly intentJudge?: IntentJudgeFace;
  /** 当前项目口径解析（项目隔离批引入；kg 缺省范围批起双消费面）：返回
 *  workspace 一级项目目录名（workspace 绑定根 + 一级目录扫描的单项目口径
 *  ——记忆召回与 kg_search/kg_get 缺省范围共用同源，不另造口径判定）；多
 *  项目/未绑定/未注入 → undefined = 召回只 global / kg 缺省聚合兑底。 */
  readonly memoryProject?: () => string | undefined;
  /** M3-d1 感知兑现批：最近活动条目读面（活动账白话行——组合根接
   *  StewardActivityService.recent(N)；快照活动段数据源。**静默降级**：
   *  读面抛错/缺席 → 快照仅基础段（assembleStewardSystemPrompt 附加段
   *  缺席 = 原样静态段语义），绝不阻塞对话主链路。） */
  readonly recentActivity?: () => readonly { at: number; domain: string; attribution: string; text: string }[];
  /** 管家感知批（M0.5）：用户 ask 活动信号（感知服务激活衰减窗点亮——
   *  响应环点亮主动环，D12-⑪；组合根接 StewardPerceptionService
   *  .noteUserActivity；缺席 = 零信号）。 */
  readonly onUserActivity?: () => void;
  /** 回合终态感知批：投递成功回调（感知服务投递关注注册——该会话回合
   *  结束即命中分诊锚「那边回完了」；组合根接 noteDelivered；缺席 =
   *  零关注注册，回合终态只入 ring 零 LLM）。 */
  readonly onDelivered?: (sessionId: string, text?: string) => void;
  /** 可靠性批：生命周期日志（run 开始/收口/挂闸暂停 info + 看门狗/TTL warn；
   *  info 可选——旧装配只带 warn 时降级只出 warn）。 */
  readonly logger?: { info?(message: string): void; warn(message: string): void };
  /** 可靠性批：确认卡 TTL 作废的 action.completed 广播出口（组合根接
   *  EventStream.broadcastStewardActionCompleted——与 feed 同订阅闸，多窗
   *  卡栈同步收口；缺席 = 作废仅 daemon 侧簿记零广播）。 */
  readonly emitActionCompleted?: (payload: StewardActionCompletedPayload) => void;
  /** 可靠性批：用户提醒出口（挂起恢复/确认可达性/TTL 作废三提醒帧——组合根
   *  接 EventStream.broadcastStewardNotify；缺席 = 零提醒）。 */
  readonly emitNotify?: (payload: StewardNotifyPayload) => void;
  /** 光球健康角标批：子系统健康上报出口（组合根接
   *  EventStream.reportStewardHealth——同态去重在出口把门；缺席 = 零帧）。
   *  触发面：judge（判官降级/恢复）/ llm（run 级失败/恢复）。 */
  readonly emitHealth?: (
    component: "judge" | "tts" | "stt" | "llm",
    status: "degraded" | "ok",
    reason?: string,
  ) => void;
  /** M3-a：对话内主动汇报实时帧出口（CAND-601 闭环——组合根接
   *  EventStream.broadcastStewardProactive；缺席 = 零帧，工作记忆记录照写
   *  ——语义面零降级，仅实时性缺席）。 */
  readonly emitProactive?: (payload: StewardProactivePayload) => void;
}

/** 确认闸目标（面板两行渲染语义重载：send = 递话目标实例；createSession /
 *  spawnReview = 动作标识；deliverSession = 递话目标会话；surfaceAct = 表面
 *  动作目标 surfaceId——见各分支注释）。 */
// PendingAction 已迁确认闸聚合域（domain/steward/confirmation——批 1）。

/** 工具声明（JSON Schema 面——flash 级模型的 function calling 契约）。 */
export const TOOL_LIST_INSTANCES: StewardLlmTool = {
  name: "list_instances",
  description: "查询全部 agent 实例的状态清单（id、运行态、被指派任务、终态摘要）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const TOOL_LIST_TASKS: StewardLlmTool = {
  name: "list_tasks",
  description: "查询任务清单（标题、状态、进度、错误）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const TOOL_PROPOSE_SEND: StewardLlmTool = {
  name: "propose_send",
  description:
    "提案向运行中的 agent 实例递话（写操作——仅提案，系统会请求用户确认后才执行）。agentId 必须是当前运行中的实例。",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "目标实例 id（如 agent-1；须运行中）" },
      message: { type: "string", description: "递话内容（将向用户全文展示以供确认）" },
    },
    required: ["agentId", "message"],
    additionalProperties: false,
  },
};

export const TOOL_QUERY_RECENT_WORK: StewardLlmTool = {
  name: "query_recent_work",
  description:
    "按时间范围查询近期工作（会话清单 + 任务清单；可按项目过滤任务、按标题关键词过滤会话）。会话行携完整 sessionId——可直接用作 deliver_to_session 的 sessionId 参数（不要让用户去界面查 id）。回答「最近在忙什么/今天做了什么/找到某个会话」类问题时先用本工具取数。",
  parameters: {
    type: "object",
    properties: {
      time_range: {
        type: "string",
        enum: ["today", "yesterday", "this_week", "last_week"],
        description: "时间范围（缺省 this_week）",
      },
      project: { type: "string", description: "项目过滤（可选——仅过滤任务清单）" },
      title_contains: {
        type: "string",
        description: "会话标题关键词过滤（可选——仅过滤会话清单；按显示标题包含匹配，不区分大小写；显示标题 = 显式标题或首条用户消息）",
      },
    },
    additionalProperties: false,
  },
};

export const TOOL_READ_SESSION: StewardLlmTool = {
  name: "read_session",
  description:
    "读取指定会话的消息内容（尾部窗口，旧→新，单条全文）——回答「那个会话聊到哪了/进展如何/具体说了什么」类问题时深读用；只读不改。sessionId 先用 query_recent_work 查（或用记忆召回行里的 sid）。需读更早的消息时用 offset 翻页（跳过最近 offset 条再取 tail 条，逐步步进）；单次结果总量有上限，读不全就加大 offset 继续翻。",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "目标会话 id（query_recent_work 结果或记忆召回行的 sid）" },
      tail: { type: "number", description: "本次读取条数（可选，缺省 6，上限 20）" },
      offset: { type: "number", description: "跳过最近 N 条再取（翻页读更早消息；可选，缺省 0 = 最近窗口；逐次步进如 0→6→12…可通读全对话）" },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
};

// ── 批A（管家开放 kg 只读工具）：项目知识只读检索二件 ────────

export const TOOL_KG_SEARCH: StewardLlmTool = {
  name: "kg_search",
  description:
    "检索项目知识图谱（只读）。按关键词（节点名/摘要子串匹配，非语义）返回摘要列表，每行含适用场景、摘要与 `kg get <id>` 指针。回答「这个项目的规则/架构/术语/历史决策是什么」类问题时先用本工具取数，命中后用 kg_get 读全文。id 永远取自返回行指针，不要自造。",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "关键词（取用户问题里的核心名词/术语——子串匹配，短而准命中率高）" },
      project: { type: "string", description: "项目名（可选；已知目标项目时显式传入避免跨项目混排——多项目 workspace 缺省聚合各项目结果并带【项目 名】标注；取 workspace 一级目录名）" },
    },
    required: ["q"],
    additionalProperties: false,
  },
};

export const TOOL_KG_GET: StewardLlmTool = {
  name: "kg_get",
  description:
    "读取项目知识节点全量（只读）：digest/适用场景/正文/锚/关系/supersede 链/变更日志。nodeId 必须取自 kg_search 返回行的「kg get <id>」指针（TR-n / E-n 形态）；结果体量大时先看 digest 与适用场景再引用。",
  parameters: {
    type: "object",
    properties: {
      nodeId: { type: "string", description: "节点 id（TR-n / E-n 形态——必须取自 kg_search 返回行指针）" },
      project: { type: "string", description: "项目名（可选；多项目 workspace 建议显式传入以定位同号节点——缺省聚合域取首个命中）" },
    },
    required: ["nodeId"],
    additionalProperties: false,
  },
};

export const TOOL_CREATE_SESSION: StewardLlmTool = {
  name: "create_session",
  description:
    "提案创建新会话（写操作——仅提案，系统会请求用户确认后才执行）。**只在用户只要一个空会话时使用**；用户话里带着任何要做的事/话题时必须改用 start_session（话题是用户要在新会话里开始的内容，不是标题——塞进 title 会丢）",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "会话主题标题（可选，缺省自动生成；仅作显示标题，不派生消息）" },
      project: { type: "string", description: "关联项目名（可选——织入标题标注）" },
    },
    additionalProperties: false,
  },
};

export const TOOL_START_SESSION: StewardLlmTool = {
  name: "start_session",
  description:
    "提案创建新会话并带着话题开局（写操作——仅提案，系统会请求用户确认后才执行）。用户想开新会话且话里带着要做的事/话题时使用：initial_message = 用户原话（不改写、不总结——确认后建成会话即作为首条消息投递并在新会话开启工作，将向用户全文展示以供确认）；话题可另提炼 title",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "会话主题标题（可选，可从话题提炼；仅作显示标题）" },
      project: { type: "string", description: "关联项目名（可选——织入标题标注）" },
      initial_message: {
        type: "string",
        description:
          "初始话题/首条消息（必填——用户想在 新会话里开始的内容，用户原话，原文投递不经改写）",
      },
    },
    required: ["initial_message"],
    additionalProperties: false,
  },
};

export const TOOL_SPAWN_REVIEW_TASK: StewardLlmTool = {
  name: "spawn_review_task",
  description:
    "提案发起评审任务（写操作——仅提案，系统会请求用户确认后才执行）。review_type: code-review（代码评审，需项目有 git 仓）或 kg-review（知识图谱评审，需项目已建 .kg 索引）",
  parameters: {
    type: "object",
    properties: {
      review_type: { type: "string", enum: ["code-review", "kg-review"], description: "评审类型" },
      project: { type: "string", description: "目标项目名（workspace 内）" },
      params: { type: "object", description: "任务参数（按任务类型 paramsSchema 透传）" },
    },
    required: ["review_type", "project"],
    additionalProperties: false,
  },
};

export const TOOL_DELIVER_TO_SESSION: StewardLlmTool = {
  name: "deliver_to_session",
  description:
    "提案向指定会话投递用户输入（写操作——仅提案，系统会请求用户确认后才执行；投递成功后界面自动切到该会话）。sessionId 可先用 query_recent_work 查询（结果含 sessionId）。",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "目标会话 id（query_recent_work 结果中的 sessionId）" },
      text: { type: "string", description: "投递内容（将向用户全文展示以供确认）" },
    },
    required: ["sessionId", "text"],
    additionalProperties: false,
  },
};

export const TOOL_REMEMBER: StewardLlmTool = {
  name: "remember",
  description:
    "沉淀长期记忆（立即静默入库并弹通知卡，无需用户确认）。仅用于跨会话有持久价值的认知增量：用户明确表达的偏好/习惯（kind=preference）或对话中确认的事实（kind=fact）。text 要提炼成一句简单易懂、主题明确的记忆句（不要照搬用户原话口语）。一次性上下文、本轮临时信息、寒暄不记；语义重复会自动覆盖更新原条目。domain 标注记忆的业务领域（缺省按 kind 推导：preference→habit、fact→general）：habit = 关于用户怎么干活（换个团队也成立）；general = 环境与通用工作方式事实（跟项目无关）；project = 绑定具体项目才有意义（换个项目不成立——项目专属事实/约定请显式标注 project）。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "记忆文本（一句自然语言，将向用户全文展示以供确认）" },
      kind: { type: "string", enum: ["fact", "preference"], description: "条目类别（缺省 fact）" },
      domain: {
        type: "string",
        enum: ["habit", "general", "project"],
        description:
          "业务领域（可选；缺省按 kind 推导：preference→habit、fact→general）：habit=用户习惯（换个团队也成立）/ general=通用事实（跟项目无关）/ project=项目专属（换个项目不成立）",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

/** memory_search（记忆批·同轨换轨）：管家长期记忆只读检索——机械注入
 *  退役后的唯一管家记忆消费面。query = 管家对用户话语的提炼重写（ASR
 *  转写生硬/错别字，不拿原文直接查）；语义与编码面 memory_search 工具
 *  同族但分野：管家面 kinds 全类收（progress 走配额 ≤2，E-247）、topK =
 *  memory.recallTopK 生效值（E-261 配置消费面保留）、幸存者记 markRecalled。 */
export const TOOL_MEMORY_SEARCH: StewardLlmTool = {
  name: "memory_search",
  description:
    "检索用户长期记忆（偏好/事实/会话进展，只读）。回答、路由或提案前必查：query 用你自己对用户话语的理解与提炼（语音转写常生硬、有错别字，先做一次问题重写再查），再综合作答——不能只看当前问题不看用户既往习惯。返回逐条记忆行，「[进展]…（sid: xxx）」行可直接作 read_session 的 sessionId；命中记忆与本轮指令冲突时以本轮指令为准，零命中即正常作答。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索意图（对用户话语的提炼重写，非转写原文；语义匹配用户偏好与工作状态类记忆）" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/** surface_list（M2 四泛型工具之一，D4）：动态发现表面与能力——新表面/新
 *  动词靠它发现，不加工具膨胀。 */
export const TOOL_SURFACE_LIST: StewardLlmTool = {
  name: "surface_list",
  description:
    "列出当前全部表面（浏览器 tab / helix 页面等）及其能力动词清单——不知道 surfaceId 或想知道能做什么时先用本工具。只读免确认。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

/** snapshot：表面状态快照（只读免确认）。 */
export const TOOL_SNAPSHOT: StewardLlmTool = {
  name: "snapshot",
  description:
    "读取指定表面的当前状态快照（页面标题/网址/可见文本摘要）——帮用户看页面现状时用。只读免确认；surfaceId 用 surface_list 查（如 browser:xxx）。",
  parameters: {
    type: "object",
    properties: {
      surfaceId: { type: "string", description: "目标表面 id（如 browser:<targetId>，先用 surface_list 查）" },
    },
    required: ["surfaceId"],
    additionalProperties: false,
  },
};

/** read：表面内容读取（只读免确认）。 */
export const TOOL_READ: StewardLlmTool = {
  name: "read",
  description:
    "读取指定表面的页面内容（可见文本全文，可限定元素范围）——需要看页面具体写了什么时用。只读免确认。",
  parameters: {
    type: "object",
    properties: {
      surfaceId: { type: "string", description: "目标表面 id（如 browser:<targetId>）" },
      selector: { type: "string", description: "CSS 选择器限定范围（可选，缺省整页）" },
      max_chars: { type: "number", description: "返回长度上限（可选，缺省 4000）" },
    },
    required: ["surfaceId"],
    additionalProperties: false,
  },
};

/** act：表面动作（risk 三级闸——read 直行 / write·destructive 提案确认后执行）。 */
export const TOOL_ACT: StewardLlmTool = {
  name: "act",
  description:
    "在指定表面上执行动作（verb 封闭词汇表：click/type/navigate/scroll/focus）。risk 挂动作：scroll/focus 免确认直行；click/type/navigate 属 write——仅提案，系统会请求用户确认后才执行；destructive 强制确认不可豁免。args 按表面与动词：navigate 在 shell 表面 {sessionId}（会话 id 字符串——切换会话，不是 url）、navigate 在 browser 表面 {url}、click {selector}、type {selector,text}、scroll {y} 或 {direction}（up/down/top/bottom）、focus {selector}。形状不合法会收到即时错误指引。",
  parameters: {
    type: "object",
    properties: {
      surfaceId: { type: "string", description: "目标表面 id（如 browser:<targetId> 或 shell:<connId>，先用 surface_list 查）" },
      verb: { type: "string", enum: ["click", "type", "navigate", "scroll", "focus"], description: "动作动词（封闭词汇表，不得私造）" },
      args: { type: "object", description: "动词参数（按表面×动词形状，见工具描述；navigate 在 shell 表面是 {sessionId}，在 browser 表面是 {url}）" },
      risk: {
        type: "string",
        enum: ["read", "write", "destructive"],
        description: "风险档（可选，缺省按动词注册档；只可升档不可降档）",
      },
    },
    required: ["surfaceId", "verb"],
    additionalProperties: false,
  },
};

/** 确认闸挂闸工具集（write 类——提案制：LLM 只能提案，人工确认后才执行；
 *  act 为 risk 动态档——read 直行/write·destructive 挂闸，判定在
 *  gateSurfaceAct）。 */
export const GATED_TOOLS: ReadonlySet<string> = new Set([
  "propose_send",
  "deliver_to_session",
  "create_session",
  "start_session",
  "spawn_review_task",
  "act",
  // remember 已摘闸（B5：记忆写入静默化——工具调用即入库 + memory_written
  // 通知，不再挂确认卡；防误吞闸仍由 directRemember 内校验承担）。
]);

/** 挂闸中待确认项（pause 态的 resume 凭据 + 提案动作——actionId 单次消费）。 */
// PendingEntry 已迁确认闸聚合域（domain/steward/confirmation——批 1）。

/** 排队 ask 项（方案甲自持队列——E-197 行为等价：上限/收口后自动下一轮/
 *  queued 双帧回执；events/deliver 是应用面载荷（pi followUp 队列不自动
 *  开 run——E-239，自持队列 + agent_end 驱动）。 */
interface StewardAskItem {
  readonly text: string;
  readonly events: StewardAskEvents;
  readonly deliver?: (payload: StewardAskResultPayload) => void;
}

/** 引擎装配上下文（createEngine 入参——application 中立形状，driven 侧
 *  buildStewardEngine 唯一配方消费）。 */
export interface StewardEngineAssemblyOptions {
  readonly systemPrompt: string;
  readonly tools: readonly StewardToolSpec[];
  readonly gatedTools: ReadonlySet<string>;
  readonly persistentListener: AgentEngineListener;
  readonly initialMessages: readonly StewardLlmMessage[];
  readonly compaction?: {
    readonly thresholdTokens: number;
    readonly keepRecent: number;
    readonly summarizeInstructions?: string;
    /** 触发档位（缺省 request——管家纯问答轮也压）。 */
    readonly trigger?: "turn" | "request";
    /** 摘要单轮执行体（缺省 = deps.llm.complete 无工具形态）。 */
    readonly summarize?: (systemPrompt: string, messages: readonly StewardLlmMessage[]) => Promise<string>;
  };
}

export class StewardService implements StewardComponent {
  private readonly deps: StewardServiceDeps;
  /** 工作记忆 KV（完整记录持久化——thinking/工具/对话全形态；daemon 重启
   *  后懒加载恢复，A1 批取代裸内存数组）。 */
  private readonly dialog: StewardDialogMemory;
  private readonly now: () => number;
  /** 行为阈值现拍面（批 0：缺省 STEWARD_TUNING_DEFAULTS；组合根接 KV 现拍
   *  运行期即热——每 tick 消费成本可忽略）。 */
  private readonly tuningOf: () => StewardTuning;
  /** 确认闸聚合（批 1：pending 卡集合 + 终局登记簿 + 卡生命周期判定——
   *  domain/steward/confirmation/ProposalLedger 纯状态机，本服务只做编排
   *  与出站翻译；行为零变更）。 */
  private readonly ledger: ProposalLedger;
  /** 工具面（批 3a 收编 tools/StewardToolKit——registerTools/挂闸/工具体）。 */
  private readonly toolKit: StewardToolKit;
  private feedSeq = 0;

  /** 八工具中立规格（createEngine 装配面——委托 toolKit 观测面）。 */
  private get toolSpecs(): readonly StewardToolSpec[] {
    return this.toolKit.toolSpecs;
  }

  /** 隐藏面板原语名（不进引擎工具面——getProfile 观测面合并显示）。 */
  private get hiddenToolNames(): readonly string[] {
    return this.toolKit.hiddenToolNames;
  }
  /** 段B翻转：pi 引擎（懒构造——首问时经 createEngine 唯一配方装配，
   *  dialog 懒加载回填 initialMessages）。 */
  private engine: AgentEnginePort | undefined;
  /** 当前 run 的挂闸提案候选（confirm_required 回执映射锚——每 run 重置）。 */
  private currentPause: { actionId: string; action: PendingAction }[] = [];
  /** ask 自持队列（批 2 收编 AskQueue 值对象——上限 tuning.ask.queueMax 即热，
   *  E-197 行为等价：FIFO 不丢/满拒新/收口后自动下一轮）。 */
  private readonly askQueue: AskQueue<StewardAskItem>;
  /** 当前 run 驱动的 ask 项（收口 deliver 回执锚）。 */
  private pendingRunAsk: StewardAskItem | undefined;
  /** ask promise 收口器（confirm_required 在 engine_paused 即收，其余 agent_end）。 */
  private askSettler: ((payload: StewardAskResultPayload) => void) | undefined;
  /** 当前 run 事件投影链（KV 写入与收口定序——事件乱序投影即数据竞争）。 */
  private projectionChain: Promise<void> = Promise.resolve();
  /** 当前 ask 的流式回调（事件转发面）。 */
  private askStreamEvents: StewardAskEvents = {};
  /** run 收口通知（driveAsk 的 abort-再驱动路径等 settle）。 */
  private runSettled: Promise<void> = Promise.resolve();
  /** run 收口通知标记（runSettled promise 的 resolve 句柄）。 */
  private runSettledMark: (() => void) | undefined;
  /** ── 批 2（DDD 重构）：run 状态容器收编原 6 散字段（runActive/
   *  runLastProgressAt/watchdogFiredAt/manualAbortAt/pausedGateToken/
   *  runState——注释语义与事故史随字段迁 domain/steward/run/StewardRun；
   *  锚清理只经容器迁移方法，「三处清锚」从根上消灭）。伴随编排态
   *  （askSettler/pendingRunAsk/askStreamEvents/projectionChain/runSettled）
   *  与 engine 代际守卫留应用层——与 promise 编排/引擎调用深度耦合。 ── */
  private readonly run: StewardRun<StewardAskErrorKind>;
  /** 可靠性提醒帧序（emitNotify 单调 seq——与感知服务同构）。 */
  private notifySeq = 0;
  /** 主动汇报实时帧序（emitProactive 单调 seq——M3-a，与 notify 同构口径）。 */
  private proactiveSeq = 0;
  /** 可靠性批巡检定时器（生产 interval 句柄——start/stopReliabilityTimers；
   *  测试不启定时器直接调 reliabilityTick 注入时钟）。 */
  private reliabilityTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: StewardServiceDeps) {
    this.deps = deps;
    this.dialog = deps.dialog ?? new StewardDialogMemory();
    this.now = deps.clock ?? (() => Date.now());
    this.tuningOf = deps.tuningOf ?? (() => STEWARD_TUNING_DEFAULTS);
    this.ledger = new ProposalLedger({ now: () => this.now() });
    this.run = new StewardRun<StewardAskErrorKind>(() => this.now());
    this.askQueue = new AskQueue<StewardAskItem>(() => this.tuningOf().ask.queueMax); // 批 2：上限现拍（KV 即热）
    // 批 3a：工具面收编 StewardToolKit（deps 全量透传；executePending 不注入
    // ——挂闸工具 execute 不直行写动作，确认执行体留在本服务 confirm 域）
    this.toolKit = new StewardToolKit(deps);
  }

  async ask(
    text: string,
    events: StewardAskEvents = {},
    deliver?: (payload: StewardAskResultPayload) => void,
    source: StewardAskSource = "text",
  ): Promise<StewardAskResultPayload> {
    if (typeof text !== "string" || text.trim() === "") {
      return { status: "error", reason: "payload.text 应为非空 string" };
    }
    if (!this.isEnabled()) {
      return {
        status: "error",
        reason: "管家未开启：请在设置页 → 通用配置开启（开关关 = 零 LLM 调用）",
      };
    }
    // 感知激活信号②：ask 即点亮衰减窗（一问即入激活——响应环点亮主动环）
    this.deps.onUserActivity?.();
    // 确认口令路由（确认链路修复批③，事故 12:27:45 实锤：「确认了很多遍」
    // 被当新指令又弹卡）：pending 卡存在时纯文本口令绑定最近一张卡消费/作废
    // ——零 LLM 零新提案；无 pending 卡时原样走 LLM。极轻判定先于队列语义
    //（挂闸阻塞中口令确认 = 面板点卡的等价入口）。
    const phrase = matchStewardCommandPhrase(text);
    if (phrase !== undefined) {
      const routed = this.routeConfirmPhrase(phrase);
      if (routed !== undefined) return routed;
    }
    // 强制停止判定（Jev 单轨——停止词表退役批）：在途 run 时停止意图判官
    // 判停 → 全停（abort 当前 + 清空排队，回执携丢弃条数）；判不出（判官
    // 缺席/抛错/降级）照常走队列（fail-open 归漏斗面——不吞用户提问、不动
    // 队列序不变量；shell 打断链的 fail-stop 归其消费面）；无在途原样走 LLM
    // （停止判定仅在场触发，TR-240 同款纪律）。挂闸阻塞态判停同样全停（旧
    // 逻辑会把停止表达当新 ask abort-再驱动——语义错位）；pending 卡不动
    //（卡生命周期 TTL 域独立）。
    if (this.run.active) {
      const stopVerdict = await this.judgeStopIntent(text);
      if (stopVerdict.stop && this.run.active) {
        const dropped = this.askQueue.clearAll();
        this.abortInFlight("停止判定全停");
        this.logInfo(`管家手动停止（停止判定判停）：丢弃排队 ${dropped} 条`);
        return { status: "stopped", reason: "已停止当前处理", dropped };
      }
    }
    // 判官泛化层（M3-a：三级漏斗第二级）：词表未命中 ∧ pending 卡在场 →
    // 判官 noul 三问分流「确认/取消/修正」。确认/取消复用口令路由执行面
    //（零 LLM 零新提案）；修正 = 撤旧卡 + 按修正后意图新开（一次 LLM 带卡
    // 全文上下文）；三问皆低 = 无关新任务原样走 LLM。判官缺席/关闭/未配/
    // 抛错 → 回退词表后行为零劣化（judgePendingIntent 内降级链）。挂闸
    // 阻塞中泛化确认 = 面板点卡的等价入口（与口令路由同构）。
    if (phrase === undefined) {
      // 判官泛化层先判（层序修复批：卡在场是最强的「对谁说」证据）——
      // 原序 addressee 先判，其问句不带卡上下文，确认卡在场期间主人的自然
      // 回应（「就这么办」「对对对赶紧弄」——词表未命中短句，无称呼无指令
      // 特征）恒判环境音 dropped，永远轮不到带卡全文的泛化判定（用户实锤）。
      // 声纹总闸已在 shell 层拦旁人（reject 整轮终止）——本层只防「主人对
      // 房间里其他人说话」，卡在场时让位：confirm/cancel/revise 分流在前，
      // 三问皆低才退回 addressee 判定。
      const generalized = await this.judgePendingIntent(text);
      if (generalized !== undefined && generalized.intent === "revise") {
        text = generalized.revisedText; // 修正轮输入替换（带卡全文上下文——不再 addressee）
      } else {
        if (generalized !== undefined) {
          const routed = this.routeConfirmPhrase(generalized.intent);
          if (routed !== undefined) return routed;
          // 卡在分类与路由间消失（TTL/并发消费）：零差异回退原样走 LLM
        }
        // addressee 判定（声纹→Jev 链路批）：双工常开麦收音段的「对谁说」
        // 判定——词表未命中才判（词表全等 = 机械权威零判定）；声纹闸在 shell
        // 已拦非用户，本层只判「用户本人是不是在叫管家」。旁人高置信 →
        // dropped 静默丢弃；判官缺席/灰区/抛错 → 偏「当聊天」继续（宁多应答不漏）。
        if (source === "voice-duplex" && (await this.judgeAddressee(text))) {
          return { status: "dropped", reason: "ambient" };
        }
      }
    }
    // 暂停态（挂闸阻塞中）新 ask：loop 语义 = 旧 run 已 settle 过期、新 ask
    // 照常（E-197 迁移前等价）——pi 映射：abort 阻塞中的 run（闸内 raceAbort
    // 唤醒、工具不执行）→ 收口后驱动新 ask（确认卡保持有效：confirm 时
    // pauseToken 已过期自然失效）。
    if (this.run.active) {
      if (this.run.gateToken !== undefined && this.engine !== undefined) {
        this.engine.abort();
        await this.runSettled;
        return this.driveAsk({ text, events, ...(deliver !== undefined ? { deliver } : {}) });
      }
      if (!this.askQueue.tryPush({ text, events, ...(deliver !== undefined ? { deliver } : {}) })) {
        return {
          status: "error",
          reason: `管家正在处理中，排队已满（上限 ${this.tuningOf().ask.queueMax} 条）——请稍后再试`,
        };
      }
      return { status: "queued", queued: true, position: this.askQueue.length };
    }
    return this.driveAsk({ text, events });
  }

  /** 在途轮 abort（幂等——非在途态 no-op 返回 false；挂闸阻塞中同样唤醒
   *  收口）。收口后自持队列自动接管（序不变量：队列不丢）。手动停止批：
   *  置位 manualAbortAt 快进锚——abort 打不醒的挂死流（E-240 实测）在宽限
   *  后由快进轨强制收口，不等被动看门狗 180s。 */
  abortInFlight(reason: string): boolean {
    void reason;
    if (!this.run.active || this.engine === undefined) return false;
    this.run.noteAbort(); // 快进锚（手动停止批）
    this.engine.abort();
    return true;
  }

  /** 全停（批 3b 两轨裁决乙：语音停止判定通道，steward.interrupt scope=all）
   *  ——与 ask 漏斗停止判定全停同径：abort 当前 + 清空 ask 队列。与轻停
   *  （abortInFlight，队列照常）相对；幂等（无在途时清队列照常——队列在场
   *  即有意义）。返回丢弃条数（日志用）。 */
  interruptAll(reason: string): number {
    const dropped = this.askQueue.clearAll();
    this.abortInFlight(reason);
    if (dropped > 0) this.logInfo(`管家手动停止（${reason}）：丢弃排队 ${dropped} 条`);
    return dropped;
  }

  /** run 驱动（原 prepareAskRun + agent.start 合体）：每 run 动态 systemPrompt
   *  组装（感知快照 + 记忆召回——setSystemPrompt 运行期变异面）+ B4a 补偿
   *  （队列接管轮）+ 事件收口挂载。
   *
   *  事故热修批④（队列并发锁）：runActive 提前到本同步段置位——原实现置位
   *  在 await 装配段之后，ask 检查面在「run 收口（runActive=false）→ driveAsk
   *  装配 await → runActive=true」的间隙里看到假空闲态，相邻 ask 并发直驱双
   *  run（2026-10-07 事故 26ms 双 run「Agent is already processing a prompt」）。
   *  同步占位 + finishRun 幂等守卫共同封死 drain 与新 ask 竞态（任一时刻至
   *  多一个 run 在途；E-240 队列行为断言面不变）。装配异常兑底：占位后若
   *  装配失败，释放占位并收口 error 回执（防 runActive 永真死锁队列）。 */
  private driveAsk(item: StewardAskItem): Promise<StewardAskResultPayload> {
    this.run.occupy(); // 单飞同步占位（零 await 间隙——ask 检查面立即可见）
    const run = this.assembleAndRun(item);
    run.catch(() => undefined); // 兕底异常不经本链传播（收口在内部处理）
    return run;
  }

  private async assembleAndRun(item: StewardAskItem): Promise<StewardAskResultPayload> {
    try {
      return await this.assembleAndRunInner(item);
    } catch (err) {
      // 装配段异常（快照/记忆召回/引擎构造失败）：占位必须释放（占位提前后
      // 的必需兑底——否则 runActive 永真死锁队列）；收口 error 回执后返。若
      // runActive 已被 finishRun/看门狗复位（收口后竞态），原样上抛。
      if (!this.run.active) throw err;
      this.run.assemblyFailed(); // 批 2：释放占位 + 清锚（不误伤下一 run）
      this.runSettledMark?.();
      this.runSettledMark = undefined;
      const payload: StewardAskResultPayload = {
        status: "error",
        reason: `引擎装配异常：${(err as Error).message}`,
        errorKind: "engine-exception",
      };
      this.settleAsk(payload);
      this.deps.logger?.warn(
        `管家 run 收口：error（分类：engine-exception；原因：引擎装配异常：${capChars((err as Error).message, 200)}；排队 ${this.askQueue.length} 条）`,
      );
      const next = this.askQueue.shift();
      if (next !== undefined) {
        void this.driveAsk(next).catch(() => undefined);
      }
      return payload;
    }
  }

  private async assembleAndRunInner(item: StewardAskItem): Promise<StewardAskResultPayload> {
    this.dialog.ensureLoaded();
    const systemPrompt = assembleStewardSystemPrompt(
      await this.buildSnapshotSafely(),
      // 记忆批（同轨换轨）：机械召回注入退役（原 recallSection(item.text)
      // 注入点）——管家记忆消费改走 memory_search 工具：LLM 按纪律主动
      // 检索，query 自对用户话语（含 ASR 转写）提炼重写，检索更准；多一次
      // 工具调用的开销用户已接受。
      // 语音闭环批 ①：在途提案段（LLM 路径上下文增强——pending 非空时引导
      // 把用户补充话语对齐确认/取消/目标修正，对齐失败才按新指令；词表快路径
      //（TR-240）在 ask 入口先行，两者叠加不冲突）
      buildPendingProposalsSection(this.ledger.entries().map((e) => e.action)),
    );
    if (this.engine === undefined) {
      const keepRecent = this.deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT;
      // 代际守卫：persistentListener 捕获本引擎引用——clearHistory 弃旧引擎后
      // 其残余事件（abort 收口帧）不再进入服务面（防污染新 run 状态）
      let engineRef: AgentEnginePort;
      engineRef = this.deps.createEngine({
        systemPrompt,
        tools: this.toolSpecs,
        gatedTools: GATED_TOOLS,
        persistentListener: (event) => {
          if (this.engine === engineRef) this.onEngineEvent(event);
        },
        initialMessages: this.dialogSnapshotMessages(),
        compaction: {
          thresholdTokens: this.deps.compaction?.thresholdTokens ?? STEWARD_COMPACTION_THRESHOLD_TOKENS,
          keepRecent,
          summarizeInstructions: STEWARD_COMPACTION_SUMMARY_PROMPT,
          summarize: async (_systemPrompt, messages) => {
            // 管家摘要身份自带（STEWARD_COMPACTION_SUMMARY_PROMPT）——pi 侧
            // systemPrompt 是英文常量（customInstructions 落 user 消息不落 sys）
            const response = await this.deps.llm.complete({
              systemPrompt: STEWARD_COMPACTION_SUMMARY_PROMPT,
              messages,
              tools: [],
            });
            if (response.kind !== "blocks") {
              throw new Error(`压缩摘要响应非块集（${response.kind}）`);
            }
            return portBlocksText(response.blocks);
          },
        },
      });
      this.engine = engineRef; // 代际守卫锚（listener 闭包比对同一引用）
    } else {
      this.engine.setSystemPrompt?.(systemPrompt);
    }
    this.run.begin(); // 批 2：run 开始赋值块（幂等占位/锚定推进锚/清双锚/重置 runState/清 gate 锚）
    this.logInfo(`管家 run 开始：${item.text.slice(0, 40)}`);
    this.pendingRunAsk = item;
    this.askStreamEvents = item.events;
    this.currentPause = [];
    const settled = new Promise<StewardAskResultPayload>((resolve) => {
      this.askSettler = resolve;
    });
    let markSettled!: () => void;
    this.runSettled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.runSettledMark = markSettled;
    // run 收口由 start() promise 驱动（agent_end 事件早于 pi run promise 收口
    // ——事件面 settle 会与引擎 busy 态竞态：队列驱动 start 撞「already
    // processing」；promise 面收口 = 真 idle 保证）
    void this.engine!
      .start(item.text, () => undefined)
      .then(() => {
        this.enqueueProjection(async () => {
          await this.finishRun();
        });
      })
      .catch((err: unknown) => {
        this.enqueueProjection(async () => {
          await this.finishRun(`引擎驱动异常：${(err as Error).message}`);
        });
      });
    return settled;
  }

  /** 引擎事件入口（persistentListener——trace 出口 + 流式回调转发 + 顺序化投影）。 */
  private onEngineEvent(event: AgentEngineEvent): void {
    this.run.touch(); // 看门狗推进锚（任何引擎事件 = 活跃）
    this.deps.emitEngineEvent?.(event);
    this.forwardStreamCallbacks(event);
    // 轮数熔断（同步判定——async 投影链赶不上无思考工具风暴；abort 越早越省）
    if (event.type === "tool_execution_start") {
      this.run.state.toolCalls += 1;
      if (this.run.state.toolCalls > this.tuningOf().run.maxToolRounds && !this.run.state.roundLimit) {
        this.run.state.roundLimit = true;
        this.engine?.abort();
      }
    }
    this.enqueueProjection(() => this.projectEngineEvent(event));
  }

  /** 投影链追加（顺序化：KV 写入与收口/队列驱动严格定序）。 */
  private enqueueProjection(step: () => Promise<void>): void {
    this.projectionChain = this.projectionChain.then(step).catch((err) => {
      this.deps.logger?.warn(`管家事件投影异常：${(err as Error).message}`);
    });
  }

  /** ask 流式回调转发（message_update/thinking/tool_execution → events 面
   *  ——签名对齐 StewardAskEvents：argsSummary/resultSummary 以事件面可得字段派生）。
   *  事故热修批⑥：thinking 帧不再由 thinking_delta 直通——pi 的 thinking_delta
   *  是 token 级增量事件，而 onThinking 契约是段级（一个完成态块一帧全量，
   *  StewardLlmPort 头注释同源）；直通 = 每 delta 一帧 → shell 每帧一条目 =
   *  「按字一行」事故形态。改为 message_end 完成块聚合发帧（与 KV 投影
   *  thinkingBlocks 同源同文本）。 */
  private forwardStreamCallbacks(event: AgentEngineEvent): void {
    const ev = this.askStreamEvents;
    if (ev.onDelta !== undefined && event.type === "message_update") {
      ev.onDelta(event.delta);
    } else if (ev.onThinking !== undefined && event.type === "message_end" && event.role !== "user" && event.role !== "toolResult") {
      const thinkingBlocks = (event.blocks ?? []).filter(
        (b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking",
      );
      const thinkingText = thinkingBlocks.map((b) => b.text).join("\n");
      if (thinkingText !== "") ev.onThinking(thinkingText);
    } else if (ev.onToolStart !== undefined && event.type === "tool_execution_start") {
      ev.onToolStart(event.toolName, summarizeArgsLite(event.args));
    } else if (ev.onToolEnd !== undefined && event.type === "tool_execution_end") {
      ev.onToolEnd(event.toolName, event.isError === true ? "（执行失败）" : event.result.slice(0, 120));
    }
  }

  /** 引擎事件投影（顺序化执行：KV 入账 / 暂停处理 / 压缩 / run 收口）。 */
  private async projectEngineEvent(event: AgentEngineEvent): Promise<void> {
    switch (event.type) {
      case "message_end":
        await this.projectMessageEnd(event);
        return;
      case "engine_error":
        if (this.run.state.softError === undefined) this.run.state.softError = event.message;
        return;
      case "tool_execution_start":
        return; // 计数与熔断在 onEngineEvent 同步段（见上）
      case "engine_paused":
        await this.handleEnginePaused(event);
        return;
      case "compaction_completed":
        // 事故热修批⑤：压缩器输出是内部上下文状态不是用户话轮——落
        // kind=compaction（不再伪装 kind=user；LLM 窗口重建经 recordToMessage
        // 转换为摘要消息注入上下文，压缩机制语义不变，仅落库与 UI 回放退出
        // user 轮域——2026-10-07 事故「## Goal（无…）压缩器工作规则」被渲染
        // 成用户发言的污染形态根修）。
        await this.dialog.compact(
          { kind: "compaction", text: event.summary, at: this.now() },
          this.deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT,
        );
        return;
      case "agent_end":
        return; // run 收口由 start() promise 驱动（真 idle 保证——见 driveAsk 注释）
      default:
        return;
    }
  }

  /** message_end → 工作记忆 KV（原 recordLoopMessage 的事件投影形态）。 */
  private async projectMessageEnd(
    event: Extract<AgentEngineEvent, { type: "message_end" }>,
  ): Promise<void> {
    if (event.role === "user") {
      // E-198 截断标记（AbortShaping 注入——固定常量文本非用户输入）照常
      // 入账（回放完整性）；user 形态记录统一带 at。
      const at = this.now();
      await this.pushRecord({ kind: "user", text: event.text, at });
      return;
    }
    if (event.role === "toolResult") {
      await this.pushRecord({
        kind: "toolResult",
        toolCallId: event.toolCallId ?? "",
        name: event.toolName ?? "",
        text: event.text,
        at: this.now(),
      });
      return;
    }
    if (event.stopReason === "aborted") this.run.state.sawAborted = true;
    if (event.stopReason === "error") {
      // 回执文案前缀（与迁移前 streamFn 包装等价——provider 原文随附）；
      // 事故热修批⑦：分类锚定 model-failure（provider 流错误——与工具面
      // aborted / 闸面 terminate 分记，收口日志不再一律记成模型失败）
      this.run.state.hardError =
        event.text.trim() !== "" ? `模型调用失败：${event.text}` : this.run.state.hardError ?? "模型调用失败";
      this.run.state.hardErrorKind = "model-failure";
      return; // error 消息不入 KV（半成品）——错误经回执交代
    }
    const blocks = event.blocks ?? [];
    // abort 半截轮无完整内容：零 assistant 记录（无「（无回答）」污染——
    // loop 无痕语义的对齐面；有文本/thinking 时照记）
    if (event.stopReason === "aborted" && blocks.length === 0 && event.text.trim() === "") return;
    const toolCall = blocks.find((b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall");
    const thinkingBlocks = blocks.filter((b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking");
    const text = toolCall !== undefined || event.text.trim() !== "" ? event.text : "（无回答）";
    if (toolCall === undefined && event.text.trim() !== "") this.run.state.lastAnswerText = event.text;
    const thinkingText = thinkingBlocks.map((b) => b.text).join("\n");
    const signature = thinkingBlocks.find((b) => b.signature !== undefined && b.signature !== "")?.signature;
    await this.pushRecord({
      kind: "assistant",
      ...(text !== "" || toolCall !== undefined ? { text } : {}),
      ...(thinkingText !== ""
        ? { thinking: signature !== undefined ? { text: thinkingText, signature } : { text: thinkingText } }
        : {}),
      ...(toolCall !== undefined ? { toolCall: { id: toolCall.id, name: toolCall.name, args: toolCall.args } } : {}),
      at: this.now(),
    });
  }

  /** 挂闸处理（原 beforeToolCallPause 校验体的 engine_paused 形态）。 */
  private async handleEnginePaused(
    event: Extract<AgentEngineEvent, { type: "engine_paused" }>,
  ): Promise<void> {
    const gated = await this.toolKit.gateWriteTool({
      runId: "",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: (event.args ?? {}) as Record<string, unknown>,
    });
    if (!gated.pause) {
      // read 档直行（M2 act）：approve 放行——工具正常执行（免确认直行）
      if (gated.approve === true) {
        await this.engine?.resume?.(event.pauseToken, { kind: "approve" });
        return;
      }
      // 校验未过直出（原 pause:false + outcome 路径）：guidance → reject
      // （模型知情续跑）；terminate → resolve 翻译（结果入账 + run 终结）。
      const outcome = gated.outcome;
      if (outcome !== undefined && outcome.kind === "terminate") {
        this.run.state.hardError = outcome.reason;
        this.run.state.hardErrorKind = "engine-error"; // 闸面终止（非模型失败——分记）
        await this.engine?.resume?.(event.pauseToken, { kind: "resolve", text: outcome.reason });
      } else {
        const text = outcome !== undefined && outcome.kind === "result" ? outcome.text : "提案未通过校验";
        await this.engine?.resume?.(event.pauseToken, { kind: "reject", text });
      }
      return;
    }
    // ── 批 1：提案登记收编 ProposalLedger（三路判别在聚合内；凭据换血 =
    //    action.toolCall + pauseToken 归聚合）。一次 run 至多一个未决提案
    //    （currentPause 归属——run 生命周期，批 2 迁 run 子域）。──
    const action: PendingAction = {
      ...gated.action,
      toolCall: { id: event.toolCallId, name: event.toolName },
    };
    const proposed = this.ledger.propose(action, { pauseToken: event.pauseToken });
    if (proposed.kind === "reused") {
      // 登记簿①：在途同 key → 复用旧卡（幂等：不新弹不新凭据；凭据换血
      // 到活 run 的 pauseToken——回灌链路续活，TTL 重置新确认窗口）
      this.currentPause.length = 0;
      this.currentPause.push({ actionId: proposed.actionId, action: proposed.entry.action });
      this.run.gate(event.pauseToken);
      this.logInfo(
        `管家确认闸复用在途提案卡：${proposed.actionId}（${gated.action.kind} → ${gated.action.displayTarget}）——同 key 幂等不新弹`,
      );
      this.settleAsk({
        status: "confirm_required",
        actionId: proposed.actionId,
        agentId: gated.action.displayTarget,
        message: gated.action.message,
      });
      return;
    }
    if (proposed.kind === "blocked") {
      // 登记簿②：已成功终局 → 不挂闸：回灌「已做过」（带原 actionId）
      this.logInfo(
        `管家确认闸拦截重复提案：${gated.action.kind} → ${gated.action.displayTarget}（已执行过 ${proposed.settled.actionId}）`,
      );
      await this.engine?.resume?.(event.pauseToken, {
        kind: "resolve",
        text: capToolResultText(`该操作已执行过（${proposed.settled.actionId}）：${proposed.settled.detail}——无需重复确认，可向用户说明`),
      });
      return;
    }
    const actionId = proposed.actionId;
    this.logInfo(`管家确认闸暂停：${actionId}（${gated.action.kind} → ${gated.action.displayTarget}）`);
    this.currentPause.length = 0; // 一次 run 至多一个未决提案（挂闸即收口）
    this.currentPause.push({ actionId, action: proposed.entry.action });
    this.run.gate(event.pauseToken);
    this.settleAsk({
      status: "confirm_required",
      actionId,
      agentId: gated.action.displayTarget,
      message: gated.action.message,
    });
  }

  /** run 收口（agent_end）：结果推导 + deliver + 队列驱动。
   *  确认链路修复批：error 收口日志附引擎错误摘要（事故 run#3/#5/#7 无原因）
   *  + 本 run 挂闸卡生命周期处置（deliver 类续活 / destructive 撤除+明示）。
   *  事故热修批④：幂等守卫（runActive=false 时直接回——防看门狗强制收口与
   *  自然收口双发驱动队列）；⑦：error 收口日志与回执携 errorKind 分类
   *  （aborted 与模型失败分记——act 挂闸 60s 后收口不再被误归模型失败）。 */
  private async finishRun(startError?: string): Promise<void> {
    if (!this.run.active) return; // 幂等守卫（事故热修批④）
    this.run.finish(); // 批 2：收口清块（runActive=false + 三锚复位）
    this.runSettledMark?.();
    this.runSettledMark = undefined;
    const outcome: StewardAskResultPayload =
      startError !== undefined
        ? { status: "error", reason: startError, errorKind: "engine-exception" }
        : this.outcomeOfRun();
    // ⑤ error 收口附原因摘要 + 分类分记（warn 级保证可见——旧装配 info 缺席
    //    时事故零日志；分类面让 aborted/模型失败/引擎异常可区分归因）
    if (outcome.status === "error") {
      const kind = outcome.errorKind ?? "-";
      this.deps.logger?.warn(
        `管家 run 收口：error（分类：${kind}；原因：${capChars(outcome.reason, 200)}；排队 ${this.askQueue.length} 条）`,
      );
      // 健康上报（光球角标批）：模型/引擎级失败 = llm 降级；aborted（用户
      // 手动停止）非故障不上报
      if (kind !== "aborted") this.deps.emitHealth?.("llm", "degraded", outcome.reason);
    } else {
      this.logInfo(`管家 run 收口：${outcome.status}（排队 ${this.askQueue.length} 条）`);
      this.deps.emitHealth?.("llm", "ok"); // 正常收口 = llm 恢复
    }
    // ④ 本 run 挂闸卡处置：deliver/send/create/spawnReview 意图不随 run 死
    //    而失效 → 凭据续活到卡终局；destructive 不可续活 → 即时撤除+明示。
    this.disposeRunPendingCards();
    const item = this.pendingRunAsk;
    this.pendingRunAsk = undefined;
    this.run.ungate();
    this.askStreamEvents = {};
    this.settleAsk(outcome);
    item?.deliver?.(outcome);
    const next = this.askQueue.shift();
    if (next !== undefined) {
      void this.driveAsk(next).catch((err) => {
        this.deps.logger?.warn(`队列驱动异常：${(err as Error).message}`);
      });
    }
  }

  /** run 收口挂闸卡处置（确认链路修复批④；批 1 起判定收编聚合）：currentPause
   *  即本 run 提案锚（一次 run 至多一个未决提案）；已终局（confirm/cancel
   *  先行）零处置；非 destructive 续活、destructive 撤除+明示（翻译面）。 */
  private disposeRunPendingCards(): void {
    const { kept, withdrawn } = this.ledger.resolveRunCards(this.currentPause.map((p) => p.actionId));
    for (const { actionId, action } of kept) {
      this.logInfo(
        `确认卡续活（run 收口不撤）：${actionId}（${action.kind} → ${action.displayTarget}）——意图不随 run 死而失效`,
      );
    }
    for (const { actionId, action } of withdrawn) {
      this.settleProposal(pendingKeyOf(action), "voided", actionId, "run 收口撤除（destructive 不可续活）");
      this.deps.emitActionCompleted?.({
        actionId,
        ok: false,
        detail: "该操作已撤回（原运行已结束，高风险操作不自动保留）——如仍需要请重新提出",
        outcome: "superseded",
      });
      this.emitLifecycleNotify(
        "normal",
        "高风险操作已撤回",
        `原运行已结束，「${action.displayTarget}」的高风险操作卡已撤除；如仍需要请重新提出`,
      );
    }
    this.currentPause = [];
  }

  /** run 结果推导（事件态 → 回执判别——原 mapRunResult）。事故热修批⑦：各
   *  error 分支携 errorKind（aborted 与模型失败分记——日志/回执可区分归因）。 */
  private outcomeOfRun(): StewardAskResultPayload {
    // aborted 优先于一切（半截文本不作终答回执——协议面回执恒 aborted error）；
    // 次之 answer（压缩失败 engine_error 不吞终答——fail-open）；最后 error
    if (this.run.state.roundLimit) {
      return {
        status: "error",
        reason: `工具循环超限（>${this.tuningOf().run.maxToolRounds} 轮熔断）——请缩小问题范围或重试`,
        errorKind: "round-limit",
      };
    }
    if (this.run.state.sawAborted) {
      return {
        status: "error",
        reason: "管家对话已被中止（abort——可重发；排队中的输入不受影响）",
        errorKind: "aborted",
      };
    }
    if (this.run.state.hardError !== undefined) {
      return {
        status: "error",
        reason: this.run.state.hardError,
        ...(this.run.state.hardErrorKind !== undefined ? { errorKind: this.run.state.hardErrorKind } : {}),
      };
    }
    if (this.run.state.lastAnswerText.trim() !== "") {
      return { status: "answer", text: this.run.state.lastAnswerText };
    }
    if (this.run.state.softError !== undefined) {
      return { status: "error", reason: this.run.state.softError, errorKind: "engine-error" };
    }
    return { status: "answer", text: "（无回答）" };
  }

  /** ask promise 收口（confirm_required 在挂闸即收；其余在 finishRun）。
   *  runSettled 不在此收——移 finishRun（暂停态新 ask 的 abort-再驱动需等
   *  引擎真 idle，而非 confirm_required 收口时点）。 */
  private settleAsk(payload: StewardAskResultPayload): void {
    const settle = this.askSettler;
    this.askSettler = undefined;
    settle?.(payload);
  }

  // ── 可靠性批（2026-10-06 事故根修）：看门狗 + 确认闸 TTL + 可达性提醒 ──
  // 三要素兑底：确认闸无超时（TTL）、run 无看门狗（watchdog）、挂起无日志
  // （生命周期日志面）。生产定时器由组合根 startReliabilityTimers 启动，
  // 测试直接调 reliabilityTick（注入时钟——E-240 行为等价不变量不受影响）。

  /** 启动可靠性巡检定时器（生产面；幂等——stewardMemory.startGcTimer 先例）。 */
  startReliabilityTimers(): void {
    if (this.reliabilityTimer !== undefined) return;
    const timer = setInterval(() => this.reliabilityTick(), this.tuningOf().run.watchdogTickMs);
    timer?.unref?.(); // TR-152 落盘面定时器纪律：不阻进程退出
    this.reliabilityTimer = timer;
  }

  /** StewardComponent 契约（批 0 生命周期登记表）：start/stop 映射既有
   *  可靠性巡检定时器面（幂等语义不变）。 */
  start(): void {
    this.startReliabilityTimers();
  }

  stop(): void {
    this.stopReliabilityTimers();
  }

  /** 停巡检定时器（shutdown 链挂点/测试清理）。 */
  stopReliabilityTimers(): void {
    if (this.reliabilityTimer === undefined) return;
    clearInterval(this.reliabilityTimer);
    this.reliabilityTimer = undefined;
  }

  /** 可靠性巡检单拍（看门狗 → 可达性提醒 → 确认闸 TTL；幂等可重入）。 */
  reliabilityTick(): void {
    const now = this.now();
    this.checkRunWatchdog(now);
    this.checkConfirmReminders(now);
    this.checkConfirmTtl(now);
  }

  /** run 看门狗 tick（批 2：判定收编 RunWatchdog 纯函数——六态穷举表驱动，
   *  domain/steward/run/RunWatchdog；副作用翻译在本方法）。原判定序与文案
   *  逐分支等价（含 CAND-666 哨兵防御/挂闸等待零通知/手动快进优先于被动轨）。 */
  private checkRunWatchdog(now: number): void {
    const verdict = judgeRunWatchdog(this.run.watchdogSnapshot(this.engine !== undefined), this.tuningOf(), now);
    switch (verdict.kind) {
      case "idle-reset":
        // 空闲态复位（下一 run 重计）——容器无独立复位方法：idle 即未触发
        return;
      case "unanchored":
      case "none":
        return;
      case "manual-fast-forward": {
        // 手动 abort 快进轨——abort 打不醒的挂死流不等被动看门狗（180s）
        this.forceRecoverRun(
          `手动停止快进：abort 后 ${this.tuningOf().run.manualAbortGraceMs / 1000}s 未收口（挂死流——abort 打不醒）——弃引擎重建并恢复队列`,
        );
        return;
      }
      case "arm": {
        this.run.armWatchdog();
        const gatedWait = this.ledger.size > 0; // 挂闸等待：有卡待确认（合法业务态）
        this.deps.logger?.warn(
          `管家 run 看门狗触发：挂起 ${verdict.hungSeconds}s 无事件推进${gatedWait ? "（挂闸等待中——pending 有卡）" : ""}——abort 在途轮${gatedWait ? "（等待态零通知）" : "并通知"}`,
        );
        if (!gatedWait) {
          // 恢复通知只留给「用户在等答案却被挂死」场景；挂闸等待用户知情
          // （有卡挂着），「已自动恢复」是惊扰噪音（2026-10-07 事故修订 CAND-666）
          this.emitLifecycleNotify(
            "high",
            "管家已自动恢复",
            `管家处理挂起 ${verdict.hungSeconds}s 无响应，已自动中止恢复；排队中的输入将继续处理`,
          );
        }
        this.abortInFlight("run 看门狗：挂起超时"); // 挂闸阻塞的 run 被唤醒收口（raceAbort）
        return;
      }
      case "force-recover": {
        this.run.armWatchdog(); // 周期性兜底重置（极端场景下每宽限窗再查）
        this.forceRecoverRun(verdict.reason);
        return;
      }
    }
  }

  /** 强制收口轨（手动停止批提取；挂死流唯一恢复路径——E-240）：看门狗宽限段
   *  与手动停止快进段共用。弃引擎（代际守卫隔离旧引擎残余事件）+ 经投影链
   *  finishRun（队列驱动/deliver 回执/挂闸卡处置全走既有收口面）。 */
  private forceRecoverRun(reason: string): void {
    this.run.forceRecoverPrepared(); // 同步清锚防重（finishRun 异步，重复 tick 不二触）
    this.engine = undefined; // 弃引擎（下一 run 懒重建；代际守卫隔旧事件）
    this.run.ungate();
    this.deps.logger?.warn(`管家 run 强制收口：${reason}`);
    this.enqueueProjection(() => this.finishRun(reason));
  }

  /** 确认可达性提醒（语音闭环批 ②聚合版）：任一卡到 30s 未消费 → 按 pending
   *  全集 N 出**一条**提醒（N=1 维持现单条文案；N≥2 合并「管家有 N 个操作
   *  等你确认」）且覆盖全集（全部置 remindedAt——后熟卡零二次提醒）。治事故
   *  「两张同模板卡各弹一条（body 仅目标不同 → 去重 key 不同全放行）」。 */
  private checkConfirmReminders(now: number): void {
    // 批 1：成熟判定/覆盖全集收编聚合；文案与帧发射留翻译面
    const matured = this.ledger.remindDue(now, this.tuningOf().confirm.remindAfterMs);
    if (matured === undefined) return;
    const total = matured.total;
    if (total >= 2) {
      this.logInfo(
        `管家确认卡可达性提醒（聚合）：pending ${total} 张（首成熟 ${matured.first.actionId}——${matured.first.entry.action.displayTarget}）——${this.tuningOf().confirm.remindAfterMs / 1000}s 无人消费`,
      );
      this.emitLifecycleNotify(
        "normal",
        "待确认操作",
        `管家有 ${total} 个操作等你确认——打开管家面板处理；${this.tuningOf().confirm.ttlMs / 1000}s 内未确认将自动作废`,
      );
      return;
    }
    this.logInfo(
      `管家确认卡可达性提醒：${matured.first.actionId}（${matured.first.entry.action.displayTarget}）——${this.tuningOf().confirm.remindAfterMs / 1000}s 无人消费`,
    );
    this.emitLifecycleNotify(
      "normal",
      "待确认操作",
      `管家有一个操作等你确认（${matured.first.entry.action.displayTarget}）——打开管家面板处理；${this.tuningOf().confirm.ttlMs / 1000}s 内未确认将自动作废`,
    );
  }

  /** 确认闸 TTL（语音闭环批 ②聚合版）：pending 卡超 tuning.confirm.ttlMs（批 0 起 KV 可配）无
   *  confirm/cancel → 自动作废（复用 cancel 内部语义——删除即作废，两段式不变
   *  量不动：作废后再 confirm 报已消费）+ 逐卡 action.completed 超时回执广播
   *  （卡栈同步面不聚合）+ **同批用户提醒合并一条**（N=1 现文案 / N≥2「N 个
   *  确认已超时作废」——治同批多卡逐条弹失效通知轰炸）。 */
  private checkConfirmTtl(now: number): void {
    // 批 1：到期批次作废收编聚合；回执/日志/提醒留翻译面（cancel 同款作废
    // 语义——删除即作废不清挂闸旗，挂闸 run 由看门狗/abort-再驱动收口）
    const expired = this.ledger.expireDue(now, this.tuningOf().confirm.ttlMs);
    for (const { actionId, entry } of expired) {
      this.ledger.markExpired(actionId); // 逐个删除（已被同 key 收敛先行删除 → no-op；帧照快照无条件发——原版时序）
      this.deps.logger?.warn(
        `管家确认卡 TTL 作废：${actionId}（${entry.action.kind} → ${entry.action.displayTarget}）——${this.tuningOf().confirm.ttlMs / 1000}s 无人确认自动作废`,
      );
      this.deps.emitActionCompleted?.({ actionId, ok: false, detail: STEWARD_CONFIRM_TIMEOUT_DETAIL, outcome: "timeout" });
      // 终局登记 + 同 key 收敛（确认链路修复批：作废也收敛，零后续连锁通知）
      this.settleProposal(entry.key ?? pendingKeyOf(entry.action), "voided", actionId, "确认超时作废");
    }
    if (expired.length === 0) return;
    if (expired.length >= 2) {
      this.emitLifecycleNotify(
        "normal",
        "确认已超时",
        `${expired.length} 个操作超过 ${this.tuningOf().confirm.ttlMs / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
      );
      return;
    }
    const single = expired[0]!;
    this.emitLifecycleNotify(
      "normal",
      "确认已超时",
      `操作「${single.entry.action.displayTarget}」超过 ${this.tuningOf().confirm.ttlMs / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
    );
  }

  /** 可靠性提醒帧出口（seq 单调；订阅闸/限流在 EventStream 侧——缺席零提醒）。 */
  private emitLifecycleNotify(urgency: "normal" | "high", title: string, body: string): void {
    if (this.deps.emitNotify === undefined) return;
    this.notifySeq += 1;
    this.deps.emitNotify({ urgency, title, body, seq: this.notifySeq });
  }

  /** 生命周期 info 日志（旧装配 logger 无 info 位时降级静默）。 */
  private logInfo(message: string): void {
    this.deps.logger?.info?.(message);
  }

  /** 工作记忆读面（steward.history 回放：完整记录数组——UI 渲染与 LLM 窗口
   *  同源重建；A1 批）。 */
  async getHistory(): Promise<readonly StewardHistoryRecord[]> {
    return this.dialog.snapshot();
  }

  /** 新对话闸（steward.history {clear:true}：KV + daemon LLM 窗口同清——
   *  前端显示由回执空数组同步；A1 批）。pending 确认卡随之作废（自然过期）。 */
  async clearHistory(): Promise<void> {
    this.ledger.clear();
    await this.dialog.clear();
    // 段B：引擎销毁重建（下一问从空窗口——与清空后 KV 同源；dialog 已清，
    // 懒构造下一问以空 initialMessages 重建）。挂闸阻塞中的 run 先 abort 释放
    //（闸内 raceAbort 唤醒）再弃引用；runActive 复位防新 ask 误判 busy。
    this.engine?.abort();
    this.engine = undefined;
    // 在途/排队 ask 先收口再清状态（孤儿化修复：askSettler 只置空不 settle
    // 的话，在途 ask 的 promise 永不 resolve——handler 的 steward.ask.result
    // 帧永不回执，UI 该轮永久等待；runSettledMark 同步收口防 abort-再驱动
    // 路径的 awaiter 挂死；排队项逐个 deliver 作废回执——新对话语义下不再
    // 处理，但发起面必须拿到终帧）。clearAll 后 finishRun 幂等守卫直接回，
    // 自然收口路径不会二次 settle——此处是唯一收口点。）
    const droppedItems = this.askQueue.drainAll();
    if (droppedItems.length > 0) this.logInfo(`管家新对话：丢弃排队 ${droppedItems.length} 条`);
    for (const queuedItem of droppedItems) {
      queuedItem.deliver?.({ status: "error", reason: "对话已清空（新对话）——排队输入作废", errorKind: "aborted" });
    }
    const clearedPayload: StewardAskResultPayload = {
      status: "error",
      reason: "对话已清空（新对话）——本轮已被中止",
      errorKind: "aborted",
    };
    const item = this.pendingRunAsk;
    this.pendingRunAsk = undefined;
    this.askStreamEvents = {};
    this.settleAsk(clearedPayload);
    this.run.clearAll(); // 批 2：run 态全复位
    this.runSettledMark?.();
    this.runSettledMark = undefined;
    item?.deliver?.(clearedPayload);
  }

  /** 确认闸放行（steward.confirm 回执）：单次消费 + 恰一次执行——
   *  **B1 两段式**（设计稿 §3.4）：
   *  ①受理即回：消费 actionId 后立即返 accepted（不 await 执行体——
   *    deliverSession 入 idle 会话的全轮 await 不再阻塞确认链，G1 主根
   *    消除；卡片即时转 accepted 态防双击）；
   *  ②异步执行：executePending 收口后经 onCompleted 回携
   *    {actionId, ok, detail}（点对点 steward.action.completed 帧，成败
   *    两路均发——错误交代面从 confirm.result 迁出）；回灌（resumeWith
   *    resolve）与工作记忆 toolResult 入账语义照旧，仅时点移入执行体。
   *  A2：动作分派（send / createSession / deliverSession / memorize /
   *  spawnReview 判别联合）。helix-loop L0：回灌经 LoopEngine 暂停点
   *  （run_resumed 事件 + appendToolResult 入账）。 */
  async confirm(
    actionId: string,
    onCompleted?: (payload: StewardActionCompletedPayload) => void,
  ): Promise<StewardConfirmResultPayload> {
    // 批 1：单次消费收编聚合（consume = 查卡+删卡一体；执行失败也不可重放）
    const entry = this.ledger.consume(actionId);
    if (entry === undefined) {
      // 确认链路修复批：用户语义文案（事故 12:17:16 点死卡只看到内部异常）
      return {
        status: "error",
        reason: `该确认已失效（actionId=${actionId} 不存在或已消费——服务重启/超时作废后凭据即失效）；如仍需要请重新提出`,
      };
    }
    // 暂停态旗同步清（B1 两段式窗口防误伤：执行体异步在飞时新 ask 不走
    // abort-再驱动路径——被弃的是确认流而非挂闸 run）
    if (this.ledger.size === 0) this.run.ungate();
    // 受理时即广播 navigate（deliverSession——sessionId 提案已知，不再等
    // 执行体全轮；createSession 的 navigate 仍在执行体（sessionId 执行后才
    // 产生））。
    if (entry.action.kind === "deliverSession") {
      this.deps.emitNavigate?.({ sessionId: entry.action.deliverSession!.sessionId });
    }
    const key = entry.key ?? pendingKeyOf(entry.action);
    // 异步执行体（受理后启动；错误经 onCompleted 交代，不浮出确认链）
    void (async () => {
      const outcome = await this.executePending(entry.action);
      // 回灌经引擎暂停面（resolve 翻译：结果入账 + run 终结——block+terminate）；
      // B4a 轮外提案无暂停点（pauseToken 缺席）——跳过回灌直接收口。
      // 确认链路修复批：run 已收口/引擎重建后凭据过期 → 降级跳过回灌
      //（事故实锤「审批闸未知 pauseToken」曾把已送达的执行误报为异常）。
      if (entry.pauseToken !== undefined && this.engine !== undefined) {
        try {
          await this.engine.resume?.(entry.pauseToken, {
            kind: "resolve",
            text: capToolResultText(outcome.detail),
            isError: !outcome.ok,
          });
        } catch (err) {
          this.logInfo(`确认卡回灌降级（run 已收口，凭据过期）：${(err as Error).message.slice(0, 80)}`);
        }
      }
      // 终局登记 + 同 key 收敛（succeeded 拦重复提案；失败不记=可重试）
      if (outcome.ok) this.settleProposal(key, "succeeded", actionId, outcome.detail);
      onCompleted?.({ actionId, ok: outcome.ok, detail: outcome.detail });
    })().catch((err: unknown) => {
      // 防御面：执行体异常不该静默（与 outcome.ok=false 同构交代）
      const detail = `确认动作执行异常：${(err as Error).message}`;
      this.deps.logger?.warn(detail);
      onCompleted?.({ actionId, ok: false, detail });
    });
    return { status: "accepted", actionId };
  }

  /** 确认卡作废（B1 steward.cancel）：pending 删除即作废——幂等（不存在/
   *  已消费静默）；作废后同 actionId 再 confirm 报「已消费」。卡片「放弃」
   *  的 daemon 侧簿记同步（消灭孤儿 actionId），零执行零回执。
   *  确认链路修复批：作废即终局——登记簿 voided（同 key 重提按新提案）+
   *  superseded 帧广播（多窗卡栈同步撤卡，G8 方向）+ 同 key 其余卡收敛。 */
  cancel(actionId: string): void {
    const entry = this.ledger.void(actionId);
    if (entry === undefined) return;
    // 不因删卡清 pausedGateToken：挂闸 run 若仍挂着（用户放弃的是卡不是 run），
    // 保留旗让下一个 ask 走 abort-再驱动唤醒收口（否则新 ask 误入队死等看门狗）
    this.settleProposal(entry.key ?? pendingKeyOf(entry.action), "voided", actionId, "用户放弃");
    this.deps.emitActionCompleted?.({
      actionId,
      ok: false,
      detail: "该操作已放弃（作废）",
      outcome: "superseded",
    });
  }

  /** 在途确认卡快照（steward.pending.snapshot 帧——订阅对账/跨重启清场；
   *  插入序；确认链路修复批，E-206 预留帧位落地）。 */
  pendingSnapshot(): readonly string[] {
    return this.ledger.pendingSnapshot();
  }

  /** 登记簿终局收口（批 1 起判定收编聚合——记终局 + 同 key 收敛；帧发射
   *  留翻译面：succeeded 拦重复/voided 放行重提 + 全订阅者 superseded 帧，
   *  零失效通知——治「已送达后又弹两条失效投递通知」）。 */
  private settleProposal(key: string, status: "succeeded" | "voided", actionId: string, detail: string): void {
    for (const { actionId: otherId } of this.ledger.settle(key, status, actionId, detail)) {
      this.deps.emitActionCompleted?.({
        actionId: otherId,
        ok: false,
        detail: "该操作已由其它确认收敛（同内容确认卡撤除）",
        outcome: "superseded",
      });
    }
  }

  // findPendingIdByKey / latestPendingActionId 已收编 ProposalLedger 聚合
  //（domain/steward/confirmation——批 1）。

  /** 判官泛化层（M3-a）：词表未命中 ∧ pending 卡在场 → 判官三问分流。
   *  返回 undefined = 不适用/降级（原样走 LLM）；confirm/cancel = 路由
   *  执行面；revise = 撤旧卡 + 修正轮 LLM 输入（带卡全文上下文）。
   *  降级链（E-250 同款）：开关关零日志 / 端点未配 WARN / 抛错 WARN 不
   *  重试——全部回退词表后行为零劣化。无卡零判官调用（不判闲聊）。 */
  /** addressee 判定（声纹→Jev 链路批）：双工收音段的「对谁说」判定。
   *  返回 true = 高置信旁人话语（调用方回 dropped 静默丢弃）；判官缺席
   *  （undefined/关/未配）/ 灰区 / 抛错一律 false = 偏「当聊天」（置信偏置
   *  同向：宁多应答不漏应答，零配置时行为与旧版完全一致）。 */
  private async judgeAddressee(text: string): Promise<boolean> {
    // 批 3a：降级链收编 judgeOrFallback（文案逐字保留——onDegraded 形态）
    const r = await judgeOrFallback({
      judge: this.deps.intentJudge,
      question: STEWARD_ADDRESSEE_QUESTION,
      text,
      interpret: isAmbientSpeech,
      fallback: false, // 灰区/坏值/判官缺席一律偏「当聊天」（置信偏置：宁多应答不漏）
      onDegraded: (kind, message) => {
        if (kind === "unready") {
          this.deps.logger?.warn("管家意图判官开启但端点未配或已失效——addressee 判定回退当聊天（原样走 LLM）");
        } else {
          this.deps.logger?.warn(`addressee 判定失败，回退当聊天：${message ?? ""}`);
        }
        // 健康上报（光球角标批）：判官关闭非故障（ok 清角标）；端点失效/调
        // 用失败 = judge 降级
        if (kind === "off") this.deps.emitHealth?.("judge", "ok");
        else this.deps.emitHealth?.("judge", "degraded", message ?? kind);
      },
    });
    if (r.degraded === undefined) this.deps.emitHealth?.("judge", "ok"); // 判官正常 = 恢复
    return r.value;
  }

  /** stop-intent 停止判定（Jev 单轨——停止词表退役批）：停止意图判官判定面
   *  ——shell 打断链与 daemon ask 漏斗的停止判定单源（协议面
   *  steward.judge_stop_intent）。**原始判定语义**：stop=true 才判停；判不出
   *  （off/unready/error）一律 stop=false + degraded 标记，fail-stop 归消费面
   *  ——shell 意图窗判不出=真停（用户裁决②：宁误停不漏停），ask 漏斗判不出
   *  =照常走队列（不吞用户提问、不动队列序不变量）。 */
  async judgeStopIntent(text: string): Promise<{ stop: boolean; score?: number; degraded?: "off" | "unready" | "error" }> {
    // 批 3a：降级链收编 judgeOrFallback（文案逐字保留）；stop=true 才判停；
    // 判不出携 degraded 标记（原始判定面——fail-stop 归消费面）。
    const r = await judgeOrFallback<{ stop: boolean; score?: number }>({
      judge: this.deps.intentJudge,
      question: STEWARD_STOP_QUESTION,
      text,
      interpret: (score) => (isStopIntent(score) ? { stop: true as const, score } : { stop: false as const, score }),
      fallback: { stop: false },
      onDegraded: (kind, message) => {
        if (kind === "unready") {
          this.deps.logger?.warn("管家意图判官开启但端点未配或已失效——stop-intent 判不出（fail-stop 归消费面）");
        } else {
          this.deps.logger?.warn(`stop-intent 判定失败（判不出）：${message ?? ""}`);
        }
        if (kind === "off") this.deps.emitHealth?.("judge", "ok");
        else this.deps.emitHealth?.("judge", "degraded", message ?? kind);
      },
    });
    if (r.degraded === undefined) this.deps.emitHealth?.("judge", "ok");
    return r.degraded !== undefined ? { ...r.value, degraded: r.degraded } : r.value;
  }

  private async judgePendingIntent(
    text: string,
  ): Promise<
    | { intent: "confirm" | "cancel" }
    | { intent: "revise"; revisedText: string }
    | undefined
  > {
    const judge = this.deps.intentJudge;
    if (judge === undefined) return undefined;
    if (!judge.enabled()) return undefined; // 开关关：默认态零日志（与分诊判官同款）
    const latest = this.ledger.latestPendingActionId();
    if (latest === undefined) return undefined; // 无卡零判官调用（范围钳制）
    if (!judge.ready()) {
      // 开关开但端点未配/已删/非 classifier——值得提醒（用户预期判官生效）
      this.deps.logger?.warn("管家意图判官开启但端点未配或已失效——回退词表后行为（原样走 LLM）");
      this.deps.emitHealth?.("judge", "degraded", "意图判官端点未配或已失效");
      return undefined;
    }
    const entry = this.ledger.entryOf(latest)!;
    const state = buildIntentJudgeState(entry.action.displayTarget, entry.action.message, text);
    try {
      const [revise, cancel, confirm] = await Promise.all([
        judge.noul(state, STEWARD_INTENT_JUDGE_REVISE_QUESTION),
        judge.noul(state, STEWARD_INTENT_JUDGE_CANCEL_QUESTION),
        judge.noul(state, STEWARD_INTENT_JUDGE_CONFIRM_QUESTION),
      ]);
      const intent = pickIntentByScores(revise, cancel, confirm);
      if (intent === undefined) return undefined; // 无关新任务 → 原样走 LLM
      if (intent === "revise") {
        // 修正：撤旧卡（终局 voided + superseded 广播——多窗卡栈同步）+
        // 修正轮 LLM 输入带原卡全文（一次 LLM，不先撤卡再裸问）
        this.cancel(latest);
        return {
          intent: "revise",
          revisedText: buildIntentReviseAskText(entry.action.displayTarget, entry.action.message, text),
        };
      }
      return { intent };
    } catch (err) {
      // 判官抛错即降级不重试（E-214/E-250 同款保守语义）
      this.deps.logger?.warn(`管家意图判官判定失败，回退词表后行为：${(err as Error).message}`);
      this.deps.emitHealth?.("judge", "degraded", (err as Error).message);
      return undefined;
    }
  }

  /** 口令路由（确认链路修复批③）：纯文本口令绑定最近 pending 卡消费/作废
   *  ——零 LLM 零新提案（治「确认了很多遍」被当新指令）；无 pending 卡时
   *  返回 undefined 原样走 LLM。确认回执经广播出口（口令来自任意连接）。 */
  private routeConfirmPhrase(phrase: "confirm" | "cancel"): StewardAskResultPayload | undefined {
    const latest = this.ledger.latestPendingActionId();
    if (latest === undefined) return undefined;
    const entry = this.ledger.entryOf(latest)!;
    const target = entry.action.displayTarget;
    if (phrase === "cancel") {
      this.cancel(latest);
      return { status: "answer", text: `已放弃该操作（${target}）——卡片已撤除` };
    }
    void this
      .confirm(latest, (payload) => this.deps.emitActionCompleted?.(payload))
      .then((accepted) => {
        if (accepted.status !== "accepted") {
          this.emitLifecycleNotify(
            "normal",
            "确认未生效",
            `口令确认未受理（${accepted.status === "error" ? accepted.reason : "未知原因"}）——请点卡片确认或重试`,
          );
        }
      })
      .catch((err) => this.deps.logger?.warn(`口令确认异常：${(err as Error).message}`));
    // 语音闭环批 ④：confirm 受理回执 = 纯语音一句话（零额外卡/toast）——deliver
    // 卡口语化带短标题（displayTarget 已是短名），其余动词维持现回执形态。
    const confirmText =
      entry.action.kind === "deliverSession"
        ? `已确认，马上投递到「${target}」——投递结果稍后告诉你`
        : `已确认执行（${target}）——执行回执稍后送达`;
    return { status: "answer", text: confirmText };
  }

  /** 确认闸执行体（单次消费后的真实写动作；detail = 用户与 LLM 共同可见的
   *  回执文本）。B1：createSession 建成后广播 steward.navigate（sessionId
   *  执行后才产生，仍在执行体；deliverSession 的 navigate 已提前到受理时——
   *  设计稿 §3.4）。 */
  private async executePending(action: PendingAction): Promise<{ ok: boolean; detail: string }> {
    if (action.kind === "surfaceAct") {
      // M2 表面动作：确认后走同一动作管道（Registry act 路由 + seq 回执）
      const request = action.surfaceAct!;
      if (this.deps.surfaces === undefined) {
        return { ok: false, detail: "表面能力面未装配（daemon 装配缺 surfaces 源）" };
      }
      try {
        const result = await this.deps.surfaces.act(request);
        return { ok: result.ok, detail: capToolResultText(formatActReceipt(result)) };
      } catch (err) {
        return { ok: false, detail: `表面动作执行异常：${(err as Error).message}` };
      }
    }
    if (action.kind === "send") {
      const outcome = this.deps.orchestration.send(action.send!.agentId, action.send!.message);
      return outcome.delivered
        ? { ok: true, detail: outcome.detail }
        : { ok: false, detail: `递话未投递：${outcome.detail}` };
    }
    if (action.kind === "createSession") {
      if (this.deps.sessions === undefined) {
        return { ok: false, detail: "会话创建面未装配（daemon 装配缺 sessions 源）" };
      }
      try {
        // 修复批①：专用入口 createTitledSession（同轨不同入口）——title 不再
        // 被当首条用户消息发送，零引擎调用零幽灵 run；确认闸/回灌闭环不变。
        const created = await this.deps.sessions.createTitledSession(action.createSession!.title);
        this.deps.emitNavigate?.({ sessionId: created.sessionId }); // 建完即切（用户语义）
        // 带着话题开始（本次批）：建成即把 initial_message 作为首条消息投递——
        // 复用 deliver_to_session 同一执行面（idle→新轮次 / running→steer 入队；
        // source=steward 与手动输入可辨）。修复批①封堵的是「title 被误当消息」
        // 的幽灵 run，不是「用户显式给的初始话题」——两者语义正交。
        const initialMessage = action.createSession!.initialMessage;
        if (initialMessage !== undefined) {
          try {
            const outcome = await this.deps.sessions.deliverToSession(created.sessionId, initialMessage);
            if (!outcome.delivered) {
              // 会话已建成（主成果保留，不可重放）——投递失败如实交代，LLM
              // 回灌后可向用户说明并提议 deliver_to_session 重试。
              return {
                ok: false,
                detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」，但初始话题投递失败：${outcome.detail}`,
              };
            }
            // 回合终态感知：初始话题投递成功 = 用户在新会话里开始了工作——同
            // deliverSession 语义注册关注（那边回合结束命中「回完了」分诊锚）。
            this.deps.onDelivered?.(created.sessionId, initialMessage);
            return {
              ok: true,
              detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」，初始话题已投递：${initialMessage}`,
            };
          } catch (err) {
            return {
              ok: false,
              detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」，但初始话题投递异常：${(err as Error).message}`,
            };
          }
        }
        return { ok: true, detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」` };
      } catch (err) {
        return { ok: false, detail: `会话创建失败：${(err as Error).message}` };
      }
    }
    if (action.kind === "deliverSession") {
      if (this.deps.sessions === undefined) {
        return { ok: false, detail: "会话投递面未装配（daemon 装配缺 sessions 源）" };
      }
      try {
        const outcome = await this.deps.sessions.deliverToSession(action.deliverSession!.sessionId, action.deliverSession!.text);
        if (!outcome.delivered) {
          return { ok: false, detail: `投递未送达：${outcome.detail}` };
        }
        // 回合终态感知：投递成功注册关注——该会话回合结束命中分诊锚
        // （「那边回完了」主动通知；缺席 = 零关注纯 opt-in）。
        this.deps.onDelivered?.(action.deliverSession!.sessionId, action.deliverSession!.text);
        return { ok: true, detail: outcome.detail };
      } catch (err) {
        return { ok: false, detail: `投递执行失败：${(err as Error).message}` };
      }
    }
    // spawnReview：paramsSchema 校验在引擎（TaskError message 原样透传）
    if (this.deps.taskEngine === undefined) {
      return { ok: false, detail: "任务创建面未装配（daemon 装配缺 taskEngine）" };
    }
    const review = action.spawnReview!;
    try {
      const created = await this.deps.taskEngine.createTask({
        type: review.reviewType,
        projects: [review.project],
        params: review.params,
        createdBy: "chat",
      });
      return { ok: true, detail: `任务已创建：${created.jobId}（${review.reviewType} @ ${review.project}）` };
    } catch (err) {
      return { ok: false, detail: `任务创建被引擎拒绝：${(err as Error).message}` };
    }
  }

  /**
   * fanout 目标入口（wireEventFanout steward-feed-bridge 装配）：①层粗筛 +
   * 闸门 + ②层模板直出 + feed 帧。只产出协议帧，零领域事件发布（防自激）。
   */
  onDomainEvent(event: DomainEvent): void {
    if (!STEWARD_FEED_EVENT_TYPES.has(event.type)) return;
    if (!this.deps.feedGate.hasStewardSubscribers()) return; // 零订阅零推送
    const text = buildFeedText(event);
    if (text === undefined) return;
    const payload = event.payload as { agentId?: string };
    if (typeof payload.agentId !== "string" || payload.agentId === "") return;
    this.feedSeq += 1;
    this.deps.emitFeed({
      kind: event.type as StewardFeedPayload["kind"],
      agentId: payload.agentId,
      text,
      seq: this.feedSeq,
    });
  }

  /** 开关现态（money gate 读面）。 */
  isEnabled(): boolean {
    return this.deps.config.get(STEWARD_ENABLED_KEY) === "1";
  }

  /** 设置现态（steward.get_config / set_config 共用读面）。summary 组 =
   *  总结配置域只读回显（config.result 回显 summary 组——写面在
   *  config.set_summary，管家配置零总结项）。triage 组 = 分诊判官配置
   *  现态（分诊判官接入批：judgeEnabled + judgeEndpoint 引用态——端点
   *  删除读面视为未配 null）。 */
  getConfig(): {
    enabled: boolean;
    model: string;
    summary: import("../summary/summaryConfig").SummaryConfigState;
    memory: import("./StewardMemoryService").StewardMemoryState;
    triage: TriageJudgeState;
  } {
    return {
      enabled: this.isEnabled(),
      model: this.deps.config.get(STEWARD_MODEL_KEY) ?? this.deps.llm.modelId,
      // 总结配置组回显（summary.* 通用域生效值——所见即所得）
      summary: readSummaryConfig(this.deps.config),
      // 管家记忆 B1：记忆面现态（未装配 = 全降级缺省——开关关/零条目；批1：
      //  endpoint 摘除——向量端点恒为全局默认端点，回执不回 endpointId）
      memory: this.deps.memory?.getMemoryState() ?? {
        enabled: false,
        available: false,
        judgeEndpoint: null,
        entryCount: 0,
        dim: null,
      },
      // 分诊判官配置现态（未装配 = 全降级缺省——开关关/端点未配）
      triage: this.deps.triageJudge?.state() ?? { judgeEnabled: false, judgeEndpoint: null },
    };
  }

  /** 管家只读档案（agent.steward_profile.get；管家公民权批）：纯导出面——
   *  零新状态，三现有源：①静态人格段 STEWARD_SYSTEM_PROMPT（动态情景快照
   *  段运行期拼入不在本面）；②注册面八工具清单（ToolRegistry.manifest 含
   *  hidden 面板原语——观测透明度 = 真实工具面）；③模型槽位 KV 现值
   *  （未设 = null——修改走智能体页管家卡模型槽位）。回执不含任何凭据类字段。 */
  getProfile(): { systemPrompt: string; tools: readonly { name: string; description: string }[]; model: string | null; kindLabel: "steward" } {
    return {
      systemPrompt: STEWARD_SYSTEM_PROMPT,
      tools: [
        ...this.toolSpecs.map((t) => ({ name: t.name, description: t.description })),
        { name: "steward_confirm", description: "确认闸放行（面板确认按钮原语；非 LLM 工具）" },
      ],
      model: this.deps.config.get(STEWARD_MODEL_KEY) ?? null,
      kindLabel: "steward",
    };
  }

  // ── 记忆条目管理委托面（管家记忆 B2：steward.memory_* 四命令回口——
  //    memory 服务缺席时零记忆降级形态）───────────────────────

  /** 条目只读清单（空数组 = 记忆面缺席/空库）。 */
  listMemoryEntries(): readonly import("../ports/outbound/StewardMemoryPort").StewardMemoryEntry[] {
    return this.deps.memory?.listEntries() ?? [];
  }

  /** 人工新增（embed 入库；缺席/失败 → error outcome）。projectScope =
   *  显式指定通道（项目隔离批——"global" 或项目目录名）；domain（domain
   *  维度批）= 业务领域显式指定，缺省按 kind 推导（preference→habit、
   *  fact→general）或由显式 projectScope 反向隐含 project 域。 */
  async appendMemoryEntry(
    text: string,
    kind?: "fact" | "preference",
    projectScope?: string,
    domain?: import("../ports/outbound/StewardMemoryPort").MemoryDomain,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.deps.memory.appendMemoryEntry(text, kind, projectScope, domain);
  }

  /** 重嵌更新（缺席/失败 → error outcome）。 */
  async updateMemoryEntry(id: number, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.deps.memory.updateMemoryEntry(id, text);
  }

  /** 行级删除（缺席 → false，幂等）。 */
  forgetMemoryEntry(id: number): boolean {
    return this.deps.memory?.forgetEntry(id) ?? false;
  }

  /** 置顶切换（遗忘机制批命令回口：置顶 = 解除淡忘 + 刷 updatedAt；
   *  缺席 → false）。 */
  pinMemoryEntry(id: number, pinned: boolean): boolean {
    return this.deps.memory?.pinMemoryEntry(id, pinned) ?? false;
  }

  /** 淡忘恢复（遗忘机制批命令回口：active 条目幂等 no-op；缺席 → false）。 */
  restoreMemoryEntry(id: number): boolean {
    return this.deps.memory?.restoreMemoryEntry(id) ?? false;
  }

  /** 设置写面（槽位可选更新；model 格式校验 "provider/model-id"；
   *  memory 组 {enabled?,judgeEndpointId?} + 批B 召回量
   *  {recallTopK?,recallPool?} + 阈值 {recallMinScore?}——组内字段整体转发
   *  通用记忆配置域 memory.*；批1：memory.endpointId 退役（向量端点选择
   *  收编 embedding.defaultEndpointId），旧壳传值由 handler 静默忽略；
   *  triage 组 {judgeEnabled?,judgeEndpointId?} 转发分诊判官配置域
   *  （分诊判官接入批）。
   *  **summary/sessionMemory 组已摘除**（会话总结器独立化批①——总结配置
   *  收编 summary.* 通用域，写面在 config.set_summary；携带旧组的载荷在
   *  handler 层拒答 invalid_payload）。 */
  async setConfig(patch: {
    enabled?: boolean;
    model?: string;
    memory?: { enabled?: boolean; judgeEndpointId?: string; recallTopK?: number; recallPool?: number; recallMinScore?: number };
    triage?: { judgeEnabled?: boolean; judgeEndpointId?: string };
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (patch.memory !== undefined) {
      // 管家记忆 B1：记忆配置委托记忆域服务（校验在其中——开启前端点必填）
      if (this.deps.memory === undefined) {
        return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
      }
      const outcome = await this.deps.memory.setMemoryConfig(patch.memory);
      if (!outcome.ok) return outcome;
    }
    if (patch.triage !== undefined) {
      // 分诊判官接入批：判官配置委托判定域面（空串 judgeEndpointId = 清除引用）
      if (this.deps.triageJudge === undefined) {
        return { ok: false, error: "分诊判官面未装配（daemon 装配缺 triage 源）" };
      }
      const outcome = await this.deps.triageJudge.setConfig(patch.triage);
      if (!outcome.ok) return outcome;
    }
    if (patch.model !== undefined) {
      const model = patch.model.trim();
      if (model !== "" && !/^[^/\s]+\/[^/\s]+$/.test(model)) {
        return { ok: false, error: `模型格式非法：${model}（应为 "provider/model-id" 形态）` };
      }
      if (model !== "") await this.deps.config.set(STEWARD_MODEL_KEY, model);
    }
    if (patch.enabled !== undefined) {
      await this.deps.config.set(STEWARD_ENABLED_KEY, patch.enabled ? "1" : "0");
    }
    return { ok: true };
  }

  /**
   * 对话内主动汇报（M0.5-R：激活态主动环投递面，D12-⑫「激活=对话内主动
   * 汇报+接续提案」）：分诊呈现轨 + 接续提案以 assistant 记录入工作记忆
   * ——同源链路保持（UI 对话回放显示的 = LLM 记得的，后续 ask 自带已汇报
   * 现场）；只是记录追加，零引擎驱动零响应环改动；接续提案为文本建议行，
   * 点按才动/写类动作仍过确认闸（D12-⑤ 不变）。组合根接
   * StewardPerceptionService.reportDialog 窄接口。
   *
   * M3-a（CAND-601 闭环）：记录追加的同时广播 steward.proactive 实时帧
   * ——开着的面板实时冒出汇报条目（不重开面板）；重开面板由 history 回放
   * 同源再现。emitProactive 缺席 = 零帧，记录照写（语义面零降级）。
   */
  async reportProactive(report: { title: string; text: string; suggestions?: readonly { label: string; verb?: string; sessionId?: string }[] }): Promise<void> {
    const lines = [`【主动汇报】${report.title}`, report.text];
    for (const s of report.suggestions ?? []) {
      if (s.label.trim() !== "") lines.push(`建议：${s.label}（点按才动）`);
    }
    await this.pushRecord({ kind: "assistant", text: lines.join("\n"), at: this.now() });
    this.proactiveSeq += 1;
    this.deps.emitProactive?.({
      title: report.title,
      text: report.text,
      ...(report.suggestions !== undefined && report.suggestions.length > 0 ? { suggestions: report.suggestions } : {}),
      seq: this.proactiveSeq,
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 工作记忆镜像 → LLM 消息窗口（同源：UI 回放显示的 = LLM 记得的；
   *  A1-hotfix：经 buildLlmWindow 配对防御——孤儿 toolResult 丢弃/缺结果
   *  toolCall 补合成结果；KV 存储与 history 回放读面不动）。 */
  private dialogSnapshotMessages(): StewardLlmMessage[] {
    return buildLlmWindow(this.dialog.snapshot());
  }

  /** 完整记录追加（工作记忆 KV——预算闸在 memory 内部）。 */
  private async pushRecord(record: StewardHistoryRecord): Promise<void> {
    await this.dialog.append(record);
  }

  // ── helix-loop L0：工具注册表装配（八工具）+ 暂停点挂钩 ──────

  // ── 工具面已收编 tools/StewardToolKit（批 3a）：registerTools/挂闸判定/
  //    提案构造/工具体全部迁出——加工具只动 StewardToolKit。 ──
  /** 快照段组装（感知查询失败静默降级 = undefined；绝不能挡对话主链路）。
   *  数据源与工具面同源：活跃 agent 数 = orchestration.status()（与
   *  list_instances 同一调用面）；会话计数与主题 = sessions 源（与
   *  query_recent_work 同一读面）；M3-d1 活动段 = recentActivity 读面
   *  （活动账白话行——**分段降级**：活动面抛错只缺席活动段，基础段照常）。 */
  private async buildSnapshotSafely(): Promise<string | undefined> {
    if (this.deps.sessions === undefined) return undefined;
    try {
      const rows = await this.deps.sessions.listSessionMetadata();
      const statuses = this.deps.orchestration.status();
      const activeAgents = statuses.filter((s) => s.state === "running").length;
      // M3-d1：活动段读面独立降级（读面抛错 → 零活动段，快照基础段照常——
      // 现 assembleStewardSystemPrompt 附加段缺席语义）
      let recentActivity: readonly { at: number; domain: string; attribution: string; text: string }[] | undefined;
      try {
        recentActivity = this.deps.recentActivity?.();
      } catch (err) {
        this.deps.logger?.warn(`管家快照活动段读面降级（快照仅基础段）：${(err as Error).message}`);
        recentActivity = undefined;
      }
      return buildContextSnapshot({
        nowMs: this.now(),
        activeAgents,
        totalAgents: statuses.length,
        sessionCount: rows.length,
        recentSessions: rows.slice(0, SNAPSHOT_RECENT_SESSIONS).map((r) => ({
          // displayTitle 单源（TR-205 口径 + 动态主题批）：title > topic > firstUserText
          title: r.title ?? r.topic ?? r.firstUserText ?? "（无主题会话）",
          updatedAt: r.updatedAt,
        })),
        ...(recentActivity !== undefined && recentActivity.length > 0 ? { recentActivity } : {}),
      });
    } catch (err) {
      this.deps.logger?.warn(`管家情景快照组装失败（降级为无快照段）：${(err as Error).message}`);
      return undefined;
    }
  }

  // ── A2：query_recent_work ───────────────────────────

}

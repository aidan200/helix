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
import { StewardDialogMemory } from "./StewardDialogMemory";
import type { StewardMemoryService } from "./StewardMemoryService";
import type { TriageJudgeFace, TriageJudgeState } from "./StewardTriageJudge";
import {
  STEWARD_ADDRESSEE_QUESTION,
  STEWARD_INTENT_JUDGE_CANCEL_QUESTION,
  STEWARD_INTENT_JUDGE_CONFIRM_QUESTION,
  STEWARD_INTENT_JUDGE_REVISE_QUESTION,
  buildIntentJudgeState,
  buildIntentReviseAskText,
  isAmbientSpeech,
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
interface GateToolContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/** 挂闸校验结果（中立——原 {pause, outcome} 判别：result/terminate 两出口）。 */
type GateToolOutcome =
  | { readonly kind: "result"; readonly text: string; readonly isError?: boolean }
  | { readonly kind: "terminate"; readonly reason: string };

/** args 摘要（feed 帧面——JSON 截断 120 字符）。 */
function summarizeArgsLite(args: unknown): string {
  try {
    const json = JSON.stringify(args) ?? "null";
    return json.length > 120 ? `${json.slice(0, 120)}…` : json;
  } catch {
    return "(unserializable)";
  }
}

/** 豁免旗标嗅探（M2 突变面）：任何「免确认」企图位——闸面整单拒绝。 */
function hasExemptionAffordance(args: Record<string, unknown>): boolean {
  for (const key of ["exempt", "auto_confirm", "autoConfirm", "skip_confirmation", "skipConfirm", "confirmed"]) {
    if (args[key] === true) return true;
  }
  return false;
}

/** act 回执文本（带序列号回流——D7-1）。 */
function formatActReceipt(result: { ok: boolean; seq: number; detail: string }): string {
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

/** L1 件二：输入缓冲 pending 队列上限（忙碌态入队不拒绝；超限提示）。 */
export const STEWARD_PENDING_ASKS_MAX = 3;

/** ── 管家可靠性根修批（2026-10-06 事故）：三道兜底的时间参数 ──────────
 *  模块常量 + 注释（配置面不做——M4 隐私面板批统一做）。事故链：write 档
 *  挂闸无人确认 → runActive 永真 → finishRun 永不执行 → 后续 ask 永远
 *  queued → 管家对一切输入装死且零日志。三要素对三参数： */

/** run 看门狗阈值：run 内无事件推进持续此时长 → abort 在途轮 + 挂起通知
 *  （180s ——事故中 20 分钟装死的兑底上限；活跃 run 每事件重置计时）。 */
export const STEWARD_RUN_WATCHDOG_MS = 180_000;

/** run 看门狗巡检间隔（生产 interval；测试直接调 reliabilityTick 注入时钟）。 */
export const STEWARD_RUN_WATCHDOG_TICK_MS = 5_000;

/** 看门狗 abort 宽限窗：abort 后仍 runActive 持续此时长 → 强制收口 + 引擎
 *  重建（pi EventStream 不竞速 abort signal——挂死的 provider 流 abort 后
 *  run promise 仍永悬，必须弃引擎重建；180+15=195s < 5 分钟自愈口径）。 */
export const STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS = 15_000;

/** 确认卡 TTL：pending 挂闸无人 confirm/cancel 持续此时长 → 自动作废（复用
 *  cancel 内部语义——删除即作废；300s）。E-206 残项中「超时作废」部分，
 *  跨重启重放不做。 */
export const STEWARD_CONFIRM_TTL_MS = 300_000;

/** 确认卡可达性提醒：confirm_required 发出后无人消费持续此时长 → 提醒帧
 *  （30s——事故中确认卡入口不可见，提醒是第二入口）。 */
export const STEWARD_CONFIRM_REMIND_AFTER_MS = 30_000;

/** 确认超时作废的 action.completed detail 文案（用户与 LLM 共同可见）。 */
export const STEWARD_CONFIRM_TIMEOUT_DETAIL = "确认超时（超时无人确认，已自动作废——如仍需要请重新提出）";

/** ── 确认链路修复批（2026-10-06 12:13-12:28 事故）：口令路由词表 + 登记簿 ──
 * 事故定性：用户每次重述 → 管家新提案 → 新卡（六卡并存）；「确认了很多遍」
 * 被当新指令又弹卡；已送达后又陆续弹失效通知。三件根治：在途提案登记簿
 * （弹卡出口唯一）、确认口令路由（词表绑定最近 pending 卡）、终局收敛
 * （同 key 其余卡静默撤除）。 */

/** 确认类口令词表（单源；纯文本全等匹配零 LLM——命中绑定最近 pending 卡消费）。 */
export const STEWARD_CONFIRM_PHRASES: readonly string[] = [
  "确认",
  "确认执行",
  "执行",
  "执行吧",
  "做吧",
  "好的",
  "行",
  "可以",
];

/** 取消类口令词表（命中绑定最近 pending 卡作废）。 */
export const STEWARD_CANCEL_PHRASES: readonly string[] = ["取消", "不要了", "放弃"];

/** 口令归一（trim + 尾部标点剥除——语音转写常带句读；中部不改）。 */ function normalizePhrase(text: string): string {
  return text.trim().replace(/[。．.!！?？?，,、；;～~\s]+$/u, "");
}

/** 口令判定（极轻纯函数，零 LLM；非词表全等 → undefined 原样走 LLM）。 */
export function matchStewardCommandPhrase(text: string): "confirm" | "cancel" | undefined {
  const normalized = normalizePhrase(text);
  if (normalized === "") return undefined;
  if (STEWARD_CONFIRM_PHRASES.includes(normalized)) return "confirm";
  if (STEWARD_CANCEL_PHRASES.includes(normalized)) return "cancel";
  return undefined;
}

/** 内容指纹（FNV-1a 32 位十六进制——登记簿 key 的 contentHash 位；非密码学用途，
 *  只求同内容同值异内容异值且极轻）。 */
function contentHashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** 提案登记簿 key = verb|targetId|contentHash（弹卡出口唯一化的幂等键；
 *  targetId 按 verb 语义取：send=agentId / deliver=sessionId / create=title /
 *  spawnReview=type@project / surfaceAct=verb@surfaceId）。 */
export function pendingKeyOf(action: PendingAction): string {
  switch (action.kind) {
    case "send":
      return `send|${action.send!.agentId}|${contentHashOf(action.send!.message)}`;
    case "deliverSession":
      return `deliverSession|${action.deliverSession!.sessionId}|${contentHashOf(action.deliverSession!.text)}`;
    case "createSession": {
      const c = action.createSession!;
      return `createSession|${c.title}|${contentHashOf(c.initialMessage ?? "")}`;
    }
    case "spawnReview": {
      const r = action.spawnReview!;
      return `spawnReview|${r.reviewType}@${r.project}|${contentHashOf(JSON.stringify(r.params))}`;
    }
    case "surfaceAct": {
      const s = action.surfaceAct!;
      return `surfaceAct|${s.verb}@${s.surfaceId}|${s.risk}|${contentHashOf(JSON.stringify(s.args))}`;
    }
  }
}

/** 提案终局登记簿上限（FIFO 淘汰——终局记录仅服务短窗幂等判定，无持久价值）。 */
export const STEWARD_PROPOSAL_REGISTRY_MAX = 256;

/** ── A2 批：动态情景快照段 ───────────────────────────────
 *  内容预算（字符级硬顶；中文 ~600 字符 ≈ 400-600 token，满足 brief
 *  ≤600 token 口径）：当前时间一行 + 活跃 agent/会话计数两行 + 最近
 *  1-2 个会话主题一行。 */
export const CONTEXT_SNAPSHOT_MAX_CHARS = 600;

/** 快照段内会话主题标题截断上限（标题级——不进正文）。 */
export const SNAPSHOT_TITLE_MAX_CHARS = 16;

/** 快照段「最近会话」行数上限。 */
export const SNAPSHOT_RECENT_SESSIONS = 2;

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

长期记忆（若 system prompt 末尾附「长期记忆」段）：那是按本轮输入语义召回的历史沉淀，仅供作答参考——与本轮指令冲突时以本轮指令为准。用户纠正你时，若纠正内容有跨会话价值，用 remember 沉淀更新后的认知（语义重复会自动覆盖更新原条目）。`;

/** 会话显示标题单源（TR-207：title > topic > firstUserText > 兜底——
 *  快照/清单/read_session 三消费面共用，不得另写推导链）。 */
function displayTitleOf(r: StewardSessionMetaRow): string {
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
function capChars(text: string, maxChars: number): string {
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
function fmtWhen(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "?";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 快照段行文（纯函数导出供单测）：<context_snapshot> XML 包裹的情景快照。
 *  行序：当前时间 → 活跃 agent → 会话计数 → 最近 1-2 个会话主题。
 *  硬预算：整体字符数 ≤ CONTEXT_SNAPSHOT_MAX_CHARS（防御性截断）。 */
export function buildContextSnapshot(input: {
  nowMs: number;
  activeAgents: number;
  totalAgents: number;
  sessionCount: number;
  recentSessions: readonly { title: string; updatedAt: string }[];
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
  const body = lines.join("\n");
  const budget = CONTEXT_SNAPSHOT_MAX_CHARS - "<context_snapshot>\n".length - "</context_snapshot>".length;
  return `<context_snapshot>\n${capChars(body, budget)}\n</context_snapshot>`;
}

/** 动态 system prompt 组装（纯函数导出供单测）：静态人格段 + 快照段 +
 *  记忆召回段（管家记忆 B1）+ 在途提案段（语音闭环批 ①——LLM 路径上下文
 *  增强）；附加段缺席（感知/召回失败静默降级）= 原样静态段。 */
export function assembleStewardSystemPrompt(
  snapshot: string | undefined,
  memorySection?: string | undefined,
  pendingSection?: string | undefined,
): string {
  let prompt = STEWARD_SYSTEM_PROMPT;
  if (memorySection !== undefined) prompt = `${prompt}\n\n${memorySection}`;
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
   *  最后 N 条 {role, text}（旧→新，repo 层单条已截 300）；sessionId 不存在
   *  = undefined（引导层判据）。 */
  readSessionTail(sessionId: string, tailEntries: number): Promise<readonly { role: string; text: string }[] | undefined>;
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
      createdBy: "page" | "chat";
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
  /** M3-a：对话内主动汇报实时帧出口（CAND-601 闭环——组合根接
   *  EventStream.broadcastStewardProactive；缺席 = 零帧，工作记忆记录照写
   *  ——语义面零降级，仅实时性缺席）。 */
  readonly emitProactive?: (payload: StewardProactivePayload) => void;
}

/** 确认闸目标（面板两行渲染语义重载：send = 递话目标实例；createSession /
 *  spawnReview = 动作标识；deliverSession = 递话目标会话；surfaceAct = 表面
 *  动作目标 surfaceId——见各分支注释）。 */
interface PendingAction {
  readonly kind: "send" | "createSession" | "spawnReview" | "deliverSession" | "surfaceAct";
  /** 面板确认卡「目标」行显示值（send = agentId；createSession = "新会话"；
   *  spawnReview = "<reviewType>@<project>"；deliverSession = sessionId）。 */
  readonly displayTarget: string;
  /** 面板确认卡「内容」行显示值（动作摘要全文）。 */
  readonly message: string;
  /** 提案时的工具调用（confirm 执行结果回灌工作记忆的配对锚）。 */
  readonly toolCall: { id: string; name: string };
  /** send 形态载荷。 */
  readonly send?: { agentId: string; message: string };
  /** createSession 形态载荷（initialMessage = 用户想带着话题开始的初始内容——建成即作为首条消息投递；缺省纯建空会话）。 */
  readonly createSession?: { title: string; initialMessage?: string };
  /** deliverSession 形态载荷（驾驶舱批：session 级 steer 投递）。 */
  readonly deliverSession?: { sessionId: string; text: string };
  // （B5：memorize 提案形态已删——记忆写入静默化，remember 工具与自动沉淀管线
  //  均直写入库 + memory_written 通知，不再挂确认闸。）
  /** spawnReview 形态载荷。 */
  readonly spawnReview?: {
    reviewType: "code-review" | "kg-review";
    project: string;
    params: Record<string, unknown>;
  };
  /** surfaceAct 形态载荷（M2 表面动作——risk 已定档，经确认闸后走同一动作管道）。 */
  readonly surfaceAct?: StewardSurfaceActRequest;
}

/** 工具声明（JSON Schema 面——flash 级模型的 function calling 契约）。 */
const TOOL_LIST_INSTANCES: StewardLlmTool = {
  name: "list_instances",
  description: "查询全部 agent 实例的状态清单（id、运行态、被指派任务、终态摘要）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const TOOL_LIST_TASKS: StewardLlmTool = {
  name: "list_tasks",
  description: "查询任务清单（标题、状态、进度、错误）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const TOOL_PROPOSE_SEND: StewardLlmTool = {
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

const TOOL_QUERY_RECENT_WORK: StewardLlmTool = {
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

const TOOL_READ_SESSION: StewardLlmTool = {
  name: "read_session",
  description:
    "读取指定会话的最近消息内容（尾部窗口，旧→新）——回答「那个会话聊到哪了/进展如何/具体说了什么」类问题时深读用；只读不改。sessionId 先用 query_recent_work 查（或用记忆召回行里的 sid）。返回尾部若干条 [user]/[assistant] 消息（长文截断）。",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "目标会话 id（query_recent_work 结果或记忆召回行的 sid）" },
      tail: { type: "number", description: "尾部条数（可选，缺省 6，上限 20）" },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
};

// ── 批A（管家开放 kg 只读工具）：项目知识只读检索二件 ────────

const TOOL_KG_SEARCH: StewardLlmTool = {
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

const TOOL_KG_GET: StewardLlmTool = {
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

const TOOL_CREATE_SESSION: StewardLlmTool = {
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

const TOOL_START_SESSION: StewardLlmTool = {
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

const TOOL_SPAWN_REVIEW_TASK: StewardLlmTool = {
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

const TOOL_DELIVER_TO_SESSION: StewardLlmTool = {
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

const TOOL_REMEMBER: StewardLlmTool = {
  name: "remember",
  description:
    "沉淀长期记忆（立即静默入库并弹通知卡，无需用户确认）。仅用于跨会话有持久价值的认知增量：用户明确表达的偏好/习惯（kind=preference）或对话中确认的事实（kind=fact）。text 要提炼成一句简单易懂、主题明确的记忆句（不要照搬用户原话口语）。一次性上下文、本轮临时信息、寒暄不记；语义重复会自动覆盖更新原条目。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "记忆文本（一句自然语言，将向用户全文展示以供确认）" },
      kind: { type: "string", enum: ["fact", "preference"], description: "条目类别（缺省 fact）" },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

/** surface_list（M2 四泛型工具之一，D4）：动态发现表面与能力——新表面/新
 *  动词靠它发现，不加工具膨胀。 */
const TOOL_SURFACE_LIST: StewardLlmTool = {
  name: "surface_list",
  description:
    "列出当前全部表面（浏览器 tab / helix 页面等）及其能力动词清单——不知道 surfaceId 或想知道能做什么时先用本工具。只读免确认。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

/** snapshot：表面状态快照（只读免确认）。 */
const TOOL_SNAPSHOT: StewardLlmTool = {
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
const TOOL_READ: StewardLlmTool = {
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
const TOOL_ACT: StewardLlmTool = {
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
const GATED_TOOLS: ReadonlySet<string> = new Set([
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
interface PendingEntry {
  readonly action: PendingAction;
  /** 登记簿幂等键（确认链路修复批——复用/收敛判定锚；缺省时现算回退）。 */
  readonly key?: string;
  /** 挂闸凭据（段B：engine_paused 的 pauseToken——confirm 执行后经
   *  engine.resume(resolve 翻译) 回灌终结 run；B4a 轮外提案（自动沉淀）
   *  缺席——confirm 时跳过回灌直接收口）。 */
  readonly pauseToken?: string;
  /** 挂闸登记时刻（this.now()——确认卡 TTL/可达性提醒的计时锚；可靠性批）。 */
  readonly createdAt: number;
  /** 可达性提醒已发时刻（undefined = 未提醒；可靠性批——一次不重复）。 */
  remindedAt: number | undefined;
}

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

export class StewardService {
  private readonly deps: StewardServiceDeps;
  /** 工作记忆 KV（完整记录持久化——thinking/工具/对话全形态；daemon 重启
   *  后懒加载恢复，A1 批取代裸内存数组）。 */
  private readonly dialog: StewardDialogMemory;
  private readonly now: () => number;
  /** 待确认写动作（actionId 单次消费；不持久化——过期即失效不跨重启）。 */
  private readonly pending = new Map<string, PendingEntry>();
  /** 提案终局登记簿（key → 最近终局；确认链路修复批：succeeded 拦截重复提案
   *  回「已做过」，voided/无记录放行新提案——治六卡并存的重复源）。 */
  private readonly proposalRegistry = new Map<
    string,
    { status: "succeeded" | "voided"; actionId: string; detail: string; settledAt: number }
  >();
  /** 八工具中立规格（createEngine 装配面——driven 工具桥投影 pi AgentTool）。 */
  private readonly toolSpecs: StewardToolSpec[] = [];
  /** 隐藏面板原语名（不进引擎工具面——getProfile 观测面合并显示）。 */
  private readonly hiddenToolNames: string[] = [];
  private actionSeq = 0;
  private feedSeq = 0;
  /** 段B翻转：pi 引擎（懒构造——首问时经 createEngine 唯一配方装配，
   *  dialog 懒加载回填 initialMessages）。 */
  private engine: AgentEnginePort | undefined;
  /** 当前 run 的挂闸提案候选（confirm_required 回执映射锚——每 run 重置）。 */
  private currentPause: { actionId: string; action: PendingAction }[] = [];
  /** ask 自持队列（方案甲——E-197 行为等价：上限 3/收口后自动下一轮）。 */
  private readonly askQueue: StewardAskItem[] = [];
  /** 当前 run 驱动的 ask 项（收口 deliver 回执锚）。 */
  private pendingRunAsk: StewardAskItem | undefined;
  /** ask promise 收口器（confirm_required 在 engine_paused 即收，其余 agent_end）。 */
  private askSettler: ((payload: StewardAskResultPayload) => void) | undefined;
  /** 当前 run 事件投影链（KV 写入与收口定序——事件乱序投影即数据竞争）。 */
  private projectionChain: Promise<void> = Promise.resolve();
  /** 当前 ask 的流式回调（事件转发面）。 */
  private askStreamEvents: StewardAskEvents = {};
  /** 当前 run 结果推导态（agent_end 时收口映射）。事故热修批⑦：hardErrorKind
   *  区分 hardError 来源（模型调用失败 vs 闸面 terminate 翻译）——工具面
   *  aborted 不再被误归为模型失败（2026-10-07 事故 act 挂闸 60s 后收口被记
   *  「模型调用失败」）。 */
  private runState: {
    lastAnswerText: string;
    hardError: string | undefined; // 消息级（stopReason=error）：error 回执优先于 answer
    hardErrorKind: StewardAskErrorKind | undefined; // hardError 分类（模型失败/闸面终止）
    softError: string | undefined; // 事件级 engine_error（压缩失败等 fail-open）：answer 在则让位
    sawAborted: boolean;
    roundLimit: boolean;
    toolCalls: number;
  } = {
    lastAnswerText: "",
    hardError: undefined,
    hardErrorKind: undefined,
    softError: undefined,
    sawAborted: false,
    roundLimit: false,
    toolCalls: 0,
  };
  /** 当前挂闸中的 pauseToken（暂停态新 ask 的 abort-再驱动判别锚）。 */
  private pausedGateToken: string | undefined;
  /** run 收口通知（driveAsk 的 abort-再驱动路径等 settle）。 */
  private runSettled: Promise<void> = Promise.resolve();
  /** run 在途自持位（busy 判别不依赖 engine.isStreaming——投影链 settle 微任务
   *  早于 pi agent 态翻转，误判 busy 会把直答 ask 错误入队）。 */
  private runActive = false;
  /** 当前 run 内最近事件时刻（可靠性批看门狗锚：driveAsk 置位、每引擎事件
   *  推进——「无事件推进」才是挂起，活跃轮永不触发）。 */
  private runLastProgressAt: number | undefined = undefined;
  /** 看门狗已触发时刻（undefined = 未触发；同集 episode 不重复 abort/通知，
   *  宽限窗后仍未收口进入强制收口轨——abort 丳不醒的挂死流兑底）。 */
  private watchdogFiredAt: number | undefined;
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
    this.registerTools();
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
    // 判官泛化层（M3-a：三级漏斗第二级）：词表未命中 ∧ pending 卡在场 →
    // 判官 noul 三问分流「确认/取消/修正」。确认/取消复用口令路由执行面
    //（零 LLM 零新提案）；修正 = 撤旧卡 + 按修正后意图新开（一次 LLM 带卡
    // 全文上下文）；三问皆低 = 无关新任务原样走 LLM。判官缺席/关闭/未配/
    // 抛错 → 回退词表后行为零劣化（judgePendingIntent 内降级链）。挂闸
    // 阻塞中泛化确认 = 面板点卡的等价入口（与口令路由同构）。
    if (phrase === undefined) {
      // addressee 判定（声纹→Jev 链路批）：双工常开麦收音段的「对谁说」判定
      // ——词表未命中才判（词表全等 = 机械权威零判定）；声纹闸在 shell 已拦
      // 非用户，本层只判「用户本人是不是在叫管家」。旁人高置信 → dropped
      // 静默丢弃；判官缺席/灰区/抛错 → 偏「当聊天」继续（宁多应答不漏）。
      if (source === "voice-duplex" && (await this.judgeAddressee(text))) {
        return { status: "dropped", reason: "ambient" };
      }
      const generalized = await this.judgePendingIntent(text);
      if (generalized !== undefined) {
        if (generalized.intent !== "revise") {
          const routed = this.routeConfirmPhrase(generalized.intent);
          if (routed !== undefined) return routed;
          // 卡在分类与路由间消失（TTL/并发消费）：零差异回退原样走 LLM
        } else {
          text = generalized.revisedText; // 修正轮输入替换（下方队列/驱动链零感知）
        }
      }
    }
    // 暂停态（挂闸阻塞中）新 ask：loop 语义 = 旧 run 已 settle 过期、新 ask
    // 照常（E-197 迁移前等价）——pi 映射：abort 阻塞中的 run（闸内 raceAbort
    // 唤醒、工具不执行）→ 收口后驱动新 ask（确认卡保持有效：confirm 时
    // pauseToken 已过期自然失效）。
    if (this.runActive) {
      if (this.pausedGateToken !== undefined && this.engine !== undefined) {
        this.engine.abort();
        await this.runSettled;
        return this.driveAsk({ text, events, ...(deliver !== undefined ? { deliver } : {}) });
      }
      if (this.askQueue.length >= STEWARD_PENDING_ASKS_MAX) {
        return {
          status: "error",
          reason: `管家正在处理中，排队已满（上限 ${STEWARD_PENDING_ASKS_MAX} 条）——请稍后再试`,
        };
      }
      this.askQueue.push({ text, events, ...(deliver !== undefined ? { deliver } : {}) });
      return { status: "queued", queued: true, position: this.askQueue.length };
    }
    return this.driveAsk({ text, events });
  }

  /** 在途轮 abort（幂等——非在途态 no-op 返回 false；挂闸阻塞中同样唤醒
   *  收口）。收口后自持队列自动接管（序不变量：队列不丢）。 */
  abortInFlight(reason: string): boolean {
    void reason;
    if (!this.runActive || this.engine === undefined) return false;
    this.engine.abort();
    return true;
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
    this.runActive = true; // 单飞同步占位（零 await 间隙——ask 检查面立即可见）
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
      if (!this.runActive) throw err;
      this.runActive = false;
      this.runLastProgressAt = undefined;
      this.watchdogFiredAt = undefined;
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
      // 项目隔离批：召回视野 = global + 当前项目（memoryProject 解析当前
      // 活跃项目；缺席/未绑定/多项目 → undefined = 只 global）
      await this.deps.memory?.recallSection(item.text, this.deps.memoryProject?.()),
      // 语音闭环批 ①：在途提案段（LLM 路径上下文增强——pending 非空时引导
      // 把用户补充话语对齐确认/取消/目标修正，对齐失败才按新指令；词表快路径
      //（TR-240）在 ask 入口先行，两者叠加不冲突）
      buildPendingProposalsSection([...this.pending.values()].map((e) => e.action)),
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
    this.runActive = true; // 幂等（driveAsk 已同步占位——防御直接调用面）
    this.runLastProgressAt = this.now();
    this.watchdogFiredAt = undefined;
    this.logInfo(`管家 run 开始：${item.text.slice(0, 40)}`);
    this.pendingRunAsk = item;
    this.askStreamEvents = item.events;
    this.runState = {
      lastAnswerText: "",
      hardError: undefined,
      hardErrorKind: undefined,
      softError: undefined,
      sawAborted: false,
      roundLimit: false,
      toolCalls: 0,
    };
    this.currentPause = [];
    this.pausedGateToken = undefined;
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

  /** run 收口通知标记（runSettled promise 的 resolve 句柄）。 */
  private runSettledMark: (() => void) | undefined;

  /** 引擎事件入口（persistentListener——trace 出口 + 流式回调转发 + 顺序化投影）。 */
  private onEngineEvent(event: AgentEngineEvent): void {
    this.runLastProgressAt = this.now(); // 看门狗推进锚（任何引擎事件 = 活跃）
    this.deps.emitEngineEvent?.(event);
    this.forwardStreamCallbacks(event);
    // 轮数熔断（同步判定——async 投影链赶不上无思考工具风暴；abort 越早越省）
    if (event.type === "tool_execution_start") {
      this.runState.toolCalls += 1;
      if (this.runState.toolCalls > STEWARD_MAX_TOOL_ROUNDS && !this.runState.roundLimit) {
        this.runState.roundLimit = true;
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
        if (this.runState.softError === undefined) this.runState.softError = event.message;
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
    if (event.stopReason === "aborted") this.runState.sawAborted = true;
    if (event.stopReason === "error") {
      // 回执文案前缀（与迁移前 streamFn 包装等价——provider 原文随附）；
      // 事故热修批⑦：分类锚定 model-failure（provider 流错误——与工具面
      // aborted / 闸面 terminate 分记，收口日志不再一律记成模型失败）
      this.runState.hardError =
        event.text.trim() !== "" ? `模型调用失败：${event.text}` : this.runState.hardError ?? "模型调用失败";
      this.runState.hardErrorKind = "model-failure";
      return; // error 消息不入 KV（半成品）——错误经回执交代
    }
    const blocks = event.blocks ?? [];
    // abort 半截轮无完整内容：零 assistant 记录（无「（无回答）」污染——
    // loop 无痕语义的对齐面；有文本/thinking 时照记）
    if (event.stopReason === "aborted" && blocks.length === 0 && event.text.trim() === "") return;
    const toolCall = blocks.find((b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall");
    const thinkingBlocks = blocks.filter((b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking");
    const text = toolCall !== undefined || event.text.trim() !== "" ? event.text : "（无回答）";
    if (toolCall === undefined && event.text.trim() !== "") this.runState.lastAnswerText = event.text;
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
    const gated = await this.gateWriteTool({
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
        this.runState.hardError = outcome.reason;
        this.runState.hardErrorKind = "engine-error"; // 闸面终止（非模型失败——分记）
        await this.engine?.resume?.(event.pauseToken, { kind: "resolve", text: outcome.reason });
      } else {
        const text = outcome !== undefined && outcome.kind === "result" ? outcome.text : "提案未通过校验";
        await this.engine?.resume?.(event.pauseToken, { kind: "reject", text });
      }
      return;
    }
    this.actionSeq += 1;
    const actionId = `steward-action-${this.actionSeq}`;
    const key = pendingKeyOf(gated.action);
    // ── 登记簿①：在途同 key → 复用旧卡（幂等：不新弹不新凭据；凭据换血
    //    到活 run 的 pauseToken——回灌链路续活，TTL 重置新确认窗口） ──
    const existingId = this.findPendingIdByKey(key);
    if (existingId !== undefined) {
      const existing = this.pending.get(existingId)!;
      this.pending.set(existingId, {
        action: { ...gated.action, toolCall: { id: event.toolCallId, name: event.toolName } },
        key,
        pauseToken: event.pauseToken,
        createdAt: this.now(),
        remindedAt: existing.remindedAt,
      });
      this.currentPause.length = 0;
      this.currentPause.push({ actionId: existingId, action: this.pending.get(existingId)!.action });
      this.pausedGateToken = event.pauseToken;
      this.logInfo(
        `管家确认闸复用在途提案卡：${existingId}（${gated.action.kind} → ${gated.action.displayTarget}）——同 key 幂等不新弹`,
      );
      this.settleAsk({
        status: "confirm_required",
        actionId: existingId,
        agentId: gated.action.displayTarget,
        message: gated.action.message,
      });
      return;
    }
    // ── 登记簿②：已成功终局 → 不挂闸：回灌「已做过」（带原 actionId）──
    const settled = this.proposalRegistry.get(key);
    if (settled !== undefined && settled.status === "succeeded") {
      this.logInfo(
        `管家确认闸拦截重复提案：${gated.action.kind} → ${gated.action.displayTarget}（已执行过 ${settled.actionId}）`,
      );
      await this.engine?.resume?.(event.pauseToken, {
        kind: "resolve",
        text: capToolResultText(`该操作已执行过（${settled.actionId}）：${settled.detail}——无需重复确认，可向用户说明`),
      });
      return;
    }
    this.logInfo(`管家确认闸暂停：${actionId}（${gated.action.kind} → ${gated.action.displayTarget}）`);
    this.currentPause.length = 0; // 一次 run 至多一个未决提案（挂闸即收口）
    this.currentPause.push({
      actionId,
      action: { ...gated.action, toolCall: { id: event.toolCallId, name: event.toolName } },
    });
    this.pending.set(actionId, {
      action: this.currentPause[0]!.action,
      key,
      pauseToken: event.pauseToken,
      createdAt: this.now(),
      remindedAt: undefined,
    });
    this.pausedGateToken = event.pauseToken;
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
    if (!this.runActive) return; // 幂等守卫（事故热修批④）
    this.runActive = false;
    this.runLastProgressAt = undefined;
    this.watchdogFiredAt = undefined;
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
    } else {
      this.logInfo(`管家 run 收口：${outcome.status}（排队 ${this.askQueue.length} 条）`);
    }
    // ④ 本 run 挂闸卡处置：deliver/send/create/spawnReview 意图不随 run 死
    //    而失效 → 凭据续活到卡终局；destructive 不可续活 → 即时撤除+明示。
    this.disposeRunPendingCards();
    const item = this.pendingRunAsk;
    this.pendingRunAsk = undefined;
    this.pausedGateToken = undefined;
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

  /** run 收口挂闸卡处置（确认链路修复批④）：currentPause 即本 run 提案锚
   *  （一次 run 至多一个未决提案）；已终局（confirm/cancel 先行）零处置。 */
  private disposeRunPendingCards(): void {
    for (const { actionId, action } of this.currentPause) {
      const entry = this.pending.get(actionId);
      if (entry === undefined) continue; // 已终局（确认/作废先行）——无处置
      const destructive = action.kind === "surfaceAct" && action.surfaceAct?.risk === "destructive";
      if (!destructive) {
        this.logInfo(
          `确认卡续活（run 收口不撤）：${actionId}（${action.kind} → ${action.displayTarget}）——意图不随 run 死而失效`,
        );
        continue;
      }
      this.pending.delete(actionId);
      this.settleProposal(entry.key ?? pendingKeyOf(entry.action), "voided", actionId, "run 收口撤除（destructive 不可续活）");
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
    if (this.runState.roundLimit) {
      return {
        status: "error",
        reason: `工具循环超限（>${STEWARD_MAX_TOOL_ROUNDS} 轮熔断）——请缩小问题范围或重试`,
        errorKind: "round-limit",
      };
    }
    if (this.runState.sawAborted) {
      return {
        status: "error",
        reason: "管家对话已被中止（abort——可重发；排队中的输入不受影响）",
        errorKind: "aborted",
      };
    }
    if (this.runState.hardError !== undefined) {
      return {
        status: "error",
        reason: this.runState.hardError,
        ...(this.runState.hardErrorKind !== undefined ? { errorKind: this.runState.hardErrorKind } : {}),
      };
    }
    if (this.runState.lastAnswerText.trim() !== "") {
      return { status: "answer", text: this.runState.lastAnswerText };
    }
    if (this.runState.softError !== undefined) {
      return { status: "error", reason: this.runState.softError, errorKind: "engine-error" };
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
    const timer = setInterval(() => this.reliabilityTick(), STEWARD_RUN_WATCHDOG_TICK_MS);
    timer?.unref?.(); // TR-152 落盘面定时器纪律：不阻进程退出
    this.reliabilityTimer = timer;
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

  /** run 看门狗：无事件推进超 STEWARD_RUN_WATCHDOG_MS → abort（复用
   *  abortInFlight 幂等面——不新造 abort）；abort 宽限窗后仍 runActive
   *  → 强制收口 + 弃引擎重建（pi EventStream 不竞速 abort signal，挂死流
   *  abort 后 run promise 仍永悬——弃引擎是唯一恢复路径；下一 run 经
   *  createEngine 从工作记忆 KV 重建，代际守卫隔离旧引擎残余事件）。 */
  private checkRunWatchdog(now: number): void {
    if (!this.runActive || this.engine === undefined) {
      this.watchdogFiredAt = undefined; // 空闲态复位（下一 run 重计）
      return;
    }
    if (this.runLastProgressAt === undefined) {
      // 2026-10-07 事故防御（CAND-666）：runActive=true 但推进锚未锚定（收口
      // 复位与下一 run 置位之间的竞态窗口）——now-0 会算出 56 年级挂起时长
      // （Date.now() 毫秒÷1000≈epoch 秒）误触发 + 荒谬文案。未锚定不判挂起。
      // 哨兵 undefined 而非 0：测试时钟域起点 0 是合法锚定值，0 会被误判未锚定。
      return;
    }
    if (this.watchdogFiredAt === undefined) {
      if (now - this.runLastProgressAt < STEWARD_RUN_WATCHDOG_MS) return;
      this.watchdogFiredAt = now;
      const hungSeconds = Math.round((now - this.runLastProgressAt) / 1000);
      const gatedWait = this.pending.size > 0; // 挂闸等待：有卡待确认（合法业务态）
      this.deps.logger?.warn(
        `管家 run 看门狗触发：挂起 ${hungSeconds}s 无事件推进${gatedWait ? "（挂闸等待中——pending 有卡）" : ""}——abort 在途轮${gatedWait ? "（等待态零通知）" : "并通知"}`,
      );
      if (!gatedWait) {
        // 恢复通知只留给「用户在等答案却被挂死」场景；挂闸等待用户知情
        // （有卡挂着），「已自动恢复」是惊扰噪音（2026-10-07 事故修订 CAND-666）
        this.emitLifecycleNotify(
          "high",
          "管家已自动恢复",
          `管家处理挂起 ${hungSeconds}s 无响应，已自动中止恢复；排队中的输入将继续处理`,
        );
      }
      this.abortInFlight("run 看门狗：挂起超时"); // 挂闸阻塞的 run 被唤醒收口（raceAbort）
      return;
    }
    // 已触发：宽限窗后仍未收口 → 强制收口（abort 丳不醒的挂死流）
    if (now - this.watchdogFiredAt >= STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS) {
      this.watchdogFiredAt = now; // 周期性兜底重置（极端场景下每宽限窗再查）
      this.deps.logger?.warn(
        `管家 run 看门狗强制收口：abort 宽限 ${STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS / 1000}s 内 run 未收口——弃引擎重建并恢复队列服务`,
      );
      this.engine = undefined; // 弃引擎（下一 run 懒重建；代际守卫隔旧事件）
      this.pausedGateToken = undefined;
      this.enqueueProjection(() => this.finishRun("run 看门狗强制收口：引擎挂死且 abort 未唤醒（已弃引擎重建）"));
    }
  }

  /** 确认可达性提醒（语音闭环批 ②聚合版）：任一卡到 30s 未消费 → 按 pending
   *  全集 N 出**一条**提醒（N=1 维持现单条文案；N≥2 合并「管家有 N 个操作
   *  等你确认」）且覆盖全集（全部置 remindedAt——后熟卡零二次提醒）。治事故
   *  「两张同模板卡各弹一条（body 仅目标不同 → 去重 key 不同全放行）」。 */
  private checkConfirmReminders(now: number): void {
    let matured: { actionId: string; entry: PendingEntry } | undefined;
    for (const [actionId, entry] of this.pending) {
      if (entry.remindedAt !== undefined) continue;
      if (now - entry.createdAt < STEWARD_CONFIRM_REMIND_AFTER_MS) continue;
      matured = { actionId, entry };
      break; // 聚合口径：任一成熟即代表全集出一条（文案按全集 N 组装）
    }
    if (matured === undefined) return;
    const total = this.pending.size;
    for (const entry of this.pending.values()) entry.remindedAt = now; // 覆盖全集
    if (total >= 2) {
      this.logInfo(
        `管家确认卡可达性提醒（聚合）：pending ${total} 张（首成熟 ${matured.actionId}——${matured.entry.action.displayTarget}）——${STEWARD_CONFIRM_REMIND_AFTER_MS / 1000}s 无人消费`,
      );
      this.emitLifecycleNotify(
        "normal",
        "待确认操作",
        `管家有 ${total} 个操作等你确认——打开管家面板处理；${STEWARD_CONFIRM_TTL_MS / 1000}s 内未确认将自动作废`,
      );
      return;
    }
    this.logInfo(
      `管家确认卡可达性提醒：${matured.actionId}（${matured.entry.action.displayTarget}）——${STEWARD_CONFIRM_REMIND_AFTER_MS / 1000}s 无人消费`,
    );
    this.emitLifecycleNotify(
      "normal",
      "待确认操作",
      `管家有一个操作等你确认（${matured.entry.action.displayTarget}）——打开管家面板处理；${STEWARD_CONFIRM_TTL_MS / 1000}s 内未确认将自动作废`,
    );
  }

  /** 确认闸 TTL（语音闭环批 ②聚合版）：pending 卡 STEWARD_CONFIRM_TTL_MS 无
   *  confirm/cancel → 自动作废（复用 cancel 内部语义——删除即作废，两段式不变
   *  量不动：作废后再 confirm 报已消费）+ 逐卡 action.completed 超时回执广播
   *  （卡栈同步面不聚合）+ **同批用户提醒合并一条**（N=1 现文案 / N≥2「N 个
   *  确认已超时作废」——治同批多卡逐条弹失效通知轰炸）。 */
  private checkConfirmTtl(now: number): void {
    const expired: { actionId: string; entry: PendingEntry }[] = [];
    for (const [actionId, entry] of [...this.pending]) {
      if (now - entry.createdAt < STEWARD_CONFIRM_TTL_MS) continue;
      expired.push({ actionId, entry });
    }
    for (const { actionId, entry } of expired) {
      this.pending.delete(actionId); // cancel 同款作废语义（删除即作废；不清挂闸
      // 旗——挂闸 run 若仍挂着由看门狗/abort-再驱动收口，同 cancel 注释）
      this.deps.logger?.warn(
        `管家确认卡 TTL 作废：${actionId}（${entry.action.kind} → ${entry.action.displayTarget}）——${STEWARD_CONFIRM_TTL_MS / 1000}s 无人确认自动作废`,
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
        `${expired.length} 个操作超过 ${STEWARD_CONFIRM_TTL_MS / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
      );
      return;
    }
    const single = expired[0]!;
    this.emitLifecycleNotify(
      "normal",
      "确认已超时",
      `操作「${single.entry.action.displayTarget}」超过 ${STEWARD_CONFIRM_TTL_MS / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
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
    this.pending.clear();
    await this.dialog.clear();
    // 段B：引擎销毁重建（下一问从空窗口——与清空后 KV 同源；dialog 已清，
    // 懒构造下一问以空 initialMessages 重建）。挂闸阻塞中的 run 先 abort 释放
    //（闸内 raceAbort 唤醒）再弃引用；runActive 复位防新 ask 误判 busy。
    this.engine?.abort();
    this.engine = undefined;
    this.pausedGateToken = undefined;
    this.runActive = false;
    this.runLastProgressAt = undefined;
    this.watchdogFiredAt = undefined;
    this.askSettler = undefined;
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
    const entry = this.pending.get(actionId);
    if (entry === undefined) {
      // 确认链路修复批：用户语义文案（事故 12:17:16 点死卡只看到内部异常）
      return {
        status: "error",
        reason: `该确认已失效（actionId=${actionId} 不存在或已消费——服务重启/超时作废后凭据即失效）；如仍需要请重新提出`,
      };
    }
    this.pending.delete(actionId); // 先消费（单次语义：执行失败也不可重放）
    // 暂停态旗同步清（B1 两段式窗口防误伤：执行体异步在飞时新 ask 不走
    // abort-再驱动路径——被弃的是确认流而非挂闸 run）
    if (this.pending.size === 0) this.pausedGateToken = undefined;
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
    const entry = this.pending.get(actionId);
    if (entry === undefined) return;
    this.pending.delete(actionId);
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
    return [...this.pending.keys()];
  }

  /** 登记簿终局收口（确认链路修复批）：记终局（succeeded 拦重复/voided 放行
   *  重提）+ 同 key 其余在途卡静默收敛（全订阅者 superseded 帧，零失效
   *  通知——治「已送达后又弹两条失效投递通知」）。 */
  private settleProposal(key: string, status: "succeeded" | "voided", actionId: string, detail: string): void {
    this.proposalRegistry.delete(key);
    this.proposalRegistry.set(key, { status, actionId, detail, settledAt: this.now() });
    if (this.proposalRegistry.size > STEWARD_PROPOSAL_REGISTRY_MAX) {
      const oldest = this.proposalRegistry.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.proposalRegistry.delete(oldest);
    }
    for (const [otherId, other] of [...this.pending]) {
      if (otherId === actionId) continue;
      if ((other.key ?? pendingKeyOf(other.action)) !== key) continue;
      this.pending.delete(otherId);
      this.deps.emitActionCompleted?.({
        actionId: otherId,
        ok: false,
        detail: "该操作已由其它确认收敛（同内容确认卡撤除）",
        outcome: "superseded",
      });
    }
  }

  /** 在途同 key 卡定位（复用旧卡判定面；key 缺席时现算回退——防御注入态）。 */
  private findPendingIdByKey(key: string): string | undefined {
    for (const [actionId, entry] of this.pending) {
      if ((entry.key ?? pendingKeyOf(entry.action)) === key) return actionId;
    }
    return undefined;
  }

  /** 最近一张 pending 卡（口令路由绑定锚——createdAt 最大，相等取后入）。 */
  private latestPendingActionId(): string | undefined {
    let latest: { id: string; createdAt: number } | undefined;
    for (const [actionId, entry] of this.pending) {
      if (latest === undefined || entry.createdAt >= latest.createdAt) latest = { id: actionId, createdAt: entry.createdAt };
    }
    return latest?.id;
  }

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
    const judge = this.deps.intentJudge;
    if (judge === undefined) return false;
    if (!judge.enabled()) return false; // 开关关：默认态零日志（同款）
    if (!judge.ready()) {
      this.deps.logger?.warn("管家意图判官开启但端点未配或已失效——addressee 判定回退当聊天（原样走 LLM）");
      return false;
    }
    try {
      const score = await judge.noul(`用户这句话：${text}`, STEWARD_ADDRESSEE_QUESTION);
      return isAmbientSpeech(score);
    } catch (err) {
      this.deps.logger?.warn(`addressee 判定失败，回退当聊天：${(err as Error).message}`);
      return false;
    }
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
    const latest = this.latestPendingActionId();
    if (latest === undefined) return undefined; // 无卡零判官调用（范围钳制）
    if (!judge.ready()) {
      // 开关开但端点未配/已删/非 classifier——值得提醒（用户预期判官生效）
      this.deps.logger?.warn("管家意图判官开启但端点未配或已失效——回退词表后行为（原样走 LLM）");
      return undefined;
    }
    const entry = this.pending.get(latest)!;
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
      return undefined;
    }
  }

  /** 口令路由（确认链路修复批③）：纯文本口令绑定最近 pending 卡消费/作废
   *  ——零 LLM 零新提案（治「确认了很多遍」被当新指令）；无 pending 卡时
   *  返回 undefined 原样走 LLM。确认回执经广播出口（口令来自任意连接）。 */
  private routeConfirmPhrase(phrase: "confirm" | "cancel"): StewardAskResultPayload | undefined {
    const latest = this.latestPendingActionId();
    if (latest === undefined) return undefined;
    const entry = this.pending.get(latest)!;
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
      // 管家记忆 B1：记忆面现态（未装配 = 全降级缺省——开关关/端点空/零条目）
      memory: this.deps.memory?.getMemoryState() ?? {
        enabled: false,
        available: false,
        endpoint: null,
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
   *  显式指定通道（项目隔离批——"global" 或项目目录名，缺省按 kind 规则）。 */
  async appendMemoryEntry(text: string, kind?: "fact" | "preference", projectScope?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.deps.memory.appendMemoryEntry(text, kind, projectScope);
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
   *  memory 组 {enabled?,endpointId?,judgeEndpointId?} + 批B 召回量
   *  {recallTopK?,recallPool?} + 阈值 {recallMinScore?}——组内字段整体转发
   *  通用记忆配置域 memory.*；
   *  triage 组 {judgeEnabled?,judgeEndpointId?} 转发分诊判官配置域
   *  （分诊判官接入批）。
   *  **summary/sessionMemory 组已摘除**（会话总结器独立化批①——总结配置
   *  收编 summary.* 通用域，写面在 config.set_summary；携带旧组的载荷在
   *  handler 层拒答 invalid_payload）。 */
  async setConfig(patch: {
    enabled?: boolean;
    model?: string;
    memory?: { enabled?: boolean; endpointId?: string; judgeEndpointId?: string; recallTopK?: number; recallPool?: number; recallMinScore?: number };
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

  /**
   * 八工具注册 ToolRegistry（迁移即验证——runTool 大 if-else 链退役）：
   * - 只读三件（list_instances/list_tasks/query_recent_work）：handler 直查；
   * - 写注入四件（propose_send/deliver_to_session/create_session/
   *   spawn_review_task）：挂闸工具——beforeToolCallPause 暂停点（gateWriteTool
   *   前置校验 + PendingAction 构造），handler 为 approve 决策执行体（L0 管家
   *   走 confirm→resolve 路径，handler 供注册面完整性与未来自动化面）；
   * - steward_confirm：hidden 注册（面板确认原语——不进 LLM 工具投影，
   *   E-46「注册面恒宽、声明面管控谁可见」同构）。
   */
  private registerTools(): void {
    // 只读三件：直查执行体（结果过 capToolResultText 体量护栏）
    this.toolSpecs.push({
      ...TOOL_LIST_INSTANCES,
      execute: async () => {
        // A1-hotfix：list_instances 走紧凑投影（status() 全量单条可达 537KB）
        const rows = compactInstanceRows(this.deps.orchestration.status());
        return { text: capToolResultText(JSON.stringify(rows)) };
      },
    });
    this.toolSpecs.push({
      ...TOOL_LIST_TASKS,
      execute: async () => {
        const rows = this.deps.tasks.listTasks({}).map((t) => ({
          jobId: t.jobId,
          title: t.title,
          status: t.status,
          progress:
            t.progress === null
              ? null
              : `${t.progress.percent}%（${t.progress.batchesDone}/${t.progress.batchesTotal} 批次）`,
          error: t.error,
        }));
        return { text: capToolResultText(JSON.stringify(rows)) };
      },
    });
    this.toolSpecs.push({
      ...TOOL_QUERY_RECENT_WORK,
      execute: async (args) => ({ text: capToolResultText(await this.queryRecentWork(args as Record<string, unknown>)) }),
    });
    // progress 批 M3：read_session——只读深读面（与三件只读同族，不挂闸）。
    // sessions 源缺席 = 引导式降级（与 query_recent_work 同姿态）。
    this.toolSpecs.push({
      ...TOOL_READ_SESSION,
      execute: async (args) => ({ text: capToolResultText(await this.readSession(args as Record<string, unknown>)) }),
    });
    // 批A：kg 只读二件（kg_search/kg_get——项目知识问答，与只读族同族不挂
    // 闸）；全链路零写：注册面不含任何 kg 写原语（写面不进管家工具面）。
    this.toolSpecs.push({
      ...TOOL_KG_SEARCH,
      execute: async (args) => ({ text: capToolResultText(await this.kgSearchOf(args as Record<string, unknown>)) }),
    });
    this.toolSpecs.push({
      ...TOOL_KG_GET,
      execute: async (args) => ({ text: capToolResultText(await this.kgGetOf(args as Record<string, unknown>)) }),
    });
    // 写注入五件：挂闸工具（GATED_TOOLS 命中即 engine_paused）——execute 为
    // approve 决策执行体（重新过闸校验 + 执行——与 confirm 的 executePending
    // 同源动作体；L0 管家走 confirm→resolve 路径，execute 供未来自动化面）
    for (const [tool, actionOf] of [
      [TOOL_PROPOSE_SEND, this.pendingActionOfProposeSend.bind(this)],
      [TOOL_DELIVER_TO_SESSION, this.pendingActionOfDeliverToSession.bind(this)],
      [TOOL_CREATE_SESSION, this.pendingActionOfCreateSession.bind(this)],
      [TOOL_START_SESSION, this.pendingActionOfStartSession.bind(this)],
      [TOOL_SPAWN_REVIEW_TASK, this.pendingActionOfSpawnReview.bind(this)],
    ] as const) {
      void actionOf;
      this.toolSpecs.push({
        ...tool,
        execute: async (args) => {
          const gated = await this.gateWriteTool({ runId: "", toolCallId: "", toolName: tool.name, args: args as Record<string, unknown> });
          if (!gated.pause) {
            const outcome = gated.outcome;
            if (outcome !== undefined && outcome.kind === "terminate") {
              return { text: outcome.reason, terminate: true };
            }
            return { text: outcome !== undefined && outcome.kind === "result" ? outcome.text : "提案未通过校验（approve 不可达此路径）" };
          }
          const outcome = await this.executePending(gated.action!);
          return { text: capToolResultText(outcome.detail), ...(outcome.ok ? {} : { isError: true }) };
        },
      });
    }
    // remember（B5 摘闸）：直接执行体——静默入库 + 通知，回执回灌续轮。
    this.toolSpecs.push({
      ...TOOL_REMEMBER,
      execute: async (args) => {
        const outcome = await this.directRemember(args as Record<string, unknown>);
        return outcome.kind === "terminate"
          ? { text: outcome.reason, terminate: true }
          : { text: outcome.text, ...(outcome.isError === true ? { isError: true } : {}) };
      },
    });
    // ── M2 四泛型工具（D4）：surface_list / snapshot / read 只读直行；
    //    act 挂闸（GATED_TOOLS）——read 档经引擎 approve 面直行执行体，
    //    write/destructive 走确认闸（本执行面不直行——防绕过）。
    this.toolSpecs.push({
      ...TOOL_SURFACE_LIST,
      execute: async () => {
        if (this.deps.surfaces === undefined) {
          return { text: "表面能力面未装配（daemon 装配缺 surfaces 源）", isError: true };
        }
        try {
          const rows = await this.deps.surfaces.list();
          return { text: capToolResultText(JSON.stringify(rows)) };
        } catch (err) {
          return { text: `表面清单读取失败：${(err as Error).message}`, isError: true };
        }
      },
    });
    this.toolSpecs.push({
      ...TOOL_SNAPSHOT,
      execute: async (args) => ({
        text: capToolResultText(await this.surfaceReadOf(args as Record<string, unknown>, "snapshot")),
      }),
    });
    this.toolSpecs.push({
      ...TOOL_READ,
      execute: async (args) => ({
        text: capToolResultText(await this.surfaceReadOf(args as Record<string, unknown>, "read")),
      }),
    });
    this.toolSpecs.push({
      ...TOOL_ACT,
      execute: async (args) => {
        const decision = await this.gateSurfaceAct(args as Record<string, unknown>);
        if (decision.kind === "refuse") return { text: decision.reason, isError: true };
        if (decision.kind === "proposal") {
          // 防绕过：write/destructive 不经用户确认恒不执行（包括自动化面）
          return {
            text: "write/destructive 动作须经确认闸（propose→用户确认→执行）——本执行面不直行",
            isError: true,
          };
        }
        try {
          const result = await this.deps.surfaces!.act(decision.request);
          return { text: capToolResultText(formatActReceipt(result)), ...(result.ok ? {} : { isError: true }) };
        } catch (err) {
          return { text: `表面动作执行异常：${(err as Error).message}`, isError: true };
        }
      },
    });
    // steward_confirm：面板确认原语（hidden——不进引擎工具面（LLM 不可见）；
    // actionId 单次消费语义与 handler 层 steward.confirm 命令等价，面板直调
    // svc.confirm——引擎轨道零注册）
    this.hiddenToolNames.push("steward_confirm");
  }

  // ── 确认闸暂停点（write 类工具挂闸——beforeToolCallPause 实现体） ──────

  /**
   * 写注入工具挂闸判定（前置校验 + PendingAction 构造——迁移前各 proposeXxx
   * 逻辑平移）：
   * - 校验失败（引导类）→ pause:false + outcome（toolResult 回灌循环继续）；
   * - 防火墙前置拒（propose_send 实例不运行）→ pause:false + terminate
   *   （run 错误收口直出回执，KV 无痕——与迁移前行为严格等价）；
   * - 校验通过 → pause:true + action（LoopEngine 发 run.paused，ask 收口
   *   confirm_required；confirm → resumeWith(resolve) 执行 + 回灌）。
   */
  private async gateWriteTool(
    ctx: GateToolContext,
  ): Promise<
    | { pause: true; action: PendingAction }
    | { pause: false; approve?: true; outcome?: GateToolOutcome }
  > {
    const { toolName: name, args } = ctx;
    if (name === "act") {
      // M2 表面动作（risk 动态档）：read 直行（approve 放行工具执行）/
      // write·destructive 挂闸（同一 steward.confirmations 两段式）/
      // 拒（私造动词/risk 降档/豁免尝试）。
      const decision = await this.gateSurfaceAct(args);
      if (decision.kind === "refuse") return { pause: false, outcome: { kind: "result", text: decision.reason, isError: true } };
      if (decision.kind === "direct") return { pause: false, approve: true };
      return { pause: true, action: decision.action };
    }
    if (name === "propose_send") {
      const action = await this.pendingActionOfProposeSend(args);
      if ("guidance" in action) return { pause: false, outcome: action.outcome };
      if ("terminate" in action) return { pause: false, outcome: { kind: "terminate", reason: action.reason } };
      return { pause: true, action };
    }
    if (name === "deliver_to_session") {
      const gated = await this.pendingActionOfDeliverToSession(args);
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    if (name === "create_session" || name === "start_session") {
      const gated = await this.pendingActionOfCreateSession(args, {
        requireInitialMessage: name === "start_session",
      });
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    if (name === "spawn_review_task") {
      const gated = await this.pendingActionOfSpawnReview(args);
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    return { pause: false };
  }

  /**
   * 表面动作闸判定（M2 risk 三级闸——D3 risk 挂动作）：
   * - 校验面：surfaceId/verb（封闭词汇表——私造动词拒）/risk（只可升档
   *   不可降档）；豁免旗标（auto_confirm/exempt 类）嗅探 → 闸面整单拒绝
   *   （【突变验证钉子】destructive 不可豁免）；
   * - 判定面（SurfaceRiskGate）：read → direct（approve 直行）；write/
   *   destructive → proposal（同一 steward.confirmations 两段式——
   *   propose→用户确认→执行）。
   */
  private async gateSurfaceAct(
    args: Record<string, unknown>,
  ): Promise<
    | { kind: "direct"; request: StewardSurfaceActRequest }
    | { kind: "proposal"; action: PendingAction }
    | { kind: "refuse"; reason: string }
  > {
    if (this.deps.surfaces === undefined) {
      return { kind: "refuse", reason: "表面能力面未装配（daemon 装配缺 surfaces 源）" };
    }
    const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
    if (surfaceId === "") {
      return { kind: "refuse", reason: "参数缺失：surfaceId 必填（先用 surface_list 发现表面）" };
    }
    const verbRaw = args.verb;
    if (!isSurfaceVerb(verbRaw)) {
      return {
        kind: "refuse",
        reason: `动词未注册（verb=${String(verbRaw)}）——封闭词汇表 click/type/navigate/scroll/focus（缺词停下申报，不私造）`,
      };
    }
    const verb = verbRaw;
    const actionArgs =
      typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : {};
    // ── act 参数契约收紧（事故热修批①）：动词 args 形状校验（按命名空间×
    //    动词——protocol 单源 validateSurfaceActArgs）。形状不合法 → 即时拒
    //    （模型收到正确形状指引可自纠），不挂闸不派发不等回执超时——治
    //    2026-10-07 事故「模型发明 url 参数 → shell 静默弃帧 → 60s 挂死」。
    //    动词注册校验/risk 三级闸不动（E-253 约束面）。──
    const nsRaw = surfaceId.split(":")[0] ?? "";
    if (isSurfaceNamespaceKind(nsRaw)) {
      const argsError = validateSurfaceActArgs(nsRaw, verb, actionArgs);
      if (argsError !== undefined) return { kind: "refuse", reason: argsError };
    }
    const floor = surfaceVerbRisk(verb);
    let risk: SurfaceRisk = floor;
    const riskRaw = args.risk;
    if (riskRaw !== undefined) {
      if (riskRaw !== "read" && riskRaw !== "write" && riskRaw !== "destructive") {
        return { kind: "refuse", reason: `risk 非法：${JSON.stringify(riskRaw)}（应为 read/write/destructive）` };
      }
      if (surfaceRiskRank(riskRaw) < surfaceRiskRank(floor)) {
        return {
          kind: "refuse",
          reason: `risk 降级拒绝：verb=${verb} 注册档=${floor}，请求=${riskRaw}（D3 risk 挂动作——只可升档）`,
        };
      }
      risk = riskRaw;
    }
    // 豁免尝试嗅探（top-level 与 args 内两处）——闸面拒绝不可豁免
    const exempt = hasExemptionAffordance(args) || hasExemptionAffordance(actionArgs);
    const decision = evaluateSurfaceRisk(risk, { exempt });
    if (decision.outcome === "reject") return { kind: "refuse", reason: decision.reason };
    const request: StewardSurfaceActRequest = { surfaceId, verb, args: actionArgs, risk };
    if (decision.outcome === "direct") return { kind: "direct", request };
    return {
      kind: "proposal",
      action: {
        kind: "surfaceAct",
        displayTarget: surfaceId,
        message: `表面动作提案：${verb} @ ${surfaceId}（risk=${risk}）：${summarizeArgsLite(actionArgs)}`,
        toolCall: { id: "", name: "act" },
        surfaceAct: request,
      },
    };
  }

  /** 只读工具执行体（snapshot/read——免确认直行）。 */
  private async surfaceReadOf(args: Record<string, unknown>, mode: "snapshot" | "read"): Promise<string> {
    if (this.deps.surfaces === undefined) return "表面能力面未装配（daemon 装配缺 surfaces 源）";
    const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
    if (surfaceId === "") return "参数缺失：surfaceId 必填（先用 surface_list 发现表面）";
    try {
      const result =
        mode === "snapshot"
          ? await this.deps.surfaces.snapshot(surfaceId)
          : await this.deps.surfaces.read(surfaceId, {
              ...(typeof args.selector === "string" && args.selector !== "" ? { selector: args.selector } : {}),
              ...(typeof args.max_chars === "number" && Number.isFinite(args.max_chars) ? { maxChars: args.max_chars } : {}),
            });
      return result.ok ? result.text : `读取失败：${result.text}`;
    } catch (err) {
      return `表面读取异常：${(err as Error).message}`;
    }
  }

  /** propose_send 提案判定（参数校验 → 运行态校验 → PendingAction）。 */
  private async pendingActionOfProposeSend(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome } | { terminate: true; reason: string }> {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const message = typeof args.message === "string" ? args.message : "";
    if (agentId === "" || message === "") {
      return {
        guidance: true,
        outcome: {
          kind: "result",
          text: capToolResultText("参数缺失：agentId 与 message 必填"),
          },
      };
    }
    // 提案校验：目标须存在且运行中（防火墙前置——终态实例递话必拒）
    const running = this.deps.orchestration.status(agentId).some((s) => s.state === "running");
    if (!running) {
      return {
        terminate: true,
        reason: `实例 ${agentId} 不存在或非运行中——递话提案拒绝（可让用户确认实例 id）`,
      };
    }
    return {
      kind: "send",
      displayTarget: agentId,
      message,
      toolCall: { id: "", name: "propose_send" },
      send: { agentId, message },
    };
  }

  /** start_session 提案判定（同 create_session 动作体，initial_message 必填兑底）。 */
  private async pendingActionOfStartSession(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    return this.pendingActionOfCreateSession(args, { requireInitialMessage: true });
  }

  /** deliver_to_session 提案判定（驾驶舱批逻辑平移：参数 → 装配面 → 会话存在性）。 */
  private async pendingActionOfDeliverToSession(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"].trim() : "";
    const text = typeof args["text"] === "string" ? args["text"] : "";
    if (sessionId === "" || text.trim() === "") {
      return this.guideOutcome("参数缺失：sessionId 与 text 必填（sessionId 可先用 query_recent_work 查询）");
    }
    if (this.deps.sessions === undefined) {
      return this.guideOutcome("会话投递面未装配——无法投递（请让用户在目标会话页直接输入）");
    }
    let exists: boolean;
    try {
      exists = await this.deps.sessions.sessionExists(sessionId);
    } catch (err) {
      return this.guideOutcome(`会话存在性校验失败：${(err as Error).message}`);
    }
    if (!exists) {
      return this.guideOutcome(
        `会话 ${sessionId} 不存在——请用 query_recent_work 查询近期会话拿正确的 sessionId（或与用户确认目标）`,
      );
    }
    // 语音闭环批 ④：提案期查短标题（displayTarget 念人类可读短名——确认卡/
    // 提醒/口令回执/在途摘要四消费面共用）；查询失败/缺席回退 sessionId。
    let displayTarget = sessionId;
    try {
      const title = await this.deps.sessions.sessionTitleOf?.(sessionId);
      if (title !== undefined && title !== "") displayTarget = capChars(title, DELIVER_TITLE_MAX_CHARS);
    } catch {
      // 标题查询失败是增强面降级（不阻断提案链）
    }
    return {
      kind: "deliverSession",
      displayTarget,
      message: text,
      toolCall: { id: "", name: "deliver_to_session" },
      deliverSession: { sessionId, text },
    };
  }

  /** create_session / start_session 提案判定（项目参数校验 → title 缺省生成 → initial_message 解析；start_session 必填服务端兑底）。 */
  private async pendingActionOfCreateSession(
    args: Record<string, unknown>,
    opts: { readonly requireInitialMessage?: boolean } = {},
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    const titleRaw = typeof args["title"] === "string" ? args["title"].trim() : "";
    const project = typeof args["project"] === "string" && args["project"] !== "" ? args["project"] : undefined;
    const guidance = this.checkProjectArg(project);
    if (guidance !== undefined) {
      return this.guideOutcome(guidance);
    }
    if (this.deps.sessions === undefined) {
      return this.guideOutcome("会话创建面未装配——无法创建会话（请让用户在侧栏新建）");
    }
    const now = new Date(this.now());
    const p2 = (n: number) => String(n).padStart(2, "0");
    const title =
      titleRaw !== ""
        ? titleRaw
        : `${project !== undefined ? `${project} ` : ""}新会话 ${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    // 带着话题开新会话：initial_message 全文进确认卡（确认前用户可审，写安全
    // 同 deliver_to_session 的「全文展示供确认」惯例）；原文透传零改写。
    // start_session = 必填兑底（schema required 之外的服务端二次防线——k3 级
    // 模型可选参数遵从弱，打回重提案而非静默建空会话）。
    const initialMessageRaw = typeof args["initial_message"] === "string" ? args["initial_message"].trim() : "";
    const initialMessage = initialMessageRaw !== "" ? initialMessageRaw : undefined;
    if (initialMessage === undefined && opts.requireInitialMessage === true) {
      return this.guideOutcome(
        "start_session 需要 initial_message（用户原话，不改写）——请带上用户想在新会话开始的话题重新提案；用户只要空会话时才用 create_session",
      );
    }
    return {
      kind: "createSession",
      displayTarget: "新会话",
      message:
        initialMessage !== undefined
          ? `将创建会话「${title}」并投递初始话题：${initialMessage}`
          : `将创建会话「${title}」`,
      toolCall: { id: "", name: "create_session" },
      createSession: initialMessage !== undefined ? { title, initialMessage } : { title },
    };
  }

  /** spawn_review_task 提案判定（review_type → 项目 → git 仓/.kg 索引三道校验）。 */
  private async pendingActionOfSpawnReview(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    const reviewTypeRaw = args["review_type"];
    const project = typeof args["project"] === "string" ? args["project"].trim() : "";
    const params =
      typeof args["params"] === "object" && args["params"] !== null && !Array.isArray(args["params"])
        ? (args["params"] as Record<string, unknown>)
        : {};
    if (reviewTypeRaw !== "code-review" && reviewTypeRaw !== "kg-review") {
      return this.guideOutcome(
        `review_type 非法：${JSON.stringify(reviewTypeRaw)}（应为 "code-review" 或 "kg-review"）`,
      );
    }
    const reviewType = reviewTypeRaw;
    if (project === "") {
      return this.guideOutcome("参数缺失：project 必填（目标项目名）");
    }
    const root = this.deps.projects?.resolve(project);
    if (root === undefined) {
      const known = "（项目解析面未装配，无法校验项目存在性）";
      return this.guideOutcome(
        this.deps.projects === undefined
          ? `无法校验项目 ${project}${known}`
          : `项目 ${project} 不在当前 workspace——请与用户确认项目名（可用清单中的项目）`,
      );
    }
    if (reviewType === "code-review" && this.deps.hasGitRepo !== undefined && !this.deps.hasGitRepo(root)) {
      return this.guideOutcome(`项目 ${project} 无 git 仓（${root}）——没有可评审的代码，需先初始化仓库`);
    }
    if (reviewType === "kg-review" && this.deps.projects !== undefined && !this.deps.projects.hasIndex(root)) {
      return this.guideOutcome(`项目 ${project} 未建知识图谱——需先 kg-bootstrap（我可以帮你创建该任务）`);
    }
    return {
      kind: "spawnReview",
      displayTarget: `${reviewType}@${project}`,
      message: `将对项目 ${project} 发起 ${reviewType}`,
      toolCall: { id: "", name: "spawn_review_task" },
      spawnReview: { reviewType, project, params },
    };
  }

  /** remember 直接执行体（B5 摘闸静默化：参数校验 → 可用性闸 → 两段查重
   *  入库 → memory_written 通知；回执回灌 LLM 续轮）。失败/不可用回执为
   *  引导文本（LLM 转述用户）——与旧 guideOutcome 语义同构。 */
  private async directRemember(args: Record<string, unknown>): Promise<GateToolOutcome> {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const kindRaw = args.kind;
    if (text === "") {
      return this.guideOutcome("参数缺失：text 必填（记忆文本）").outcome;
    }
    if (kindRaw !== undefined && kindRaw !== "fact" && kindRaw !== "preference") {
      return this.guideOutcome(`kind 非法：${JSON.stringify(kindRaw)}（应为 "fact" 或 "preference"）`).outcome;
    }
    const kind = (kindRaw as "fact" | "preference" | undefined) ?? "fact";
    const memory = this.deps.memory;
    if (memory === undefined || !memory.isAvailable()) {
      return this.guideOutcome(
        "记忆功能未启用或未配置——本次不沉淀（用户可在 设置 → 通用 → 管家 开启记忆并配置嵌入端点）",
      ).outcome;
    }
    try {
      // 项目隔离批：fact 缺省绑写时项目——项目上下文与召回同源
      //（memoryProject 单项目 workspace 口径；多项目/未绑定 → 不传 →
      // 回落 global）。preference 不受 project 通道影响（kind 规则缺省
      // global）。
      const project = this.deps.memoryProject?.();
      const saved = await memory.remember(text, kind, "steward-turn", project !== undefined ? { project } : undefined);
      this.deps.emitMemoryWritten?.({ text, mode: saved.updated ? "updated" : "added" });
      const detail = `${saved.updated ? "已更新记忆（语义重复，覆盖原条目）" : "已沉淀长期记忆"}（#${saved.id}）：${text}`;
      return { kind: "result", text: capToolResultText(detail) };
    } catch (err) {
      const detail = `记忆沉淀失败：${(err as Error).message}`;
      return { kind: "result", text: capToolResultText(detail) };
    }
  }

  /** 引导式工具结果（toolResult 回灌 LLM 循环继续可转述/自纠——迁移前
   *  toolErrorResult 的校验路径产物）。 */
  private guideOutcome(guidance: string): { guidance: true; outcome: GateToolOutcome } {
    return { guidance: true, outcome: { kind: "result", text: capToolResultText(guidance) } };
  }

  // ── A2：情景快照组装 ────────────────────────────────

  /** 快照段组装（感知查询失败静默降级 = undefined；绝不能挡对话主链路）。
   *  数据源与工具面同源：活跃 agent 数 = orchestration.status()（与
   *  list_instances 同一调用面）；会话计数与主题 = sessions 源（与
   *  query_recent_work 同一读面）。 */
  private async buildSnapshotSafely(): Promise<string | undefined> {
    if (this.deps.sessions === undefined) return undefined;
    try {
      const rows = await this.deps.sessions.listSessionMetadata();
      const statuses = this.deps.orchestration.status();
      const activeAgents = statuses.filter((s) => s.state === "running").length;
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
      });
    } catch (err) {
      this.deps.logger?.warn(`管家情景快照组装失败（降级为无快照段）：${(err as Error).message}`);
      return undefined;
    }
  }

  // ── A2：query_recent_work ───────────────────────────

  /** 近期工作查询（文本组装；会话源缺席/失败时降级提示，不抛错）。 */
  private async queryRecentWork(args: Record<string, unknown>): Promise<string> {
    const rangeRaw = args["time_range"];
    const range: TimeRange =
      rangeRaw === "today" || rangeRaw === "yesterday" || rangeRaw === "last_week" || rangeRaw === "this_week"
        ? rangeRaw
        : "this_week";
    const project = typeof args["project"] === "string" && args["project"] !== "" ? args["project"] : undefined;
    const titleContains =
      typeof args["title_contains"] === "string" && args["title_contains"] !== "" ? args["title_contains"] : undefined;
    const win = timeRangeWindow(range, this.now());
    const inWindow = (iso: string): boolean => {
      const t = Date.parse(iso);
      return !Number.isNaN(t) && t >= win.sinceMs && t < win.untilMs;
    };
    const sessionLines: string[] = [];
    let sessionTotal = 0;
    let sessionTotalAll = 0; // 窗口内全部会话数（未过 title_contains）——「无记录」短路判据
    if (this.deps.sessions !== undefined) {
      try {
        const rowsAll = (await this.deps.sessions.listSessionMetadata()).filter((r) => inWindow(r.updatedAt));
        // 显示标题口径（与快照/会话页同语义）：显式标题列优先，旧行 NULL
        // 回落首条用户消息截断推导（repo 层注释的消费侧兑现——L1 投影修复批）。
        // displayTitle 单源（displayTitleOf——TR-207 三消费面共用）
        const displayTitle = (r: StewardSessionMetaRow): string => displayTitleOf(r);
        // title_contains 过滤在投影前（计数同口径：段头【会话·N】= 过滤后
        // 剩余数；大小写不敏感包含匹配，判据 = 显示标题）。
        const rows =
          titleContains === undefined
            ? rowsAll
            : rowsAll.filter((r) => displayTitle(r).toLowerCase().includes(titleContains.toLowerCase()));
        sessionTotal = rows.length;
        sessionTotalAll = rowsAll.length;
        for (const r of rows.slice(0, RECENT_WORK_LINES_MAX)) {
          const title = capChars(displayTitle(r), RECENT_WORK_TITLE_MAX_CHARS);
          const scale = r.entryCount === null ? "" : ` · 约${r.entryCount}条消息`;
          // sid 完整不截断（deliver_to_session 参数源——prompt 路由行承诺
          // 「结果含 sessionId」由本行兑现；截断的 id 不可复制即不可用）。
          sessionLines.push(`「${title}」(sid: ${r.sessionId}) ${fmtWhen(r.createdAt)}~${fmtWhen(r.updatedAt)}${scale}`);
        }
        if (rows.length > RECENT_WORK_LINES_MAX) {
          sessionLines.push(`…另有 ${rows.length - RECENT_WORK_LINES_MAX} 个会话未列出`);
        }
        // 未命中可区分：有会话但无一匹配关键词时明说（不落入「无记录」误导）。
        if (titleContains !== undefined && rows.length === 0 && rowsAll.length > 0) {
          sessionLines.push(`（${rowsAll.length} 个会话均不含关键词「${titleContains}」）`);
        }
      } catch (err) {
        this.deps.logger?.warn(`query_recent_work 会话读面失败：${(err as Error).message}`);
      }
    }
    const taskRows = this.deps.tasks
      .listTasks({})
      .filter(
        (t) =>
          inWindow((t as unknown as { createdAt?: string }).createdAt ?? "") &&
          (project === undefined || (t as unknown as { projects?: readonly string[] }).projects?.includes(project)),
      );
    const taskLines = taskRows.slice(0, RECENT_WORK_LINES_MAX).map((t) => {
      const meta = t as unknown as { type?: string; createdAt?: string };
      const tail = t.error !== null && t.error !== "" ? capChars(t.error, 40) : t.progress === null ? "" : `${t.progress.percent}%`;
      const type = meta.type ?? "task";
      return `[${type}] ${capChars(t.title, RECENT_WORK_TITLE_MAX_CHARS)}——${t.status}${tail !== "" ? `（${tail}）` : ""}`;
    });
    if (taskRows.length > RECENT_WORK_LINES_MAX) {
      taskLines.push(`…另有 ${taskRows.length - RECENT_WORK_LINES_MAX} 个任务未列出`);
    }
    if (sessionTotalAll === 0 && taskRows.length === 0) {
      return `${win.zhLabel}（${win.label}）范围内无记录——没有会话与任务活动`;
    }
    const parts: string[] = [`【会话·${sessionTotal}】`];
    parts.push(...(sessionLines.length > 0 ? sessionLines : ["（无）"]));
    parts.push(`【任务·${taskRows.length}${project !== undefined ? ` · 项目 ${project}` : ""}】`);
    parts.push(...(taskLines.length > 0 ? taskLines : ["（无）"]));
    return parts.join("\n");
  }

  /** 项目参数校验（create_session 的可选 project；undefined = 无参数直过）。 */
  private checkProjectArg(project: string | undefined): string | undefined {
    if (project === undefined || this.deps.projects === undefined) return undefined;
    if (this.deps.projects.resolve(project) === undefined) {
      return `项目 ${project} 不在当前 workspace——请与用户确认项目名`;
    }
    return undefined;
  }

  // ── 批A：kg_search / kg_get（项目知识只读检索） ─────────

  /** kg scope 解析（E-212 纪律：必填显式 + 服务端兜底打回；缺省 = 当前项目
   *  口径（memoryProject 同源：workspace 绑定根 + 一级目录扫描的单项目判定
   *  ——不另造口径）：单项目 workspace → 该项目（与显式 project 同一解析路
   *  径）；多项目/未绑定/未注入 → 聚合兑底（root 缺省 = kg 项目域聚合，适配
   *  器逐项目分块带【项目】头））：返回 projectRoot 或引导文案（打回/降级
   *  均不抛错，与 query_recent_work 降级姿态同族）。 */
  private resolveKgScope(projectArg: unknown): { root?: string } | { guide: string } {
    const kg = this.deps.kg;
    if (kg === undefined) {
      return { guide: "知识图谱读面不可用（daemon 装配缺 kg 源）——项目知识暂无法检索，可建议用户直接查看项目文档" };
    }
    const explicit = typeof projectArg === "string" && projectArg.trim() !== "" ? projectArg.trim() : undefined;
    // 缺省 = 当前项目口径（memoryProject 同源）：单项目 workspace 解析出项目
    // 名后与显式 project 走同一解析路径（同一次序/同一引导文案）；多项目/
    // 未绑定/未注入 → undefined 聚合兑底。
    const project = explicit ?? this.deps.memoryProject?.();
    if (project === undefined) {
      const roots = kg.kgProjects();
      if (roots.length === 0) {
        return {
          guide:
            "当前 workspace 尚无项目知识索引（.helix-kg/kg.db 缺席）——项目知识检索需先建索引；可引导用户到知识图谱页建立索引，或如实告知查不到",
        };
      }
      // 聚合域（root 缺省）：适配器逐项目分块带【项目】头（空命中项目省略，
      // 单 kg 项目域原样渲染）——不在此按 kg 域计数窄化伪装「当前项目」。
      return {};
    }
    // 显式 project（或缺省解析出的当前项目）：workspace-scan/scanProjects
    // 口径解析（deps.projects 同源）
    if (this.deps.projects === undefined) {
      const hit = kg.kgProjects().find((root) => root.split("/").pop() === project);
      return hit !== undefined ? { root: hit } : { guide: `项目 ${project} 不在当前知识域——请与用户确认项目名` };
    }
    const root = this.deps.projects.resolve(project);
    if (root === undefined) return { guide: `项目 ${project} 不在当前 workspace——请与用户确认项目名` };
    if (!this.deps.projects.hasIndex(root)) {
      return { guide: `项目 ${project} 尚未建知识索引（.helix-kg 缺席）——可建议用户先建索引后再问，或如实告知查不到` };
    }
    return { root };
  }

  /** kg_search 工具体（只读）：关键词 → digest+指针摘要行；体量过
   *  capToolResultText 护栏由注册面兜底。 */
  private async kgSearchOf(args: Record<string, unknown>): Promise<string> {
    const q = typeof args["q"] === "string" ? args["q"].trim() : "";
    if (q === "") return "参数缺失：q 必填（关键词——知识节点名/摘要子串匹配）";
    const scope = this.resolveKgScope(args["project"]);
    if ("guide" in scope) return scope.guide;
    try {
      return await this.deps.kg!.search(q, scope.root);
    } catch (err) {
      this.deps.logger?.warn(`kg_search 读面失败：${(err as Error).message}`);
      return `知识检索失败：${(err as Error).message}`;
    }
  }

  /** kg_get 工具体（只读）：节点全量；id 非法/查无节点 = 引导类（实现体
   *  中文引导原文兜底转文本——不抛错不炸轮）。 */
  private async kgGetOf(args: Record<string, unknown>): Promise<string> {
    const nodeId = typeof args["nodeId"] === "string" ? args["nodeId"].trim() : "";
    if (nodeId === "") return "参数缺失：nodeId 必填（取自 kg_search 返回行的「kg get <id>」指针）";
    const scope = this.resolveKgScope(args["project"]);
    if ("guide" in scope) return scope.guide;
    try {
      return await this.deps.kg!.get(nodeId, scope.root);
    } catch (err) {
      return (err as Error).message;
    }
  }

  // ── progress 批 M3：read_session（会话尾部内容深读）────────

  /** 尾部条数缺省与上限（LLM 面体量面：缺省 6 上限 20，repo 层单条已截 300，
   *  capToolResultText 4000 总护栏兑底）。 */
  private static readonly READ_SESSION_TAIL_DEFAULT = 6;
  private static readonly READ_SESSION_TAIL_MAX = 20;

  /** read_session 工具体：meta 行定位（displayTitle 单源）→ 尾窗投影 →
   *  文本组装；双失败径（meta 缺/尾读 undefined）统一引导回 query_recent_work。 */
  private async readSession(args: Record<string, unknown>): Promise<string> {
    const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"] : "";
    if (sessionId === "") {
      return "参数缺失：sessionId 必填（可先用 query_recent_work 查询，结果含 sessionId）";
    }
    const tailRaw = typeof args["tail"] === "number" ? args["tail"] : StewardService.READ_SESSION_TAIL_DEFAULT;
    const tail = Math.min(
      Number.isInteger(tailRaw) && tailRaw > 0 ? tailRaw : StewardService.READ_SESSION_TAIL_DEFAULT,
      StewardService.READ_SESSION_TAIL_MAX,
    );
    if (this.deps.sessions === undefined) {
      return "会话读面不可用（daemon 装配缺 sessions 源）";
    }
    try {
      const meta = (await this.deps.sessions.listSessionMetadata()).find((r) => r.sessionId === sessionId);
      const tailRows = await this.deps.sessions.readSessionTail(sessionId, tail);
      if (meta === undefined || tailRows === undefined) {
        return `会话 ${sessionId} 不存在——请用 query_recent_work 查询近期会话拿正确的 sessionId（或与用户确认目标）`;
      }
      const lines = [`${tailRows.length === 0 ? "（会话暂无消息）" : `最近 ${tailRows.length} 条消息（旧→新）：`}`];
      for (const e of tailRows) {
        lines.push(`[${e.role}] ${e.text}`);
      }
      return `会话「${capChars(displayTitleOf(meta), RECENT_WORK_TITLE_MAX_CHARS)}」(sid: ${sessionId})\n${lines.join("\n")}`;
    } catch (err) {
      this.deps.logger?.warn(`read_session 读面失败：${(err as Error).message}`);
      return `会话 ${sessionId} 读取失败：${(err as Error).message}`;
    }
  }

}

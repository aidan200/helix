/**
 * StewardService —— 管家域门面与聚合根（V2.5 文本管家 application service；
 * 设计 §2 三分法 / §5.2 权限分级 / §5.3 ①②层；文本形态架构验证——语音版
 * V3 直接套壳）。
 *
 * 体量门 P4 拆分（本文件自 2691 行拆出四块，读面/行为零变更）：
 * - 分诊路由域 StewardRouting：ask 判定漏斗（词表 → 停止判定 → 意图泛化
 *   → addressee 分诊）+ 确认闸门禁（放行/作废/执行/终局登记）；
 * - 播报编排域 StewardOutlet：feed 播报直出、生命周期提醒、主动汇报、
 *   过程流式回执；
 * - 生命周期域 StewardLifecycle：run 执行链（装配/投影/收口）、看门狗、
 *   确认卡 TTL 与提醒巡检、启停定时器、对话记忆读写；
 * - 共享内核 StewardCore：依赖注入面 + 可达状态容器 + 伴随编排态。
 * 本文件保留：聚合根装配（三域构造与绑定）、配置/档案/记忆管理读回口、
 * 情景快照组装，以及对外公共面的一手委托。
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
import { stewardBlocksText } from "./stewardBlocks";

// 确认闸聚合域 re-export（批 1：定义已迁 domain/steward/confirmation——
// 兼容既有引用面；行为零变更）
export { pendingKeyOf } from "../../domain/steward/confirmation/ProposalLedger";
export type { PendingAction, PendingEntry } from "../../domain/steward/confirmation/ProposalLedger";

// ── 体量门 P4：迁出符号经门面原路径精确再导出（消费方 import 零改动）──
export { STEWARD_FEED_EVENT_TYPES, FEED_SUMMARY_MAX_CHARS, buildFeedText } from "./stewardFeed";
export {
  summarizeArgsLite,
  hasExemptionAffordance,
  formatActReceipt,
  displayTitleOf,
  capChars,
  formatDeliverReceipt,
  capToolResultText,
  compactInstanceRows,
  buildLlmWindow,
  matchStewardCommandPhrase,
} from "./stewardProjections";
export {
  STEWARD_MAX_TOOL_ROUNDS,
  HISTORY_WINDOW,
  TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATION_MARK,
  INSTANCE_TASK_MAX_CHARS,
  INSTANCE_SUMMARY_MAX_CHARS,
  STEWARD_MISSING_TOOL_RESULT_TEXT,
  STEWARD_ENABLED_KEY,
  STEWARD_MODEL_KEY,
  STEWARD_COMPACTION_THRESHOLD_TOKENS,
  STEWARD_COMPACTION_KEEP_RECENT,
  STEWARD_PENDING_ASKS_MAX,
  STEWARD_RUN_WATCHDOG_MS,
  STEWARD_RUN_WATCHDOG_TICK_MS,
  STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS,
  STEWARD_MANUAL_ABORT_GRACE_MS,
  STEWARD_CONFIRM_TTL_MS,
  STEWARD_CONFIRM_REMIND_AFTER_MS,
  STEWARD_CONFIRM_TIMEOUT_DETAIL,
  CONTEXT_SNAPSHOT_MAX_CHARS,
  SNAPSHOT_TITLE_MAX_CHARS,
  SNAPSHOT_RECENT_SESSIONS,
  SNAPSHOT_ACTIVITY_MAX_ENTRIES,
  SNAPSHOT_ACTIVITY_LINE_MAX_CHARS,
  SNAPSHOT_ACTIVITY_MAX_CHARS,
  SNAPSHOT_ACTIVITY_DOMAIN_LABELS,
  RECENT_WORK_LINES_MAX,
  RECENT_WORK_TITLE_MAX_CHARS,
  DELIVER_TITLE_MAX_CHARS,
} from "./stewardConstants";
export type {
  GateToolContext,
  GateToolOutcome,
  StewardAskEvents,
  StewardTasksSource,
  StewardSessionMetaRow,
  StewardSessionsSource,
  StewardProjectsSource,
  StewardKgSource,
  StewardServiceDeps,
  StewardEngineAssemblyOptions,
} from "./stewardServiceTypes";
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
import { StewardCore } from "./StewardCore";
import { StewardRouting } from "./StewardRouting";
import { StewardOutlet } from "./StewardOutlet";
import { capChars, capToolResultText, displayTitleOf, summarizeArgsLite } from "./stewardProjections";
import {
  CONTEXT_SNAPSHOT_MAX_CHARS,
  SNAPSHOT_ACTIVITY_DOMAIN_LABELS,
  SNAPSHOT_ACTIVITY_LINE_MAX_CHARS,
  SNAPSHOT_ACTIVITY_MAX_CHARS,
  SNAPSHOT_ACTIVITY_MAX_ENTRIES,
  SNAPSHOT_RECENT_SESSIONS,
  SNAPSHOT_TITLE_MAX_CHARS,
  STEWARD_COMPACTION_KEEP_RECENT,
  STEWARD_COMPACTION_THRESHOLD_TOKENS,
  STEWARD_CONFIRM_TIMEOUT_DETAIL,
  STEWARD_ENABLED_KEY,
  STEWARD_MODEL_KEY,
  STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS,
} from "./stewardConstants";
import type { StewardAskEvents, StewardAskItem, StewardServiceDeps } from "./stewardServiceTypes";

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

export class StewardService implements StewardComponent {
  /** 共享内核（依赖注入面 + 可达状态 + 伴随编排态；体量门 P4）。 */
  private readonly core: StewardCore;
  /** 分诊路由域（ask 判定漏斗 + 确认闸门禁）。 */
  private readonly routing: StewardRouting;
  /** 播报编排域（feed 播报 / 提醒帧 / 主动汇报 / 过程回执）。 */
  private readonly outlet: StewardOutlet;

  constructor(deps: StewardServiceDeps) {
    this.core = new StewardCore(deps);
    // 协作面（分诊路由域 → run 驱动 / 提醒播报；过渡期先指回本服务，
    // 生命周期域/播报域迁出后改为直连对应域实例）
    this.outlet = new StewardOutlet(this.core);
    this.routing = new StewardRouting(this.core, {
      driveAsk: (item) => this.driveAsk(item),
      emitLifecycleNotify: (urgency, title, body) => this.outlet.emitLifecycleNotify(urgency, title, body),
    });
    this.core.bindDomains({ routing: this.routing, outlet: this.outlet });
  }

  /** 八工具中立规格（createEngine 装配面——委托内客观测面）。 */
  private get toolSpecs() {
    return this.core.toolSpecs;
  }

  /** 隐藏面板原语名（不进引擎工具面——getProfile 观测面合并显示）。 */
  private get hiddenToolNames() {
    return this.core.hiddenToolNames;
  }

  // ── 分诊路由域委托（StewardRouting）────────────────────────

  /** 入站 ask（判定漏斗 + 排队接管——域内实现见 StewardRouting.ask）。 */
  async ask(
    text: string,
    events: StewardAskEvents = {},
    deliver?: (payload: StewardAskResultPayload) => void,
    source: StewardAskSource = "text",
  ): Promise<StewardAskResultPayload> {
    return this.routing.ask(text, events, deliver, source);
  }

  /** 在途轮 abort（幂等轻停——队列照常）。 */
  abortInFlight(reason: string): boolean {
    return this.routing.abortInFlight(reason);
  }

  /** 全停（abort 当前 + 清空排队；语音停止判定通道）。 */
  interruptAll(reason: string): number {
    return this.routing.interruptAll(reason);
  }

  /** 停止意图判定（协议面 steward.judge_stop_intent 单源）。 */
  async judgeStopIntent(
    text: string,
  ): Promise<{ stop: boolean; score?: number; degraded?: "off" | "unready" | "error" }> {
    return this.routing.judgeStopIntent(text);
  }

  /** 确认闸放行（两段式：受理即回 + 异步执行回执）。 */
  async confirm(
    actionId: string,
    onCompleted?: (payload: StewardActionCompletedPayload) => void,
  ): Promise<StewardConfirmResultPayload> {
    return this.routing.confirm(actionId, onCompleted);
  }

  /** 确认卡作废（幂等；作废即终局）。 */
  cancel(actionId: string): void {
    this.routing.cancel(actionId);
  }

  /** 在途确认卡快照（steward.pending.snapshot 对账/跨重启清场）。 */
  pendingSnapshot(): readonly string[] {
    return this.routing.pendingSnapshot();
  }

  /** 开关现态（money gate 读面）。 */
  isEnabled(): boolean {
    return this.core.isEnabled();
  }

  // ── 播报编排域委托（StewardOutlet）──────────────────────────

  /** 事件 feed 播报入口（①层粗筛 + 订阅闸 + ②层模板直出 + feed 帧）。 */
  onDomainEvent(event: DomainEvent): void {
    this.outlet.onDomainEvent(event);
  }

  /** 对话内主动汇报（记录入工作记忆 + steward.proactive 实时帧）。 */
  async reportProactive(report: {
    title: string;
    text: string;
    suggestions?: readonly { label: string; verb?: string; sessionId?: string }[];
  }): Promise<void> {
    return this.outlet.reportProactive(report);
  }

  /** run 驱动（原 prepareAskRun + agent.start 合体）：每 run 动态 systemPrompt
   *  组装（感知快照 + 记忆召回——setSystemPrompt 运行期变异面）+ B4a 补偿
   *  （队列接管轮）+ 事件收口挂载。   *
   *  事故热修批④（队列并发锁）：runActive 提前到本同步段置位——原实现置位
   *  在 await 装配段之后，ask 检查面在「run 收口（runActive=false）→ driveAsk
   *  装配 await → runActive=true」的间隙里看到假空闲态，相邻 ask 并发直驱双
   *  run（2026-10-07 事故 26ms 双 run「Agent is already processing a prompt」）。
   *  同步占位 + finishRun 幂等守卫共同封死 drain 与新 ask 竞态（任一时刻至
   *  多一个 run 在途；E-240 队列行为断言面不变）。装配异常兑底：占位后若
   *  装配失败，释放占位并收口 error 回执（防 runActive 永真死锁队列）。 */
  private driveAsk(item: StewardAskItem): Promise<StewardAskResultPayload> {
    this.core.run.occupy(); // 单飞同步占位（零 await 间隙——ask 检查面立即可见）
    this.core.runEpoch += 1; // run 代际号（评审 low #2：异步判定回来时认「是不是同一个 run」）
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
      if (!this.core.run.active) throw err;
      this.core.run.assemblyFailed(); // 批 2：释放占位 + 清锚（不误伤下一 run）
      this.core.runSettledMark?.();
      this.core.runSettledMark = undefined;
      const payload: StewardAskResultPayload = {
        status: "error",
        reason: `引擎装配异常：${(err as Error).message}`,
        errorKind: "engine-exception",
      };
      this.settleAsk(payload);
      this.core.deps.logger?.warn(
        `管家 run 收口：error（分类：engine-exception；原因：引擎装配异常：${capChars((err as Error).message, 200)}；排队 ${this.core.askQueue.length} 条）`,
      );
      const next = this.core.askQueue.shift();
      if (next !== undefined) {
        void this.driveAsk(next).catch(() => undefined);
      }
      return payload;
    }
  }

  private async assembleAndRunInner(item: StewardAskItem): Promise<StewardAskResultPayload> {
    this.core.dialog.ensureLoaded();
    const systemPrompt = assembleStewardSystemPrompt(
      await this.buildSnapshotSafely(),
      // 记忆批（同轨换轨）：机械召回注入退役（原 recallSection(item.text)
      // 注入点）——管家记忆消费改走 memory_search 工具：LLM 按纪律主动
      // 检索，query 自对用户话语（含 ASR 转写）提炼重写，检索更准；多一次
      // 工具调用的开销用户已接受。
      // 语音闭环批 ①：在途提案段（LLM 路径上下文增强——pending 非空时引导
      // 把用户补充话语对齐确认/取消/目标修正，对齐失败才按新指令；词表快路径
      //（TR-240）在 ask 入口先行，两者叠加不冲突）
      buildPendingProposalsSection(this.core.ledger.entries().map((e) => e.action)),
    );
    if (this.core.engine === undefined) {
      const keepRecent = this.core.deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT;
      // 代际守卫：persistentListener 捕获本引擎引用——clearHistory 弃旧引擎后
      // 其残余事件（abort 收口帧）不再进入服务面（防污染新 run 状态）
      let engineRef: AgentEnginePort;
      engineRef = this.core.deps.createEngine({
        systemPrompt,
        tools: this.core.toolSpecs,
        gatedTools: GATED_TOOLS,
        persistentListener: (event) => {
          if (this.core.engine === engineRef) this.onEngineEvent(event);
        },
        initialMessages: this.core.dialogSnapshotMessages(),
        compaction: {
          thresholdTokens: this.core.deps.compaction?.thresholdTokens ?? STEWARD_COMPACTION_THRESHOLD_TOKENS,
          keepRecent,
          summarizeInstructions: STEWARD_COMPACTION_SUMMARY_PROMPT,
          summarize: async (_systemPrompt, messages) => {
            // 管家摘要身份自带（STEWARD_COMPACTION_SUMMARY_PROMPT）——pi 侧
            // systemPrompt 是英文常量（customInstructions 落 user 消息不落 sys）
            const response = await this.core.deps.llm.complete({
              systemPrompt: STEWARD_COMPACTION_SUMMARY_PROMPT,
              messages,
              tools: [],
            });
            if (response.kind !== "blocks") {
              throw new Error(`压缩摘要响应非块集（${response.kind}）`);
            }
            return stewardBlocksText(response.blocks);
          },
        },
      });
      this.core.engine = engineRef; // 代际守卫锚（listener 闭包比对同一引用）
    } else {
      this.core.engine.setSystemPrompt?.(systemPrompt);
    }
    this.core.run.begin(); // 批 2：run 开始赋值块（幂等占位/锚定推进锚/清双锚/重置 runState/清 gate 锚）
    this.core.logInfo(`管家 run 开始：${item.text.slice(0, 40)}`);
    this.core.pendingRunAsk = item;
    this.core.askStreamEvents = item.events;
    this.core.currentPause = [];
    const settled = new Promise<StewardAskResultPayload>((resolve) => {
      this.core.askSettler = resolve;
    });
    let markSettled!: () => void;
    this.core.runSettled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.core.runSettledMark = markSettled;
    // run 收口由 start() promise 驱动（agent_end 事件早于 pi run promise 收口
    // ——事件面 settle 会与引擎 busy 态竞态：队列驱动 start 撞「already
    // processing」；promise 面收口 = 真 idle 保证）
    void this.core.engine!
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
    this.core.run.touch(); // 看门狗推进锚（任何引擎事件 = 活跃）
    this.core.deps.emitEngineEvent?.(event);
    this.core.outlet.forwardStreamCallbacks(event);
    // 轮数熔断（同步判定——async 投影链赶不上无思考工具风暴；abort 越早越省）
    if (event.type === "tool_execution_start") {
      this.core.run.state.toolCalls += 1;
      if (this.core.run.state.toolCalls > this.core.tuningOf().run.maxToolRounds && !this.core.run.state.roundLimit) {
        this.core.run.state.roundLimit = true;
        this.core.engine?.abort();
      }
    }
    this.enqueueProjection(() => this.projectEngineEvent(event));
  }

  /** 投影链追加（顺序化：KV 写入与收口/队列驱动严格定序）。 */
  private enqueueProjection(step: () => Promise<void>): void {
    this.core.projectionChain = this.core.projectionChain.then(step).catch((err) => {
      this.core.deps.logger?.warn(`管家事件投影异常：${(err as Error).message}`);
    });
  }

  /** 引擎事件投影（顺序化执行：KV 入账 / 暂停处理 / 压缩 / run 收口）。 */
  private async projectEngineEvent(event: AgentEngineEvent): Promise<void> {
    switch (event.type) {
      case "message_end":
        await this.projectMessageEnd(event);
        return;
      case "engine_error":
        if (this.core.run.state.softError === undefined) this.core.run.state.softError = event.message;
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
        await this.core.dialog.compact(
          { kind: "compaction", text: event.summary, at: this.core.now() },
          this.core.deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT,
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
      const at = this.core.now();
      await this.core.pushRecord({ kind: "user", text: event.text, at });
      return;
    }
    if (event.role === "toolResult") {
      await this.core.pushRecord({
        kind: "toolResult",
        toolCallId: event.toolCallId ?? "",
        name: event.toolName ?? "",
        text: event.text,
        at: this.core.now(),
      });
      return;
    }
    if (event.stopReason === "aborted") this.core.run.state.sawAborted = true;
    if (event.stopReason === "error") {
      // 回执文案前缀（与迁移前 streamFn 包装等价——provider 原文随附）；
      // 事故热修批⑦：分类锚定 model-failure（provider 流错误——与工具面
      // aborted / 闸面 terminate 分记，收口日志不再一律记成模型失败）
      this.core.run.state.hardError =
        event.text.trim() !== "" ? `模型调用失败：${event.text}` : this.core.run.state.hardError ?? "模型调用失败";
      this.core.run.state.hardErrorKind = "model-failure";
      return; // error 消息不入 KV（半成品）——错误经回执交代
    }
    const blocks = event.blocks ?? [];
    // abort 半截轮无完整内容：零 assistant 记录（无「（无回答）」污染——
    // loop 无痕语义的对齐面；有文本/thinking 时照记）
    if (event.stopReason === "aborted" && blocks.length === 0 && event.text.trim() === "") return;
    const toolCall = blocks.find((b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall");
    const thinkingBlocks = blocks.filter((b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking");
    const text = toolCall !== undefined || event.text.trim() !== "" ? event.text : "（无回答）";
    if (toolCall === undefined && event.text.trim() !== "") this.core.run.state.lastAnswerText = event.text;
    const thinkingText = thinkingBlocks.map((b) => b.text).join("\n");
    const signature = thinkingBlocks.find((b) => b.signature !== undefined && b.signature !== "")?.signature;
    await this.core.pushRecord({
      kind: "assistant",
      ...(text !== "" || toolCall !== undefined ? { text } : {}),
      ...(thinkingText !== ""
        ? { thinking: signature !== undefined ? { text: thinkingText, signature } : { text: thinkingText } }
        : {}),
      ...(toolCall !== undefined ? { toolCall: { id: toolCall.id, name: toolCall.name, args: toolCall.args } } : {}),
      at: this.core.now(),
    });
  }

  /** 挂闸处理（原 beforeToolCallPause 校验体的 engine_paused 形态）。 */
  private async handleEnginePaused(
    event: Extract<AgentEngineEvent, { type: "engine_paused" }>,
  ): Promise<void> {
    const gated = await this.core.toolKit.gateWriteTool({
      runId: "",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: (event.args ?? {}) as Record<string, unknown>,
    });
    if (!gated.pause) {
      // read 档直行（M2 act）：approve 放行——工具正常执行（免确认直行）
      if (gated.approve === true) {
        await this.core.engine?.resume?.(event.pauseToken, { kind: "approve" });
        return;
      }
      // 校验未过直出（原 pause:false + outcome 路径）：guidance → reject
      // （模型知情续跑）；terminate → resolve 翻译（结果入账 + run 终结）。
      const outcome = gated.outcome;
      if (outcome !== undefined && outcome.kind === "terminate") {
        this.core.run.state.hardError = outcome.reason;
        this.core.run.state.hardErrorKind = "engine-error"; // 闸面终止（非模型失败——分记）
        await this.core.engine?.resume?.(event.pauseToken, { kind: "resolve", text: outcome.reason });
      } else {
        const text = outcome !== undefined && outcome.kind === "result" ? outcome.text : "提案未通过校验";
        await this.core.engine?.resume?.(event.pauseToken, { kind: "reject", text });
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
    const proposed = this.core.ledger.propose(action, { pauseToken: event.pauseToken });
    if (proposed.kind === "reused") {
      // 登记簿①：在途同 key → 复用旧卡（幂等：不新弹不新凭据；凭据换血
      // 到活 run 的 pauseToken——回灌链路续活，TTL 重置新确认窗口）
      this.core.currentPause.length = 0;
      this.core.currentPause.push({ actionId: proposed.actionId, action: proposed.entry.action });
      this.core.run.gate(event.pauseToken);
      this.core.logInfo(
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
      this.core.logInfo(
        `管家确认闸拦截重复提案：${gated.action.kind} → ${gated.action.displayTarget}（已执行过 ${proposed.settled.actionId}）`,
      );
      await this.core.engine?.resume?.(event.pauseToken, {
        kind: "resolve",
        text: capToolResultText(`该操作已执行过（${proposed.settled.actionId}）：${proposed.settled.detail}——无需重复确认，可向用户说明`),
      });
      return;
    }
    const actionId = proposed.actionId;
    this.core.logInfo(`管家确认闸暂停：${actionId}（${gated.action.kind} → ${gated.action.displayTarget}）`);
    this.core.currentPause.length = 0; // 一次 run 至多一个未决提案（挂闸即收口）
    this.core.currentPause.push({ actionId, action: proposed.entry.action });
    this.core.run.gate(event.pauseToken);
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
    if (!this.core.run.active) return; // 幂等守卫（事故热修批④）
    this.core.run.finish(); // 批 2：收口清块（runActive=false + 三锚复位）
    this.core.runSettledMark?.();
    this.core.runSettledMark = undefined;
    const outcome: StewardAskResultPayload =
      startError !== undefined
        ? { status: "error", reason: startError, errorKind: "engine-exception" }
        : this.outcomeOfRun();
    // ⑤ error 收口附原因摘要 + 分类分记（warn 级保证可见——旧装配 info 缺席
    //    时事故零日志；分类面让 aborted/模型失败/引擎异常可区分归因）
    if (outcome.status === "error") {
      const kind = outcome.errorKind ?? "-";
      this.core.deps.logger?.warn(
        `管家 run 收口：error（分类：${kind}；原因：${capChars(outcome.reason, 200)}；排队 ${this.core.askQueue.length} 条）`,
      );
      // 健康上报（光球角标批）：模型/引擎级失败 = llm 降级；aborted（用户
      // 手动停止）非故障不上报
      if (kind !== "aborted") this.core.deps.emitHealth?.("llm", "degraded", outcome.reason);
    } else {
      this.core.logInfo(`管家 run 收口：${outcome.status}（排队 ${this.core.askQueue.length} 条）`);
      this.core.deps.emitHealth?.("llm", "ok"); // 正常收口 = llm 恢复
    }
    // ④ 本 run 挂闸卡处置：deliver/send/create/spawnReview 意图不随 run 死
    //    而失效 → 凭据续活到卡终局；destructive 不可续活 → 即时撤除+明示。
    this.disposeRunPendingCards();
    const item = this.core.pendingRunAsk;
    this.core.pendingRunAsk = undefined;
    this.core.run.ungate();
    this.core.askStreamEvents = {};
    this.settleAsk(outcome);
    item?.deliver?.(outcome);
    const next = this.core.askQueue.shift();
    if (next !== undefined) {
      void this.driveAsk(next).catch((err) => {
        this.core.deps.logger?.warn(`队列驱动异常：${(err as Error).message}`);
      });
    }
  }

  /** run 收口挂闸卡处置（确认链路修复批④；批 1 起判定收编聚合）：currentPause
   *  即本 run 提案锚（一次 run 至多一个未决提案）；已终局（confirm/cancel
   *  先行）零处置；非 destructive 续活、destructive 撤除+明示（翻译面）。 */
  private disposeRunPendingCards(): void {
    const { kept, withdrawn } = this.core.ledger.resolveRunCards(this.core.currentPause.map((p) => p.actionId));
    for (const { actionId, action } of kept) {
      this.core.logInfo(
        `确认卡续活（run 收口不撤）：${actionId}（${action.kind} → ${action.displayTarget}）——意图不随 run 死而失效`,
      );
    }
    for (const { actionId, action } of withdrawn) {
      this.core.routing.settleProposal(pendingKeyOf(action), "voided", actionId, "run 收口撤除（destructive 不可续活）");
      this.core.deps.emitActionCompleted?.({
        actionId,
        ok: false,
        detail: "该操作已撤回（原运行已结束，高风险操作不自动保留）——如仍需要请重新提出",
        outcome: "superseded",
      });
      this.core.outlet.emitLifecycleNotify(
        "normal",
        "高风险操作已撤回",
        `原运行已结束，「${action.displayTarget}」的高风险操作卡已撤除；如仍需要请重新提出`,
      );
    }
    this.core.currentPause = [];
  }

  /** run 结果推导（事件态 → 回执判别——原 mapRunResult）。事故热修批⑦：各
   *  error 分支携 errorKind（aborted 与模型失败分记——日志/回执可区分归因）。 */
  private outcomeOfRun(): StewardAskResultPayload {
    // aborted 优先于一切（半截文本不作终答回执——协议面回执恒 aborted error）；
    // 次之 answer（压缩失败 engine_error 不吞终答——fail-open）；最后 error
    if (this.core.run.state.roundLimit) {
      return {
        status: "error",
        reason: `工具循环超限（>${this.core.tuningOf().run.maxToolRounds} 轮熔断）——请缩小问题范围或重试`,
        errorKind: "round-limit",
      };
    }
    if (this.core.run.state.sawAborted) {
      return {
        status: "error",
        reason: "管家对话已被中止（abort——可重发；排队中的输入不受影响）",
        errorKind: "aborted",
      };
    }
    if (this.core.run.state.hardError !== undefined) {
      return {
        status: "error",
        reason: this.core.run.state.hardError,
        ...(this.core.run.state.hardErrorKind !== undefined ? { errorKind: this.core.run.state.hardErrorKind } : {}),
      };
    }
    if (this.core.run.state.lastAnswerText.trim() !== "") {
      return { status: "answer", text: this.core.run.state.lastAnswerText };
    }
    if (this.core.run.state.softError !== undefined) {
      return { status: "error", reason: this.core.run.state.softError, errorKind: "engine-error" };
    }
    return { status: "answer", text: "（无回答）" };
  }

  /** ask promise 收口（confirm_required 在挂闸即收；其余在 finishRun）。
   *  runSettled 不在此收——移 finishRun（暂停态新 ask 的 abort-再驱动需等
   *  引擎真 idle，而非 confirm_required 收口时点）。 */
  private settleAsk(payload: StewardAskResultPayload): void {
    const settle = this.core.askSettler;
    this.core.askSettler = undefined;
    settle?.(payload);
  }

  // ── 可靠性批（2026-10-06 事故根修）：看门狗 + 确认闸 TTL + 可达性提醒 ──
  // 三要素兑底：确认闸无超时（TTL）、run 无看门狗（watchdog）、挂起无日志
  // （生命周期日志面）。生产定时器由组合根 startReliabilityTimers 启动，
  // 测试直接调 reliabilityTick（注入时钟——E-240 行为等价不变量不受影响）。

  /** 启动可靠性巡检定时器（生产面；幂等——stewardMemory.startGcTimer 先例）。 */
  startReliabilityTimers(): void {
    if (this.core.reliabilityTimer !== undefined) return;
    const timer = setInterval(() => this.reliabilityTick(), this.core.tuningOf().run.watchdogTickMs);
    timer?.unref?.(); // TR-152 落盘面定时器纪律：不阻进程退出
    this.core.reliabilityTimer = timer;
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
    if (this.core.reliabilityTimer === undefined) return;
    clearInterval(this.core.reliabilityTimer);
    this.core.reliabilityTimer = undefined;
  }

  /** 可靠性巡检单拍（看门狗 → 可达性提醒 → 确认闸 TTL；幂等可重入）。 */
  reliabilityTick(): void {
    const now = this.core.now();
    this.checkRunWatchdog(now);
    this.checkConfirmReminders(now);
    this.checkConfirmTtl(now);
  }

  /** run 看门狗 tick（批 2：判定收编 RunWatchdog 纯函数——六态穷举表驱动，
   *  domain/steward/run/RunWatchdog；副作用翻译在本方法）。原判定序与文案
   *  逐分支等价（含 CAND-666 哨兵防御/挂闸等待零通知/手动快进优先于被动轨）。 */
  private checkRunWatchdog(now: number): void {
    const verdict = judgeRunWatchdog(this.core.run.watchdogSnapshot(this.core.engine !== undefined), this.core.tuningOf(), now);
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
          `手动停止快进：abort 后 ${this.core.tuningOf().run.manualAbortGraceMs / 1000}s 未收口（挂死流——abort 打不醒）——弃引擎重建并恢复队列`,
        );
        return;
      }
      case "arm": {
        this.core.run.armWatchdog();
        const gatedWait = this.core.ledger.size > 0; // 挂闸等待：有卡待确认（合法业务态）
        this.core.deps.logger?.warn(
          `管家 run 看门狗触发：挂起 ${verdict.hungSeconds}s 无事件推进${gatedWait ? "（挂闸等待中——pending 有卡）" : ""}——abort 在途轮${gatedWait ? "（等待态零通知）" : "并通知"}`,
        );
        if (!gatedWait) {
          // 恢复通知只留给「用户在等答案却被挂死」场景；挂闸等待用户知情
          // （有卡挂着），「已自动恢复」是惊扰噪音（2026-10-07 事故修订 CAND-666）
          this.core.outlet.emitLifecycleNotify(
            "high",
            "管家已自动恢复",
            `管家处理挂起 ${verdict.hungSeconds}s 无响应，已自动中止恢复；排队中的输入将继续处理`,
          );
        }
        this.core.routing.abortInFlight("run 看门狗：挂起超时"); // 挂闸阻塞的 run 被唤醒收口（raceAbort）
        return;
      }
      case "force-recover": {
        this.core.run.armWatchdog(); // 周期性兜底重置（极端场景下每宽限窗再查）
        this.forceRecoverRun(verdict.reason);
        return;
      }
    }
  }

  /** 强制收口轨（手动停止批提取；挂死流唯一恢复路径——E-240）：看门狗宽限段
   *  与手动停止快进段共用。弃引擎（代际守卫隔离旧引擎残余事件）+ 经投影链
   *  finishRun（队列驱动/deliver 回执/挂闸卡处置全走既有收口面）。 */
  private forceRecoverRun(reason: string): void {
    this.core.run.forceRecoverPrepared(); // 同步清锚防重（finishRun 异步，重复 tick 不二触）
    this.core.engine = undefined; // 弃引擎（下一 run 懒重建；代际守卫隔旧事件）
    this.core.run.ungate();
    this.core.deps.logger?.warn(`管家 run 强制收口：${reason}`);
    this.enqueueProjection(() => this.finishRun(reason));
  }

  /** 确认可达性提醒（语音闭环批 ②聚合版）：任一卡到 30s 未消费 → 按 pending
   *  全集 N 出**一条**提醒（N=1 维持现单条文案；N≥2 合并「管家有 N 个操作
   *  等你确认」）且覆盖全集（全部置 remindedAt——后熟卡零二次提醒）。治事故
   *  「两张同模板卡各弹一条（body 仅目标不同 → 去重 key 不同全放行）」。 */
  private checkConfirmReminders(now: number): void {
    // 批 1：成熟判定/覆盖全集收编聚合；文案与帧发射留翻译面
    const matured = this.core.ledger.remindDue(now, this.core.tuningOf().confirm.remindAfterMs);
    if (matured === undefined) return;
    const total = matured.total;
    if (total >= 2) {
      this.core.logInfo(
        `管家确认卡可达性提醒（聚合）：pending ${total} 张（首成熟 ${matured.first.actionId}——${matured.first.entry.action.displayTarget}）——${this.core.tuningOf().confirm.remindAfterMs / 1000}s 无人消费`,
      );
      this.core.outlet.emitLifecycleNotify(
        "normal",
        "待确认操作",
        `管家有 ${total} 个操作等你确认——打开管家面板处理；${this.core.tuningOf().confirm.ttlMs / 1000}s 内未确认将自动作废`,
      );
      return;
    }
    this.core.logInfo(
      `管家确认卡可达性提醒：${matured.first.actionId}（${matured.first.entry.action.displayTarget}）——${this.core.tuningOf().confirm.remindAfterMs / 1000}s 无人消费`,
    );
    this.core.outlet.emitLifecycleNotify(
      "normal",
      "待确认操作",
      `管家有一个操作等你确认（${matured.first.entry.action.displayTarget}）——打开管家面板处理；${this.core.tuningOf().confirm.ttlMs / 1000}s 内未确认将自动作废`,
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
    const expired = this.core.ledger.expireDue(now, this.core.tuningOf().confirm.ttlMs);
    for (const { actionId, entry } of expired) {
      this.core.ledger.markExpired(actionId); // 逐个删除（已被同 key 收敛先行删除 → no-op；帧照快照无条件发——原版时序）
      this.core.deps.logger?.warn(
        `管家确认卡 TTL 作废：${actionId}（${entry.action.kind} → ${entry.action.displayTarget}）——${this.core.tuningOf().confirm.ttlMs / 1000}s 无人确认自动作废`,
      );
      this.core.deps.emitActionCompleted?.({ actionId, ok: false, detail: STEWARD_CONFIRM_TIMEOUT_DETAIL, outcome: "timeout" });
      // 终局登记 + 同 key 收敛（确认链路修复批：作废也收敛，零后续连锁通知）
      this.core.routing.settleProposal(entry.key ?? pendingKeyOf(entry.action), "voided", actionId, "确认超时作废");
    }
    if (expired.length === 0) return;
    if (expired.length >= 2) {
      this.core.outlet.emitLifecycleNotify(
        "normal",
        "确认已超时",
        `${expired.length} 个操作超过 ${this.core.tuningOf().confirm.ttlMs / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
      );
      return;
    }
    const single = expired[0]!;
    this.core.outlet.emitLifecycleNotify(
      "normal",
      "确认已超时",
      `操作「${single.entry.action.displayTarget}」超过 ${this.core.tuningOf().confirm.ttlMs / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
    );
  }

  /** 工作记忆读面（steward.history 回放：完整记录数组——UI 渲染与 LLM 窗口
   *  同源重建；A1 批）。 */
  async getHistory(): Promise<readonly StewardHistoryRecord[]> {
    return this.core.dialog.snapshot();
  }

  /** 新对话闸（steward.history {clear:true}：KV + daemon LLM 窗口同清——
   *  前端显示由回执空数组同步；A1 批）。pending 确认卡随之作废（自然过期）。 */
  async clearHistory(): Promise<void> {
    this.core.ledger.clear();
    await this.core.dialog.clear();
    // 段B：引擎销毁重建（下一问从空窗口——与清空后 KV 同源；dialog 已清，
    // 懒构造下一问以空 initialMessages 重建）。挂闸阻塞中的 run 先 abort 释放
    //（闸内 raceAbort 唤醒）再弃引用；runActive 复位防新 ask 误判 busy。
    this.core.engine?.abort();
    this.core.engine = undefined;
    // 在途/排队 ask 先收口再清状态（孤儿化修复：askSettler 只置空不 settle
    // 的话，在途 ask 的 promise 永不 resolve——handler 的 steward.ask.result
    // 帧永不回执，UI 该轮永久等待；runSettledMark 同步收口防 abort-再驱动
    // 路径的 awaiter 挂死；排队项逐个 deliver 作废回执——新对话语义下不再
    // 处理，但发起面必须拿到终帧）。clearAll 后 finishRun 幂等守卫直接回，
    // 自然收口路径不会二次 settle——此处是唯一收口点。）
    const droppedItems = this.core.askQueue.drainAll();
    if (droppedItems.length > 0) this.core.logInfo(`管家新对话：丢弃排队 ${droppedItems.length} 条`);
    for (const queuedItem of droppedItems) {
      queuedItem.deliver?.({ status: "error", reason: "对话已清空（新对话）——排队输入作废", errorKind: "aborted" });
    }
    const clearedPayload: StewardAskResultPayload = {
      status: "error",
      reason: "对话已清空（新对话）——本轮已被中止",
      errorKind: "aborted",
    };
    const item = this.core.pendingRunAsk;
    this.core.pendingRunAsk = undefined;
    this.core.askStreamEvents = {};
    this.settleAsk(clearedPayload);
    this.core.run.clearAll(); // 批 2：run 态全复位
    this.core.runSettledMark?.();
    this.core.runSettledMark = undefined;
    item?.deliver?.(clearedPayload);
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
      model: this.core.deps.config.get(STEWARD_MODEL_KEY) ?? this.core.deps.llm.modelId,
      // 总结配置组回显（summary.* 通用域生效值——所见即所得）
      summary: readSummaryConfig(this.core.deps.config),
      // 管家记忆 B1：记忆面现态（未装配 = 全降级缺省——开关关/零条目；批1：
      //  endpoint 摘除——向量端点恒为全局默认端点，回执不回 endpointId）
      memory: this.core.deps.memory?.getMemoryState() ?? {
        enabled: false,
        available: false,
        judgeEndpoint: null,
        entryCount: 0,
        dim: null,
      },
      // 分诊判官配置现态（未装配 = 全降级缺省——开关关/端点未配）
      triage: this.core.deps.triageJudge?.state() ?? { judgeEnabled: false, judgeEndpoint: null },
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
        ...this.core.toolSpecs.map((t) => ({ name: t.name, description: t.description })),
        { name: "steward_confirm", description: "确认闸放行（面板确认按钮原语；非 LLM 工具）" },
      ],
      model: this.core.deps.config.get(STEWARD_MODEL_KEY) ?? null,
      kindLabel: "steward",
    };
  }

  // ── 记忆条目管理委托面（管家记忆 B2：steward.memory_* 四命令回口——
  //    memory 服务缺席时零记忆降级形态）───────────────────────

  /** 条目只读清单（空数组 = 记忆面缺席/空库）。 */
  listMemoryEntries(): readonly import("../ports/outbound/StewardMemoryPort").StewardMemoryEntry[] {
    return this.core.deps.memory?.listEntries() ?? [];
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
    if (this.core.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.core.deps.memory.appendMemoryEntry(text, kind, projectScope, domain);
  }

  /** 重嵌更新（缺席/失败 → error outcome）。 */
  async updateMemoryEntry(id: number, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.core.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.core.deps.memory.updateMemoryEntry(id, text);
  }

  /** 行级删除（缺席 → false，幂等）。 */
  forgetMemoryEntry(id: number): boolean {
    return this.core.deps.memory?.forgetEntry(id) ?? false;
  }

  /** 置顶切换（遗忘机制批命令回口：置顶 = 解除淡忘 + 刷 updatedAt；
   *  缺席 → false）。 */
  pinMemoryEntry(id: number, pinned: boolean): boolean {
    return this.core.deps.memory?.pinMemoryEntry(id, pinned) ?? false;
  }

  /** 淡忘恢复（遗忘机制批命令回口：active 条目幂等 no-op；缺席 → false）。 */
  restoreMemoryEntry(id: number): boolean {
    return this.core.deps.memory?.restoreMemoryEntry(id) ?? false;
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
      if (this.core.deps.memory === undefined) {
        return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
      }
      const outcome = await this.core.deps.memory.setMemoryConfig(patch.memory);
      if (!outcome.ok) return outcome;
    }
    if (patch.triage !== undefined) {
      // 分诊判官接入批：判官配置委托判定域面（空串 judgeEndpointId = 清除引用）
      if (this.core.deps.triageJudge === undefined) {
        return { ok: false, error: "分诊判官面未装配（daemon 装配缺 triage 源）" };
      }
      const outcome = await this.core.deps.triageJudge.setConfig(patch.triage);
      if (!outcome.ok) return outcome;
    }
    if (patch.model !== undefined) {
      const model = patch.model.trim();
      if (model !== "" && !/^[^/\s]+\/[^/\s]+$/.test(model)) {
        return { ok: false, error: `模型格式非法：${model}（应为 "provider/model-id" 形态）` };
      }
      if (model !== "") await this.core.deps.config.set(STEWARD_MODEL_KEY, model);
    }
    if (patch.enabled !== undefined) {
      await this.core.deps.config.set(STEWARD_ENABLED_KEY, patch.enabled ? "1" : "0");
    }
    return { ok: true };
  }

  // ── 内部 ────────────────────────────────────────────────

  // ── helix-loop L0：工具注册表装配（八工具）+ 暂停点挂钩 ──────

  // ── 工具面已收编 tools/StewardToolKit（批 3a）：registerTools/挂闸判定/
  //    提案构造/工具体全部迁出——加工具只动 StewardToolKit。 ──
  /** 快照段组装（感知查询失败静默降级 = undefined；绝不能挡对话主链路）。
   *  数据源与工具面同源：活跃 agent 数 = orchestration.status()（与
   *  list_instances 同一调用面）；会话计数与主题 = sessions 源（与
   *  query_recent_work 同一读面）；M3-d1 活动段 = recentActivity 读面
   *  （活动账白话行——**分段降级**：活动面抛错只缺席活动段，基础段照常）。 */
  private async buildSnapshotSafely(): Promise<string | undefined> {
    if (this.core.deps.sessions === undefined) return undefined;
    try {
      const rows = await this.core.deps.sessions.listSessionMetadata();
      const statuses = this.core.deps.orchestration.status();
      const activeAgents = statuses.filter((s) => s.state === "running").length;
      // M3-d1：活动段读面独立降级（读面抛错 → 零活动段，快照基础段照常——
      // 现 assembleStewardSystemPrompt 附加段缺席语义）
      let recentActivity: readonly { at: number; domain: string; attribution: string; text: string }[] | undefined;
      try {
        recentActivity = this.core.deps.recentActivity?.();
      } catch (err) {
        this.core.deps.logger?.warn(`管家快照活动段读面降级（快照仅基础段）：${(err as Error).message}`);
        recentActivity = undefined;
      }
      return buildContextSnapshot({
        nowMs: this.core.now(),
        activeAgents,
        totalAgents: statuses.length,
        sessionCount: rows.length,
        recentSessions: rows.slice(0, SNAPSHOT_RECENT_SESSIONS).map((r) => ({
          // displayTitle 单源（TR-207）：推导链只在 displayTitleOf，快照面禁另写
          title: displayTitleOf(r),
          updatedAt: r.updatedAt,
        })),
        ...(recentActivity !== undefined && recentActivity.length > 0 ? { recentActivity } : {}),
      });
    } catch (err) {
      this.core.deps.logger?.warn(`管家情景快照组装失败（降级为无快照段）：${(err as Error).message}`);
      return undefined;
    }
  }

}

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
  StewardLlmThinking,
} from "../ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { AgentOrchestrationPort } from "../ports/inbound/AgentOrchestrationPort";
import type {
  StewardAskResultPayload,
  StewardConfirmResultPayload,
  StewardFeedPayload,
  StewardHistoryRecord,
  StewardNavigatePayload,
  StewardSedimentProposalPayload,
} from "@helix/protocol";
import { StewardDialogMemory } from "./StewardDialogMemory";
import type { StewardMemoryService } from "./StewardMemoryService";
import type {
  LoopCompactionInfo,
  LoopEngine,
  LoopEvent,
  LoopMessage,
  LoopMessageSink,
  LoopPauseDecision,
  LoopResumeDecision,
  LoopRunResult,
  LoopStreamFn,
  LoopStreamResult,
  LoopToolCallContext,
  LoopToolOutcome,
} from "../../domain/loop";
import { LOOP_COMPACTION_SUMMARY_PROMPT, LOOP_INTERRUPTED_MARKER_TEXT } from "../../domain/loop";
import { LoopEngine as LoopEngineImpl, ToolRegistry } from "../../domain/loop";

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

/** 自动沉淀跳过低档（B4a：判官校准概率 < 此值 = 高置信「无认知增量」→ 静默
 *  跳过。0.35 起步值——Jev 校准度真实数据攒够后调；确认卡全走（第一版
 *  不做高档自动入库——先验证校准再灰度放开）。 */
export const STEWARD_SEDIMENT_SKIP_THRESHOLD = 0.35;

/** 自动沉淀候选文本截断（B4a：用户消息原文——零 LLM 提取，可解释）。 */
const SEDIMENT_CANDIDATE_MAX_CHARS = 200;

/** 判官问题模板（B4a：noul 判定问句——只沉淀认知增量）。 */
const SEDIMENT_QUESTION =
  "这段对话是否包含值得跨会话长期记忆的用户偏好、习惯、纠正或新事实？（一次性上下文/本轮临时信息/寒暄/纯任务执行不算——只沉淀认知增量）";

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

/** L1 件一：压缩触发阈值（token 估算口径与 estimateLoopTokens 同族；
 *  任务书默认 12k——低于工作记忆 16k 预算闸，压缩先于粗裁剪接管）。 */
export const STEWARD_COMPACTION_THRESHOLD_TOKENS = 12_288;

/** L1 件一：压缩尾部滚动窗（条数——TR-47：压的是历史不是工作集）。 */
export const STEWARD_COMPACTION_KEEP_RECENT = 6;

/** L1 件二：输入缓冲 pending 队列上限（忙碌态入队不拒绝；超限提示）。 */
export const STEWARD_PENDING_ASKS_MAX = 3;

/** 工具/思考过程帧摘要截断上限（steward.tool 帧面——屏幕折叠行密度）。 */
export const PROCESS_SUMMARY_MAX_CHARS = 200;

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
- 不执行未过闸的写操作：唯一写原语 = propose_send / deliver_to_session / create_session / spawn_review_task，且必须等用户在面板确认后才执行。
- 不伪装用户身份、不代替用户做决策。

意图路由（每次用户输入先分类再行动；判据 = 目标语义，不是目标是否在运行）：
- 问管家：关于全局状态/近期工作的问题 → 直接回答（可用 list_instances / list_tasks / query_recent_work 取数）。
- 开新会话：用户想开新 session/新话题（可带标题）→ create_session 提案；建成后界面会自动切到新会话。
- 记忆沉淀：用户明确表达偏好/习惯（「以后都…」「我喜欢…」「记住…」）或对话中确认了跨会话有价值的事实 → remember 提案（写操作——确认后才真正入库）。只沉淀认知增量：一次性上下文/本轮临时信息/寒暄不记。
- 对会话说（用户意图主通道）：用户说「发到那个会话/对 XX 会话说/继续那个话题」等指向某个会话 → deliver_to_session 提案——**无论目标会话是否空闲**（空闲会话投递会自动开新轮次，运行中会话自动注入队列，两者都是正常路径）。不确定 sessionId 时先用 query_recent_work 查（结果含 sessionId）；投递成功后界面会自动切到该会话。
- 给运行中的 agent 实例递话（SubAgent 补充通道）：用户明确点名某个正在跑的 agent-xxx（补充指示/催进度）→ propose_send 提案（agentId 必须运行中）。用户没点名具体 agent 实例时不要走本通道。

路由反判例行（覆盖历史判例）：不要以「没有运行中的 agent 实例」为由拒绝会话投递——投递目标可以是任何存在的会话，空闲会话投递会自动开新轮次，这是正常路径；也不要建议用户「自己去会话页输入」来替代投递。历史对话中你对投递能力的自述（如「我不能直发」「只能递给运行中的 agent」）如有与本规则冲突，以本规则为准。

你只持有全局状态摘要与自身对话状态；回答用中文，简洁直答。

长期记忆（若 system prompt 末尾附「长期记忆」段）：那是按本轮输入语义召回的历史沉淀，仅供作答参考——与本轮指令冲突时以本轮指令为准。用户纠正你时，若纠正内容有跨会话价值，用 remember 沉淀更新后的认知。`;

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

/** 工作记忆记录 → LLM 消息（同源映射：记录携带 at，LLM 面不含时间戳）。 */
function recordToMessage(record: StewardHistoryRecord): StewardLlmMessage {
  if (record.kind === "user") return { role: "user", text: record.text };
  if (record.kind === "toolResult") {
    return { role: "toolResult", toolCallId: record.toolCallId, name: record.name, text: record.text };
  }
  return {
    role: "assistant",
    ...(record.text !== undefined ? { text: record.text } : {}),
    ...(record.thinking !== undefined ? { thinking: record.thinking } : {}),
    ...(record.toolCall !== undefined ? { toolCall: record.toolCall } : {}),
  };
}

/** 过程帧摘要（防御性截断）。 */
function summarizeForFrame(text: string): string {
  return text.length <= PROCESS_SUMMARY_MAX_CHARS ? text : `${text.slice(0, PROCESS_SUMMARY_MAX_CHARS)}…`;
}

/** 字段级截断（紧凑投影用；超限截断加省略号）。 */
function capChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

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
 *  记忆召回段（管家记忆 B1）；两附加段缺席（感知/召回失败静默降级）
 *  = 原样静态段。 */
export function assembleStewardSystemPrompt(snapshot: string | undefined, memorySection?: string | undefined): string {
  let prompt = STEWARD_SYSTEM_PROMPT;
  if (memorySection !== undefined) prompt = `${prompt}\n\n${memorySection}`;
  if (snapshot !== undefined) prompt = `${prompt}\n\n${snapshot}`;
  return prompt;
}

/** 工具结果送 LLM 前体量护栏（A1-hotfix 纯函数，导出供单测）：超
 *  TOOL_RESULT_MAX_CHARS 截断 + 标记（防任何工具的病理体量直达上下文；
 *  过程帧摘要面 summarizeForFrame 独立，不受影响）。 */
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
  /** session 级投递执行面（驾驶舱批；确认闸后调用）：把用户输入投进目标
   *  会话——复用主会话 steer 机制（运行中 → steer 队列；空闲 → 新轮次，
   *  与用户在该会话页直接输入同语义）。delivered=false = 拒绝（detail 含
   *  引导）；成功后由调用方广播 steward.navigate 切页。 */
  deliverToSession(sessionId: string, text: string): Promise<{ delivered: boolean; detail: string }>;
}

/** A2：kg 项目解析面（KgProjectService 同款窄接口——spawn_review_task
 *  前置校验：项目存在性 + .kg 索引判定）。 */
export interface StewardProjectsSource {
  /** 项目名/绝对路径 → projectRoot；不在 workspace 扫描全集 = undefined。 */
  resolve(project: string): string | undefined;
  /** projectRoot 有 .helix-kg/kg.db（读面绝不新建库）。 */
  hasIndex(projectRoot: string): boolean;
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
  /** 自动沉淀提案帧出口（B4a；组合根接 EventStream.broadcastStewardSedimentProposal
   *  ——与 feed 同订阅闸；缺席 = 提案挂 pending 但零广播，确认仍可经 actionId 直达）。 */
  readonly emitSedimentProposal?: (payload: StewardSedimentProposalPayload) => void;
  /** 页面切换指令帧出口（驾驶舱批；组合根接 EventStream.broadcastStewardNavigate
   *  ——deliver_to_session 投递成功 / create_session 建成后广播，shell 切页）。
   *  缺席 = 无切页指令（语义面零降级，仅行为缺席）。 */
  readonly emitNavigate?: (payload: StewardNavigatePayload) => void;
  /** A2：L1 感知面（快照 + query_recent_work + create_session 执行面）。
   *  缺席 = 无快照段/query_recent_work 降级提示/create_session 引导式不可用
   *  ——感知查询绝不能挡住对话主链路（缺席零抛错）。 */
  readonly sessions?: StewardSessionsSource;
  /** A2：kg 项目解析面（spawn_review_task 前置校验；缺席 = 项目校验降级
   *  为存在性未知，直接进确认闸）。 */
  readonly projects?: StewardProjectsSource;
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
  /** helix-loop L0：loop 事件出口（追踪可见性——组合根接 domain_events
   *  投影：LoopEvent → DomainEvent{instanceId:"steward"} 落库；缺席 =
   *  零落库零广播，对话主链路零降级）。 */
  readonly emitLoopEvent?: (event: LoopEvent) => void;
  /** L1 件一：压缩参数覆盖（thresholdTokens/keepRecent 缺省回落导出常量；
   *  本体能力在 LoopEngine compaction 挂点——管家是首个消费者）。 */
  readonly compaction?: { readonly thresholdTokens?: number; readonly keepRecent?: number };
  /** 管家记忆 B1：长期记忆编排面（召回段注入 + remember 执行体 + 配置读写）。
   *  缺席 = 记忆整体降级不可用（recall 零段/remember 引导拒/配置面
   *  available=false）——对话主链路零影响。 */
  readonly memory?: StewardMemoryService;
  readonly logger?: { warn(message: string): void };
}

/** 确认闸目标（面板两行渲染语义重载：send = 递话目标实例；createSession /
 *  spawnReview = 动作标识；deliverSession = 递话目标会话——见各分支注释）。 */
interface PendingAction {
  readonly kind: "send" | "createSession" | "spawnReview" | "deliverSession" | "memorize";
  /** 面板确认卡「目标」行显示值（send = agentId；createSession = "新会话"；
   *  spawnReview = "<reviewType>@<project>"；deliverSession = sessionId）。 */
  readonly displayTarget: string;
  /** 面板确认卡「内容」行显示值（动作摘要全文）。 */
  readonly message: string;
  /** 提案时的工具调用（confirm 执行结果回灌工作记忆的配对锚）。 */
  readonly toolCall: { id: string; name: string };
  /** send 形态载荷。 */
  readonly send?: { agentId: string; message: string };
  /** createSession 形态载荷。 */
  readonly createSession?: { title: string };
  /** deliverSession 形态载荷（驾驶舱批：session 级 steer 投递）。 */
  readonly deliverSession?: { sessionId: string; text: string };
  /** memorize 形态载荷（管家记忆 B1：remember 提案——确认后沉淀长期记忆）。 */
  readonly memorize?: { text: string; kind: "fact" | "preference"; source?: string };
  /** spawnReview 形态载荷。 */
  readonly spawnReview?: {
    reviewType: "code-review" | "kg-review";
    project: string;
    params: Record<string, unknown>;
  };
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

const TOOL_CREATE_SESSION: StewardLlmTool = {
  name: "create_session",
  description:
    "提案创建新会话（写操作——仅提案，系统会请求用户确认后才执行）。用户想开新会话/新话题时使用。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "会话主题标题（可选，缺省自动生成）" },
      project: { type: "string", description: "关联项目名（可选——织入标题标注）" },
    },
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
    "提案沉淀长期记忆（写操作——仅提案，系统会请求用户确认后才执行）。仅用于跨会话有持久价值的认知增量：用户明确表达的偏好/习惯（kind=preference）或对话中确认的事实（kind=fact）。一次性上下文、本轮临时信息、寒暄不记。",
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

const STEWARD_TOOLS: readonly StewardLlmTool[] = [
  TOOL_LIST_INSTANCES,
  TOOL_LIST_TASKS,
  TOOL_QUERY_RECENT_WORK,
  TOOL_PROPOSE_SEND,
  TOOL_DELIVER_TO_SESSION,
  TOOL_CREATE_SESSION,
  TOOL_SPAWN_REVIEW_TASK,
  TOOL_REMEMBER,
];

/** 确认闸挂闸工具集（write 类——提案制：LLM 只能提案，人工确认后才执行）。 */
const GATED_TOOLS: ReadonlySet<string> = new Set([
  "propose_send",
  "deliver_to_session",
  "create_session",
  "spawn_review_task",
  "remember",
]);

/** 挂闸中待确认项（pause 态的 resume 凭据 + 提案动作——actionId 单次消费）。 */
interface PendingEntry {
  readonly action: PendingAction;
  /** LoopEngine 暂停点 resume（B4a 轮外提案（自动沉淀）缺席——confirm 时
   *  跳过回灌直接收口）。 */
  readonly resume?: (decision: LoopResumeDecision) => Promise<LoopRunResult>;
}

/** L1 件二：排队中的 ask 项（忙碌态输入缓冲——收口后自动作为下一轮输入）。
 *  deliver = 轮次完成回执面（queued 帧已由 ask promise 发出，结果帧经此
 *  闭包直达原发起方——handler 层注入 sendNow(sender)）。 */
interface PendingAsk {
  readonly text: string;
  readonly events: StewardAskEvents;
  readonly deliver?: (payload: StewardAskResultPayload) => void;
}

export class StewardService {
  private readonly deps: StewardServiceDeps;
  /** 工作记忆 KV（完整记录持久化——thinking/工具/对话全形态；daemon 重启
   *  后懒加载恢复，A1 批取代裸内存数组）。 */
  private readonly dialog: StewardDialogMemory;
  private readonly now: () => number;
  /** 待确认写动作（actionId 单次消费；不持久化——过期即失效不跨重启）。 */
  private readonly pending = new Map<string, PendingEntry>();
  private actionSeq = 0;
  private feedSeq = 0;
  /** helix-loop L0：LoopEngine 驱动（八工具注册 ToolRegistry；自写 for
   *  循环退役——迁移即验证：行为等价 + abort-and-drain 门控新增）。 */
  private readonly registry: ToolRegistry;
  private readonly engine: LoopEngine;
  /** ask 单飞门控（L1 件二：在途轮忙碌态新 ask 入 pending 队列不拒——
   *  收口（answer/confirm_required/error/aborted 均算）后自动作为下一轮
   *  输入；duplex-truncation §6.2 的 abort-and-drain 序保留：队列消费在
   *  drain 完成（promise settle = KV 写入收尾）之后，abort 语义下队列
   *  保留不丢）。 */
  private inFlight: Promise<StewardAskResultPayload> | null = null;
  private inFlightAbort: AbortController | null = null;
  /** L1 件二：输入缓冲队列（上限 STEWARD_PENDING_ASKS_MAX）。 */
  private pendingAsks: PendingAsk[] = [];

  constructor(deps: StewardServiceDeps) {
    this.deps = deps;
    this.dialog = deps.dialog ?? new StewardDialogMemory(deps.config);
    this.now = deps.clock ?? (() => Date.now());
    this.registry = new ToolRegistry();
    this.registerTools();
    this.engine = new LoopEngineImpl({
      streamFn: this.streamFn.bind(this),
      registry: this.registry,
      emit: (event) => this.deps.emitLoopEvent?.(event),
      // L1 件一：循环内压缩（loop 域能力，管家首个消费者）——摘要执行体
      // 复用 StewardLlmPort 单轮无工具形态（pi streamSimple 同体），失败
      // 由引擎降级（事件 failed + 原窗口继续，16k 粗裁剪兑底）。
      compaction: {
        thresholdTokens: deps.compaction?.thresholdTokens ?? STEWARD_COMPACTION_THRESHOLD_TOKENS,
        keepRecent: deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT,
        summarize: (messages) => this.summarizeForCompaction(messages),
      },
    });
  }

  /** StewardLlmPort（散参面）→ LoopStreamFn（loop 域契约）包装——application
   *  内零 pi 胶水（pi-ai 真体在 driven adapter；LLM 失败前缀与 warn 与迁移前
   *  行为等价）。 */
  private async streamFn(
    input: Parameters<LoopStreamFn>[0],
    callbacks?: Parameters<LoopStreamFn>[1],
  ): Promise<LoopStreamResult> {
    try {
      return await this.deps.llm.complete(
        {
          systemPrompt: input.systemPrompt,
          messages: input.messages,
          tools: input.tools,
        },
        callbacks?.onDelta, // 文本生成段透传（工具轮 LLM 不产 text 增量 = 天然静默）
        callbacks?.onThinking, // thinking 段级（一个完成态块一帧）
        callbacks?.signal,
        callbacks?.onBlockEnd, // E-198 块级收尾帧（打断 partial 收集面；LoopStreamBlock 与 StewardLlmBlock 结构同构）
      );
    } catch (err) {
      this.deps.logger?.warn(`管家 LLM 调用失败：${(err as Error).message}`);
      throw new Error(`管家模型调用失败：${(err as Error).message}`);
    }
  }

  /**
   * 管家对话一轮（steward.ask 回执；events = 过程回调面——文本增量/
   * thinking 段级/工具开始结束，A1 批工具与 thinking 过程对屏幕通道可见；
   * 工具执行段无文本增量，终态以返回值为权威）。
   * money gate：开关关 → error 判别零 LLM 调用零回调。
   *
   * helix-loop L0：自写 for 循环退役——LoopEngine 驱动（八工具 ToolRegistry
   * 分发 + 确认闸 beforeToolCallPause 暂停点）。
   * L1 件二：忙碌态输入缓冲——在途轮未收口时新 ask 入 pending 队列
   * （上限 3，超限 error 提示）不拒答；本轮收口后自动作为下一轮输入
   * （队列消费在 drain 完成后；abort 语义下队列保留不丢）。回执双帧：
   * queued 确认帧（promise 立即 settle）+ 轮次结果帧（经 deliver 闭包
   * 直达原发起方）。
   */
  async ask(
    text: string,
    events: StewardAskEvents = {},
    deliver?: (payload: StewardAskResultPayload) => void,
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
    // L1 件二：忙碌态入队不拒绝（替代 L0 的 abort-and-drain 取代语义）
    if (this.inFlight !== null) {
      if (this.pendingAsks.length >= STEWARD_PENDING_ASKS_MAX) {
        return {
          status: "error",
          reason: `管家正在处理中，排队已满（上限 ${STEWARD_PENDING_ASKS_MAX} 条）——请稍后再试`,
        };
      }
      this.pendingAsks.push({ text, events, ...(deliver !== undefined ? { deliver } : {}) });
      return { status: "queued", queued: true, position: this.pendingAsks.length };
    }
    return this.runAskPipeline({ text, events, ...(deliver !== undefined ? { deliver } : {}) });
  }

  /** 在途轮 abort（L2 interrupt/barge-in 地基；幂等——非在途态 no-op 返回
   *  false）。abort 只作用 LLM 流式段（工具段不打断）；收口后队列自动
   * 消费（L1 件二序不变量：队列不丢）。 */
  abortInFlight(reason: string): boolean {
    if (this.inFlightAbort === null) return false;
    this.inFlightAbort.abort(reason);
    return true;
  }

  /** 单轮管线（直接路径 promise 即结果；drain 消费路径轮完成经 item.deliver
   *  回执）。收口序：promise settle = drain 完成（KV 写入收尾）→ 队列消费
   *  → 新轮首 KV 写入（写入顺序不变量保持）。 */
  private async runAskPipeline(item: PendingAsk): Promise<StewardAskResultPayload> {
    this.dialog.ensureLoaded();
    // B4a 重启补偿：补判水位后未判定尾部（fire-and-forget——snapshot 同步取定
    // 不含本轮；主钩子覆盖本轮）。
    this.trackSediment(
      this.sedimentUnjudgedTail().catch((err) =>
        this.deps.logger?.warn(`自动沉淀重启补偿降级：${(err as Error).message}`),
      ),
    );
    const userAt = this.now();
    await this.pushRecord({ kind: "user", text: item.text, at: userAt });
    // A2：动态情景快照（每次 ask 组装一次——工具轮内状态变化由工具结果
    // 反映，不重取；感知查询失败静默降级为无快照段，绝不挡对话主链路）。
    // 管家记忆 B1：长期记忆召回段同口径（记忆未启用/召回失败 → 无记忆段）。
    const systemPrompt = assembleStewardSystemPrompt(
      await this.buildSnapshotSafely(),
      await this.deps.memory?.recallSection(item.text),
    );
    const controller = new AbortController();
    const done = this.runAskLoop(item.text, systemPrompt, item.events, controller.signal);
    this.inFlight = done;
    this.inFlightAbort = controller;
    let result: StewardAskResultPayload | undefined;
    try {
      result = await done;
      return result;
    } finally {
      if (this.inFlight === done) {
        this.inFlight = null;
        this.inFlightAbort = null;
      }
      // B4a 主钩子：answer 轮收口 → 异步判定（fire-and-forget 不阻塞 drain；
      // error/confirm_required/aborted 半成品轮不判定）。
      if (result?.status === "answer") this.maybeAutoSediment(item.text, result.text, userAt);
      // L1 件二：drain 完成后自动消费队列（下一轮输入）；abort/error 收口
      // 同样触发——队列保留不丢（duplex-truncation T9 同族序）。
      this.drainPendingAsks();
    }
  }

  /** 队列消费（在途轮收口后）：队首自动开新轮，结果经 item.deliver 回执。 */
  private drainPendingAsks(): void {
    if (this.inFlight !== null || this.pendingAsks.length === 0) return;
    const item = this.pendingAsks.shift()!;
    void this.runAskPipeline(item).then((payload) => {
      item.deliver?.(payload);
    });
  }

  // ── B4a 自动沉淀判定管线（轮次主钩子 + 重启补偿 + 清空兜底三面复用同一内核）──

  /** 在途判定任务集（fire-and-forget 任务的排空面——flushSediment 消费）。 */
  private readonly sedimentTasks = new Set<Promise<void>>();

  private trackSediment(task: Promise<void>): void {
    this.sedimentTasks.add(task);
    const cleanup = () => {
      this.sedimentTasks.delete(task);
    };
    void task.then(cleanup, cleanup);
  }

  /** 判定管线排空（测试面/daemon 关停前防丢在途判定；错误已内核降级，
   *  allSettled 双保险）。 */
  async flushSediment(): Promise<void> {
    await Promise.allSettled([...this.sedimentTasks]);
  }

  /** 判定内核：money 闸（零订阅零判官调用但推水位）→ 判官可用闸（不可用推
   *  水位静默跳过）→ 水位防御 → noul → 低档静默 / 高档挂 memorize 提案 +
   *  sediment_proposal 广播。判官抛错不推水位（下轮重试面）。 */
  private async judgeAndPropose(userText: string, assistantText: string, at: number): Promise<void> {
    if (!this.deps.feedGate.hasStewardSubscribers()) {
      await this.dialog.markJudged(at);
      return;
    }
    const memory = this.deps.memory;
    if (memory === undefined || !memory.judgeSedimentAvailable()) {
      await this.dialog.markJudged(at);
      return;
    }
    if (at <= this.dialog.judgedWatermark()) return; // 已判定（重复触发防御）
    let probability: number;
    try {
      probability = await memory.judgeSediment(`用户：${userText}\n管家：${assistantText}`, SEDIMENT_QUESTION);
    } catch (err) {
      this.deps.logger?.warn(`自动沉淀判定降级（本轮跳过）：${(err as Error).message}`);
      return; // 不推水位——下轮重试
    }
    await this.dialog.markJudged(at);
    if (probability < STEWARD_SEDIMENT_SKIP_THRESHOLD) return;
    const text =
      userText.length > SEDIMENT_CANDIDATE_MAX_CHARS
        ? `${userText.slice(0, SEDIMENT_CANDIDATE_MAX_CHARS)}…`
        : userText;
    this.actionSeq += 1;
    const actionId = `steward-action-${this.actionSeq}`;
    this.pending.set(actionId, {
      action: {
        kind: "memorize",
        displayTarget: "长期记忆",
        message: `沉淀长期记忆：「${text}」`,
        toolCall: { id: "", name: "remember" },
        memorize: { text, kind: "preference", source: "auto-sediment" },
      },
      // resume 缺席——轮外提案无 LoopEngine 暂停点
    });
    this.deps.emitSedimentProposal?.({ actionId, text, kind: "preference" });
  }

  /** 轮次主钩子（runAskPipeline finally；fire-and-forget 不阻塞 drain）。 */
  private maybeAutoSediment(userText: string, assistantText: string, at: number): void {
    this.trackSediment(
      this.judgeAndPropose(userText, assistantText, at).catch((err) =>
        this.deps.logger?.warn(`自动沉淀管线异常：${(err as Error).message}`),
      ),
    );
  }

  /** 未判定尾部补判（重启补偿 + 清空兜底复用；snapshot 同步取定）。 */
  private sedimentUnjudgedTail(): Promise<void> {
    const watermark = this.dialog.judgedWatermark();
    const tail = this.dialog
      .snapshot()
      .filter((r) => r.kind === "user" && r.at > watermark && r.text !== LOOP_INTERRUPTED_MARKER_TEXT); // E-198：截断标记非用户输入不参与判定
    if (tail.length === 0) return Promise.resolve();
    const latest = tail[tail.length - 1]!;
    return this.judgeAndPropose(tail.map((r) => r.text).join("\n"), "", latest.at);
  }

  /** L1 件一：压缩摘要执行体（StewardLlmPort 单轮无工具形态——与主对话
   *  同一 adapter/模型槽位；prompt 要点见 LOOP_COMPACTION_SUMMARY_PROMPT）。
   *  抛错由 LoopEngine 收口为 failed 事件 + 原窗口继续（降级粗裁剪）。 */
  private async summarizeForCompaction(messages: readonly LoopMessage[]): Promise<string> {
    const response = await this.deps.llm.complete({
      systemPrompt: LOOP_COMPACTION_SUMMARY_PROMPT,
      messages: messages as readonly import("../ports/outbound/StewardLlmPort").StewardLlmMessage[],
      tools: [],
    });
    if (response.kind !== "text") {
      throw new Error(`压缩摘要响应非文本（${response.kind}）`);
    }
    return response.text;
  }

  /** 单轮 LoopEngine 驱动（ask 主循环体——含确认闸挂闸闭包与回执映射）。 */
  private async runAskLoop(
    text: string,
    systemPrompt: string,
    events: StewardAskEvents,
    signal: AbortSignal,
  ): Promise<StewardAskResultPayload> {
    // 挂闸闭包状态：当前 pause 的提案候选（actionId + 回执面）——run
    // promise settle paused 后由此构造 confirm_required 回执 + pending 登记。
    // （容器数组绕开 TS 跨闭包赋值窄化限制）
    const pauseCandidate: { actionId: string; action: PendingAction }[] = [];
    const onNewMessage: LoopMessageSink = async (message) => {
      await this.recordLoopMessage(message);
    };
    const beforeToolCallPause = async (ctx: LoopToolCallContext): Promise<LoopPauseDecision> => {
      if (!GATED_TOOLS.has(ctx.toolName)) return { pause: false };
      const gated = await this.gateWriteTool(ctx);
      if (gated.pause) {
        this.actionSeq += 1;
        const actionId = `steward-action-${this.actionSeq}`;
        pauseCandidate.length = 0; // 一次 run 至多一个未决提案（挂闸即收口）
        pauseCandidate.push({
          actionId,
          action: { ...gated.action, toolCall: { id: ctx.toolCallId, name: ctx.toolName } },
        });
        return { pause: true };
      }
      return gated.outcome !== undefined ? { pause: false, outcome: gated.outcome } : { pause: false };
    };
    const run = this.engine.startRun({
      systemPrompt,
      messages: this.dialogSnapshotMessages(),
      tools: this.registry.llmTools(),
      maxRounds: STEWARD_MAX_TOOL_ROUNDS,
      signal,
      beforeToolCallPause,
      onNewMessage,
      // L1 件一：压缩完成同步——KV 整窗替换（[摘要记录, ...尾部滚动窗]）
      // 与引擎窗口替换同步（KV 与 LLM 窗口同源不变量；两空间的尾部保窗
      // 同族口径——buildLlmWindow 占位差异客忍，孤儿两空间各自清理）。
      onCompacted: async (info: LoopCompactionInfo) => {
        await this.dialog.compact(
          { kind: "user", text: info.summaryMessage.text, at: this.now(), compaction: true },
          this.deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT,
        );
      },
      callbacks: {
        ...(events.onDelta !== undefined ? { onDelta: events.onDelta } : {}),
        ...(events.onThinking !== undefined ? { onThinking: events.onThinking } : {}),
        ...(events.onToolStart !== undefined ? { onToolStart: events.onToolStart } : {}),
        ...(events.onToolEnd !== undefined ? { onToolEnd: events.onToolEnd } : {}),
      },
      promptSummary: text.slice(0, 80),
    });
    const result = await run.promise;
    if (result.kind === "finished") {
      return { status: "answer", text: result.text };
    }
    if (result.kind === "paused") {
      const candidate = pauseCandidate[pauseCandidate.length - 1];
      if (candidate === undefined) {
        // 结构性不可达（挂闸必然置候选——防御分支，不静默）
        return { status: "error", reason: "确认闸挂起异常：提案候选缺失" };
      }
      this.pending.set(candidate.actionId, {
        action: candidate.action,
        resume: result.resumeWith,
      });
      return {
        status: "confirm_required",
        actionId: candidate.actionId,
        agentId: candidate.action.displayTarget,
        message: candidate.action.message,
      };
    }
    if (result.kind === "roundLimit") {
      return {
        status: "error",
        reason: `工具循环超限（>${STEWARD_MAX_TOOL_ROUNDS} 轮熔断）——请缩小问题范围或重试`,
      };
    }
    if (result.kind === "aborted") {
      // E-198 audit（I6：丢弃内容日志必留——审计面与模型面分离）
      if (result.audit !== undefined) {
        const dropped =
          result.audit.droppedBlocks.length > 0
            ? `，丢弃 ${result.audit.droppedBlocks.map((b) => `${b.kind}（${b.reason}）`).join("；")}`
            : "";
        this.deps.logger?.warn(
          `管家对话被中断：入账 ${result.audit.keptMessages} 条安全块${dropped}（截断标记已落）`,
        );
      }
      return { status: "error", reason: "管家对话已被中止（abort——可重发；排队中的输入不受影响）" };
    }
    if (result.kind === "resolved") {
      // 结构性不可达（resolved 只在 confirm→resume 轨道收口——ask 轨道防御分支）
      return { status: "error", reason: "管家对话已由确认闸收口" };
    }
    return { status: "error", reason: result.message };
  }

  /** 工作记忆读面（steward.history 回放：完整记录数组——UI 渲染与 LLM 窗口
   *  同源重建；A1 批）。 */
  async getHistory(): Promise<readonly StewardHistoryRecord[]> {
    return this.dialog.snapshot();
  }

  /** 新对话闸（steward.history {clear:true}：KV + daemon LLM 窗口同清——
   *  前端显示由回执空数组同步；A1 批）。pending 确认卡随之作废（自然过期）。
   *  B4a：清空前尾部补判 + 在途判定落定（await——防水位竞态：判定的
   *  markJudged 与 clear 归零序不定会把旧水位拉回新对话致重复判定）。 */
  async clearHistory(): Promise<void> {
    await this.sedimentUnjudgedTail().catch((err) =>
      this.deps.logger?.warn(`自动沉淀清空兜底降级：${(err as Error).message}`),
    );
    await this.flushSediment();
    this.pending.clear();
    await this.dialog.clear();
  }

  /** 确认闸放行（steward.confirm 回执）：单次消费 + 恰一次执行。
   *  A2：动作分派（send / createSession / spawnReview 判别联合）；执行结果
   *  （成败均）回灌工作记忆 toolResult——下一轮 ask LLM 可见真实回执
   *  （同时闭环 buildLlmWindow 配对防御：缺结果 toolCall 不再补合成占位）。
   *  helix-loop L0：回灌经暂停点 resumeWith(resolve) 走 LoopEngine
   *  （run_resumed 事件 + appendToolResult 入账——与迁移前 confirm 直接
   *  pushRecord 等价）。 */
  async confirm(actionId: string): Promise<StewardConfirmResultPayload> {
    const entry = this.pending.get(actionId);
    if (entry === undefined) {
      return { status: "error", reason: `待确认动作不存在或已消费（actionId=${actionId}）` };
    }
    this.pending.delete(actionId); // 先消费（单次语义：执行失败也不可重放）
    const outcome = await this.executePending(entry.action);
    // 回灌经 LoopEngine 暂停点（resolve 决策：toolResult 入账 + run 终结）；
    // B4a 轮外提案无暂停点（resume 缺席）——跳过回灌直接收口。
    if (entry.resume !== undefined) {
      await entry.resume({
        kind: "resolve",
        text: capToolResultText(outcome.detail),
        isError: !outcome.ok,
      });
    }
    if (!outcome.ok) return { status: "error", reason: outcome.detail };
    return { status: "ok", agentId: entry.action.displayTarget, detail: outcome.detail };
  }

  /** 确认闸执行体（单次消费后的真实写动作；detail = 用户与 LLM 共同可见的
   *  回执文本）。驾驶舱批：deliverSession 投递成功 / createSession 建成后
   *  广播 steward.navigate（切页指令——仅成功路径）。 */
  private async executePending(action: PendingAction): Promise<{ ok: boolean; detail: string }> {
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
        this.deps.emitNavigate?.({ sessionId: action.deliverSession!.sessionId }); // 投递成功 → 切页
        return { ok: true, detail: outcome.detail };
      } catch (err) {
        return { ok: false, detail: `投递执行失败：${(err as Error).message}` };
      }
    }
    if (action.kind === "memorize") {
      if (this.deps.memory === undefined) {
        return { ok: false, detail: "记忆面未装配（daemon 装配缺 memory 源）" };
      }
      try {
        const memo = action.memorize!;
        const saved = await this.deps.memory.remember(memo.text, memo.kind, memo.source ?? "steward-turn");
        return {
          ok: true,
          detail: `${saved.updated ? "已更新记忆（语义重复，覆盖原条目）" : "已沉淀长期记忆"}（#${saved.id}）：${memo.text}`,
        };
      } catch (err) {
        return { ok: false, detail: `记忆沉淀失败：${(err as Error).message}` };
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

  /** 设置现态（steward.get_config / set_config 共用读面）。 */
  getConfig(): { enabled: boolean; model: string; memory: import("./StewardMemoryService").StewardMemoryState } {
    return {
      enabled: this.isEnabled(),
      model: this.deps.config.get(STEWARD_MODEL_KEY) ?? this.deps.llm.modelId,
      // 管家记忆 B1：记忆面现态（未装配 = 全降级缺省——开关关/端点空/零条目）
      memory: this.deps.memory?.getMemoryState() ?? {
        enabled: false,
        available: false,
        endpoint: null,
        judgeEndpoint: null,
        entryCount: 0,
        dim: null,
      },
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
      tools: this.registry.manifest(),
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

  /** 人工新增（embed 入库；缺席/失败 → error outcome）。 */
  async appendMemoryEntry(text: string, kind?: "fact" | "preference"): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.deps.memory.appendMemoryEntry(text, kind);
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

  /** 设置写面（两槽位可选更新；model 格式校验 "provider/model-id"；
   *  memory 组 B2 瘦身形态 {enabled?,endpointId?} + B4a judgeEndpointId）。 */
  async setConfig(patch: {
    enabled?: boolean;
    model?: string;
    memory?: { enabled?: boolean; endpointId?: string; judgeEndpointId?: string };
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (patch.memory !== undefined) {
      // 管家记忆 B1：记忆配置委托记忆域服务（校验在其中——开启前端点必填）
      if (this.deps.memory === undefined) {
        return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
      }
      const outcome = await this.deps.memory.setMemoryConfig(patch.memory);
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
    this.registry.register({
      ...TOOL_LIST_INSTANCES,
      handler: async () => {
        // A1-hotfix：list_instances 走紧凑投影（根因实证：status() 全量含完整
        //  task brief 文本与全部历史实例，单条 toolResult 可达 537KB）；一切
        //  工具结果再过 capToolResultText 4000 体量护栏。
        const rows = compactInstanceRows(this.deps.orchestration.status());
        const resultText = capToolResultText(JSON.stringify(rows));
        return {
          kind: "result",
          text: resultText,
          summary: summarizeForFrame(`${rows.length} 条记录：${resultText.slice(0, 80)}`),
        };
      },
    });
    this.registry.register({
      ...TOOL_LIST_TASKS,
      handler: async () => {
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
        const resultText = capToolResultText(JSON.stringify(rows));
        return {
          kind: "result",
          text: resultText,
          summary: summarizeForFrame(`${rows.length} 条记录：${resultText.slice(0, 80)}`),
        };
      },
    });
    this.registry.register({
      ...TOOL_QUERY_RECENT_WORK,
      handler: async (args) => {
        const resultText = capToolResultText(await this.queryRecentWork(args));
        return { kind: "result", text: resultText, summary: summarizeForFrame(resultText.slice(0, 120)) };
      },
    });
    // 写注入四件：handler = approve 决策执行体（重新过闸校验 + 执行——与
    // confirm 的 executePending 同源动作体）
    for (const [tool, actionOf] of [
      [TOOL_PROPOSE_SEND, this.pendingActionOfProposeSend.bind(this)],
      [TOOL_DELIVER_TO_SESSION, this.pendingActionOfDeliverToSession.bind(this)],
      [TOOL_CREATE_SESSION, this.pendingActionOfCreateSession.bind(this)],
      [TOOL_SPAWN_REVIEW_TASK, this.pendingActionOfSpawnReview.bind(this)],
      [TOOL_REMEMBER, this.pendingActionOfRemember.bind(this)],
    ] as const) {
      this.registry.register({
        ...tool,
        handler: async (args) => {
          const gated = await this.gateWriteTool({ runId: "", toolCallId: "", toolName: tool.name, args });
          if (!gated.pause) {
            const outcome = gated.outcome ?? { kind: "result" as const, text: "提案未通过校验（approve 不可达此路径）" };
            return outcome;
          }
          const outcome = await this.executePending(gated.action!);
          return {
            kind: "result",
            text: capToolResultText(outcome.detail),
            isError: !outcome.ok,
            summary: summarizeForFrame(outcome.detail),
          };
        },
      });
    }
    // steward_confirm：面板确认原语（hidden——LLM 不可见；actionId 单次消费
    // 语义与 handler 层 steward.confirm 命令等价）
    this.registry.register({
      name: "steward_confirm",
      description: "确认闸放行（面板确认按钮原语——actionId 单次消费；非 LLM 工具）。",
      parameters: {
        type: "object",
        properties: { actionId: { type: "string", description: "待确认动作 id" } },
        required: ["actionId"],
        additionalProperties: false,
      },
      hiddenFromLlm: true,
      handler: async (args) => {
        const actionId = typeof args.actionId === "string" ? args.actionId : "";
        const outcome = await this.confirm(actionId);
        return {
          kind: "result",
          text: capToolResultText(outcome.status === "ok" ? outcome.detail : outcome.reason),
          isError: outcome.status !== "ok",
        };
      },
    });
  }

  /** LoopMessage → 工作记忆 KV 记录（onNewMessage 持久化回调——空文本兜底
   *  「（无回答）」与迁移前行为等价；user 不经此面，初始窗口注入——唯一
   *  例外：E-198 打断截断标记（engine 侧合成的固定常量 user 消息）。 */
  private async recordLoopMessage(message: LoopMessage): Promise<void> {
    if (message.role === "toolResult") {
      await this.pushRecord({
        kind: "toolResult",
        toolCallId: message.toolCallId,
        name: message.name,
        text: message.text,
        at: this.now(),
      });
      return;
    }
    if (message.role === "user") {
      // E-198 截断标记（engine 打断善后专用通道——固定常量文本，非用户真实
      // 输入；sediment 判定面按常量过滤）
      await this.pushRecord({ kind: "user", text: message.text, at: this.now() });
      return;
    }
    if (message.role === "assistant") {
      const hasToolCall = message.toolCall !== undefined;
      const rawText = message.text ?? "";
      const text = hasToolCall || rawText.trim() !== "" ? rawText : "（无回答）";
      await this.pushRecord({
        kind: "assistant",
        ...(text !== "" || hasToolCall ? { text } : {}),
        ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
        ...(message.toolCall !== undefined ? { toolCall: message.toolCall } : {}),
        at: this.now(),
      });
    }
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
    ctx: LoopToolCallContext,
  ): Promise<{ pause: true; action: PendingAction } | { pause: false; outcome?: LoopToolOutcome }> {
    const { toolName: name, args } = ctx;
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
    if (name === "create_session") {
      const gated = await this.pendingActionOfCreateSession(args);
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    if (name === "spawn_review_task") {
      const gated = await this.pendingActionOfSpawnReview(args);
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    if (name === "remember") {
      const gated = await this.pendingActionOfRemember(args);
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    return { pause: false };
  }

  /** propose_send 提案判定（参数校验 → 运行态校验 → PendingAction）。 */
  private async pendingActionOfProposeSend(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: LoopToolOutcome } | { terminate: true; reason: string }> {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const message = typeof args.message === "string" ? args.message : "";
    if (agentId === "" || message === "") {
      return {
        guidance: true,
        outcome: {
          kind: "result",
          text: capToolResultText("参数缺失：agentId 与 message 必填"),
          summary: "参数缺失：agentId 与 message 必填",
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

  /** deliver_to_session 提案判定（驾驶舱批逻辑平移：参数 → 装配面 → 会话存在性）。 */
  private async pendingActionOfDeliverToSession(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: LoopToolOutcome }> {
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
    return {
      kind: "deliverSession",
      displayTarget: sessionId,
      message: text,
      toolCall: { id: "", name: "deliver_to_session" },
      deliverSession: { sessionId, text },
    };
  }

  /** create_session 提案判定（项目参数校验 → title 缺省生成）。 */
  private async pendingActionOfCreateSession(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: LoopToolOutcome }> {
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
    return {
      kind: "createSession",
      displayTarget: "新会话",
      message: `将创建会话「${title}」`,
      toolCall: { id: "", name: "create_session" },
      createSession: { title },
    };
  }

  /** spawn_review_task 提案判定（review_type → 项目 → git 仓/.kg 索引三道校验）。 */
  private async pendingActionOfSpawnReview(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: LoopToolOutcome }> {
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

  /** remember 提案判定（管家记忆 B1：参数校验 + 可用性前置——记忆未启用
   *  /未配置 → 引导式降级（不挂闸不提案，LLM 拿引导文本转述用户））。 */
  private async pendingActionOfRemember(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: LoopToolOutcome }> {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const kindRaw = args.kind;
    if (text === "") {
      return this.guideOutcome("参数缺失：text 必填（记忆文本）");
    }
    if (kindRaw !== undefined && kindRaw !== "fact" && kindRaw !== "preference") {
      return this.guideOutcome(`kind 非法：${JSON.stringify(kindRaw)}（应为 "fact" 或 "preference"）`);
    }
    const kind = (kindRaw as "fact" | "preference" | undefined) ?? "fact";
    if (this.deps.memory === undefined || !this.deps.memory.isAvailable()) {
      return this.guideOutcome(
        "记忆功能未启用或未配置——本次不沉淀（用户可在 设置 → 通用 → 管家 开启记忆并配置嵌入端点）",
      );
    }
    return {
      kind: "memorize",
      displayTarget: "长期记忆",
      message: `将沉淀${kind === "preference" ? "偏好" : "事实"}：${text}`,
      toolCall: { id: "", name: "remember" },
      memorize: { text, kind },
    };
  }

  /** 引导式工具结果（toolResult 回灌 LLM 循环继续可转述/自纠——迁移前
   *  toolErrorResult 的校验路径产物）。 */
  private guideOutcome(guidance: string): { guidance: true; outcome: LoopToolOutcome } {
    return { guidance: true, outcome: { kind: "result", text: capToolResultText(guidance), summary: summarizeForFrame(guidance) } };
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
        // displayTitle 单源（TR-205 口径 + 动态主题批）：title > topic > firstUserText
        const displayTitle = (r: StewardSessionMetaRow): string => r.title ?? r.topic ?? r.firstUserText ?? "（无主题）";
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

}

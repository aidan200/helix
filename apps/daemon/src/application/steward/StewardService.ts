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
} from "@helix/protocol";
import { StewardDialogMemory } from "./StewardDialogMemory";

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
② 递话：用户想向运行中的 agent 实例传达消息时——调用 propose_send 工具提案；系统会向用户请求确认（确认按钮），用户确认后才执行。每次只提案一条递话。
③ 拒绝越权：
- 不代答工作上下文问题（如「就按刚才聊的改」）——工作上下文留在各会话/agent，请建议用户把话递给持有该上下文的 agent（可提议 propose_send）。
- 不执行未过闸的写操作：唯一写原语 = propose_send，且必须等用户在面板确认后才执行。
- 不伪装用户身份、不代替用户做决策。

你只持有全局状态摘要与自身对话状态；回答用中文，简洁直答。`;

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

/** 动态 system prompt 组装（纯函数导出供单测）：静态人格段 + 快照段；
 *  快照缺席（感知查询失败静默降级）= 原样静态段。 */
export function assembleStewardSystemPrompt(snapshot: string | undefined): string {
  return snapshot === undefined ? STEWARD_SYSTEM_PROMPT : `${STEWARD_SYSTEM_PROMPT}\n\n${snapshot}`;
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
 *  .listSessionMetadata 同形，additive entryCount 消息量级）。 */
export interface StewardSessionMetaRow {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 首条用户消息全文（title 推导源）；无用户消息的持久化会话为 null。 */
  readonly firstUserText: string | null;
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
  readonly logger?: { warn(message: string): void };
}

/** 确认闸目标（面板两行渲染语义重载：send = 递话目标实例；createSession /
 *  spawnReview = 动作标识——见各分支注释）。 */
interface PendingAction {
  readonly kind: "send" | "createSession" | "spawnReview";
  /** 面板确认卡「目标」行显示值（send = agentId；createSession = "新会话"；
   *  spawnReview = "<reviewType>@<project>"）。 */
  readonly displayTarget: string;
  /** 面板确认卡「内容」行显示值（动作摘要全文）。 */
  readonly message: string;
  /** 提案时的工具调用（confirm 执行结果回灌工作记忆的配对锚）。 */
  readonly toolCall: { id: string; name: string };
  /** send 形态载荷。 */
  readonly send?: { agentId: string; message: string };
  /** createSession 形态载荷。 */
  readonly createSession?: { title: string };
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
    "按时间范围查询近期工作（会话清单 + 任务清单；可按项目过滤任务）。回答「最近在忙什么/今天做了什么」类问题时先用本工具取数。",
  parameters: {
    type: "object",
    properties: {
      time_range: {
        type: "string",
        enum: ["today", "yesterday", "this_week", "last_week"],
        description: "时间范围（缺省 this_week）",
      },
      project: { type: "string", description: "项目过滤（可选——仅过滤任务清单）" },
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

const STEWARD_TOOLS: readonly StewardLlmTool[] = [
  TOOL_LIST_INSTANCES,
  TOOL_LIST_TASKS,
  TOOL_QUERY_RECENT_WORK,
  TOOL_PROPOSE_SEND,
  TOOL_CREATE_SESSION,
  TOOL_SPAWN_REVIEW_TASK,
];

export class StewardService {
  private readonly deps: StewardServiceDeps;
  /** 工作记忆 KV（完整记录持久化——thinking/工具/对话全形态；daemon 重启
   *  后懒加载恢复，A1 批取代裸内存数组）。 */
  private readonly dialog: StewardDialogMemory;
  private readonly now: () => number;
  /** 待确认写动作（actionId 单次消费；不持久化——过期即失效不跨重启）。 */
  private readonly pending = new Map<string, PendingAction>();
  private actionSeq = 0;
  private feedSeq = 0;

  constructor(deps: StewardServiceDeps) {
    this.deps = deps;
    this.dialog = deps.dialog ?? new StewardDialogMemory(deps.config);
    this.now = deps.clock ?? (() => Date.now());
  }

  /**
   * 管家对话一轮（steward.ask 回执；events = 过程回调面——文本增量/
   * thinking 段级/工具开始结束，A1 批工具与 thinking 过程对屏幕通道可见；
   * 工具执行段无文本增量，终态以返回值为权威）。
   * money gate：开关关 → error 判别零 LLM 调用零回调。
   */
  async ask(text: string, events: StewardAskEvents = {}): Promise<StewardAskResultPayload> {
    if (typeof text !== "string" || text.trim() === "") {
      return { status: "error", reason: "payload.text 应为非空 string" };
    }
    if (!this.isEnabled()) {
      return {
        status: "error",
        reason: "管家未开启：请在设置页 → 文本管家 区开启开关（开关关 = 零 LLM 调用）",
      };
    }
    this.dialog.ensureLoaded();
    await this.pushRecord({ kind: "user", text, at: this.now() });
    // A2：动态情景快照（每次 ask 组装一次——工具轮内状态变化由工具结果
    // 反映，不重取；感知查询失败静默降级为无快照段，绝不挡对话主链路）。
    const systemPrompt = assembleStewardSystemPrompt(await this.buildSnapshotSafely());
    for (let round = 0; round < STEWARD_MAX_TOOL_ROUNDS; round += 1) {
      let response;
      try {
        response = await this.deps.llm.complete(
          {
            systemPrompt,
            messages: this.dialogSnapshotMessages(),
            tools: STEWARD_TOOLS,
          },
          events.onDelta, // 文本生成段透传（工具轮 LLM 不产 text 增量 = 天然静默）
          events.onThinking, // thinking 段级（一个完成态块一帧）
        );
      } catch (err) {
        this.deps.logger?.warn(`管家 LLM 调用失败：${(err as Error).message}`);
        return { status: "error", reason: `管家模型调用失败：${(err as Error).message}` };
      }
      if (response.kind === "text") {
        const answer = response.text.trim() === "" ? "（无回答）" : response.text;
        await this.pushRecord({
          kind: "assistant",
          text: answer,
          ...(response.thinking !== undefined ? { thinking: response.thinking } : {}),
          at: this.now(),
        });
        return { status: "answer", text: answer };
      }
      // 工具轮：assistant 工具调用（携 thinking）入史 + 执行只读面/过闸提案
      const outcome = await this.runTool(response.id, response.name, response.args, response.thinking, events);
      if (outcome !== undefined) return outcome;
    }
    return {
      status: "error",
      reason: `工具循环超限（>${STEWARD_MAX_TOOL_ROUNDS} 轮熔断）——请缩小问题范围或重试`,
    };
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
  }

  /** 确认闸放行（steward.confirm 回执）：单次消费 + 恰一次执行。
   *  A2：动作分派（send / createSession / spawnReview 判别联合）；执行结果
   *  （成败均）回灌工作记忆 toolResult——下一轮 ask LLM 可见真实回执
   *  （同时闭环 buildLlmWindow 配对防御：缺结果 toolCall 不再补合成占位）。 */
  async confirm(actionId: string): Promise<StewardConfirmResultPayload> {
    const action = this.pending.get(actionId);
    if (action === undefined) {
      return { status: "error", reason: `待确认动作不存在或已消费（actionId=${actionId}）` };
    }
    this.pending.delete(actionId); // 先消费（单次语义：执行失败也不可重放）
    const outcome = await this.executePending(action);
    await this.pushRecord({
      kind: "toolResult",
      toolCallId: action.toolCall.id,
      name: action.toolCall.name,
      text: capToolResultText(outcome.detail),
      at: this.now(),
    });
    if (!outcome.ok) return { status: "error", reason: outcome.detail };
    return { status: "ok", agentId: action.displayTarget, detail: outcome.detail };
  }

  /** 确认闸执行体（单次消费后的真实写动作；detail = 用户与 LLM 共同可见的
   *  回执文本）。 */
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
        return { ok: true, detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」` };
      } catch (err) {
        return { ok: false, detail: `会话创建失败：${(err as Error).message}` };
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
  getConfig(): { enabled: boolean; model: string } {
    return {
      enabled: this.isEnabled(),
      model: this.deps.config.get(STEWARD_MODEL_KEY) ?? this.deps.llm.modelId,
    };
  }

  /** 设置写面（两槽位可选更新；model 格式校验 "provider/model-id"）。 */
  async setConfig(patch: { enabled?: boolean; model?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
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

  /** 执行单轮工具调用；返回非 undefined = 终止循环直出回执（提案/失败）。
   *  过程可见（A1 批）：onToolStart/onToolEnd 回调携摘要——屏幕通道
   *  （TTS 播报链路零接入——耳朵只听 assistant 结论）。 */
  private async runTool(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    thinking: StewardLlmThinking | undefined,
    events: StewardAskEvents,
  ): Promise<StewardAskResultPayload | undefined> {
    const argsSummary = summarizeForFrame(JSON.stringify(args));
    if (name === "list_instances" || name === "list_tasks") {
      // A1-hotfix：list_instances 走紧凑投影（根因实证：status() 全量含完整
      //  task brief 文本与全部历史实例，单条 toolResult 可达 537KB）；一切
      //  工具结果再过 capToolResultText 4000 体量护栏。
      const rows =
        name === "list_instances"
          ? compactInstanceRows(this.deps.orchestration.status())
          : this.deps.tasks.listTasks({}).map((t) => ({
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
      events.onToolStart?.(name, argsSummary);
      await this.pushRecord({
        kind: "assistant",
        ...(thinking !== undefined ? { thinking } : {}),
        toolCall: { id: callId, name, args },
        at: this.now(),
      });
      await this.pushRecord({ kind: "toolResult", toolCallId: callId, name, text: resultText, at: this.now() });
      events.onToolEnd?.(name, summarizeForFrame(`${rows.length} 条记录：${resultText.slice(0, 80)}`));
      return undefined;
    }
    if (name === "propose_send") {
      const agentId = typeof args.agentId === "string" ? args.agentId : "";
      const message = typeof args.message === "string" ? args.message : "";
      if (agentId === "" || message === "") {
        events.onToolStart?.(name, argsSummary);
        await this.pushRecord({
          kind: "assistant",
          ...(thinking !== undefined ? { thinking } : {}),
          toolCall: { id: callId, name, args },
          at: this.now(),
        });
        await this.pushRecord({
          kind: "toolResult",
          toolCallId: callId,
          name,
          text: capToolResultText("参数缺失：agentId 与 message 必填"),
          at: this.now(),
        });
        events.onToolEnd?.(name, "参数缺失：agentId 与 message 必填");
        return undefined;
      }
      // 提案校验：目标须存在且运行中（防火墙前置——终态实例递话必拒）
      const running = this.deps.orchestration.status(agentId).some((s) => s.state === "running");
      if (!running) {
        return { status: "error", reason: `实例 ${agentId} 不存在或非运行中——递话提案拒绝（可让用户确认实例 id）` };
      }
      this.actionSeq += 1;
      const actionId = `steward-action-${this.actionSeq}`;
      this.pending.set(actionId, {
        kind: "send",
        displayTarget: agentId,
        message,
        toolCall: { id: callId, name },
        send: { agentId, message },
      });
      events.onToolStart?.(name, argsSummary);
      await this.pushRecord({
        kind: "assistant",
        ...(thinking !== undefined ? { thinking } : {}),
        toolCall: { id: callId, name, args },
        at: this.now(),
      });
      // 确认闸：不执行、不入工具结果（对话挂起待用户裁决——confirm 后执行结果
      // 回灌工作记忆，用户可继续新 ask）
      return { status: "confirm_required", actionId, agentId, message };
    }
    if (name === "query_recent_work") {
      const resultText = capToolResultText(await this.queryRecentWork(args));
      events.onToolStart?.(name, argsSummary);
      await this.pushRecord({
        kind: "assistant",
        ...(thinking !== undefined ? { thinking } : {}),
        toolCall: { id: callId, name, args },
        at: this.now(),
      });
      await this.pushRecord({ kind: "toolResult", toolCallId: callId, name, text: resultText, at: this.now() });
      events.onToolEnd?.(name, summarizeForFrame(resultText.slice(0, 120)));
      return undefined;
    }
    if (name === "create_session") {
      const outcome = await this.proposeCreateSession(callId, name, args, thinking, events, argsSummary);
      return outcome;
    }
    if (name === "spawn_review_task") {
      const outcome = await this.proposeSpawnReview(callId, name, args, thinking, events, argsSummary);
      return outcome;
    }
    // 未知工具（wire 防御）：toolResult 报错回灌，循环继续（模型可自纠）
    events.onToolStart?.(name, argsSummary);
    await this.pushRecord({
      kind: "assistant",
      ...(thinking !== undefined ? { thinking } : {}),
      toolCall: { id: callId, name, args },
      at: this.now(),
    });
    await this.pushRecord({ kind: "toolResult", toolCallId: callId, name, text: capToolResultText(`未知工具 ${name}`), at: this.now() });
    events.onToolEnd?.(name, `未知工具 ${name}`);
    return undefined;
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
          title: r.firstUserText ?? "（无主题会话）",
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
    const win = timeRangeWindow(range, this.now());
    const inWindow = (iso: string): boolean => {
      const t = Date.parse(iso);
      return !Number.isNaN(t) && t >= win.sinceMs && t < win.untilMs;
    };
    const sessionLines: string[] = [];
    let sessionTotal = 0;
    if (this.deps.sessions !== undefined) {
      try {
        const rows = (await this.deps.sessions.listSessionMetadata()).filter((r) => inWindow(r.updatedAt));
        sessionTotal = rows.length;
        for (const r of rows.slice(0, RECENT_WORK_LINES_MAX)) {
          const title = capChars(r.firstUserText ?? "（无主题）", RECENT_WORK_TITLE_MAX_CHARS);
          const scale = r.entryCount === null ? "" : ` · 约${r.entryCount}条消息`;
          sessionLines.push(`「${title}」${fmtWhen(r.createdAt)}~${fmtWhen(r.updatedAt)}${scale}`);
        }
        if (rows.length > RECENT_WORK_LINES_MAX) {
          sessionLines.push(`…另有 ${rows.length - RECENT_WORK_LINES_MAX} 个会话未列出`);
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
    if (sessionTotal === 0 && taskRows.length === 0) {
      return `${win.zhLabel}（${win.label}）范围内无记录——没有会话与任务活动`;
    }
    const parts: string[] = [`【会话·${sessionTotal}】`];
    parts.push(...(sessionLines.length > 0 ? sessionLines : ["（无）"]));
    parts.push(`【任务·${taskRows.length}${project !== undefined ? ` · 项目 ${project}` : ""}】`);
    parts.push(...(taskLines.length > 0 ? taskLines : ["（无）"]));
    return parts.join("\n");
  }

  // ── A2：create_session / spawn_review_task 提案 ──────

  /** create_session 提案（确认闸）：项目参数（若给）先做存在性校验；
   *  title 缺省自动生成（含时间；项目名织入标题）。 */
  private async proposeCreateSession(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    thinking: StewardLlmThinking | undefined,
    events: StewardAskEvents,
    argsSummary: string,
  ): Promise<StewardAskResultPayload | undefined> {
    const titleRaw = typeof args["title"] === "string" ? args["title"].trim() : "";
    const project = typeof args["project"] === "string" && args["project"] !== "" ? args["project"] : undefined;
    const guidance = this.checkProjectArg(project);
    if (guidance !== undefined) {
      return this.toolErrorResult(callId, name, args, thinking, events, argsSummary, guidance);
    }
    if (this.deps.sessions === undefined) {
      return this.toolErrorResult(callId, name, args, thinking, events, argsSummary, "会话创建面未装配——无法创建会话（请让用户在侧栏新建）");
    }
    const now = new Date(this.now());
    const p2 = (n: number) => String(n).padStart(2, "0");
    const title =
      titleRaw !== ""
        ? titleRaw
        : `${project !== undefined ? `${project} ` : ""}新会话 ${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    this.actionSeq += 1;
    const actionId = `steward-action-${this.actionSeq}`;
    this.pending.set(actionId, {
      kind: "createSession",
      displayTarget: "新会话",
      message: `将创建会话「${title}」`,
      toolCall: { id: callId, name },
      createSession: { title },
    });
    events.onToolStart?.(name, argsSummary);
    await this.pushRecord({
      kind: "assistant",
      ...(thinking !== undefined ? { thinking } : {}),
      toolCall: { id: callId, name, args },
      at: this.now(),
    });
    return { status: "confirm_required", actionId, agentId: "新会话", message: `将创建会话「${title}」` };
  }

  /** spawn_review_task 提案（前置校验 + 确认闸）：项目存在性 / git 仓 /
   *  .kg 索引三道引导式校验（失败 toolResult 回灌 LLM 可转述追问）。 */
  private async proposeSpawnReview(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    thinking: StewardLlmThinking | undefined,
    events: StewardAskEvents,
    argsSummary: string,
  ): Promise<StewardAskResultPayload | undefined> {
    const reviewTypeRaw = args["review_type"];
    const project = typeof args["project"] === "string" ? args["project"].trim() : "";
    const params =
      typeof args["params"] === "object" && args["params"] !== null && !Array.isArray(args["params"])
        ? (args["params"] as Record<string, unknown>)
        : {};
    if (reviewTypeRaw !== "code-review" && reviewTypeRaw !== "kg-review") {
      return this.toolErrorResult(
        callId, name, args, thinking, events, argsSummary,
        `review_type 非法：${JSON.stringify(reviewTypeRaw)}（应为 "code-review" 或 "kg-review"）`,
      );
    }
    const reviewType = reviewTypeRaw;
    if (project === "") {
      return this.toolErrorResult(callId, name, args, thinking, events, argsSummary, "参数缺失：project 必填（目标项目名）");
    }
    const root = this.deps.projects?.resolve(project);
    if (root === undefined) {
      const known = "（项目解析面未装配，无法校验项目存在性）";
      return this.toolErrorResult(
        callId, name, args, thinking, events, argsSummary,
        this.deps.projects === undefined
          ? `无法校验项目 ${project}${known}`
          : `项目 ${project} 不在当前 workspace——请与用户确认项目名（可用清单中的项目）`,
      );
    }
    if (reviewType === "code-review" && this.deps.hasGitRepo !== undefined && !this.deps.hasGitRepo(root)) {
      return this.toolErrorResult(
        callId, name, args, thinking, events, argsSummary,
        `项目 ${project} 无 git 仓（${root}）——没有可评审的代码，需先初始化仓库`,
      );
    }
    if (reviewType === "kg-review" && this.deps.projects !== undefined && !this.deps.projects.hasIndex(root)) {
      return this.toolErrorResult(
        callId, name, args, thinking, events, argsSummary,
        `项目 ${project} 未建知识图谱——需先 kg-bootstrap（我可以帮你创建该任务）`,
      );
    }
    this.actionSeq += 1;
    const actionId = `steward-action-${this.actionSeq}`;
    const message = `将对项目 ${project} 发起 ${reviewType}`;
    this.pending.set(actionId, {
      kind: "spawnReview",
      displayTarget: `${reviewType}@${project}`,
      message,
      toolCall: { id: callId, name },
      spawnReview: { reviewType, project, params },
    });
    events.onToolStart?.(name, argsSummary);
    await this.pushRecord({
      kind: "assistant",
      ...(thinking !== undefined ? { thinking } : {}),
      toolCall: { id: callId, name, args },
      at: this.now(),
    });
    return { status: "confirm_required", actionId, agentId: `${reviewType}@${project}`, message };
  }

  /** 项目参数校验（create_session 的可选 project；undefined = 无参数直过）。 */
  private checkProjectArg(project: string | undefined): string | undefined {
    if (project === undefined || this.deps.projects === undefined) return undefined;
    if (this.deps.projects.resolve(project) === undefined) {
      return `项目 ${project} 不在当前 workspace——请与用户确认项目名`;
    }
    return undefined;
  }

  /** 引导式工具错误（toolResult 回灌，LLM 循环继续可转述/自纠）。 */
  private async toolErrorResult(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    thinking: StewardLlmThinking | undefined,
    events: StewardAskEvents,
    argsSummary: string,
    guidance: string,
  ): Promise<undefined> {
    events.onToolStart?.(name, argsSummary);
    await this.pushRecord({
      kind: "assistant",
      ...(thinking !== undefined ? { thinking } : {}),
      toolCall: { id: callId, name, args },
      at: this.now(),
    });
    await this.pushRecord({ kind: "toolResult", toolCallId: callId, name, text: capToolResultText(guidance), at: this.now() });
    events.onToolEnd?.(name, summarizeForFrame(guidance));
    return undefined;
  }
}

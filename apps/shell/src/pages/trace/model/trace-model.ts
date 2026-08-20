/**
 * P-1 TracePage 页面私有状态模型（CL-5；T2.2）。
 *
 * 职责：
 * - 五态互斥状态机（idle/loading/error/empty/success；断连 overlay 正交——
 *   conn 由组件从会话门面派生，不进本模型；review.md 状态模型）；
 * - 单飞 + filterEcho 并发一致性（AF-5：pending 记录期望回显，不匹配即丢弃，
 *   不加 requestId）；
 * - 组合过滤三维（实例/类型类目/时间范围）→ trace.query payload 构造
 *   （类型 chip 原型 8 类目映射真实 DomainEventType 全集；时间窗参考零点 =
 *   会话最新事件 ts，换算绝对窗口下推 daemon，前端不本地过滤）；
 * - 分页 beforeId 游标（PAGE_SIZE 步进；追加按 id 去重；恰整除末页空载收口
 *   沿契约口径）；筛选变更重置游标/展开/提示词折叠；
 * - 上下文卡 fold：变更轨迹（modelTimeline + compaction 里程碑 ts 升序合并、
 *   当前模型高亮）、实例面板名称/起止 fold、事件摘要与类目。
 *
 * 纯函数纪律（AG-14 同规）：无 React / 无 IO / 无 Date.now——参考零点来自
 * state.latestEventTs（最近一次无筛选 fresh 结果的 rows[0].ts），运行中实例
 * 时长参考点由组件注入。
 */
import type {
  TraceEventRow,
  TraceInstanceRecord,
  TraceQueryFilterEcho,
  TraceQueryPayload,
} from "@helix/protocol";

/** 查询分页步进（契约缺省 limit=50 同值；显式发送保证 filterEcho 可比对）。 */
export const TRACE_PAGE_SIZE = 50;

/** 时间范围档位（秒；null = 全部时间）。 */
export const TRACE_RANGE_OPTIONS: readonly (number | null)[] = [null, 3600, 900, 300];

// ── 类型 chips（原型 8 类目 → 真实 DomainEventType 映射）────

export interface TraceTypeCategory {
  /** chip 展示名（原型词汇，mono 字面量非 i18n）。 */
  key: string;
  /** 类目覆盖的领域事件类型（domain_events.type 真值）。 */
  types: readonly string[];
}

/**
 * 原型 P-1 的 8 枚类型 chip 与 daemon DomainEventType 全集（22）的映射
 * （表现层类目 → 查询下推的 concrete types）。lifecycle 聚合轮次/编排/steer
 * 生命周期族。
 */
export const TRACE_TYPE_CATEGORIES: readonly TraceTypeCategory[] = [
  { key: "message", types: ["message.completed"] },
  { key: "tool", types: ["tool.call.started", "tool.call.result"] },
  { key: "thinking", types: ["thinking.completed"] },
  { key: "usage", types: ["usage.recorded"] },
  {
    key: "lifecycle",
    types: [
      "turn.started",
      "turn.completed",
      "turn.interrupted",
      "steer.queued",
      "steer.drained",
      "agent.state.changed",
      "agent.spawned",
      "agent.queued",
      "agent.started",
      "agent.stalled",
      "agent.completed",
      "agent.failed",
      "agent.killed",
      "agent.instantiated",
    ],
  },
  { key: "engine.error", types: ["engine.error"] },
  { key: "compaction.completed", types: ["compaction.completed"] },
  { key: "model.changed", types: ["agent.model.changed"] },
];

/** 全类型清单（类目全集 flat；null 过滤的展开形态）。 */
export const ALL_TRACE_TYPES: readonly string[] = TRACE_TYPE_CATEGORIES.flatMap((c) => c.types);

/** 类目选中判定：null = 全选；否则类目全部 types 均在清单内。 */
export function isCategoryOn(types: readonly string[] | null, cat: TraceTypeCategory): boolean {
  return types === null || cat.types.every((t) => types.includes(t));
}

/**
 * 类目 toggle：null（全选）起点展开为全清单再减/加；全覆盖归一 null
 * （缺省语义）；空集保留（契约：types=[] = 空结果显式语义）。
 */
export function toggleTypeCategory(
  current: readonly string[] | null,
  cat: TraceTypeCategory,
): string[] | null {
  const base = current === null ? [...ALL_TRACE_TYPES] : [...current];
  const on = cat.types.every((t) => base.includes(t));
  const next = on
    ? base.filter((t) => !cat.types.includes(t))
    : [...new Set([...base, ...cat.types])];
  if (next.length === 0) return [];
  if (next.length === ALL_TRACE_TYPES.length) return null;
  return next;
}

// ── 查询构造（payload + 期望 filterEcho 同产，防手写漂移）───

export interface TraceFilter {
  sessionId: string;
  /** null = 全部实例（混排视图）。 */
  instanceId: string | null;
  /** null = 全部类型；[] = 空结果（契约显式语义）。 */
  types: string[] | null;
  /** 秒；null = 全部时间。 */
  rangeSec: number | null;
}

export interface BuiltTraceQuery {
  payload: TraceQueryPayload;
  /** 期望回显（与 daemon normalize 口径同构：缺省维 null，page.limit 显式）。 */
  echo: TraceQueryFilterEcho;
}

/**
 * 构造 trace.query：三维过滤下推（前端不本地过滤）；时间窗参考零点 =
 * latestEventTs（会话最新事件 ts，含起含止：to = 零点本身）；零点未知
 * （尚无全量结果）时不下推时间窗（退化为全量，避免错误窗口）。
 */
export function buildTraceQuery(
  filter: TraceFilter,
  latestEventTs: string | null,
  beforeId: number | null,
): BuiltTraceQuery {
  let timeRange: { from: string; to: string } | undefined;
  if (filter.rangeSec !== null && latestEventTs !== null) {
    const toMs = Date.parse(latestEventTs);
    timeRange = { from: new Date(toMs - filter.rangeSec * 1000).toISOString(), to: latestEventTs };
  }
  const payload: TraceQueryPayload = {
    sessionId: filter.sessionId,
    ...(filter.instanceId !== null ? { instanceIds: [filter.instanceId] } : {}),
    ...(filter.types !== null ? { types: [...filter.types] } : {}),
    ...(timeRange !== undefined ? { timeRange } : {}),
    page: { limit: TRACE_PAGE_SIZE, ...(beforeId !== null ? { beforeId } : {}) },
  };
  const echo: TraceQueryFilterEcho = {
    sessionId: filter.sessionId,
    instanceIds: filter.instanceId !== null ? [filter.instanceId] : null,
    agentKind: null,
    types: filter.types !== null ? [...filter.types] : null,
    timeRange: timeRange !== undefined ? { from: timeRange.from, to: timeRange.to } : null,
    page: { limit: TRACE_PAGE_SIZE, beforeId },
  };
  return { payload, echo };
}

function setEquals(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** filterEcho 匹配（AF-5 单飞去抖）：数组维集合语义（顺序漂移不构成不匹配）。 */
export function echoMatches(expected: TraceQueryFilterEcho, actual: TraceQueryFilterEcho): boolean {
  const tr = (t: TraceQueryFilterEcho["timeRange"]) =>
    t === null ? null : `${t.from ?? ""}|${t.to ?? ""}`;
  return (
    expected.sessionId === actual.sessionId &&
    setEquals(expected.instanceIds, actual.instanceIds) &&
    expected.agentKind === actual.agentKind &&
    setEquals(expected.types, actual.types) &&
    tr(expected.timeRange) === tr(actual.timeRange) &&
    expected.page.limit === actual.page.limit &&
    expected.page.beforeId === actual.page.beforeId
  );
}

// ── 事件摘要与类目（表格行文本；payload 防御性提取）────────

export type TraceCategoryKey =
  | "message"
  | "tool"
  | "thinking"
  | "usage"
  | "lifecycle"
  | "engine.error"
  | "compaction"
  | "model";

/** 事件类型 → 展示类目（tt 徽标着色 / chip 词汇同源）。 */
export function categoryOfType(type: string): TraceCategoryKey {
  switch (type) {
    case "message.completed":
      return "message";
    case "tool.call.started":
    case "tool.call.result":
      return "tool";
    case "thinking.completed":
      return "thinking";
    case "usage.recorded":
      return "usage";
    case "engine.error":
      return "engine.error";
    case "compaction.completed":
      return "compaction";
    case "agent.model.changed":
      return "model";
    default:
      return "lifecycle";
  }
}

const asRec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const asStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function truncateText(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function fmtNum(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 行摘要（原型 summaryHtml 的数据驱动版；纯文本，着色归类目徽标）。 */
export function summarizeTraceEvent(row: TraceEventRow): string {
  const p = asRec(row.payload);
  switch (row.type) {
    case "message.completed": {
      const role = asStr(p.role) ?? "?";
      const text = asStr(p.text);
      return text !== null ? `${role} · ${truncateText(text)}` : role;
    }
    case "tool.call.started":
      return `call · ${asStr(p.toolName) ?? "?"}`;
    case "tool.call.result":
      return `result · ${asStr(p.toolName) ?? "?"}${p.isError === true ? " · error" : ""}`;
    case "thinking.completed": {
      const text = asStr(p.text);
      return text !== null ? truncateText(text) : row.type;
    }
    case "usage.recorded": {
      const input = asNum(p.input);
      const output = asNum(p.output);
      const cost = asNum(p.cost);
      if (input === null || output === null) return row.type;
      return `in ${fmtNum(input)} / out ${fmtNum(output)} tok${cost !== null ? ` · $${cost.toFixed(4)}` : ""}`;
    }
    case "engine.error": {
      const provider = asStr(p.provider);
      const model = asStr(p.model);
      const status = asNum(p.status);
      const message = asStr(p.message) ?? "";
      const head = provider !== null && model !== null ? `${provider}/${model}` : null;
      const tail = [status !== null ? String(status) : null, message]
        .filter((x) => x !== null && x !== "")
        .join(" ");
      return [head, tail].filter((x) => x !== null && x !== "").join(" · ");
    }
    case "compaction.completed": {
      const before = asNum(p.tokensBefore);
      const after = asNum(p.tokensAfter);
      return before !== null && after !== null
        ? `compaction · ${fmtNum(before)} → ${fmtNum(after)} tok`
        : row.type;
    }
    case "agent.model.changed": {
      const from = asStr(p.from);
      const to = asStr(p.to);
      return from !== null && to !== null ? `${from} → ${to}` : row.type;
    }
    case "agent.instantiated": {
      const kind = asStr(p.profileKind);
      return kind !== null ? `agent.instantiated · ${kind}` : row.type;
    }
    case "agent.spawned": {
      const id = asStr(p.instanceId);
      return id !== null ? `agent.spawn · ${id}` : row.type;
    }
    case "agent.completed":
    case "agent.failed":
    case "agent.killed": {
      const reason = asStr(p.reason);
      return reason !== null ? `${row.type} · ${truncateText(reason, 48)}` : row.type;
    }
    case "steer.queued":
    case "steer.drained": {
      const text = asStr(p.text);
      return text !== null ? `steer · ${truncateText(text, 48)}` : row.type;
    }
    case "agent.state.changed": {
      const st = asStr(p.state);
      return st !== null ? `agent.state → ${st}` : row.type;
    }
    default:
      return row.type;
  }
}

// ── 上下文卡 fold（AD-6 双段）──────────────────────────────

export interface TraceTimelineRow {
  at: string;
  kind: "model" | "compaction";
  from?: string;
  to?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  /** 当前生效模型行（modelTimeline 末条；契约口径 = currentModel）。 */
  current: boolean;
}

export interface TraceCompactionMilestone {
  at: string;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * 变更轨迹 fold：模型时间线（instance record 的 modelTimeline，契约已按 ts
 * 升序）+ compaction 里程碑（来自已加载事件页——契约无实例级 compaction
 * fold，记录在案）按 ts 升序合并；末条 model 变更 = 当前生效值高亮。
 */
export function buildTimelineRows(
  record: TraceInstanceRecord,
  compactions: readonly TraceCompactionMilestone[],
): TraceTimelineRow[] {
  const models: TraceTimelineRow[] = (record.modelTimeline ?? []).map((m, i, arr) => ({
    at: m.at,
    kind: "model",
    from: m.from,
    to: m.to,
    current: i === arr.length - 1,
  }));
  const comps: TraceTimelineRow[] = compactions.map((c) => ({
    at: c.at,
    kind: "compaction",
    tokensBefore: c.tokensBefore,
    tokensAfter: c.tokensAfter,
    current: false,
  }));
  return [...models, ...comps].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ── 实例面板 fold ──────────────────────────────────────────

/** 实例显示名：主 = 本地化 mainName；Sub = task 截断（24 字符）；无 task 退化 id。 */
export function instanceDisplayName(rec: TraceInstanceRecord, mainName: string): string {
  if (rec.agentKind === "main") return mainName;
  if (typeof rec.task === "string" && rec.task !== "") {
    return rec.task.length > 24 ? `${rec.task.slice(0, 24)}…` : rec.task;
  }
  return rec.instanceId;
}

export interface InstanceTimes {
  startMs: number | null;
  endMs: number | null;
  /** 终态 = endedAt - startedAt；running = refMs - startedAt（参考点注入）。 */
  durationMs: number | null;
}

/** 起止 fold（原型 timeLine 口径：running 的时长相对参考点——会话最新事件/now）。 */
export function instanceTimes(rec: TraceInstanceRecord, refMs: number): InstanceTimes {
  const startMs = typeof rec.startedAt === "string" ? Date.parse(rec.startedAt) : NaN;
  if (!Number.isFinite(startMs)) return { startMs: null, endMs: null, durationMs: null };
  const endMs = typeof rec.endedAt === "string" ? Date.parse(rec.endedAt) : NaN;
  if (Number.isFinite(endMs)) {
    return { startMs, endMs, durationMs: Math.max(0, endMs - startMs) };
  }
  return { startMs, endMs: null, durationMs: Math.max(0, refMs - startMs) };
}

// ── 页面私有 reducer（五态互斥 + 单飞 + 分页 + 手风琴）──────

export type TraceView = "idle" | "loading" | "error" | "empty" | "success";
export type TraceEmptyFlavor = "session" | "filtered";

export interface TracePageState {
  filter: TraceFilter;
  view: TraceView;
  emptyFlavor: TraceEmptyFlavor;
  errorReason: string | null;
  /** 实例面板摘要块（会话级 fold，AF-5：不受事件过滤维影响）。 */
  instances: TraceInstanceRecord[];
  /** 已累积事件页（id 降序拼接）。 */
  events: TraceEventRow[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** 手风琴单开（事件 id）。 */
  openId: number | null;
  promptOpen: boolean;
  /** 在途查询的期望回显（单飞；null = 无在途）。 */
  pending: TraceQueryFilterEcho | null;
  /** 时间窗参考零点（最近一次无筛选 fresh 结果的 rows[0].ts）。 */
  latestEventTs: string | null;
}

export function createTracePageState(): TracePageState {
  return {
    filter: { sessionId: "", instanceId: null, types: null, rangeSec: null },
    view: "idle",
    emptyFlavor: "session",
    errorReason: null,
    instances: [],
    events: [],
    total: 0,
    hasMore: false,
    loadingMore: false,
    openId: null,
    promptOpen: false,
    pending: null,
    latestEventTs: null,
  };
}

export type TraceAction =
  | {
      type: "query-started";
      filter: TraceFilter;
      echo: TraceQueryFilterEcho;
      /** session = 切会话（连 instances/参考零点清）；filter = 同会话筛选变更（面板保留防闪烁）。 */
      scope: "session" | "filter";
    }
  | { type: "page-started"; echo: TraceQueryFilterEcho }
  | {
      type: "query-result";
      echo: TraceQueryFilterEcho;
      instances: TraceInstanceRecord[];
      rows: TraceEventRow[];
      page: { loaded: number; total: number; hasMore: boolean };
    }
  | { type: "query-failed"; reason: string }
  | { type: "toggle-row"; id: number }
  | { type: "toggle-prompt" };

/** 展示视图（五态互斥状态机的当前态）。 */
export function selectTraceView(s: TracePageState): TraceView {
  return s.view;
}

function isUnfilteredEcho(echo: TraceQueryFilterEcho): boolean {
  return echo.instanceIds === null && echo.types === null && echo.timeRange === null;
}

export function traceReducer(s: TracePageState, a: TraceAction): TracePageState {
  switch (a.type) {
    case "query-started":
      // 转换规则：任何新查询先清旧态（error/empty/success 一律归零）再进 loading
      return {
        ...s,
        filter: a.filter,
        view: "loading",
        errorReason: null,
        events: [],
        total: 0,
        hasMore: false,
        loadingMore: false,
        openId: null,
        promptOpen: false,
        pending: a.echo,
        instances: a.scope === "session" ? [] : s.instances,
        latestEventTs: a.scope === "session" ? null : s.latestEventTs,
      };
    case "page-started":
      return { ...s, loadingMore: true, pending: a.echo };
    case "query-result": {
      // 单飞：无在途 / echo 不匹配的迟到结果一律丢弃
      if (s.pending === null || !echoMatches(s.pending, a.echo)) return s;
      const append = a.echo.page.beforeId !== null;
      const events = append ? appendRows(s.events, a.rows) : a.rows;
      const next: TracePageState = {
        ...s,
        pending: null,
        loadingMore: false,
        errorReason: null,
        instances: a.instances,
        events,
        total: a.page.total,
        hasMore: a.page.hasMore,
      };
      if (append) return next; // 追加不收口视图态（保持 success）
      if (!append && isUnfilteredEcho(a.echo) && a.rows.length > 0) {
        next.latestEventTs = a.rows[0]!.ts; // 参考零点 = 会话最新事件 ts
      }
      if (a.page.total === 0) {
        next.view = "empty";
        next.emptyFlavor = isUnfilteredEcho(a.echo) ? "session" : "filtered";
      } else {
        next.view = "success";
      }
      return next;
    }
    case "query-failed": {
      if (s.pending === null) return s;
      if (s.loadingMore) {
        // 追加失败：保持已加载内容，仅清在途（视图不中断）
        return { ...s, pending: null, loadingMore: false };
      }
      return { ...s, pending: null, view: "error", errorReason: a.reason };
    }
    case "toggle-row":
      return { ...s, openId: s.openId === a.id ? null : a.id };
    case "toggle-prompt":
      return { ...s, promptOpen: !s.promptOpen };
    default:
      return s;
  }
}

/** 追加拼接：按 id 去重（防御重叠页），保持到达序（id 降序）。 */
function appendRows(prev: readonly TraceEventRow[], rows: readonly TraceEventRow[]): TraceEventRow[] {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...rows.filter((r) => !seen.has(r.id))];
}

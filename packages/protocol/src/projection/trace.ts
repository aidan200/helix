/**
 * trace 投影域 —— trace 查询归一 / 分页判据 / 事件页过滤纯函数
 * （iter-20260821-dg90 T3.1 / M4 投资批，CL-4；迁自 daemon domain/trace/
 * TraceQuery.ts normalize/hasMoreBefore 段 + fake-transport 过滤分页段——
 * 原「逐条镜像」双实现单源化）。
 *
 * 消费面：
 * - daemon：SqliteTraceQueryAdapter 入口调 normalizeTraceQuery（校验收口
 *   在实现类入口，§3.5b「调仓储前」；driven adapter import protocol 先例），
 *   校验失败抛 TraceQueryInvalidError → driving 侧映射
 *   command.invalid_payload 回执（message 透传）；
 * - shell fake-transport：normalize + pageTraceEvents 直调（镜像段退役）。
 *
 * 错误通道（F-6④ 选边落定）：协议自有 TraceQueryInvalidError 单源
 * （message 中文，与 daemon 原 DomainError 版逐字一致——消费面正则断言
 * 零改动）；daemon domain 侧类型面（NormalizedTraceQuery）经形状同构对应
 * 保留（TR-AD-3 既有模式）。
 *
 * 纯数据进纯数据出（无 IO / framework-free）。
 */
import type { TraceEventRow } from "../types/trace";

/** 分页缺省与上限（契约 v0.4 §1.2：缺省 50，上限鉗制 200 不报错）。 */
export const TRACE_PAGE_DEFAULT = 50;
export const TRACE_PAGE_MAX = 200;

/** 归一后的查询（= 结果帧 filterEcho 形态；缺省维归一 null）。 */
export interface NormalizedTraceQuery {
  readonly sessionId: string;
  /** null = 全部实例（缺省）；空数组 = 空结果（显式语义）。 */
  readonly instanceIds: readonly string[] | null;
  readonly agentKind: "main" | "subagent" | null;
  /** null = 全部类型（缺省）；空数组 = 空结果。 */
  readonly types: readonly string[] | null;
  /** ISO 8601 含起含止（ts >= from && ts <= to）。 */
  readonly timeRange: { readonly from: string | null; readonly to: string | null } | null;
  readonly page: { readonly limit: number; readonly beforeId: number | null };
}

/**
 * trace.query 校验失败错误（协议单源；daemon 侧映射链：normalize 抛出 →
 * handlers/trace.ts catch → connection.error{command.invalid_payload}）。
 */
export class TraceQueryInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceQueryInvalidError";
  }
}

/**
 * WS payload（未信 unknown）→ 归一查询。校验规则（契约 v0.4 §4 机械判据）：
 * sessionId 必填非空；instanceIds/types 为非空 string 数组（空数组合法 =
 * 空结果，无成员枚举）；agentKind ∈ {"main","subagent"}；timeRange from>to
 * 矛盾拒绝；limit 正整数鉗制 MAX_PAGE；beforeId 正整数。违反即
 * TraceQueryInvalidError（中文说明）。
 */
export function normalizeTraceQuery(input: unknown): NormalizedTraceQuery {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const sessionId = raw.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new TraceQueryInvalidError("trace.query 校验失败：payload.sessionId 应为非空 string");
  }

  const instanceIds = optionalStringArray(raw.instanceIds, "instanceIds");
  const types = optionalStringArray(raw.types, "types");

  const agentKindRaw = raw.agentKind;
  if (agentKindRaw !== undefined && agentKindRaw !== "main" && agentKindRaw !== "subagent") {
    throw new TraceQueryInvalidError('trace.query 校验失败：payload.agentKind 应为 "main" | "subagent"');
  }
  const agentKind = (agentKindRaw ?? null) as "main" | "subagent" | null;

  let timeRange: NormalizedTraceQuery["timeRange"] = null;
  if (raw.timeRange !== undefined) {
    const tr = (typeof raw.timeRange === "object" && raw.timeRange !== null ? raw.timeRange : {}) as Record<string, unknown>;
    const from = optionalIsoString(tr.from, "timeRange.from");
    const to = optionalIsoString(tr.to, "timeRange.to");
    if (from !== null && to !== null && from > to) {
      throw new TraceQueryInvalidError(`trace.query 校验失败：timeRange 矛盾（from ${from} 晚于 to ${to}，含起含止窗口为空）`);
    }
    timeRange = { from, to };
  }

  let limit = TRACE_PAGE_DEFAULT;
  let beforeId: number | null = null;
  if (raw.page !== undefined) {
    const page = (typeof raw.page === "object" && raw.page !== null ? raw.page : {}) as Record<string, unknown>;
    if (page.limit !== undefined) {
      if (typeof page.limit !== "number" || !Number.isInteger(page.limit) || page.limit < 1) {
        throw new TraceQueryInvalidError("trace.query 校验失败：page.limit 应为正整数");
      }
      limit = Math.min(page.limit, TRACE_PAGE_MAX); // 鉗制不报错（契约 §4）
    }
    if (page.beforeId !== undefined) {
      if (typeof page.beforeId !== "number" || !Number.isInteger(page.beforeId) || page.beforeId < 1) {
        throw new TraceQueryInvalidError("trace.query 校验失败：page.beforeId 应为正整数（id 游标）");
      }
      beforeId = page.beforeId;
    }
  }

  return { sessionId, instanceIds, agentKind, types, timeRange, page: { limit, beforeId } };
}

/** 更早页判据（AF-3 id 游标）：本页实载 == limit 即可能还有更早页。 */
export function hasMoreBefore(loaded: number, limit: number): boolean {
  return loaded === limit;
}

// ── 事件页过滤（内存语义 = daemon SQL WHERE/ORDER BY/LIMIT 的等价镜像） ──

/** 事件页（过滤 + 游标 + 限量 + total；fake 等内存数据源消费）。 */
export interface TraceEventPage {
  /** 本页事件行（id 降序 = 最新在前；游标/过滤已生效）。 */
  readonly rows: TraceEventRow[];
  /** 同过滤条件（不含游标/限量）的总行数。 */
  readonly total: number;
  /** rows.length === limit（可能还有更早页）。 */
  readonly hasMore: boolean;
}

/**
 * 事件全集 + 归一查询 → 事件页（daemon SqliteTraceQueryAdapter.queryEventPage
 * 的内存等价：instanceIds includes / agentKind === / types includes（空数组 =
 * 空结果）/ ts 字符串比较含起含止 / ORDER BY id DESC / beforeId 严格小于 /
 * LIMIT limit）。SQL 数据源（daemon）不消费本函数（SQL 承担同语义）。
 */
export function pageTraceEvents(events: readonly TraceEventRow[], query: NormalizedTraceQuery): TraceEventPage {
  const matched = events
    .filter((e) => query.instanceIds === null || query.instanceIds.includes(e.instanceId))
    .filter((e) => query.agentKind === null || query.agentKind === e.agentKind)
    .filter((e) => query.types === null || query.types.includes(e.type))
    .filter((e) => query.timeRange === null || query.timeRange.from === null || e.ts >= query.timeRange.from)
    .filter((e) => query.timeRange === null || query.timeRange.to === null || e.ts <= query.timeRange.to)
    .sort((a, b) => b.id - a.id);
  const total = matched.length;
  const paged = matched
    .filter((e) => query.page.beforeId === null || e.id < query.page.beforeId)
    .slice(0, query.page.limit);
  return { rows: paged, total, hasMore: hasMoreBefore(paged.length, query.page.limit) };
}

// ── 内部：字段校验辅助 ────────────────────────────────────

function optionalStringArray(value: unknown, name: string): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
    throw new TraceQueryInvalidError(`trace.query 校验失败：payload.${name} 应为非空 string 数组（空数组 = 空结果）`);
  }
  return value as readonly string[];
}

function optionalIsoString(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value === "" || Number.isNaN(Date.parse(value))) {
    throw new TraceQueryInvalidError(`trace.query 校验失败：${name} 应为 ISO 8601 时间文本`);
  }
  return value;
}

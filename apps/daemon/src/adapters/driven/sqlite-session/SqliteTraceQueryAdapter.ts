import type { WriteQueue } from "./WriteQueue";
import type { TraceQueryPort, TraceQueryResultSet } from "../../../domain/trace/TraceQueryPort";
import type {
  InstanceAggregateRow,
  TraceEventRowData,
  TraceInstanceRecord,
} from "../../../domain/trace/TraceQuery";
// T3.1 投影收敛：normalize/分页判据单源 @helix/protocol projection（原 domain
// TraceQuery 迁出，类型面形状同构对应；driven adapter import protocol 先例）
import {
  hasMoreBefore,
  normalizeTraceQuery,
  type NormalizedTraceQuery,
} from "@helix/protocol";
import { assembleInstancePanel } from "../../../domain/trace/TraceQuery";
import type { DomainEventRow } from "./rows/Rows";

/**
 * SqliteTraceQueryAdapter —— trace 读面（iter-20260819-erio T2.1，CL-5/F5.5/F5.6；
 * architecture.md §3.5b + 契约 v0.4 §1/§4）。
 *
 * 同库同表 domain_events（唯一真实源，不建 trace 独立表/聚合）；**只读面**——
 * 经 WriteQueue.database 共享连接直查，不经单写队列（与写路径零交错）。
 *
 * SQL 形态（契约 §4 机械判据）：
 * - 事件页：WHERE session_id=? [AND agent_instance_id IN …] [AND agent_kind=?]
 *   [AND type IN …] [AND ts>=? AND ts<=?（含起含止）] [AND id<?（游标）]
 *   ORDER BY id DESC LIMIT ?；
 * - total：同过滤 WHERE（不含游标/限量）COUNT(*)；
 * - 实例面板：会话级 COUNT/MIN/MAX GROUP BY agent_instance_id + agent.*
 *   生命周期事件全量 → domain 纯函数 assembleInstancePanel fold
 *   （面板恒为全会话口径，不受 events 过滤维影响，AF-5）。
 */

/** 面板 fold 所需的生命周期事件类型（domain_events.type 列值）。 */
const PANEL_LIFECYCLE_TYPES = [
  "agent.spawned",
  "agent.instantiated",
  "agent.completed",
  "agent.failed",
  "agent.killed",
  "agent.model.changed",
] as const;

export class SqliteTraceQueryAdapter implements TraceQueryPort {
  constructor(private readonly queue: WriteQueue) {}

  queryTrace(input: unknown): TraceQueryResultSet {
    // normalize 收口在本入口（§3.5b「调仓储前」；AG-12：driving 对 domain 仅
    // type-only，校验规则调用归 driven）——校验失败 TraceQueryInvalidError
    //（@helix/protocol projection 单源）上抛，driving 侧映射
    // command.invalid_payload 回执。
    const query = normalizeTraceQuery(input);
    return {
      filter: query,
      ...this.queryEventPage(query),
      instances: this.queryInstancePanel(query.sessionId),
    };
  }

  // ── 事件页（过滤 + 游标 + 限量 + total） ──────────────────

  private queryEventPage(query: NormalizedTraceQuery): {
    rows: readonly TraceEventRowData[];
    total: number;
    hasMore: boolean;
  } {
    // 空数组 = 空结果（显式语义：不展开为「全部」，SQL IN () 非法需短路）
    if (query.instanceIds !== null && query.instanceIds.length === 0) {
      return { rows: [], total: 0, hasMore: false };
    }
    if (query.types !== null && query.types.length === 0) {
      return { rows: [], total: 0, hasMore: false };
    }

    const where: string[] = ["session_id = ?"];
    const params: (string | number)[] = [query.sessionId];
    if (query.instanceIds !== null) {
      where.push(`agent_instance_id IN (${query.instanceIds.map(() => "?").join(",")})`);
      params.push(...query.instanceIds);
    }
    if (query.agentKind !== null) {
      where.push("agent_kind = ?");
      params.push(query.agentKind);
    }
    if (query.types !== null) {
      where.push(`type IN (${query.types.map(() => "?").join(",")})`);
      params.push(...query.types);
    }
    if (query.timeRange !== null) {
      if (query.timeRange.from !== null) {
        where.push("ts >= ?"); // 含起
        params.push(query.timeRange.from);
      }
      if (query.timeRange.to !== null) {
        where.push("ts <= ?"); // 含止
        params.push(query.timeRange.to);
      }
    }
    const filterWhere = where.join(" AND ");

    const total = (
      this.queue.database
        .prepare(`SELECT COUNT(*) AS c FROM domain_events WHERE ${filterWhere}`)
        .get(...params) as { c: number }
    ).c;

    const pageWhere =
      query.page.beforeId !== null ? `${filterWhere} AND id < ?` : filterWhere;
    const pageParams =
      query.page.beforeId !== null ? [...params, query.page.beforeId] : params;
    const rows = this.queue.database
      .prepare(
        "SELECT id, session_id, agent_kind, agent_instance_id, type, payload, ts FROM domain_events " +
          `WHERE ${pageWhere} ORDER BY id DESC LIMIT ?`,
      )
      .all(...pageParams, query.page.limit) as DomainEventRow[];

    const mapped = rows.map(rowToTraceEventRow);
    return { rows: mapped, total, hasMore: hasMoreBefore(mapped.length, query.page.limit) };
  }

  // ── 实例面板（会话级 fold） ─────────────────────────────

  private queryInstancePanel(sessionId: string): readonly TraceInstanceRecord[] {
    const aggregates = this.queue.database
      .prepare(
        "SELECT agent_instance_id, agent_kind, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS c " +
          "FROM domain_events WHERE session_id = ? GROUP BY agent_instance_id",
      )
      .all(sessionId) as {
      agent_instance_id: string;
      agent_kind: string;
      first_ts: string;
      last_ts: string;
      c: number;
    }[];
    if (aggregates.length === 0) return [];

    const lifecycleRows = this.queue.database
      .prepare(
        "SELECT id, session_id, agent_kind, agent_instance_id, type, payload, ts FROM domain_events " +
          `WHERE session_id = ? AND type IN (${PANEL_LIFECYCLE_TYPES.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(sessionId, ...PANEL_LIFECYCLE_TYPES) as DomainEventRow[];

    const rows: InstanceAggregateRow[] = aggregates.map((r) => ({
      instanceId: r.agent_instance_id,
      agentKind: r.agent_kind === "subagent" ? "subagent" : "main",
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      eventCount: r.c,
    }));
    return assembleInstancePanel(rows, lifecycleRows.map(rowToTraceEventRow));
  }
}

/** domain_events 行 → trace 事件行（payload JSON 解析；损坏行兜底原文串）。 */
function rowToTraceEventRow(row: DomainEventRow): TraceEventRowData {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload; // 损坏行防御：原文透出，不崩查询面
  }
  return {
    id: row.id ?? 0,
    ts: row.ts,
    sessionId: row.session_id,
    instanceId: row.agent_instance_id,
    agentKind: row.agent_kind === "subagent" ? "subagent" : "main",
    type: row.type,
    payload,
  };
}

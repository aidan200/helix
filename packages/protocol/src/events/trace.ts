import type { EventFrame } from "../envelope";
import type {
  TraceEventRow,
  TraceInstanceRecord,
  TraceQueryFilterEcho,
} from "../types/trace";

// ── v0.4 新增 payload：trace 命令族 + agent 执行上下文面（契约 v0.4 §1/§2/§3；iter-20260819-erio T2.1） ──

/** trace.query.result：会话历史事件查询结果（点对点回执；instances 面板恒为全会话 fold，AF-5） */
export interface TraceQueryResultPayload {
  /** 实际生效的过滤条件回显（normalize 后形态；缺省维归一 null）。 */
  filterEcho: TraceQueryFilterEcho;
  /** 实例面板摘要块（会话级，不受 events 过滤维影响）。 */
  instances: TraceInstanceRecord[];
  /** 本页事件行（id 降序 = 最新在前）。 */
  events: TraceEventRow[];
  page: {
    /** 本页实载行数。 */
    loaded: number;
    /** 同过滤条件（不含游标/限量）总行数。 */
    total: number;
    /** rows.length === limit（可能还有更早页；恰整除时末页多一次空载，记录在案）。 */
    hasMore: boolean;
  };
}

// ── v0.4 新增信封（契约 v0.4；iter-20260819-erio T2.1） ──

/**
 * trace.query.result：trace 查询命令结果（点对点回执——仅发给发起
 * trace.query 命令的连接，不经 EventStream 广播；TR-AD-21 同构）。
 * 信封 sessionId = 目标会话 id；channel = "trace"（v0.4 新族）。
 */
export interface TraceQueryResultEvent extends EventFrame<TraceQueryResultPayload> {
  channel?: "trace";
  type: "trace.query.result";
}

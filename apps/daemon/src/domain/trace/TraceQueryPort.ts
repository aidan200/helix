import type { NormalizedTraceQuery, TraceEventRowData, TraceInstanceRecord } from "./TraceQuery";

/**
 * TraceQueryPort —— trace 读面 inbound port（iter-20260819-erio T2.1，
 * architecture.md §3.5b 用户审阅修正：trace 读路径独立 port，**不焊**
 * SessionRepositoryPort——后者回到纯聚合职责，DomainEventQuery 不动）。
 *
 * 唯一真实源 = domain_events 事件存储（不建 Trace 聚合/独立表，§3.5b 禁令）；
 * 实现类 SqliteTraceQueryAdapter（同库同表，adapters/driven/sqlite-session）。
 * 只读面：不经单写队列（TR-AD-21 点对点读面，与写路径零交错）。
 *
 * 同步形态（bun:sqlite 同步读；与 SessionRepositoryPort.queryEvents 同步先例一致）。
 */
export interface TraceQueryResultSet {
  /** 实际生效的归一过滤（= 结果帧 filterEcho 数据源，AF-5）。 */
  readonly filter: NormalizedTraceQuery;
  /** 本页事件行（id 降序 = 最新在前；游标/过滤已生效）。 */
  readonly rows: readonly TraceEventRowData[];
  /** 同过滤条件（不含游标/限量）的总行数。 */
  readonly total: number;
  /** rows.length === limit（可能还有更早页；恰整除边界多一次空载，记录在案）。 */
  readonly hasMore: boolean;
  /** 实例面板摘要块（会话级 fold，不受 events 过滤维影响，AF-5）。 */
  readonly instances: readonly TraceInstanceRecord[];
}

export interface TraceQueryPort {
  /**
   * 执行 trace 查询。入参 = WS payload（未信 unknown）——normalize 收口在
   * 实现类入口（architecture.md §3.5b「调仓储前」；AG-12 纪律下 driving 侧
   * 对 domain 仅 type-only 引用，校验规则调用归 driven adapter）。
   * 校验失败抛 TraceQueryInvalidError（T3.1 起单源 @helix/protocol
   * projection；driving 侧映射 command.invalid_payload 回执）。
   */
  queryTrace(input: unknown): TraceQueryResultSet;
}

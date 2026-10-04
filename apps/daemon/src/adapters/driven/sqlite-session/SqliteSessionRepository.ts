import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { InstanceClosurePayload } from "../../../domain/events/DomainEvent";
import type {
  AgentLifecycleRowData,
  ClosureRecordData,
  DomainEventQuery,
  InstanceState,
  OrphanInstanceLifecycleRow,
  PendingSyncRowData,
  PersistedDomainState,
  SessionMetadataRow,
  SessionRepositoryPort,
} from "../../../application/ports/outbound/SessionRepositoryPort";
import type { WriteQueue } from "./WriteQueue";
import { LEGACY_MAIN_INSTANCE_ID } from "../../../domain/agent/AgentInstance";
import { rowToDomainEvent, rowsToPersistedState } from "./rows/RowMapper";
import type {
  AgentLifecycleRow,
  DomainEventRow,
  SessionStateRow,
  SteerQueueRow,
  ToolCallRow,
} from "./rows/Rows";

/** 尾部投影单条截断（Unicode 码点——progress 批 M3，LLM 面体量护栏出口）。 */
const READ_TAIL_ENTRY_MAX_CHARS = 300;

/** closure_records 行投影（读面；findings 为 JSON 串，由消费方解析）。 */
export interface ClosureRecordRow {
  readonly id: number;
  readonly session_id: string;
  readonly agent_id: string;
  readonly result: "done" | "failed" | "killed";
  readonly status: "done" | "failed";
  readonly summary: string;
  readonly report_path: string | null;
  readonly findings: string | null;
  readonly findings_file: string | null;
  readonly task_id: string | null;
  readonly created_at: string;
}

/**
 * SqliteSessionRepository —— SessionRepositoryPort 的 SQLite 实现
 * （architecture.md §3.4 / §5.2）。
 *
 * 写：全部经 WriteQueue（daemon 内唯一写通道，AG-06）——save 即入队，
 * await 返回时已落盘（write-through）。读：共用 WriteQueue 的连接做
 * 只读 SELECT（本文件不含任何写语句）。
 *
 * queryEvents 是 trace 数据面的内部查询能力：按
 * session/agent/类型/时间四维过滤 domain_events——只留数据不留 API，
 * 不对协议/前端暴露。
 */

export class SqliteSessionRepository implements SessionRepositoryPort {
  constructor(private readonly queue: WriteQueue) {}

  async save(state: PersistedDomainState): Promise<void> {
    await this.queue.saveState(state);
  }

  async restore(sessionId: string): Promise<PersistedDomainState | undefined> {
    const db = this.queue.database;
    const session = db
      .prepare("SELECT session_id, created_at, entries, turns, updated_at, main_instance_id, mode, title, topic FROM session_state WHERE session_id = ?")
      .get(sessionId) as SessionStateRow | null;
    if (!session) return undefined;
    // agent_lifecycle 已是每实例一行（复合 PK）：主会话运行态取 main 实例行；
    // SubAgent 实例行由编排侧消费，此处不混合读取
    const lifecycle = db
      .prepare(
        "SELECT session_id, instance_id, state, updated_at FROM agent_lifecycle WHERE session_id = ? AND instance_id = ?",
      )
      .get(sessionId, LEGACY_MAIN_INSTANCE_ID) as AgentLifecycleRow | null;
    const steer = db
      .prepare("SELECT seq, session_id, entry_id, text, source FROM steer_queue WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as SteerQueueRow[];
    const toolCalls = db
      .prepare(
        "SELECT id, session_id, instance_id, tool_name, args, status, result, error, images, started_at, ended_at " +
          "FROM tool_calls WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId) as ToolCallRow[];
    return rowsToPersistedState(session, lifecycle ?? undefined, steer, toolCalls);
  }

  async listSessionIds(): Promise<string[]> {
    const rows = this.queue.database
      .prepare("SELECT session_id FROM session_state ORDER BY created_at, rowid")
      .all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  /** 尾部消息投影（progress 批 M3）：单行点读（与 restore 同级成本——每次
   *  只读一行，非全表扫）；TS 层 parse 后立即投影丢弃原文，出口单条截 300
   *  码点——LLM 面体量护栏在 repo 出口处收口（任何消费面天然受控）。 */
  async readSessionTail(
    sessionId: string,
    tailEntries: number,
  ): Promise<readonly { role: string; text: string }[] | undefined> {
    const row = this.queue.database
      .prepare("SELECT entries FROM session_state WHERE session_id = ?")
      .get(sessionId) as { entries: string } | null | undefined;
    if (row === undefined || row === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.entries) as unknown;
    } catch {
      return []; // 脏行防御：entries 非法 JSON 不炸读面（空投影语义）
    }
    if (!Array.isArray(parsed)) return [];
    const n = Number.isInteger(tailEntries) && tailEntries > 0 ? tailEntries : 1;
    return parsed.slice(-n).map((e) => {
      const entry = e as { role?: unknown; text?: unknown };
      const text = typeof entry.text === "string" ? [...entry.text] : [];
      const capped =
        text.length > READ_TAIL_ENTRY_MAX_CHARS ? `${text.slice(0, READ_TAIL_ENTRY_MAX_CHARS).join("")}…` : text.join("");
      return { role: typeof entry.role === "string" ? entry.role : "?", text: capped };
    });
  }

  /**
   * 会话元数据轻量读面（AD-4）：json_extract 只取首条 entry 的
   * role/text（不整体反序列化 entries——session.list 读面不随会话体量线性
   * 传输）；首条非 user entry（理论不可达：会话首条必为用户消息）防御 null。
   * entry_count = json_array_length（A2 管家 query_recent_work 消息量级；
   * additive 列，消费方缺省 null）。
   */
  async listSessionMetadata(): Promise<readonly SessionMetadataRow[]> {
    const rows = this.queue.database
      .prepare(
        "SELECT session_id, created_at, updated_at, title, topic, " +
          "json_extract(entries, '$[0].role') AS first_role, " +
          "json_extract(entries, '$[0].text') AS first_text, " +
          "json_array_length(entries) AS entry_count " +
          "FROM session_state ORDER BY updated_at DESC",
      )
      .all() as {
        session_id: string;
        created_at: string;
        updated_at: string;
        title: string | null;
        topic: string | null;
        first_role: string | null;
        first_text: string | null;
        entry_count: number | null;
      }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // 修复批①：显式标题列优先（createTitledSession 定格；旧行 NULL =
      // 首条用户消息截断推导——消费单点 metaFromRow 兑现）
      ...(r.title !== null ? { title: r.title } : {}),
      // 动态主题批：演进主题列（旧行 NULL = 不携带；消费单点 metaFromRow
      // 按 title > topic > firstUserText 兑现）
      ...(r.topic !== null ? { topic: r.topic } : {}),
      firstUserText: r.first_role === "user" ? r.first_text : null,
      entryCount: r.entry_count,
    }));
  }

  /** 会话删除（AD-4）：会话维全部表（八表：七表 session_id 维 + work_item
   *  instance 维）清行经单写通道（同会话仓内 FIFO 保序）。 */
  async deleteSession(sessionId: string): Promise<void> {
    await this.queue.deleteSession(sessionId);
  }

  /** 实例生命周期投影行（调度器写面：经 WriteQueue 单写通道串行落盘）。 */
  async saveAgentLifecycle(sessionId: string, instanceId: string, state: InstanceState): Promise<void> {
    await this.queue.saveAgentLifecycle(sessionId, instanceId, state);
  }

  /** closure 记录行（O-5 任务报告本体；追加重，经单写通道）。 */
  async saveClosureRecord(
    sessionId: string,
    agentId: string,
    result: "done" | "failed" | "killed",
    closure: InstanceClosurePayload,
    findingsFile: string | null = null,
  ): Promise<void> {
    await this.queue.saveClosureRecord(sessionId, agentId, result, closure, findingsFile);
  }

  /** 报告文件产物（O-5：markdown 摘要+findings；同队列原子写）。 */
  async saveReportFile(reportPath: string, content: string): Promise<void> {
    await this.queue.saveReportFile(reportPath, content);
  }

  /** closure 记录行读面（按会话/实例过滤，落盘序；findings 解析为值）。 */
  queryClosureRecords(sessionId: string, agentId?: string): ClosureRecordData[] {
    const sql =
      "SELECT id, session_id, agent_id, result, status, summary, report_path, findings, findings_file, task_id, created_at " +
      "FROM closure_records WHERE session_id = ?" + (agentId !== undefined ? " AND agent_id = ?" : "") +
      " ORDER BY id";
    const stmt = this.queue.database.prepare(sql);
    const rows =
      agentId !== undefined
        ? (stmt.all(sessionId, agentId) as unknown as ClosureRecordRow[])
        : (stmt.all(sessionId) as unknown as ClosureRecordRow[]);
    return rows.map((r) => ({
      agentId: r.agent_id,
      result: r.result,
      status: r.status,
      summary: r.summary,
      reportPath: r.report_path,
      // 损坏行兑底：findings JSON 解析失败 → null（对齐 SqliteTraceQueryAdapter
      // rowToTraceEventRow 的原文/降级口径，一行脏 findings 不崩整次 closure 查询）
      findings: parseFindingsSafe(r.findings),
      findingsFile: r.findings_file,
      taskId: r.task_id,
      createdAt: r.created_at,
    }));
  }

  /** 实例生命周期行读面（agent_lifecycle 每实例行，注册表重建数据源）。 */
  async queryAgentLifecycles(sessionId: string): Promise<readonly AgentLifecycleRowData[]> {
    const rows = this.queue.database
      .prepare("SELECT instance_id, state, updated_at FROM agent_lifecycle WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as { instance_id: string; state: string; updated_at: string }[];
    return rows.map((r) => ({ instanceId: r.instance_id, state: r.state, updatedAt: r.updated_at }));
  }

  /** 幽灵实例行全库扫描（恢复链专用；判据见端口注释）。 */
  async queryOrphanInstanceLifecycles(bootedAtIso: string): Promise<readonly OrphanInstanceLifecycleRow[]> {
    const rows = this.queue.database
      .prepare(
        `SELECT session_id, instance_id, state, updated_at FROM agent_lifecycle
         WHERE instance_id LIKE 'agent-%'
           AND state IN ('queued', 'running', 'parked')
           AND updated_at < ?
         ORDER BY updated_at`,
      )
      .all(bootedAtIso) as { session_id: string; instance_id: string; state: string; updated_at: string }[];
    return rows.map((r) => ({ sessionId: r.session_id, instanceId: r.instance_id, state: r.state, updatedAt: r.updated_at }));
  }

  // ── W2-D pending_sync 变更追踪（R13/R22） ─────────────────

  /**
   * 写类工具成功调用判定（闭环记录点机械判据）。v1 口径：仅工具名
   * edit/write + status=completed——bash 写操作难判定不算、edit-lines 不
   * 在第一版集合内（口径注释 = 设计 D4「第一版只认 edit/write 工具名」）。
   */
  hasSuccessfulWriteToolCall(sessionId: string): boolean {
    const row = this.queue.database
      .prepare(
        "SELECT 1 AS hit FROM tool_calls WHERE session_id = ? AND tool_name IN ('edit', 'write') AND status = 'completed' LIMIT 1",
      )
      .get(sessionId);
    return row !== null;
  }

  /** pending_sync upsert（经 WriteQueue 单写通道；同主键单行复位 notified=0）。 */
  async savePendingSync(sessionId: string, jobId: string | null, changedAt: string): Promise<void> {
    await this.queue.savePendingSync(sessionId, jobId, changedAt);
  }

  /** pending_sync 未提示行读面（任务会话 sessionId 或 job_id 双径命中；session_id 序确定）。 */
  queryUnnotifiedPendingSync(sessionId: string, jobId: string): readonly PendingSyncRowData[] {
    const rows = this.queue.database
      .prepare(
        "SELECT session_id, job_id, changed_at FROM pending_sync WHERE notified = 0 AND (session_id = ? OR job_id = ?) ORDER BY session_id",
      )
      .all(sessionId, jobId) as { session_id: string; job_id: string | null; changed_at: string }[];
    return rows.map((r) => ({ sessionId: r.session_id, jobId: r.job_id, changedAt: r.changed_at }));
  }

  /** pending_sync 置已提示（经单写通道；重复置位幂等）。 */
  async markPendingSyncNotified(sessionIds: readonly string[]): Promise<void> {
    await this.queue.markPendingSyncNotified(sessionIds);
  }

  /** 四维过滤查询（trace 数据面，v0 无对外 API——内部能力 + 测试证明）。 */
  queryEvents(query: DomainEventQuery = {}): DomainEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.sessionId !== undefined) {
      where.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query.agentKind !== undefined) {
      where.push("agent_kind = ?");
      params.push(query.agentKind);
    }
    if (query.instanceId !== undefined) {
      where.push("agent_instance_id = ?");
      params.push(query.instanceId);
    }
    if (query.types !== undefined && query.types.length > 0) {
      where.push(`type IN (${query.types.map(() => "?").join(",")})`);
      params.push(...query.types);
    } else if (query.type !== undefined) {
      where.push("type = ?");
      params.push(query.type);
    }
    if (query.since !== undefined) {
      where.push("ts >= ?");
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push("ts <= ?");
      params.push(query.until);
    }
    const sql =
      "SELECT id, session_id, agent_kind, agent_instance_id, type, payload, ts FROM domain_events" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id";
    const rows = this.queue.database.prepare(sql).all(...params) as DomainEventRow[];
    return rows.map(rowToDomainEvent);
  }
}

/** closure findings 列安全解析：null 或损坏 JSON → null（查询面不因脏行崩）。 */
function parseFindingsSafe(raw: string | null): unknown[] | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown[];
  } catch {
    return null; // 损坏行防御：降级为无 findings，不崩查询面
  }
}

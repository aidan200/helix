import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { InstanceClosurePayload } from "../../../domain/events/DomainEvent";
import type {
  AgentLifecycleRowData,
  ClosureRecordData,
  DomainEventQuery,
  InstanceState,
  PersistedDomainState,
  SessionMetadataRow,
  SessionRepositoryPort,
} from "../../../application/ports/outbound/SessionRepositoryPort";
import type { WriteQueue } from "./WriteQueue";
// MAIN_INSTANCE_ID 改引协议导出（v0.2 OI 收口，F-2⑬；domain 定义保留 AG-02 例外）
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import { rowToDomainEvent, rowsToPersistedState } from "./rows/RowMapper";
import type {
  AgentLifecycleRow,
  DomainEventRow,
  SessionStateRow,
  SteerQueueRow,
  ToolCallRow,
} from "./rows/Rows";

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
 * queryEvents 是 trace 数据面的内部查询能力（TP-CL8-9）：按
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
      .prepare("SELECT session_id, created_at, entries, turns, updated_at FROM session_state WHERE session_id = ?")
      .get(sessionId) as SessionStateRow | null;
    if (!session) return undefined;
    // agent_lifecycle 已是每实例一行（复合 PK）：主会话运行态取 main 实例行；
    // SubAgent 实例行由编排侧（T2.x）消费，此处不混合读取
    const lifecycle = db
      .prepare(
        "SELECT session_id, instance_id, state, updated_at FROM agent_lifecycle WHERE session_id = ? AND instance_id = ?",
      )
      .get(sessionId, MAIN_INSTANCE_ID) as AgentLifecycleRow | null;
    const steer = db
      .prepare("SELECT seq, session_id, entry_id, text FROM steer_queue WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as SteerQueueRow[];
    const toolCalls = db
      .prepare(
        "SELECT id, session_id, instance_id, tool_name, args, status, result, error, started_at, ended_at " +
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

  /**
   * 会话元数据轻量读面（T2.2 AD-4）：json_extract 只取首条 entry 的
   * role/text（不整体反序列化 entries——session.list 读面不随会话体量线性
   * 传输）；首条非 user entry（理论不可达：会话首条必为用户消息）防御 null。
   */
  async listSessionMetadata(): Promise<readonly SessionMetadataRow[]> {
    const rows = this.queue.database
      .prepare(
        "SELECT session_id, created_at, updated_at, " +
          "json_extract(entries, '$[0].role') AS first_role, " +
          "json_extract(entries, '$[0].text') AS first_text " +
          "FROM session_state ORDER BY updated_at DESC",
      )
      .all() as {
        session_id: string;
        created_at: string;
        updated_at: string;
        first_role: string | null;
        first_text: string | null;
      }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      firstUserText: r.first_role === "user" ? r.first_text : null,
    }));
  }

  /** 会话删除（T2.2 AD-4）：六表清行经单写通道（同会话仓内 FIFO 保序）。 */
  async deleteSession(sessionId: string): Promise<void> {
    await this.queue.deleteSession(sessionId);
  }

  /** 实例生命周期投影行（T2.1 调度器写面：经 WriteQueue 单写通道串行落盘）。 */
  async saveAgentLifecycle(sessionId: string, instanceId: string, state: InstanceState): Promise<void> {
    await this.queue.saveAgentLifecycle(sessionId, instanceId, state);
  }

  /** closure 记录行（T2.3 O-5 任务报告本体；追加重，经单写通道）。 */
  async saveClosureRecord(
    sessionId: string,
    agentId: string,
    result: "done" | "failed" | "killed",
    closure: InstanceClosurePayload,
  ): Promise<void> {
    await this.queue.saveClosureRecord(sessionId, agentId, result, closure);
  }

  /** 报告文件产物（T2.3 O-5：markdown 摘要+findings；同队列原子写）。 */
  async saveReportFile(reportPath: string, content: string): Promise<void> {
    await this.queue.saveReportFile(reportPath, content);
  }

  /** closure 记录行读面（按会话/实例过滤，落盘序；T2.4 恢复读入点，findings 解析为值）。 */
  queryClosureRecords(sessionId: string, agentId?: string): ClosureRecordData[] {
    const sql =
      "SELECT id, session_id, agent_id, result, status, summary, report_path, findings, task_id, created_at " +
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
      findings: r.findings === null ? null : (JSON.parse(r.findings) as unknown[]),
      taskId: r.task_id,
      createdAt: r.created_at,
    }));
  }

  /** 实例生命周期行读面（T2.4：agent_lifecycle 每实例行，注册表重建数据源）。 */
  async queryAgentLifecycles(sessionId: string): Promise<readonly AgentLifecycleRowData[]> {
    const rows = this.queue.database
      .prepare("SELECT instance_id, state, updated_at FROM agent_lifecycle WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as { instance_id: string; state: string; updated_at: string }[];
    return rows.map((r) => ({ instanceId: r.instance_id, state: r.state, updatedAt: r.updated_at }));
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
    if (query.type !== undefined) {
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

import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type {
  PersistedDomainState,
  SessionRepositoryPort,
} from "../../../application/ports/outbound/SessionRepositoryPort";
import type { WriteQueue } from "./WriteQueue";
import { rowToDomainEvent, rowsToPersistedState } from "./rows/RowMapper";
import type {
  AgentLifecycleRow,
  DomainEventRow,
  SessionStateRow,
  SteerQueueRow,
  ToolCallRow,
} from "./rows/Rows";

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
export interface DomainEventQuery {
  readonly sessionId?: string;
  readonly agentKind?: string;
  readonly type?: string;
  /** ISO 8601 下界（含）。 */
  readonly since?: string;
  /** ISO 8601 上界（含）。 */
  readonly until?: string;
}

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
    const lifecycle = db
      .prepare("SELECT session_id, state, updated_at FROM agent_lifecycle WHERE session_id = ?")
      .get(sessionId) as AgentLifecycleRow | null;
    const steer = db
      .prepare("SELECT seq, session_id, entry_id, text FROM steer_queue WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as SteerQueueRow[];
    const toolCalls = db
      .prepare(
        "SELECT id, session_id, tool_name, args, status, result, error, started_at, ended_at " +
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
      "SELECT id, session_id, agent_kind, type, payload, ts FROM domain_events" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id";
    const rows = this.queue.database.prepare(sql).all(...params) as DomainEventRow[];
    return rows.map(rowToDomainEvent);
  }
}

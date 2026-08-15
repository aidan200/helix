import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";
import { persistedStateToRows, domainEventToRow } from "./rows/RowMapper";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { PersistedDomainState } from "../../../application/ports/outbound/SessionRepositoryPort";

/**
 * WriteQueue —— application 侧单写队列（architecture.md §5.2，AD-16/F(8).1）。
 *
 * daemon 内**唯一**的 SQLite 写通道（AG-06：new Database / exec / 全部
 * INSERT-UPDATE-DELETE 语句只出现在本文件）：领域事件与领域状态整体经
 * enqueue 进入 FIFO 串行链，按入队顺序逐个落盘（TP-CL8-2 并发保序）。
 *
 * - write-through：job 的 promise 在该 job 落盘完成后才 resolve——
 *   await appendEvent/saveState 返回即可查（非批量延迟）；
 * - 流式 delta 不进本队列（AD-16 §5.3：由调用方保证，publishDelta 无入口）；
 * - 优雅退出：close() 先 drain 链上全部 job 再关闭连接（挂 daemon
 *   lifecycle 的 shutdown 路径）；
 * - 单 job 失败不崩 daemon：经 onError 上报、链继续（后续 job 不受阻断）。
 *
 * v0 单 db 文件（多 workspace 不分库）；WAL 模式保证崩溃一致性。
 */

/** agent 维度默认值：v0 单 main 会话 agent（四维查询的 agent 维预留，AD-7）。 */
export const MAIN_AGENT_KIND = "main";

export interface WriteQueueOptions {
  /** 落盘失败上报（组合根接 logger；不抛出——写失败不阻断会话）。 */
  readonly onError?: (error: unknown, job: WriteJob) => void;
}

type WriteJob =
  | { readonly kind: "event"; readonly event: DomainEvent; readonly agentKind: string }
  | { readonly kind: "state"; readonly state: PersistedDomainState };

export class WriteQueue {
  private readonly db: Database;
  private readonly onError?: (error: unknown, job: WriteJob) => void;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  // 全部写语句在此 prepare（AG-06：src 内唯一 SQLite 写点集合；构造体内赋值）
  private readonly insertEvent!: Statement;
  private readonly upsertSession!: Statement;
  private readonly upsertLifecycle!: Statement;
  private readonly clearSteer!: Statement;
  private readonly insertSteer!: Statement;
  private readonly clearToolCalls!: Statement;
  private readonly insertToolCall!: Statement;

  constructor(dbPath: string, options: WriteQueueOptions = {}) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);
    this.onError = options.onError;

    this.insertEvent = this.db.prepare(
      "INSERT INTO domain_events (session_id, agent_kind, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
    );
    this.upsertSession = this.db.prepare(
      "INSERT INTO session_state (session_id, created_at, entries, turns, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET created_at = excluded.created_at, entries = excluded.entries, " +
        "turns = excluded.turns, updated_at = excluded.updated_at",
    );
    this.upsertLifecycle = this.db.prepare(
      "INSERT INTO agent_lifecycle (session_id, state, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    );
    this.clearSteer = this.db.prepare("DELETE FROM steer_queue WHERE session_id = ?");
    this.insertSteer = this.db.prepare(
      "INSERT INTO steer_queue (session_id, entry_id, text) VALUES (?, ?, ?)",
    );
    this.clearToolCalls = this.db.prepare("DELETE FROM tool_calls WHERE session_id = ?");
    this.insertToolCall = this.db.prepare(
      "INSERT INTO tool_calls (id, session_id, tool_name, args, status, result, error, started_at, ended_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
  }
  /** 读侧共用连接（SqliteSessionRepository 只读 SELECT；写仍唯一走本队列）。 */
  get database(): Database {
    return this.db;
  }

  /** 领域事件入队（里程碑事件源，四维可查询）；agentKind 默认 main。 */
  appendEvent(event: DomainEvent, agentKind: string = MAIN_AGENT_KIND): Promise<void> {
    return this.enqueue({ kind: "event", event, agentKind });
  }

  /** 领域状态整体入队（投影行整体替换：内存是权威，磁盘是投影缓存）。 */
  saveState(state: PersistedDomainState): Promise<void> {
    return this.enqueue({ kind: "state", state });
  }

  /** 等待已入队 job 全部落盘（测试/优雅退出用）。 */
  async flush(): Promise<void> {
    await this.tail;
  }

  /** 优雅退出：drain 全部 job 后关闭连接（幂等）。 */
  async close(): Promise<void> {
    await this.tail;
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  // ── 内部：FIFO 串行链 ────────────────────────────────────

  private enqueue(job: WriteJob): Promise<void> {
    if (this.closed) {
      // 关闭后到达的 job 视为进程退出竞态：上报不崩
      this.onError?.(new Error("WriteQueue 已关闭，job 被丢弃"), job);
      return Promise.resolve();
    }
    const done = this.tail.then(() => this.apply(job)).catch((error: unknown) => {
      this.onError?.(error, job); // 上报但不断链：单 job 失败不阻断后续落盘
    });
    this.tail = done;
    return done;
  }

  private apply(job: WriteJob): void {
    if (job.kind === "event") {
      const row = domainEventToRow(job.event, job.agentKind);
      this.insertEvent.run(row.session_id, row.agent_kind, row.type, row.payload, row.ts);
      return;
    }
    const rows = persistedStateToRows(job.state);
    const sessionId = rows.session.session_id;
    this.upsertSession.run(
      rows.session.session_id,
      rows.session.created_at,
      rows.session.entries,
      rows.session.turns,
      rows.session.updated_at,
    );
    this.upsertLifecycle.run(rows.lifecycle.session_id, rows.lifecycle.state, rows.lifecycle.updated_at);
    // 队列/记录行整体替换（投影语义：与内存当前态一致，顺序保持入队序）
    this.clearSteer.run(sessionId);
    for (const s of rows.steer) this.insertSteer.run(s.session_id, s.entry_id, s.text);
    this.clearToolCalls.run(sessionId);
    for (const t of rows.toolCalls) {
      this.insertToolCall.run(
        t.id,
        t.session_id,
        t.tool_name,
        t.args,
        t.status,
        t.result,
        t.error,
        t.started_at,
        t.ended_at,
      );
    }
  }
}

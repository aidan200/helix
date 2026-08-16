import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";
import { persistedStateToRows, domainEventToRow } from "./rows/RowMapper";
import { MAIN_INSTANCE_ID } from "../../../domain/agent/AgentInstance";
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
    // 守护式 schema 演进先于建表：旧库先补列/重建 PK，SCHEMA_SQL 随后幂等
    // 直建新库（新列在 CREATE TABLE 内，索引依赖的列此时必然已存在）。
    ensureSchemaEvolved(this.db);
    this.db.exec(SCHEMA_SQL);
    this.onError = options.onError;

    this.insertEvent = this.db.prepare(
      "INSERT INTO domain_events (session_id, agent_kind, agent_instance_id, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.upsertSession = this.db.prepare(
      "INSERT INTO session_state (session_id, created_at, entries, turns, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET created_at = excluded.created_at, entries = excluded.entries, " +
        "turns = excluded.turns, updated_at = excluded.updated_at",
    );
    this.upsertLifecycle = this.db.prepare(
      "INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(session_id, instance_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    );
    this.clearSteer = this.db.prepare("DELETE FROM steer_queue WHERE session_id = ?");
    this.insertSteer = this.db.prepare(
      "INSERT INTO steer_queue (session_id, entry_id, text) VALUES (?, ?, ?)",
    );
    this.clearToolCalls = this.db.prepare("DELETE FROM tool_calls WHERE session_id = ?");
    this.insertToolCall = this.db.prepare(
      "INSERT INTO tool_calls (id, session_id, instance_id, tool_name, args, status, result, error, started_at, ended_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      this.insertEvent.run(
        row.session_id,
        row.agent_kind,
        row.agent_instance_id,
        row.type,
        row.payload,
        row.ts,
      );
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
    this.upsertLifecycle.run(
      rows.lifecycle.session_id,
      rows.lifecycle.instance_id,
      rows.lifecycle.state,
      rows.lifecycle.updated_at,
    );
    // 队列/记录行整体替换（投影语义：与内存当前态一致，顺序保持入队序）
    this.clearSteer.run(sessionId);
    for (const s of rows.steer) this.insertSteer.run(s.session_id, s.entry_id, s.text);
    this.clearToolCalls.run(sessionId);
    for (const t of rows.toolCalls) {
      this.insertToolCall.run(
        t.id,
        t.session_id,
        t.instance_id,
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

// ── O-3 守护式 schema 演进（architecture.md §8.1，AG-06 唯一写点内） ──

/**
 * 启动期列级演进（幂等，每次打开执行，已演进则全部 no-op）：
 *
 * - domain_events.agent_instance_id / tool_calls.instance_id 缺列 →
 *   ALTER TABLE ADD COLUMN TEXT NOT NULL DEFAULT 'main'——SQLite 对
 *   NOT NULL 补列强制要求 DEFAULT，恰好即 O-3 裁决的旧行回填机制：
 *   存量行自动落 'main'（主实例固定 id，与 O-4 同源），新行恒显式写入。
 * - agent_lifecycle 单列 PK → (session_id, instance_id)：SQLite 无法
 *   ALTER 主键，走守护式重建（rename→create→copy→drop，事务包裹原子；
 *   旧行 instance_id 回填 'main'）。重建表形状与 schema.ts 新建表一致。
 *
 * 不做迁移框架（迭代边界）：无版本表、无回滚——检测即修，崩溃安全靠事务。
 */
function ensureSchemaEvolved(db: Database): void {
  if (!hasColumn(db, "domain_events", "agent_instance_id")) {
    db.exec("ALTER TABLE domain_events ADD COLUMN agent_instance_id TEXT NOT NULL DEFAULT 'main'");
  }
  if (!hasColumn(db, "tool_calls", "instance_id")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'main'");
  }
  const lifecycleCols = tableColumns(db, "agent_lifecycle");
  if (lifecycleCols.length > 0 && !lifecycleCols.includes("instance_id")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP TABLE IF EXISTS agent_lifecycle_rebuild"); // 上次崩溃残留防御（事务内不可达，保险）
      db.exec("ALTER TABLE agent_lifecycle RENAME TO agent_lifecycle_rebuild");
      db.exec(
        "CREATE TABLE agent_lifecycle (" +
          "session_id TEXT NOT NULL, " +
          `instance_id TEXT NOT NULL DEFAULT '${MAIN_INSTANCE_ID}', ` +
          "state TEXT NOT NULL, " +
          "updated_at TEXT NOT NULL, " +
          "PRIMARY KEY (session_id, instance_id))",
      );
      db.exec(
        "INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) " +
          `SELECT session_id, '${MAIN_INSTANCE_ID}', state, updated_at FROM agent_lifecycle_rebuild`,
      );
      db.exec("DROP TABLE agent_lifecycle_rebuild");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error; // 迁移失败快速失败：daemon 不带病启动
    }
  }
}

/** 列存在性（表不存在视为"无需演进"——随后的 CREATE TABLE 直建新形状）。 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = tableColumns(db, table);
  return cols.length === 0 || cols.includes(column);
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

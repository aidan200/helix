import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";
import { persistedStateToRows, domainEventToRow } from "./rows/RowMapper";
import { LEGACY_MAIN_INSTANCE_ID } from "../../../domain/agent/AgentInstance";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { InstanceClosurePayload } from "../../../domain/events/DomainEvent";
import type { PersistedDomainState } from "../../../application/ports/outbound/SessionRepositoryPort";

/**
 * WriteQueue —— application 侧单写队列（architecture.md §5.2，AD-16）。
 *
 * daemon 内**唯一**的 SQLite 写通道（AG-06：new Database / exec / 全部
 * INSERT-UPDATE-DELETE 语句只出现在本文件）：领域事件与领域状态整体经
 * enqueue 进入 FIFO 串行链，按入队顺序逐个落盘（并发保序，AD-16）。
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
  | { readonly kind: "state"; readonly state: PersistedDomainState }
  | {
      readonly kind: "agentLifecycle";
      readonly sessionId: string;
      readonly instanceId: string;
      readonly state: string;
    }
  | {
      /** O-5：closure 记录行（任务报告本体，SQLite 追加行）。 */
      readonly kind: "closureRecord";
      readonly sessionId: string;
      readonly agentId: string;
      readonly result: "done" | "failed" | "killed";
      readonly closure: InstanceClosurePayload;
      readonly occurredAt: string;
    }
  | {
      /** O-5：reportPath 文件产物（markdown；TR-AD-13 同队列原子写）。 */
      readonly kind: "reportFile";
      readonly reportPath: string;
      readonly content: string;
    }
  | {
      /** 会话删除——六表按 session_id 清行（删除收口链的删库步；AD-4）。 */
      readonly kind: "deleteSession";
      readonly sessionId: string;
    }
  | {
      /** 通用运行时配置 KV upsert（runtime_config 表，无会话维——全局链；P1 T1）。 */
      readonly kind: "runtimeConfig";
      readonly key: string;
      readonly value: string;
    }
  | {
      /** 资源启停差异行 upsert（resource_state 全局表，无会话维——全局链）。 */
      readonly kind: "resourceState";
      readonly profileKind: string;
      readonly resourceType: string;
      readonly name: string;
      readonly enabled: boolean;
    }
  | {
      /** 清空某 (profile_kind, resource_type) 全部差异行（model 槽位 clear）。 */
      readonly kind: "clearResourceState";
      readonly profileKind: string;
      readonly resourceType: string;
    }
  | {
      /** model 槽位原子替换（先清该 kind 全部 model 行再插入新行，
       *  enabled 恒 1——model 型行不承载启停语义，删除行 = 未设）。 */
      readonly kind: "modelSlot";
      readonly profileKind: string;
      readonly model: string;
    }
  | {
      /** 通用槽位原子替换（thinking 批扩值：同 modelSlot 单行不变式，
       *  resourceType 参数化——先清该 (kind, resourceType) 全部行再插入，
       *  enabled 恒 1）。 */
      readonly kind: "slotValue";
      readonly profileKind: string;
      readonly resourceType: string;
      readonly name: string;
    };

export class WriteQueue {
  private readonly db: Database;
  private readonly onError?: (error: unknown, job: WriteJob) => void;
  /**
   * 分仓 FIFO（AD-4，architecture-feedback #19 结构性落位）：每会话独立
   * 仓位/消费者按 session_id 路由——仓内严格 FIFO（同会话事件行先于状态行、
   * 删除行晚于一切写），仓间互不阻塞（A 会话的写高峰不队头阻塞 B 会话）；
   * 无会话维度的 job（reportFile）走全局链。
   */
  private readonly sessionTails = new Map<string, Promise<void>>();
  private globalTail: Promise<void> = Promise.resolve();
  private closed = false;

  // 全部写语句在此 prepare（AG-06：src 内唯一 SQLite 写点集合；构造体内赋值）
  private readonly insertEvent!: Statement;
  private readonly upsertSession!: Statement;
  private readonly upsertLifecycle!: Statement;
  private readonly clearSteer!: Statement;
  private readonly insertSteer!: Statement;
  private readonly clearToolCalls!: Statement;
  private readonly insertToolCall!: Statement;
  private readonly insertClosureRecord!: Statement;
  private readonly deleteSessionState!: Statement;
  private readonly deleteSessionEvents!: Statement;
  private readonly deleteSessionLifecycle!: Statement;
  private readonly deleteSessionSteer!: Statement;
  private readonly deleteSessionToolCalls!: Statement;
  private readonly deleteSessionClosures!: Statement;
  private readonly upsertRuntimeConfig!: Statement;
  private readonly upsertResourceState!: Statement;
  private readonly clearResourceStateByType!: Statement;

  constructor(dbPath: string, options: WriteQueueOptions = {}) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // 守护式 schema 演进先于建表：旧库先补列/重建 PK，SCHEMA_SQL 随后幂等
    // 直建新库（新列在 CREATE TABLE 内，索引依赖的列此时必然已存在）。
    ensureSchemaEvolved(this.db);
    this.db.exec(SCHEMA_SQL);
    // legacy default_model 单行表 → runtime_config KV 一次性数据迁移（P1 T1：
    // SCHEMA_SQL 建好新表后执行——拷贝+drop 事务包裹，幂等见函数注释）
    migrateLegacyDefaultModel(this.db);
    this.onError = options.onError;

    this.insertEvent = this.db.prepare(
      "INSERT INTO domain_events (session_id, agent_kind, agent_instance_id, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.upsertSession = this.db.prepare(
      "INSERT INTO session_state (session_id, created_at, entries, turns, updated_at, main_instance_id) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET created_at = excluded.created_at, entries = excluded.entries, " +
        "turns = excluded.turns, updated_at = excluded.updated_at, main_instance_id = excluded.main_instance_id",
    );
    this.upsertLifecycle = this.db.prepare(
      "INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(session_id, instance_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    );
    this.clearSteer = this.db.prepare("DELETE FROM steer_queue WHERE session_id = ?");
    this.insertSteer = this.db.prepare(
      "INSERT INTO steer_queue (session_id, entry_id, text, source) VALUES (?, ?, ?, ?)",
    );
    this.clearToolCalls = this.db.prepare("DELETE FROM tool_calls WHERE session_id = ?");
    this.insertToolCall = this.db.prepare(
      "INSERT INTO tool_calls (id, session_id, instance_id, tool_name, args, status, result, error, images, started_at, ended_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.insertClosureRecord = this.db.prepare(
      "INSERT INTO closure_records (session_id, agent_id, result, status, summary, report_path, findings, task_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.deleteSessionState = this.db.prepare("DELETE FROM session_state WHERE session_id = ?");
    this.deleteSessionEvents = this.db.prepare("DELETE FROM domain_events WHERE session_id = ?");
    this.deleteSessionLifecycle = this.db.prepare("DELETE FROM agent_lifecycle WHERE session_id = ?");
    this.deleteSessionSteer = this.db.prepare("DELETE FROM steer_queue WHERE session_id = ?");
    this.deleteSessionToolCalls = this.db.prepare("DELETE FROM tool_calls WHERE session_id = ?");
    this.deleteSessionClosures = this.db.prepare("DELETE FROM closure_records WHERE session_id = ?");
    this.upsertRuntimeConfig = this.db.prepare(
      "INSERT INTO runtime_config (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.upsertResourceState = this.db.prepare(
      "INSERT INTO resource_state (profile_kind, resource_type, name, enabled, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(profile_kind, resource_type, name) DO UPDATE SET enabled = excluded.enabled, " +
        "updated_at = excluded.updated_at",
    );
    this.clearResourceStateByType = this.db.prepare(
      "DELETE FROM resource_state WHERE profile_kind = ? AND resource_type = ?",
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

  /**
   * 实例生命周期投影行入队（agent_lifecycle upsert；调度器扩列写面：
   * SubAgent 实例状态迁移与主实例会话状态同表同 FIFO，保序落盘）。
   */
  saveAgentLifecycle(sessionId: string, instanceId: string, state: string): Promise<void> {
    return this.enqueue({ kind: "agentLifecycle", sessionId, instanceId, state });
  }

  /**
   * closure 记录行入队（O-5：任务报告本体 SQLite 行，追加重；
   * findings 保 JSON，重启后经读面完整可读）。
   */
  saveClosureRecord(
    sessionId: string,
    agentId: string,
    result: "done" | "failed" | "killed",
    closure: InstanceClosurePayload,
    occurredAt: string = new Date().toISOString(),
  ): Promise<void> {
    return this.enqueue({ kind: "closureRecord", sessionId, agentId, result, closure, occurredAt });
  }

  /**
   * 报告文件产物入队（O-5：markdown 摘要+findings 落
   * <home>/reports/<session>/<agentId>.md；与 SQLite 写同链串行——
   * tmp 写入 + rename 原子替换，崩溃不留半文件）。
   */
  saveReportFile(reportPath: string, content: string): Promise<void> {
    return this.enqueue({ kind: "reportFile", reportPath, content });
  }

  /**
   * 会话删除入队（AD-4 删除收口链的删库步）：六表按 session_id 清行；
   * 入本会话仓位尾部（此前已入队的写全部先落盘——删除不会被早到的状态写复活）。
   */
  deleteSession(sessionId: string): Promise<void> {
    return this.enqueue({ kind: "deleteSession", sessionId });
  }

  /**
   * 通用运行时配置 KV upsert 入队（P1 T1：runtime_config 表；无会话维 →
   * 全局链 FIFO，与仓间写互不阻塞；同键覆盖）。
   */
  saveRuntimeConfig(key: string, value: string): Promise<void> {
    return this.enqueue({ kind: "runtimeConfig", key, value });
  }

  /**
   * 资源启停差异行 upsert 入队（resource_state 全局表；无会话维 →
   * 全局链 FIFO——勿入 sessionTails 分仓）。
   */
  saveResourceState(
    profileKind: string,
    resourceType: string,
    name: string,
    enabled: boolean,
  ): Promise<void> {
    return this.enqueue({ kind: "resourceState", profileKind, resourceType, name, enabled });
  }

  /** 清空某 (profile_kind, resource_type) 全部差异行（model 槽位 clear 语义）。 */
  clearResourceState(profileKind: string, resourceType: string): Promise<void> {
    return this.enqueue({ kind: "clearResourceState", profileKind, resourceType });
  }

  /**
   * model 槽位原子替换入队（同 job 内先清该 kind 全部 model 行再
   * 插入新行——主键含 name，非原子替换会遗留旧行破坏单行不变式）。
   */
  saveModelSlot(profileKind: string, model: string): Promise<void> {
    return this.enqueue({ kind: "modelSlot", profileKind, model });
  }

  /**
   * 通用槽位原子替换入队（thinking 槽位等 model 以外的槽位型资源；同 job
   * 内先清该 (kind, resourceType) 全部行再插入——单行不变式同 modelSlot）。
   */
  saveSlotValue(profileKind: string, resourceType: string, name: string): Promise<void> {
    return this.enqueue({ kind: "slotValue", profileKind, resourceType, name });
  }

  /** 等待已入队 job 全部落盘（测试/优雅退出用；分仓后 = 全部仓位 drain）。 */
  async flush(): Promise<void> {
    await this.drainAll();
  }

  /** 优雅退出：drain 全部 job 后关闭连接（幂等）。 */
  async close(): Promise<void> {
    await this.drainAll();
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  // ── 内部：分仓 FIFO 串行链 ──────────────────────────────

  /** job → 仓位键（session 维 job 入会话仓；无会话维 job 入全局链）。 */
  private chainKeyOf(job: WriteJob): string | undefined {
    switch (job.kind) {
      case "event":
        return job.event.sessionId;
      case "state":
        return job.state.session.sessionId;
      case "agentLifecycle":
      case "closureRecord":
      case "deleteSession":
        return job.sessionId;
      default:
        return undefined; // reportFile/runtimeConfig/resource_state 族：无会话维（全局链）
    }
  }

  private enqueue(job: WriteJob): Promise<void> {
    if (this.closed) {
      // 关闭后到达的 job 视为进程退出竞态：上报不崩
      this.onError?.(new Error("WriteQueue 已关闭，job 被丢弃"), job);
      return Promise.resolve();
    }
    const key = this.chainKeyOf(job);
    const prev = key === undefined ? this.globalTail : (this.sessionTails.get(key) ?? Promise.resolve());
    const done = prev.then(() => this.apply(job)).catch((error: unknown) => {
      this.onError?.(error, job); // 上报但不断链：单 job 失败不阻断后续落盘
    });
    if (key === undefined) this.globalTail = done;
    else this.sessionTails.set(key, done);
    return done;
  }

  /** 全部仓位 drain；循环至稳定（drain 期间新入队的 job 一并等待）。 */
  private async drainAll(): Promise<void> {
    for (;;) {
      const globalBefore = this.globalTail;
      const sizeBefore = this.sessionTails.size;
      await Promise.all([this.globalTail, ...this.sessionTails.values()]);
      if (this.globalTail === globalBefore && this.sessionTails.size === sizeBefore) return;
    }
  }

  private apply(job: WriteJob): void {
    if (job.kind === "agentLifecycle") {
      this.upsertLifecycle.run(job.sessionId, job.instanceId, job.state, new Date().toISOString());
      return;
    }
    if (job.kind === "deleteSession") {
      // 六表清行（同仓 FIFO：此前同会话全部写先落盘，删除不会被复活）
      this.deleteSessionState.run(job.sessionId);
      this.deleteSessionEvents.run(job.sessionId);
      this.deleteSessionLifecycle.run(job.sessionId);
      this.deleteSessionSteer.run(job.sessionId);
      this.deleteSessionToolCalls.run(job.sessionId);
      this.deleteSessionClosures.run(job.sessionId);
      return;
    }
    if (job.kind === "runtimeConfig") {
      this.upsertRuntimeConfig.run(job.key, job.value);
      return;
    }
    if (job.kind === "resourceState") {
      this.upsertResourceState.run(
        job.profileKind,
        job.resourceType,
        job.name,
        job.enabled ? 1 : 0,
        new Date().toISOString(),
      );
      return;
    }
    if (job.kind === "clearResourceState") {
      this.clearResourceStateByType.run(job.profileKind, job.resourceType);
      return;
    }
    if (job.kind === "modelSlot") {
      // 原子替换：同 job 先清旧行再插新行（单行不变式不依赖调用方时序）
      this.clearResourceStateByType.run(job.profileKind, "model");
      this.upsertResourceState.run(job.profileKind, "model", job.model, 1, new Date().toISOString());
      return;
    }
    if (job.kind === "slotValue") {
      // 通用槽位原子替换（同 modelSlot 不变式，resourceType 参数化）
      this.clearResourceStateByType.run(job.profileKind, job.resourceType);
      this.upsertResourceState.run(job.profileKind, job.resourceType, job.name, 1, new Date().toISOString());
      return;
    }
    if (job.kind === "closureRecord") {
      this.insertClosureRecord.run(
        job.sessionId,
        job.agentId,
        job.result,
        job.closure.status,
        job.closure.summary,
        job.closure.reportPath ?? null,
        job.closure.findings === null || job.closure.findings === undefined ? null : JSON.stringify(job.closure.findings),
        job.closure.taskId ?? null,
        job.occurredAt,
      );
      return;
    }
    if (job.kind === "reportFile") {
      mkdirSync(path.dirname(job.reportPath), { recursive: true });
      writeFileSync(`${job.reportPath}.tmp`, job.content, "utf8");
      renameSync(`${job.reportPath}.tmp`, job.reportPath); // 同目录 rename 原子替换
      return;
    }
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
      rows.session.main_instance_id,
    );
    this.upsertLifecycle.run(
      rows.lifecycle.session_id,
      rows.lifecycle.instance_id,
      rows.lifecycle.state,
      rows.lifecycle.updated_at,
    );
    // 队列/记录行整体替换（投影语义：与内存当前态一致，顺序保持入队序）
    this.clearSteer.run(sessionId);
    for (const s of rows.steer) this.insertSteer.run(s.session_id, s.entry_id, s.text, s.source);
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
        t.images,
        t.started_at,
        t.ended_at,
      );
    }
  }
}

// ── 守护式 schema 演进（architecture.md §8.1，AG-06 唯一写点内） ──

/**
 * 启动期列级演进（幂等，每次打开执行，已演进则全部 no-op）：
 *
 * - domain_events.agent_instance_id / tool_calls.instance_id 缺列 →
 *   ALTER TABLE ADD COLUMN TEXT NOT NULL DEFAULT 'main'——SQLite 对
 * NOT NULL 补列强制要求 DEFAULT，恰与旧行回填机制吻合：
 * 存量行自动落 'main'（主实例固定 id），新行恒显式写入。
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
  // 图片下行：tool_calls.images（data URL 数组 JSON 文本；可空无默认——
  // 旧行 NULL = 无图，读取侧 undefined 前向兼容）
  if (!hasColumn(db, "tool_calls", "images")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN images TEXT");
  }
  // T11a：steer_queue.source（注入来源 user/closure/progress；可空无默认——
  // 旧行 NULL = 缺省 user 语义，读取侧键不携带前向兼容）
  if (!hasColumn(db, "steer_queue", "source")) {
    db.exec("ALTER TABLE steer_queue ADD COLUMN source TEXT");
  }
  // T10a 方案 A：session_state.main_instance_id（会话主实例 id，agent-<唯一串>；
  // 可空无默认——旧行 NULL = legacy "main"，读取侧兜底前向兼容）
  if (!hasColumn(db, "session_state", "main_instance_id")) {
    db.exec("ALTER TABLE session_state ADD COLUMN main_instance_id TEXT");
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
          `instance_id TEXT NOT NULL DEFAULT '${LEGACY_MAIN_INSTANCE_ID}', ` +
          "state TEXT NOT NULL, " +
          "updated_at TEXT NOT NULL, " +
          "PRIMARY KEY (session_id, instance_id))",
      );
      db.exec(
        "INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) " +
          `SELECT session_id, '${LEGACY_MAIN_INSTANCE_ID}', state, updated_at FROM agent_lifecycle_rebuild`,
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

/**
 * legacy default_model 单行表 → runtime_config KV 一次性数据迁移（P1 T1，
 * 决策 D1：独占单行表改通用 KV；构造期守护执行，与 ensureSchemaEvolved
 * 同族——SQL 内表→表数据迁移先例 agent_lifecycle PK 重建）。
 *
 * 规则（幂等）：旧表存在 → 拷贝（旧表有值且 KV 无 default_model 键时）后
 * drop 旧表；旧表不存在（新库/已迁移）→ no-op。事务包裹：拷贝+drop 同
 * 生共死，崩溃重开重试不双写（KV 有键即跳过拷贝）。选 drop 不选保留：
 * 表已出 SCHEMA_SQL，保留即孤儿双源；drop 后幂等性结构化（表不在 = 迁完）。
 */
function migrateLegacyDefaultModel(db: Database): void {
  const legacyTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'default_model'")
    .get();
  if (legacyTable === null) return; // 新库/已迁移：no-op
  db.exec("BEGIN IMMEDIATE");
  try {
    const legacy = db.prepare("SELECT model FROM default_model WHERE id = 1").get() as
      | { model: string }
      | null;
    const kv = db.prepare("SELECT value FROM runtime_config WHERE key = 'default_model'").get() as
      | { value: string }
      | null;
    if (legacy !== null && kv === null) {
      db.prepare("INSERT INTO runtime_config (key, value) VALUES ('default_model', ?)").run(
        legacy.model,
      );
    }
    db.exec("DROP TABLE default_model");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error; // 迁移失败快速失败：daemon 不带病启动（与 ensureSchemaEvolved 同调）
  }
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KG_SCHEMA_SQL } from "./schema";

/**
 * KgDatabase —— .helix-kg 单库 per-project 连接管理（TR-AD-14 口径存储适配器底座）。
 *
 * 两代形态差异的显式设计点（architecture.md §3.3）：v1 是子进程 CLI 唯一
 * 写者，v2 改为 daemon 进程内持有——连接管理是新代码，不照抄 v1。
 *
 * - 库定位 `<projectRoot>/.helix-kg/kg.db`（AF-21 二次裁决 2026-08-26：v2 落独立
 *   目录，v1 `.kg/kg.db` 原位不动不碰；AD-9/AD-15：按项目根持有，多 worktree
 *   天然隔离；daemon 全局自有状态仍在 ~/.helix/helix.db，两库互不混淆）；
 * - per-project 连接缓存（projectRoot→connection，懒开）；首次打开建库
 *   建表（IF NOT EXISTS 幂等）+ WAL（页面读不阻塞写）；
 * - 双写通道各自连接（AD-15「按表分域不竞争」）：知识层通道
 *   （writeKnowledge：nodes/anchor_decl/change_log/edges）与符号层通道
 *   （applySync：files/symbols/contains_edges/materialized_anchors/meta）
 *   各持一条连接、各自事务——BEGIN IMMEDIATE 前置取写锁 + busy_timeout，
 *   两通道串行化于 SQLite 写锁而不死锁（bun:sqlite 同步执行面下事务
 *   不可 interleaved，双连接为并发形态的正确性结构）；
 * - 读面共用知识层通道连接（WAL 读不阻塞写）。
 *
 * 本文件持有 new Database / DDL exec / pragma（AG-06 白名单写点之一）；
 * 数据写语句在 SqliteKnowledgeStore.ts。
 */
export class KgDatabase {
  private readonly knowledgeChannels = new Map<string, Database>();
  private readonly syncChannels = new Map<string, Database>();

  /** 知识层通道连接（writeKnowledge 与全部读面）。 */
  knowledgeConnection(projectRoot: string): Database {
    return this.connectionOf(this.knowledgeChannels, projectRoot);
  }

  /** 符号层通道连接（applySync 单事务）。 */
  syncConnection(projectRoot: string): Database {
    return this.connectionOf(this.syncChannels, projectRoot);
  }

  /** 关闭全部通道连接（测试清理/daemon 退出；库文件保留）。 */
  closeAll(): void {
    for (const db of this.knowledgeChannels.values()) db.close();
    for (const db of this.syncChannels.values()) db.close();
    this.knowledgeChannels.clear();
    this.syncChannels.clear();
  }

  private connectionOf(channels: Map<string, Database>, projectRoot: string): Database {
    const cached = channels.get(projectRoot);
    if (cached !== undefined) return cached;
    const dbPath = kgDbPath(projectRoot);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;"); // 持久库级设置；崩溃一致 + 页面读不阻塞写
    db.exec("PRAGMA busy_timeout = 10000;"); // 双通道并发时另一写者等待而非 BUSY 失败
    db.exec(KG_SCHEMA_SQL); // 幂等直建（冷启动首建 / 旧库重开 no-op）
    ensureSchemaEvolved(db); // 列级演进守护（老库 ALTER 补列；已演进 no-op）
    channels.set(projectRoot, db);
    return db;
  }
}

// ── 守护式 schema 演进（T2.1 两列 additive 迁移） ─────────

/**
 * 启动期列级演进（幂等，每次打开执行，已演进则 no-op；镜像 sqlite-session
 * WriteQueue.ensureSchemaEvolved 先例——hasColumn 守卫 + ALTER ADD COLUMN）：
 *
 * - nodes.origin_batch_id / change_log.task_id（AD-10 任务→kg 唯一衔接面）
 *   缺列 → ALTER ADD COLUMN TEXT（可空无默认——旧行 NULL = 无任务元数据，
 *   读取侧前向兼容）。老库既有行/数据不动；新库经 KG_SCHEMA_SQL 直建含
 *   两列（本函数 no-op）。
 *
 * 不做迁移框架（与 sqlite-session 同口径）：无版本表、无回滚——检测即修。
 */
function ensureSchemaEvolved(db: Database): void {
  if (!hasColumn(db, "nodes", "origin_batch_id")) {
    db.exec("ALTER TABLE nodes ADD COLUMN origin_batch_id TEXT");
  }
  if (!hasColumn(db, "change_log", "task_id")) {
    db.exec("ALTER TABLE change_log ADD COLUMN task_id TEXT");
  }
}

/** 列存在性（表不存在视为"无需演进"——随后的 CREATE TABLE 直建新形状）。 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
  return cols.length === 0 || cols.includes(column);
}

/** .helix-kg 库文件定位（导出供测试/迁移脚本对账；运行时经 KgDatabase 访问）。 */
export function kgDbPath(projectRoot: string): string {
  return path.join(projectRoot, ".helix-kg", "kg.db");
}

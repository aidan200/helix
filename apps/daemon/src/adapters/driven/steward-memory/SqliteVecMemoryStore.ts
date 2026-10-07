/**
 * sqlite-vec 管家长期记忆存储（driven，管家记忆 B1 批——StewardMemoryPort
 * 实现体）。
 *
 * 引擎形态：better-sqlite3（NAPI——Bun ≥1.4.2 加载修复后可用，spike
 * 实证解释态/编译单文件态全通）+ sqlite-vec 扩展（vec0 虚拟表，
 * distance_metric=cosine）。库文件独立 `<home>/steward_memory.db`——
 * 与 helix.db（bun:sqlite + WriteQueue，AG-06）物理隔离：vec0 只能活在
 * better-sqlite3 连接里，两引擎同文件必打架；本库仅管家记忆域单写者，
 * 无跨面并发（WAL 防御性开启）。
 *
 * 表结构：
 * - entries(id/kind/text/source/created_at/updated_at)：记忆条目——唯一
 *   source of truth（维度切换只清向量面，条目零损失）；updated_at B5 起
 *   落盘（覆盖更新时刷新，append 时 = created_at——存量库幂等补列）；
 * - meta(key/value)：当前向量维度（"dim" 键）——建 vec0 表维度锁死，
 *   换 embedding 模型（dim 变）→ resetVectors 重建向量面；
 * - vec_items：vec0 虚拟表（rowid = entries.id 对齐——同事务写入保证）。
 *
 * 构造即开库 + 建表（entries/meta 幂等）；vec0 表惰性——首次 append/
 * resetVectors 按当时维度建表（未建表前 search 返回空、storedDim 返回
 * null——零配置开箱降级语义的一部分）。
 */

import Database from "better-sqlite3";
import type {
  StewardMemoryAppendItem,
  StewardMemoryEntry,
  StewardMemoryHit,
  StewardMemoryPort,
} from "../../../application/ports/outbound/StewardMemoryPort";

interface EntryRow {
  id: number;
  kind: "fact" | "preference" | "progress";
  text: string;
  source: string;
  created_at: number;
  updated_at: number;
  last_recalled_at: number;
  recall_count: number;
  faded_at: number;
  pinned: number;
  /** progress 批：关联会话锄（存量行 ALTER 补列后为 ''——非 progress 形态）。 */
  session_id?: string;
  /** 项目隔离批：项目作用域（存量行 ALTER 补列后为 'global'）。 */
  project_scope: string;
}

function toEntry(row: EntryRow): StewardMemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalledAt: row.last_recalled_at,
    recallCount: row.recall_count,
    fadedAt: row.faded_at,
    pinned: row.pinned === 1,
    // progress 批：空串 = 非 progress 条目（无会话锄）——投影不携带
    ...(row.session_id !== undefined && row.session_id !== "" ? { sessionId: row.session_id } : {}),
    // 项目隔离批：存储投影恒携带（列 NOT NULL——真库总有值）
    projectScope: row.project_scope,
  };
}

export class SqliteVecMemoryStore implements StewardMemoryPort {
  private readonly db: Database.Database;

  /**
   * @param dbPath 库文件路径（":memory:" 供测试）。
   * @param vec0Path vec0 扩展绝对路径（resolve-vec0 解析产物——本类不做
   *   路径解析，加载失败直接抛构造错，由装配层捕获降级为记忆不可用）。
   */
  constructor(dbPath: string, vec0Path: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.loadExtension(vec0Path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // B5 幂等补列：存量库无 updated_at（首记 = created_at；新库建表即含——
    // CREATE TABLE IF NOT EXISTS 对已有表零动作，两形态统一在此补齐）。
    const columns = this.db.prepare("PRAGMA table_info(entries)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "updated_at")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE entries SET updated_at = created_at WHERE updated_at = 0");
    }
    // 遗忘机制批幂等补列（四列）：生命周期/强化/置位——存量回填 last_recalled_at
    // = updated_at（从未被想起但以最近变更为锄点起步），其余零值缺省。
    if (!columns.some((c) => c.name === "last_recalled_at")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN last_recalled_at INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE entries SET last_recalled_at = updated_at WHERE last_recalled_at = 0");
    }
    if (!columns.some((c) => c.name === "recall_count")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((c) => c.name === "faded_at")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN faded_at INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((c) => c.name === "pinned")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
    // progress 批幂等补列：会话锚（空串 = 非 progress 条目——避免 NULL 三态）。
    if (!columns.some((c) => c.name === "session_id")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
    }
    // 项目隔离批幂等补列：项目作用域（'global' = 跨项目可见；存量行迁移
    // 默认 global——零行为变化起步；ALTER ADD COLUMN NOT NULL DEFAULT 对
    // 存量行填充默认值）。二次构造列已存在 → 零动作（幂等重跑）。
    if (!columns.some((c) => c.name === "project_scope")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN project_scope TEXT NOT NULL DEFAULT 'global'");
    }
  }

  storedDim(): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'dim'").get() as { value: string } | undefined;
    if (row === undefined) return null;
    const dim = Number.parseInt(row.value, 10);
    return Number.isFinite(dim) && dim > 0 ? dim : null;
  }

  /** vec0 虚拟表建表（维度锁死——重复调用按既有维度幂等）。 */
  private ensureVecTable(dim: number): void {
    if (this.storedDim() === dim) return;
    this.resetVectors(dim);
  }

  resetVectors(newDim: number): void {
    if (!Number.isInteger(newDim) || newDim <= 0) {
      throw new Error(`vec0 维度非法：${newDim}（应为正整数）`);
    }
    this.db.exec(`DROP TABLE IF EXISTS vec_items`);
    this.db.exec(
      `CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[${newDim}] distance_metric=cosine)`,
    );
    this.db.prepare("INSERT INTO meta(key, value) VALUES('dim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(newDim),
    );
  }

  append(items: readonly StewardMemoryAppendItem[]): void {
    if (items.length === 0) return;
    this.ensureVecTable(items[0]!.vector.length);
    const insertEntry = this.db.prepare(
      "INSERT INTO entries(kind, text, source, created_at, updated_at, last_recalled_at, recall_count, faded_at, pinned, session_id, project_scope) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)",
    );
    const insertVec = this.db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
    const tx = this.db.transaction((rows: readonly StewardMemoryAppendItem[]) => {
      for (const item of rows) {
        // 遗忘机制批：新条目满强度起步（last_recalled_at = createdAt——锄点
        // 即创建时刻，新条目不吃存量衰减亏）。项目隔离批：scope 写入时落
        // （缺省 global）。
        const info = insertEntry.run(item.kind, item.text, item.source, item.createdAt, item.createdAt, item.createdAt, item.sessionId ?? "", item.projectScope ?? "global");
        // Bun NAPI better-sqlite3 把 JS number 绑定为 REAL——vec0 rowid 只
        // 收 INTEGER 字面类型（"Only integers are allowed" 实证），BigInt
        // 才绑定为 INTEGER（条目数 << 2^53 无精度问题）。
        insertVec.run(BigInt(Number(info.lastInsertRowid)), Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength));
      }
    });
    tx(items);
  }

  putVector(id: number, vector: Float32Array): void {
    this.ensureVecTable(vector.length);
    this.db
      .prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)")
      .run(BigInt(id), Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
  }

  search(query: Float32Array, topK: number, scopeFilter?: readonly string[]): readonly StewardMemoryHit[] {
    if (this.storedDim() === null || topK <= 0) return [];
    // 项目隔离批：rowid IN 预过滤（spike 实证 sqlite-vec KNN 查询对
    // rowid IN 子查询是 pre-filter——KNN 名额只给合格行，他项目最近邻
    // 不占位；与 JOIN 外表 WHERE 的 post-filter 形态（名额被占）语义
    // 相反，此处必须用 IN 形态。值全部经 ? 参数绑定（零拼接注入面）。
    const scopeClause =
      scopeFilter !== undefined && scopeFilter.length > 0
        ? ` AND v.rowid IN (SELECT id FROM entries WHERE project_scope IN (${scopeFilter.map(() => "?").join(",")}))`
        : "";
    const rows = this.db
      .prepare(
        `SELECT e.id, e.kind, e.text, e.source, e.created_at, e.updated_at, e.last_recalled_at, e.recall_count, e.faded_at, e.pinned, e.session_id, e.project_scope, v.distance
         FROM vec_items v JOIN entries e ON e.id = v.rowid
         WHERE v.embedding MATCH ? AND k = ?${scopeClause}
         ORDER BY v.distance ASC`,
      )
      .all(
        Buffer.from(query.buffer, query.byteOffset, query.byteLength),
        topK,
        ...(scopeFilter ?? []),
      ) as (EntryRow & { distance: number })[];
    return rows.map((row) => ({ ...toEntry(row), score: 1 - row.distance }));
  }

  list(): readonly StewardMemoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT id, kind, text, source, created_at, updated_at, last_recalled_at, recall_count, faded_at, pinned, session_id, project_scope FROM entries ORDER BY created_at ASC",
      )
      .all() as EntryRow[];
    return rows.map(toEntry);
  }

  findProgressId(sessionId: string): number | null {
    const row = this.db
      .prepare("SELECT id FROM entries WHERE kind = 'progress' AND session_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  forget(id: number): boolean {
    const tx = this.db.transaction((target: number) => {
      this.db.prepare("DELETE FROM vec_items WHERE rowid = ?").run(BigInt(target));
      return this.db.prepare("DELETE FROM entries WHERE id = ?").run(target).changes;
    });
    return tx(id) > 0;
  }

  updateEntry(id: number, text: string, vector: Float32Array, updatedAt: number, projectScope?: string): boolean {
    // 维度对齐：新向量维度 ≠ 锁表维度时重建向量面（调用方 ensureDim 已保证，
    // 此处防御性兑底——重建清全表后旧行已亡，直接 INSERT）
    this.ensureVecTable(vector.length);
    const tx = this.db.transaction(
      (target: number, newText: string, vec: Float32Array, updated: number, scope: string | undefined) => {
        // 遗忘机制批：编辑即救活（faded_at 归零——用户动手 = 明确价值信号）。
        // 项目隔离批：scope 传入 = 随写时项目重落（progress 覆盖更新）；
        // 缺省 = 保持原值（人工编辑/查重覆盖不改归属）。
        const changed = (scope !== undefined
          ? this.db.prepare("UPDATE entries SET text = ?, updated_at = ?, faded_at = 0, project_scope = ? WHERE id = ?").run(newText, updated, scope, target)
          : this.db.prepare("UPDATE entries SET text = ?, updated_at = ?, faded_at = 0 WHERE id = ?").run(newText, updated, target)
        ).changes;
      if (changed === 0) return false;
      // 向量重写：先删旧行再插入（vec0 rowid 无 REPLACE 语义）
      this.db.prepare("DELETE FROM vec_items WHERE rowid = ?").run(BigInt(target));
      this.db
        .prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)")
        .run(BigInt(target), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      return true;
    });
    return tx(id, text, vector, updatedAt, projectScope);
  }

  markRecalled(ids: readonly number[], at: number): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare("UPDATE entries SET last_recalled_at = ?, recall_count = recall_count + 1 WHERE id = ?");
    const tx = this.db.transaction((targets: readonly number[]) => {
      for (const id of targets) stmt.run(at, id);
    });
    tx(ids);
  }

  setPinned(id: number, pinned: boolean, at: number): boolean {
    if (pinned) {
      // 置顶 = 解除淡忘 + 刷新 updatedAt（协议回执 updatedAt 降序——浮顶可见）
      return this.db
        .prepare("UPDATE entries SET pinned = 1, faded_at = 0, updated_at = ? WHERE id = ?")
        .run(at, id).changes > 0;
    }
    return this.db.prepare("UPDATE entries SET pinned = 0 WHERE id = ?").run(id).changes > 0;
  }

  restore(id: number, at: number): boolean {
    // 仅淡忘条目可恢复（active 条目幂等 no-op → false——无变更即无回执语义）
    return this.db
      .prepare("UPDATE entries SET faded_at = 0, updated_at = ? WHERE id = ? AND faded_at != 0")
      .run(at, id).changes > 0;
  }

  fadeMany(ids: readonly number[], at: number): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare("UPDATE entries SET faded_at = ? WHERE id = ? AND faded_at = 0");
    const tx = this.db.transaction((targets: readonly number[]) => {
      for (const id of targets) stmt.run(at, id);
    });
    tx(ids);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

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
 * - entries(id/kind/text/source/created_at)：记忆条目——唯一 source of
 *   truth（维度切换只清向量面，条目零损失）；
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
  kind: "fact" | "preference";
  text: string;
  source: string;
  created_at: number;
}

function toEntry(row: EntryRow): StewardMemoryEntry {
  return { id: row.id, kind: row.kind, text: row.text, source: row.source, createdAt: row.created_at };
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
      "INSERT INTO entries(kind, text, source, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertVec = this.db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
    const tx = this.db.transaction((rows: readonly StewardMemoryAppendItem[]) => {
      for (const item of rows) {
        const info = insertEntry.run(item.kind, item.text, item.source, item.createdAt);
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

  search(query: Float32Array, topK: number): readonly StewardMemoryHit[] {
    if (this.storedDim() === null || topK <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT e.id, e.kind, e.text, e.source, e.created_at, v.distance
         FROM vec_items v JOIN entries e ON e.id = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance ASC`,
      )
      .all(Buffer.from(query.buffer, query.byteOffset, query.byteLength), topK) as (EntryRow & { distance: number })[];
    return rows.map((row) => ({ ...toEntry(row), score: 1 - row.distance }));
  }

  list(): readonly StewardMemoryEntry[] {
    const rows = this.db.prepare("SELECT id, kind, text, source, created_at FROM entries ORDER BY created_at ASC").all() as EntryRow[];
    return rows.map(toEntry);
  }

  forget(id: number): boolean {
    const tx = this.db.transaction((target: number) => {
      this.db.prepare("DELETE FROM vec_items WHERE rowid = ?").run(BigInt(target));
      return this.db.prepare("DELETE FROM entries WHERE id = ?").run(target).changes;
    });
    return tx(id) > 0;
  }

  updateEntry(id: number, text: string, vector: Float32Array): boolean {
    // 维度对齐：新向量维度 ≠ 锁表维度时重建向量面（调用方 ensureDim 已保证，
    // 此处防御性兑底——重建清全表后旧行已亡，直接 INSERT）
    this.ensureVecTable(vector.length);
    const tx = this.db.transaction((target: number, newText: string, vec: Float32Array) => {
      const changed = this.db.prepare("UPDATE entries SET text = ? WHERE id = ?").run(newText, target).changes;
      if (changed === 0) return false;
      // 向量重写：先删旧行再插入（vec0 rowid 无 REPLACE 语义）
      this.db.prepare("DELETE FROM vec_items WHERE rowid = ?").run(BigInt(target));
      this.db
        .prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)")
        .run(BigInt(target), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      return true;
    });
    return tx(id, text, vector);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

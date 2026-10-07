/**
 * 管家短期记忆行式消息存储（driven，B6 消息落盘批——StewardDialogStorePort
 * 实现体）。
 *
 * 引擎形态：better-sqlite3，库文件复用管家域独立库 `<home>/steward_memory.db`
 * （与长期记忆 entries/vec_items 同库不同表——管家域数据单库聚合，与 helix.db
 * 引擎库物理隔离；两连接同文件 WAL 并存，表不相交无跨面写冲突）。
 *
 * 表结构：
 * - steward_messages(id/kind/payload/at)：一条对话记录一行。payload = 协议
 *   StewardHistoryRecord JSON 原文（唯一真源——记录形态演进零 schema 迁移，
 *   UI 显示的 = LLM 记得的 = 落盘的）；kind/at 提取列供裁剪与排查查询；
 * - meta(key/value)：活跃时间（steward_dialog_last_active_at）——与长期记忆
 *   dim 键同表不同键。
 *
 * 构造即开库 + 建表（幂等）；构造抛错由装配层捕获降级为「对话不持久化」
 * （StewardDialogMemory 无 store 纯内存模式，管家对话不中断）。
 */
import Database from "better-sqlite3";
import type { StewardHistoryRecord } from "@helix/protocol";
import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type {
  StewardDialogStorePort,
  StewardDialogStoreSnapshot,
} from "../../../application/ports/outbound/StewardDialogStorePort";
import { STEWARD_DIALOG_KEY, parseStewardDialogKv } from "../../../application/steward/StewardDialogMemory";

const META_LAST_ACTIVE_AT = "steward_dialog_last_active_at";

interface MessageRow {
  readonly payload: string;
}

interface MetaRow {
  readonly value: string;
}

/** 单行 payload → 域记录（形状防御：非法 JSON/缺 kind 跳过——损坏行不毒窗口）。 */
function parseRecord(raw: string): StewardHistoryRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    if (typeof parsed.kind !== "string") return undefined;
    return parsed as StewardHistoryRecord;
  } catch {
    return undefined;
  }
}

export class SqliteStewardDialogStore implements StewardDialogStorePort {
  private readonly db: Database.Database;

  /** @param dbPath 库文件路径（":memory:" 供测试）。 */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS steward_messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  append(record: StewardHistoryRecord, at: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO steward_messages(kind, payload, at) VALUES (?, ?, ?)")
        .run(record.kind, JSON.stringify(record), at);
      this.setMeta(META_LAST_ACTIVE_AT, String(at));
    });
    tx();
  }

  deleteHead(count: number): void {
    if (count <= 0) return;
    this.db
      .prepare("DELETE FROM steward_messages WHERE id IN (SELECT id FROM steward_messages ORDER BY id ASC LIMIT ?)")
      .run(count);
  }

  replaceAll(records: readonly StewardHistoryRecord[], at: number): void {
    const insert = this.db.prepare("INSERT INTO steward_messages(kind, payload, at) VALUES (?, ?, ?)");
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM steward_messages");
      for (const r of records) insert.run(r.kind, JSON.stringify(r), at);
      this.setMeta(META_LAST_ACTIVE_AT, String(at));
    });
    tx();
  }

  loadRecent(): StewardDialogStoreSnapshot {
    // 防御上界（预算闸常态裁在百行级；超界 = 裁剪失守的自愈读面）
    const rows = this.db
      .prepare("SELECT payload FROM steward_messages ORDER BY id DESC LIMIT 2000")
      .all() as MessageRow[];
    const records: StewardHistoryRecord[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const parsed = parseRecord(rows[i]!.payload);
      if (parsed !== undefined) records.push(parsed);
    }
    const lastActiveAt = Number(this.getMeta(META_LAST_ACTIVE_AT) ?? "0");
    return {
      records,
      lastActiveAt: Number.isFinite(lastActiveAt) ? lastActiveAt : 0,
    };
  }

  clear(): void {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM steward_messages");
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(META_LAST_ACTIVE_AT);
    });
    tx();
  }

  close(): void {
    this.db.close();
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as MetaRow | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

/**
 * A1 KV → B6 行式存储一次性迁移（幂等）：runtime_config 整包 JSON 拆行导入
 * 后墓碑旧键（置空——空值对旧代码 parseDialog 也 = 不可用，双向安全）。
 * TTL 判定不在此做——导入后 ensureLoaded 的 TTL 闸照常收口（过期清空）。
 */
export function migrateStewardDialogKv(store: StewardDialogStorePort, kv: RuntimeConfigPort): boolean {
  const raw = kv.get(STEWARD_DIALOG_KEY);
  if (raw === undefined || raw === "") return false;
  const parsed = parseStewardDialogKv(raw);
  if (parsed !== undefined && parsed.records.length > 0) {
    store.replaceAll(parsed.records, parsed.lastActiveAt);
  }
  // 墓碑（best-effort——写失败下次重试导入，幂等无害）
  void kv.set(STEWARD_DIALOG_KEY, "").catch(() => {});
  return true;
}

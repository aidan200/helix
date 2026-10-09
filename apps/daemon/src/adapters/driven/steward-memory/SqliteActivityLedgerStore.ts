/**
 * 管家活动账行式存储（driven，M3-d1 感知兑现批——StewardActivityStorePort
 * 实现体）。
 *
 * 引擎形态：better-sqlite3，库文件复用管家域独立库 `<home>/steward_memory.db`
 * （第三连接：与长期记忆 entries/vec_items（B1）、短期对话 steward_messages
 * （B6）同库不同表——管家域数据单库聚合；三连接同文件 WAL 并存，表域不相交
 * 无跨面写冲突。AG-06 白名单登记成员，见 arch-guard.test.ts）。
 *
 * 表结构：steward_activity(id/at/domain/attribution/text)——一条活动一行，
 * at/domain/attribution 提取列供时间窗查询与域归组；text 恒白话（TR-249 延伸，
 * 条目化时已收口——本层零再加工）。
 *
 * 体量治理：滚动上限 ACTIVITY_LEDGER_STORE_LIMIT（append 计数达
 * ACTIVITY_LEDGER_TRIM_EVERY 时一次 DELETE 淘汰旧段——摊销单次 O(1) 写）。
 *
 * 构造即开库 + 建表（幂等）；构造抛错由装配层捕获降级为「账本不落盘」
 * （StewardActivityService 纯内存模式，感知/投影零影响）。
 */
import Database from "better-sqlite3";
import type { StewardActivityEntryView } from "@helix/protocol";
import type { StewardActivityStorePort, StewardActivityWindowQuery } from "../../../application/ports/outbound/StewardActivityStorePort";

/** 落盘滚动上限（条目制非原始事件流——回看窗口有界；超出淘汰最旧段）。 */
export const ACTIVITY_LEDGER_STORE_LIMIT = 2000;

/** 旧段淘汰摊销间隔（每 N 次 append 触发一次 DELETE——避免每写一次全表剪）。 */
export const ACTIVITY_LEDGER_TRIM_EVERY = 100;

interface Row {
  readonly at: number;
  readonly domain: string;
  readonly attribution: string;
  readonly text: string;
}

export class SqliteActivityLedgerStore implements StewardActivityStorePort {
  private readonly db: Database.Database;
  private appendCount = 0;

  /** @param dbPath 库文件路径（":memory:" 供测试）。 */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS steward_activity(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        domain TEXT NOT NULL,
        attribution TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_steward_activity_at ON steward_activity(at DESC);
    `);
  }

  append(entry: StewardActivityEntryView): void {
    this.db
      .prepare("INSERT INTO steward_activity(at, domain, attribution, text) VALUES (?, ?, ?, ?)")
      .run(entry.at, entry.domain, entry.attribution, entry.text);
    this.appendCount += 1;
    if (this.appendCount % ACTIVITY_LEDGER_TRIM_EVERY === 0) this.trim();
  }

  listWindow(query: StewardActivityWindowQuery): StewardActivityEntryView[] {
    const until = query.untilMs ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        "SELECT at, domain, attribution, text FROM steward_activity WHERE at >= ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?",
      )
      .all(query.sinceMs, until, query.limit) as Row[];
    return rows.map((r) => ({
      at: r.at,
      domain: r.domain as StewardActivityEntryView["domain"],
      attribution: r.attribution as StewardActivityEntryView["attribution"],
      text: r.text,
    }));
  }

  clear(): void {
    this.db.exec("DELETE FROM steward_activity");
  }

  close(): void {
    this.db.close();
  }

  /** 滚动淘汰（保最近 ACTIVITY_LEDGER_STORE_LIMIT 行）。 */
  private trim(): void {
    this.db
      .prepare(
        "DELETE FROM steward_activity WHERE id IN (SELECT id FROM steward_activity ORDER BY id ASC LIMIT MAX(0, (SELECT COUNT(*) FROM steward_activity) - ?))",
      )
      .run(ACTIVITY_LEDGER_STORE_LIMIT);
  }
}

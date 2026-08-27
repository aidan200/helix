import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";

/**
 * I 层（真 SQLite tmp 库）：.helix-kg 冷启动建库 + nodes.status 三值枚举（CL-2.A11）。
 * 8 张域表（知识 4 + 符号 3 + 物化 1）+ meta KV；WAL 生效（journal_mode 断言）。
 */

const disposers: Array<() => void> = [];

function freshProject(): { root: string; database: KgDatabase } {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-schema-"));
  const database = new KgDatabase();
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database };
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

describe("kg 冷启动建库（CL-2.A1 存储半；AD-9/AD-13）", () => {
  test("① .helix-kg 缺失的 projectRoot 首次打开 → 建库建表（8 张域表 + meta）且 WAL 生效", () => {
    const { root, database } = freshProject();
    expect(existsSync(kgDbPath(root))).toBe(false); // 前置：库不存在
    database.knowledgeConnection(root); // 首次打开（懒建）
    expect(existsSync(kgDbPath(root))).toBe(true);

    const probe = new Database(kgDbPath(root));
    try {
      const mode = probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(mode.journal_mode).toBe("wal");
      const tables = (
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toEqual([
        "anchor_decl",
        "change_log",
        "contains_edges",
        "edges",
        "files",
        "materialized_anchors",
        "meta",
        "nodes",
        "symbols",
      ]);
    } finally {
      probe.close();
    }
  });

  test("② 两条通道连接（知识层/符号层）对同一 projectRoot 共用同一库文件（per-project 隔离单元）", () => {
    const { root, database } = freshProject();
    database.knowledgeConnection(root);
    database.syncConnection(root);
    expect(existsSync(kgDbPath(root))).toBe(true);
  });
});

describe("nodes.status 三值枚举（CL-2.A11，AD-11 预留 + supersede 翻转目标态）", () => {
  test("① 默认 draft；draft/confirmed/superseded 三值合法；越界值被 CHECK 拒绝", () => {
    const { root, database } = freshProject();
    const db = database.knowledgeConnection(root);
    const insert = (id: string, status: string) =>
      db
        .prepare(
          "INSERT INTO nodes (id, kind, name, digest, status, created_at, updated_at) VALUES (?, 'rule', 'n', 'd', ?, 't', 't')",
        )
        .run(id, status);
    // 缺省 = draft（AD-11 生命周期预留；省略 status 列走 DEFAULT——SQLite 显式
    // NULL 绑定不取 DEFAULT，必须省略列才能验默认值）
    db.prepare(
      "INSERT INTO nodes (id, kind, name, digest, created_at, updated_at) VALUES ('TR-1', 'rule', 'n', 'd', 't', 't')",
    ).run();
    expect(
      (db.prepare("SELECT status FROM nodes WHERE id = 'TR-1'").get() as { status: string }).status,
    ).toBe("draft");
    // 三值枚举中其余两值合法
    insert("TR-2", "confirmed");
    insert("TR-3", "superseded");
    // 越界值被表级 CHECK 拒绝（schema 即防线最内层兜底）
    expect(() => insert("TR-4", "bogus")).toThrow();
    expect(() => insert("TR-5", "active")).toThrow(); // v1 词表不进 v2
  });

  test("② nodes.name 非唯一：重名节点共存（AD-16 重名合法，靠 digest 区分）", () => {
    const { root, database } = freshProject();
    const db = database.knowledgeConnection(root);
    db.prepare(
      "INSERT INTO nodes (id, kind, name, digest, created_at, updated_at) VALUES ('TR-1', 'rule', '同名', '摘要甲', 't', 't')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO nodes (id, kind, name, digest, created_at, updated_at) VALUES ('TR-2', 'rule', '同名', '摘要乙', 't', 't')",
        )
        .run(),
    ).not.toThrow();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE name = '同名'").get() as { n: number }).n,
    ).toBe(2);
  });
});

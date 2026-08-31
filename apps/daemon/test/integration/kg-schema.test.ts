import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";

/**
 * I 层（真 SQLite tmp 库）：.helix-kg 冷启动建库 + nodes.status 三值枚举（CL-2.A11）。
 * 9 张域表（知识 4 + 符号 3 + 物化 1 + 候选 1）+ meta KV；WAL 生效（journal_mode 断言）。
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
  test("① .helix-kg 缺失的 projectRoot 首次打开 → 建库建表（9 张域表 + meta）且 WAL 生效", () => {
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
        "candidates",
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

describe("change_log.iteration_id 可空演进（P0 ④：老库 NOT NULL → 打开即重建为可空）", () => {
  /** 造老形状库：change_log 带 iteration_id NOT NULL（v2 早期 DDL）+ 存量行。 */
  function legacyProject(): string {
    const root = mkdtempSync(path.join(tmpdir(), "helix-kg-evolve-"));
    mkdirSync(path.dirname(kgDbPath(root)), { recursive: true });
    const raw = new Database(kgDbPath(root));
    raw.exec(
      "CREATE TABLE change_log (" +
        "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "iteration_id TEXT NOT NULL, " +
        "task_id TEXT, " +
        "op TEXT NOT NULL, " +
        "node_id TEXT NOT NULL, " +
        "supersede_of TEXT, " +
        "reason TEXT, " +
        "ts TEXT NOT NULL)",
    );
    raw.exec(
      "CREATE INDEX idx_change_log_node ON change_log(node_id)",
    );
    raw.prepare(
      "INSERT INTO change_log (iteration_id, task_id, op, node_id, supersede_of, reason, ts) VALUES (?, ?, 'createNode', 'TR-1', NULL, NULL, 't')",
    ).run("iter-old", "task-1");
    raw.prepare(
      "INSERT INTO change_log (iteration_id, op, node_id, ts) VALUES ('iter-old', 'createNode', 'TR-2', 't')",
    ).run();
    raw.close();
    disposers.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  test("① 老库首开：notnull 解除 + 存量行/序号/task_id 保留 + AUTOINCREMENT 续号不回卷", () => {
    const root = legacyProject();
    const database = new KgDatabase();
    disposers.push(() => database.closeAll());
    const db = database.knowledgeConnection(root); // 首开即演进
    // notnull 解除（新形状）
    const col = (db.prepare("PRAGMA table_info(change_log)").all() as { name: string; notnull: number }[]).find(
      (c) => c.name === "iteration_id",
    );
    expect(col!.notnull).toBe(0);
    // 存量行完整保留（seq/iteration_id/task_id）
    const rows = db.prepare("SELECT seq, iteration_id, task_id, node_id FROM change_log ORDER BY seq").all();
    expect(rows).toEqual([
      { seq: 1, iteration_id: "iter-old", task_id: "task-1", node_id: "TR-1" },
      { seq: 2, iteration_id: "iter-old", task_id: null, node_id: "TR-2" },
    ]);
    // 可写 NULL 行（新语义落地）
    db.prepare("INSERT INTO change_log (iteration_id, op, node_id, ts) VALUES (NULL, 'createNode', 'TR-3', 't')").run();
    expect(
      (db.prepare("SELECT iteration_id FROM change_log WHERE seq = 3").get() as { iteration_id: string | null }).iteration_id,
    ).toBe(null);
    // AUTOINCREMENT 续号不回卷（重建后发号从 max(seq) 起）
    const next = db.prepare("INSERT INTO change_log (iteration_id, op, node_id, ts) VALUES (NULL, 'createNode', 'TR-4', 't')").run();
    expect(next.lastInsertRowid).toBe(4);
    // 索引随重建恢复
    const indexes = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'change_log' AND name LIKE 'idx_%'")
      .all() as { name: string }[]
    ).map((r) => r.name).sort();
    expect(indexes).toEqual(["idx_change_log_node", "idx_change_log_supersede_of"]);
  });

  test("② 幂等：新库/已演进库重开 no-op（行数不变，notnull 保持 0）", () => {
    const root = legacyProject();
    const first = new KgDatabase();
    first.knowledgeConnection(root); // 演进
    first.closeAll();
    const second = new KgDatabase();
    disposers.push(() => second.closeAll());
    const db = second.knowledgeConnection(root); // 重开 no-op
    const count = (db.prepare("SELECT COUNT(*) AS n FROM change_log").get() as { n: number }).n;
    expect(count).toBe(2);
    const col = (db.prepare("PRAGMA table_info(change_log)").all() as { name: string; notnull: number }[]).find(
      (c) => c.name === "iteration_id",
    );
    expect(col!.notnull).toBe(0);
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

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { KnowledgeWriteOp } from "../../src/domain/kg/types";

/**
 * I 层（真 SQLite tmp 库）：nodes.scene 独立列 + 沉淀必填（R23 裁决，
 * kg-driven-dev-loop-design.md D3 三层设计第 1 条）。
 *
 * 覆盖：
 * ① schema 校验机械强制——createNode/batchCreateNodes 缺 scene（或空白）
 *    → KG_E_SCHEMA 拒绝零落库；显式保号 id（迁移通道）豁免（存量不回填）；
 * ② scene 落库读回——getNode/search/附着快照三面同值；
 * ③ 老库守护式演进——无 scene 列旧库打开自动 ALTER 补列、既有行 scene=''、
 *    二次打开幂等（origin_batch_id 补列先例同构）。
 */

interface Fixture {
  readonly root: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
}

const fixtures: Fixture[] = [];

afterAll(() => {
  for (const f of fixtures) {
    f.database.closeAll();
    rmSync(f.root, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "kg-scene-it-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const fixture: Fixture = { root, database, store, graph, write };
  fixtures.push(fixture);
  return fixture;
}

const SCENE = "本规则适用于：改动 kg 写通道前";

function createOp(draft: Record<string, unknown>, extra: Record<string, unknown> = {}): KnowledgeWriteOp {
  return { kind: "createNode", iterationId: "iter-scene", draft, ...extra } as unknown as KnowledgeWriteOp;
}

describe("① scene 沉淀必填（schema 校验机械强制，R23）", () => {
  test("createNode 缺 scene → KG_E_SCHEMA 拒绝且零落库", () => {
    const f = makeFixture();
    const result = f.write.write(f.root, createOp({ kind: "rule", name: "无场景规则", digest: "d" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_SCHEMA");
      expect(result.error.path).toBe("op.draft.scene");
      expect(result.error.message).toContain("scene");
    }
    expect(f.graph.search(f.root, "无场景规则")).toHaveLength(0);
  });

  test("createNode scene 为空白串 → 同样拒绝", () => {
    const f = makeFixture();
    const result = f.write.write(f.root, createOp({ kind: "rule", name: "空白场景", digest: "d", scene: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KG_E_SCHEMA");
  });

  test("createNode scene 非字符串 → KG_E_SCHEMA", () => {
    const f = makeFixture();
    const result = f.write.write(f.root, createOp({ kind: "rule", name: "坏场景", digest: "d", scene: 42 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_SCHEMA");
      expect(result.error.path).toBe("op.draft.scene");
    }
  });

  test("batchCreateNodes 任一项缺 scene → 整批拒绝零部分落库（O-5 原子性不变）", () => {
    const f = makeFixture();
    const op = {
      kind: "batchCreateNodes",
      iterationId: "iter-scene",
      nodes: [
        { draft: { kind: "rule", name: "有场景", digest: "d", scene: SCENE } },
        { draft: { kind: "entity", name: "没场景", digest: "d" } },
      ],
    } as unknown as KnowledgeWriteOp;
    const result = f.write.write(f.root, op);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_SCHEMA");
      expect(result.error.path).toBe("op.nodes[1].draft.scene");
    }
    expect(f.graph.search(f.root, "场景")).toHaveLength(0); // 整批回滚
  });

  test("显式保号 id（迁移通道）缺 scene → 豁免允许（存量回填归 kg-review，R23）", () => {
    const f = makeFixture();
    const result = f.write.write(
      f.root,
      createOp({ kind: "rule", name: "存量规则", digest: "d" }, { id: "TR-AD-47" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nodeId).toBe("TR-AD-47");
    // 豁免落库的存量节点 scene 读面为 ''（空串兜底形态由渲染层负责）
    const detail = f.graph.getNode(f.root, "TR-AD-47");
    expect(detail?.node.scene).toBe("");
  });
});

describe("② scene 落库与读面三面同值", () => {
  test("createNode 带 scene → getNode / search / 附着快照均携带", async () => {
    const f = makeFixture();
    const created = f.write.write(f.root, createOp({ kind: "rule", name: "场景规则", digest: "d", scene: SCENE }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const detail = f.graph.getNode(f.root, created.nodeId);
    expect(detail?.node.scene).toBe(SCENE);

    const hits = f.graph.search(f.root, "场景规则");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.scene).toBe(SCENE);

    // 附着快照（物化锚 join 节点摘要）：scene 随节点行投影
    await f.store.applySync(f.root, {
      files: [{ path: "src/a.ts", mtime: 1, sha256: "h" }],
      symbols: [],
      containsEdges: [],
      materializedAnchors: [
        { nodeId: created.nodeId, anchorKind: "path", anchorPath: "src/a.ts", anchorSymbol: null },
      ],
      baseline: "b1",
      degraded: false,
    });
    const snapshot = f.graph.getAttachmentSnapshot(f.root);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]!.scene).toBe(SCENE);
  });

  test("supersede replacement 草稿可携带 scene（新号节点落列）", () => {
    const f = makeFixture();
    const created = f.write.write(f.root, createOp({ kind: "rule", name: "旧规", digest: "d", scene: SCENE }));
    if (!created.ok) throw new Error("seed failed");
    const result = f.write.write(f.root, {
      kind: "supersede",
      iterationId: "iter-scene",
      nodeId: created.nodeId,
      reason: "推翻重来",
      replacementNodeDraft: { kind: "rule", name: "新规", digest: "d2", scene: "本规则适用于：改动读面前" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(f.graph.getNode(f.root, result.nodeId)?.node.scene).toBe("本规则适用于：改动读面前");
  });
});

describe("③ 老库守护式演进（无 scene 列 → ALTER 补列，origin_batch_id 先例同构）", () => {
  /** 无 scene 列的旧库形态（演进前 schema 子集 + 既有行）。 */
  function buildLegacyDb(root: string): void {
    const dbPath = kgDbPath(root);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rule','entity')),
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  domain TEXT CHECK (domain IN ('tech','business')),
  layer TEXT,
  origin_batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
    db.prepare(
      "INSERT INTO nodes (id, kind, name, digest, body, domain, layer, origin_batch_id, status, created_at, updated_at) " +
        "VALUES ('TR-1', 'rule', '既有规则', '既有摘要', '', 'tech', NULL, NULL, 'confirmed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run();
    db.close();
  }

  test("老库打开 → 自动补 scene 列，既有行 scene='' 零变化；二次打开幂等", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-scene-legacy-"));
    const database = new KgDatabase();
    fixtures.push({ root, database, store: null!, graph: null!, write: null! });
    buildLegacyDb(root);

    database.knowledgeConnection(root); // 打开触发演进
    const probe = new Database(kgDbPath(root));
    try {
      const cols = (probe.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).map((c) => c.name);
      expect(cols.filter((c) => c === "scene")).toHaveLength(1);
      const row = probe.prepare("SELECT scene FROM nodes WHERE id = 'TR-1'").get() as { scene: string };
      expect(row.scene).toBe(""); // 存量行兜底空串（不回填）
    } finally {
      probe.close();
    }

    // 二次打开幂等（ALTER 不重复执行）
    const again = new KgDatabase();
    again.knowledgeConnection(root);
    again.closeAll();
    const probe2 = new Database(kgDbPath(root));
    try {
      const cols = (probe2.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).map((c) => c.name);
      expect(cols.filter((c) => c === "scene")).toHaveLength(1);
    } finally {
      probe2.close();
    }
  });
});

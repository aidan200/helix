import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { CreateNodePayload, KnowledgeWriteOp, NodeDraft } from "../../src/domain/kg/types";

/**
 * I 层（真 SQLite @ tmp）：任务域 → kg 域元数据衔接面（T2.1，CL-2 / F2.4，
 * AD-10 唯一衔接面 = kg 节点元数据）。
 *
 * 覆盖（testing/test-design CL-2-T6 / CL-2-T14 / V-1②）：
 * - 迁移面：老库（无两列）打开自动 ALTER 补列且既有行零变化；新库直建含两列；双向幂等；
 * - 元数据落值：createNode 携带 layer/originBatchId/taskId → nodes.origin_batch_id +
 *   change_log.task_id 落值；不携带 → 行为与现状逐字节一致（NULL 落列）；
 * - batchCreateNodes（O-5 裁决本迭代直接做）：先全量校验后单事务，任一节点
 *   失败整批回滚零部分落库（错误指明非法项序号）；元数据逐节点登记；
 * - 混用等价（CL-2-T14）：同批次「3 单条 + 1 批量(2)」与「5 单条」结果集相等。
 */

interface Stack {
  readonly root: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly service: KgWriteService;
}

const disposers: Array<() => void> = [];

function freshStack(): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-taskmeta-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const service = new KgWriteService({ store });
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database, store, graph, service };
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

// ── 原始库探针（直查 SQL——迁移/落值的权威证据面） ──────────

function columnsOf(root: string, table: string): string[] {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function rowsOf(root: string, sql: string): Record<string, unknown>[] {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function countOf(root: string, table: string): number {
  return rowsOf(root, `SELECT COUNT(*) AS n FROM ${table}`)[0]!["n"] as number;
}

function metaOf(root: string, key: string): string | null {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row === null ? null : row.value;
  } finally {
    db.close();
  }
}

/** T2.1 之前的旧库形态（nodes 无 origin_batch_id / change_log 无 task_id）。 */
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
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id TEXT NOT NULL,
  op TEXT NOT NULL,
  node_id TEXT NOT NULL,
  supersede_of TEXT,
  reason TEXT,
  ts TEXT NOT NULL
);
`);
  db.prepare(
    "INSERT INTO nodes (id, kind, name, digest, body, domain, layer, status, created_at, updated_at) " +
      "VALUES ('TR-1', 'rule', '既有规则', '既有摘要', '既有正文', 'tech', NULL, 'confirmed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO change_log (iteration_id, op, node_id, supersede_of, reason, ts) " +
      "VALUES ('iter-old', 'createNode', 'TR-1', NULL, NULL, '2026-01-01T00:00:00.000Z')",
  ).run();
  db.close();
}

// ── CL-2-T6：迁移面（老库 ALTER 补列 / 新库直建 / 幂等） ────

describe("kg 两列 additive 迁移（nodes.origin_batch_id + change_log.task_id）", () => {
  test("① 老库（无两列）打开 → 自动 ALTER 补列且既有节点/change_log 行零变化", () => {
    const s = freshStack();
    buildLegacyDb(s.root); // 前置：旧形态库 + 既有行
    const db = s.database.knowledgeConnection(s.root); // 打开触发演进
    expect(columnsOf(s.root, "nodes")).toContain("origin_batch_id");
    expect(columnsOf(s.root, "change_log")).toContain("task_id");
    // 既有行零变化（值逐字段不动；新列 NULL）
    const node = rowsOf(s.root, "SELECT * FROM nodes WHERE id = 'TR-1'")[0]!;
    expect(node["name"]).toBe("既有规则");
    expect(node["digest"]).toBe("既有摘要");
    expect(node["body"]).toBe("既有正文");
    expect(node["domain"]).toBe("tech");
    expect(node["layer"]).toBeNull();
    expect(node["status"]).toBe("confirmed");
    expect(node["created_at"]).toBe("2026-01-01T00:00:00.000Z");
    expect(node["origin_batch_id"]).toBeNull();
    const log = rowsOf(s.root, "SELECT * FROM change_log WHERE node_id = 'TR-1'")[0]!;
    expect(log["iteration_id"]).toBe("iter-old");
    expect(log["op"]).toBe("createNode");
    expect(log["supersede_of"]).toBeNull();
    expect(log["task_id"]).toBeNull();
    // 补列后写入面立即可用（演进与写通道同连接）
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes").get()).toEqual({ n: 1 });
  });

  test("② 老库重复打开（知识层/符号层双通道）幂等——列不重复补、数据不动", () => {
    const s = freshStack();
    buildLegacyDb(s.root);
    s.database.knowledgeConnection(s.root);
    s.database.closeAll();
    // 第二个 KgDatabase 实例重开同一库（另一进程/重启形态）
    const again = new KgDatabase();
    disposers.push(() => again.closeAll());
    again.knowledgeConnection(s.root);
    again.syncConnection(s.root); // 符号层通道同样过演进挂点
    const nodesCols = columnsOf(s.root, "nodes").filter((c) => c === "origin_batch_id");
    expect(nodesCols).toHaveLength(1); // ALTER 不重复执行
    expect(countOf(s.root, "nodes")).toBe(1);
    expect(countOf(s.root, "change_log")).toBe(1);
  });

  test("③ 新库直建含两列（冷启动即新形状，不经 ALTER）", () => {
    const s = freshStack();
    s.database.knowledgeConnection(s.root);
    expect(columnsOf(s.root, "nodes")).toContain("origin_batch_id");
    expect(columnsOf(s.root, "change_log")).toContain("task_id");
  });
});

// ── CL-2-T6：createNode 三元数据落值 + 不携带回归 ───────────

describe("createNode 任务元数据（layer / originBatchId / taskId）落值", () => {
  test("① 携带三元数据 → nodes.origin_batch_id + nodes.layer 落值 + change_log.task_id 记账（三处可查证）", () => {
    const s = freshStack();
    const result = s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-meta",
      taskId: "job-7",
      originBatchId: "batch-9",
      draft: { kind: "rule", name: "带任务元数据的规则", digest: "摘要", scene: "测试场景", layer: "L1", status: "confirmed" },
    });
    expect(result).toEqual({ ok: true, nodeId: "TR-1" });
    const node = rowsOf(s.root, "SELECT * FROM nodes WHERE id = 'TR-1'")[0]!;
    expect(node["layer"]).toBe("L1");
    expect(node["origin_batch_id"]).toBe("batch-9");
    const log = rowsOf(s.root, "SELECT * FROM change_log")[0]!;
    expect(log["task_id"]).toBe("job-7");
    expect(log["iteration_id"]).toBe("iter-meta");
    // 读面同源可查（getNode 聚合投影携带新列）
    const detail = s.graph.getNode(s.root, "TR-1")!;
    expect(detail.node.layer).toBe("L1");
    expect(detail.node.originBatchId).toBe("batch-9");
    expect(detail.changeLog[0]!.taskId).toBe("job-7");
  });

  test("② 不携带 → 行为与现状逐字节一致：两列 NULL、change_log 形状不变", () => {
    const s = freshStack();
    const result = s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-plain",
      draft: { kind: "rule", name: "普通规则", digest: "摘要", scene: "测试场景" },
    });
    expect(result).toEqual({ ok: true, nodeId: "TR-1" });
    const node = rowsOf(s.root, "SELECT * FROM nodes WHERE id = 'TR-1'")[0]!;
    expect(node["origin_batch_id"]).toBeNull();
    expect(node["layer"]).toBeNull();
    expect(node["status"]).toBe("draft");
    const log = rowsOf(s.root, "SELECT * FROM change_log")[0]!;
    expect(log["task_id"]).toBeNull();
    expect(log["op"]).toBe("createNode");
    expect(log["supersede_of"]).toBeNull();
  });

  test("③ 元数据字段形态校验：非字符串 / 空串 → KG_E_SCHEMA（新字段全可选带缺省）", () => {
    const s = freshStack();
    s.database.knowledgeConnection(s.root); // 前置建库（拒绝路径零 IO，行数断言可读表）
    const bad1 = s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-bad",
      taskId: 42,
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    } as unknown as KnowledgeWriteOp);
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) {
      expect(bad1.error.code).toBe("KG_E_SCHEMA");
      expect(bad1.error.path).toBe("op.taskId");
    }
    const bad2 = s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-bad",
      originBatchId: "  ",
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    } as unknown as KnowledgeWriteOp);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) {
      expect(bad2.error.code).toBe("KG_E_SCHEMA");
      expect(bad2.error.path).toBe("op.originBatchId");
    }
    expect(countOf(s.root, "nodes")).toBe(0); // 校验前置：零写入
  });
});

// ── CL-2-T14 / V-1②：batchCreateNodes 批量 op ──────────────

describe("batchCreateNodes（先全量校验后单事务，失败整批回滚）", () => {
  test("① 5 节点单 op → 全部落库 + 逐节点元数据齐 + change_log 逐行 task_id 记账", () => {
    const s = freshStack();
    const nodes = [1, 2, 3, 4, 5].map((i): CreateNodePayload => ({
      draft: { kind: "rule", name: `批量规则 ${i}`, digest: `第 ${i} 条摘要`, scene: "测试场景", layer: "L2", status: "confirmed" },
    }));
    const result = s.service.write(s.root, {
      kind: "batchCreateNodes",
      iterationId: "iter-batch",
      taskId: "job-1",
      originBatchId: "batch-1",
      nodes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodeId).toBe("TR-5"); // 末节点（发号顺序内联）
    expect(countOf(s.root, "nodes")).toBe(5);
    expect(countOf(s.root, "change_log")).toBe(5);
    for (const row of rowsOf(s.root, "SELECT * FROM nodes")) {
      expect(row["origin_batch_id"]).toBe("batch-1");
      expect(row["layer"]).toBe("L2");
      expect(row["status"]).toBe("confirmed");
    }
    for (const row of rowsOf(s.root, "SELECT * FROM change_log")) {
      expect(row["task_id"]).toBe("job-1");
      expect(row["iteration_id"]).toBe("iter-batch");
      expect(row["op"]).toBe("createNode");
    }
    expect(metaOf(s.root, "seq:rule")).toBe("5"); // 发号推进到批量末
  });

  test("② 校验期失败（第 3 项 digest 超行）→ 整批拒绝，错误路径指明非法项序号，零 IO", () => {
    const s = freshStack();
    s.database.knowledgeConnection(s.root); // 前置建库（校验前置零 IO，行数断言可读表）
    const result = s.service.write(s.root, {
      kind: "batchCreateNodes",
      iterationId: "iter-batch",
      nodes: [
        { draft: { kind: "rule", name: "好 1", digest: "d1", scene: "测试场景" } },
        { draft: { kind: "rule", name: "好 2", digest: "d2", scene: "测试场景" } },
        { draft: { kind: "rule", name: "坏 3", digest: "一\n二\n三", scene: "测试场景" } },
        { draft: { kind: "rule", name: "好 4", digest: "d4", scene: "测试场景" } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_SCHEMA");
      expect(result.error.path).toBe("op.nodes[2].draft.digest"); // 序号 0-based 指明
    }
    expect(countOf(s.root, "nodes")).toBe(0);
    expect(countOf(s.root, "change_log")).toBe(0);
    expect(metaOf(s.root, "seq:rule")).toBeNull(); // 发号零推进
  });

  test("③ 事务期失败（第 2 项显式 id 与第 1 项冲突）→ 整批回滚零行落库（零部分落库）", () => {
    const s = freshStack();
    const result = s.service.write(s.root, {
      kind: "batchCreateNodes",
      iterationId: "iter-batch",
      taskId: "job-x",
      nodes: [
        { id: "TR-100", draft: { kind: "rule", name: "先落", digest: "d1", scene: "测试场景" } },
        { id: "TR-100", draft: { kind: "rule", name: "撞号", digest: "d2", scene: "测试场景" } },
        { draft: { kind: "rule", name: "第三", digest: "d3", scene: "测试场景" } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_ID");
      expect(result.error.path).toBe("op.nodes[1].id");
      expect(result.error.message).toContain("1"); // 错误指明非法项序号
      expect(result.error.message).toContain("整批");
    }
    expect(countOf(s.root, "nodes")).toBe(0);
    expect(countOf(s.root, "change_log")).toBe(0);
    expect(metaOf(s.root, "seq:rule")).toBeNull(); // 计数器随事务回滚
  });

  test("④ nodes 缺失/空数组 → KG_E_SCHEMA（节点数组非空）", () => {
    const s = freshStack();
    s.database.knowledgeConnection(s.root); // 前置建库
    const empty = s.service.write(s.root, {
      kind: "batchCreateNodes",
      iterationId: "iter-batch",
      nodes: [],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("KG_E_SCHEMA");
      expect(empty.error.path).toBe("op.nodes");
    }
    const missing = s.service.write(s.root, {
      kind: "batchCreateNodes",
      iterationId: "iter-batch",
    } as unknown as KnowledgeWriteOp);
    expect(missing.ok).toBe(false);
    expect(countOf(s.root, "nodes")).toBe(0);
  });

  test("⑤ 显式 id 保号语义逐项适用（kind 前缀不符 → 序号指明的结构化拒绝）", () => {
    const s = freshStack();
    s.database.knowledgeConnection(s.root); // 前置建库
    const result = s.service.write(s.root, {
      kind: "batchCreateNodes",
      iterationId: "iter-batch",
      nodes: [
        { draft: { kind: "entity", name: "实体", digest: "d", scene: "测试场景" } },
        { id: "TR-9", draft: { kind: "entity", name: "前缀错", digest: "d", scene: "测试场景" } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_SCHEMA");
      expect(result.error.path).toBe("op.nodes[1].id");
    }
    expect(countOf(s.root, "nodes")).toBe(0);
  });
});

// ── CL-2-T14：单条/批量混用等价 ────────────────────────────

describe("混用等价：3 单条 + 1 批量(2) 与 5 单条结果集相等", () => {
  test("两库终态逐行相等（nodes 全列投影 + change_log 全列投影）", () => {
    const a = freshStack();
    const b = freshStack();
    const meta = { iterationId: "iter-mix", taskId: "job-m", originBatchId: "batch-m" };
    const draftOf = (i: number): NodeDraft => ({
      kind: "rule",
      name: `混用规则 ${i}`,
      digest: `第 ${i} 条摘要`, scene: "测试场景",
      layer: "L1",
      status: "confirmed",
    });
    // A：3 单条 + 1 批量(2)
    for (const i of [1, 2, 3]) {
      expect(a.service.write(a.root, { kind: "createNode", ...meta, draft: draftOf(i) }).ok).toBe(true);
    }
    expect(
      a.service.write(a.root, { kind: "batchCreateNodes", ...meta, nodes: [{ draft: draftOf(4) }, { draft: draftOf(5) }] }).ok,
    ).toBe(true);
    // B：5 单条
    for (const i of [1, 2, 3, 4, 5]) {
      expect(b.service.write(b.root, { kind: "createNode", ...meta, draft: draftOf(i) }).ok).toBe(true);
    }
    const projection = (root: string) =>
      rowsOf(root, "SELECT kind, name, digest, body, domain, layer, origin_batch_id, status FROM nodes ORDER BY name");
    expect(projection(a.root)).toEqual(projection(b.root));
    const logProjection = (root: string) =>
      rowsOf(root, "SELECT iteration_id, op, node_id, supersede_of, reason, task_id FROM change_log ORDER BY seq");
    expect(logProjection(a.root)).toEqual(logProjection(b.root));
    expect(metaOf(a.root, "seq:rule")).toBe(metaOf(b.root, "seq:rule"));
  });
});

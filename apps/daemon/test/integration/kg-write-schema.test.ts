import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { KnowledgeWriteOp } from "../../src/domain/kg/types";

/**
 * I 层：kg service API schema 防线（CL-2.A10；AD-9「校验即防线」）。
 * 非法 KnowledgeWriteOp → 结构化拒绝（code/message/字段路径）+ 库零写入
 * （校验前置，port 不被触达、不落任何部分写入）。tmp 真库。
 */

interface Stack {
  readonly root: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly service: KgWriteService;
}

const stacks: Stack[] = [];
const disposers: Array<() => void> = [];

function freshStack(): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-write-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const service = new KgWriteService({ store });
  database.knowledgeConnection(root); // 前置建库（拒绝路径零写入断言可读表）
  const stack: Stack = { root, database, store, graph, service };
  stacks.push(stack);
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return stack;
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

/** 知识层四表行数（零写入断言用）。 */
function knowledgeCounts(root: string): { nodes: number; anchor_decl: number; change_log: number; edges: number } {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    const n = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      nodes: n("nodes"),
      anchor_decl: n("anchor_decl"),
      change_log: n("change_log"),
      edges: n("edges"),
    };
  } finally {
    db.close();
  }
}

const validDraft = { kind: "rule" as const, name: "写点唯一", digest: "SQLite 写语句只允许出现在白名单写点" };

describe("kg service API schema 防线（CL-2.A10）", () => {
  test("① 未知 op kind → KG_E_SCHEMA + 字段路径 op.kind，库零写入", () => {
    const { root, service } = freshStack();
    const result = service.write(root, {
      kind: "deleteNode",
      iterationId: "iter-1",
      nodeId: "TR-1",
    } as unknown as KnowledgeWriteOp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_SCHEMA");
      expect(result.error.path).toBe("op.kind");
      expect(typeof result.error.message).toBe("string");
    }
    expect(knowledgeCounts(root)).toEqual({ nodes: 0, anchor_decl: 0, change_log: 0, edges: 0 });
  });

  test("② createNode 缺必填 → KG_E_SCHEMA + 字段路径（draft.name / draft.digest）", () => {
    const { root, service } = freshStack();
    const noName = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", digest: "d" },
    } as unknown as KnowledgeWriteOp);
    expect(noName).toEqual({
      ok: false,
      error: { code: "KG_E_SCHEMA", message: expect.any(String), path: "op.draft.name" },
    });

    const noDigest = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n" },
    } as unknown as KnowledgeWriteOp);
    expect(noDigest.ok).toBe(false);
    if (!noDigest.ok) expect(noDigest.error.path).toBe("op.draft.digest");

    const badKind = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "ad-hoc", name: "n", digest: "d" },
    } as unknown as KnowledgeWriteOp);
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) {
      expect(badKind.error.code).toBe("KG_E_SCHEMA");
      expect(badKind.error.path).toBe("op.draft.kind");
    }
    expect(knowledgeCounts(root)).toEqual({ nodes: 0, anchor_decl: 0, change_log: 0, edges: 0 });
  });

  test("③ digest 超 2 行 → KG_E_SCHEMA + op.draft.digest（v1 digest ≤2 行约定）", () => {
    const { root, service } = freshStack();
    const result = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "第一行\n第二行\n第三行" },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "KG_E_SCHEMA", message: expect.any(String), path: "op.draft.digest" },
    });
    expect(knowledgeCounts(root).nodes).toBe(0);
    // 恰 2 行合法（边界）
    const edge = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "第一行\n第二行" },
    });
    expect(edge.ok).toBe(true);
  });

  test("④ addEdge verb 不在封闭词表 → KG_E_VERB + op.verb", () => {
    const { root, service } = freshStack();
    const created = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: validDraft,
    });
    expect(created.ok).toBe(true);
    const result = service.write(root, {
      kind: "addEdge",
      iterationId: "iter-1",
      srcId: "TR-1",
      verb: "producedIn",
      dstId: "TR-1",
    } as unknown as KnowledgeWriteOp);
    expect(result).toEqual({
      ok: false,
      error: { code: "KG_E_VERB", message: expect.any(String), path: "op.verb" },
    });
    expect(knowledgeCounts(root).edges).toBe(0); // 非法边零写入
  });

  test("⑤ 显式 id：形态/前缀不符 → KG_E_SCHEMA；与现存冲突 → KG_E_ID（保号迁移入口，AD-16）", () => {
    const { root, service } = freshStack();
    // 前缀与 kind 不符
    const wrongPrefix = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: validDraft,
      id: "E-7",
    } as unknown as KnowledgeWriteOp);
    expect(wrongPrefix.ok).toBe(false);
    if (!wrongPrefix.ok) {
      expect(wrongPrefix.error.code).toBe("KG_E_SCHEMA");
      expect(wrongPrefix.error.path).toBe("op.id");
    }
    // 复合前缀不在新号空间
    const legacyPrefix = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: validDraft,
      id: "TR-AD-47",
    } as unknown as KnowledgeWriteOp);
    expect(legacyPrefix.ok).toBe(false);
    if (!legacyPrefix.ok) expect(legacyPrefix.error.path).toBe("op.id");
    // 合法显式 id 落库后，同 id 二次写入 → 冲突拒绝、零写入
    const first = service.write(root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: validDraft,
      id: "TR-47",
    });
    expect(first).toEqual({ ok: true, nodeId: "TR-47" });
    const conflict = service.write(root, {
      kind: "createNode",
      iterationId: "iter-2",
      draft: validDraft,
      id: "TR-47",
    });
    expect(conflict).toEqual({
      ok: false,
      error: { code: "KG_E_ID", message: expect.any(String), path: "op.id" },
    });
    expect(knowledgeCounts(root)).toEqual({ nodes: 1, anchor_decl: 0, change_log: 1, edges: 0 });
  });

  test("⑥ 缺 iterationId / 非对象 op → KG_E_SCHEMA（change_log 每行需迭代 id）", () => {
    const { root, service } = freshStack();
    const noIteration = service.write(root, {
      kind: "createNode",
      draft: validDraft,
    } as unknown as KnowledgeWriteOp);
    expect(noIteration).toEqual({
      ok: false,
      error: { code: "KG_E_SCHEMA", message: expect.any(String), path: "op.iterationId" },
    });
    const notObject = service.write(root, "createNode" as unknown as KnowledgeWriteOp);
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.error.code).toBe("KG_E_SCHEMA");
    expect(knowledgeCounts(root).change_log).toBe(0);
  });
});

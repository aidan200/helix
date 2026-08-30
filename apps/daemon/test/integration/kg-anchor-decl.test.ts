import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { KnowledgeWriteOp, SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层：三级作用域锚声明（AD-13）写读往返 + 按表分域写入面
 * （anchor_decl 归 API 写、materialized_anchors 归 sync 写；global 声明永不物化）。
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
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-anchor-"));
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

function count(root: string, table: string): number {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const batch: SymbolBatch = {
  files: [{ path: "src/a.ts", mtime: 1, sha256: "h1" }],
  symbols: [{ name: "handler", kind: "function", spanStart: 3, spanEnd: 9, file: "src/a.ts" }],
  containsEdges: [],
  materializedAnchors: [
    { nodeId: "TR-1", anchorPath: "src/a.ts", anchorSymbol: "handler", anchorKind: "symbol" },
  ],
  baseline: "2026-08-25T00:00:00.000Z",
  degraded: false,
};

describe("三级作用域声明（AD-13）", () => {
  test("① global/path/symbol 三级 scope_kind 写读往返", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    });
    const declared = s.service.write(s.root, {
      kind: "declareAnchors",
      iterationId: "iter-1",
      nodeId: "TR-1",
      anchors: [
        { scopeKind: "global" },
        { scopeKind: "path", pattern: "src/**/*.ts" },
        { scopeKind: "symbol", pattern: "src/foo.ts#Bar" },
      ],
    });
    expect(declared.ok).toBe(true);
    expect(s.graph.getNode(s.root, "TR-1")?.anchorDeclarations).toEqual([
      { scopeKind: "global", pattern: "" },
      { scopeKind: "path", pattern: "src/**/*.ts" },
      { scopeKind: "symbol", pattern: "src/foo.ts#Bar" },
    ]);
  });

  test("② global 声明不被物化：declareAnchors 只写 anchor_decl，materialized_anchors 零行（物化归 sync/T2.2）", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    });
    s.service.write(s.root, {
      kind: "declareAnchors",
      iterationId: "iter-1",
      nodeId: "TR-1",
      anchors: [{ scopeKind: "global" }, { scopeKind: "path", pattern: "src/**" }],
    });
    expect(count(s.root, "anchor_decl")).toBe(2);
    expect(count(s.root, "materialized_anchors")).toBe(0); // 知识层通道不碰物化表
    expect(s.graph.getAttachmentSnapshot(s.root)).toEqual({
      nodes: [],
      fileAnchors: [],
      symbolAnchors: [],
      contains: [],
    });
  });

  test("③ 非法声明：scopeKind 越界 / path 空 pattern / global 带 pattern / 重复声明 → KG_E_SCHEMA + 字段路径", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    });
    const cases: Array<{ op: KnowledgeWriteOp; path: string }> = [
      {
        op: {
          kind: "declareAnchors",
          iterationId: "iter-1",
          nodeId: "TR-1",
          anchors: [{ scopeKind: "weird", pattern: "x" }],
        } as unknown as KnowledgeWriteOp,
        path: "op.anchors[0].scopeKind",
      },
      {
        op: {
          kind: "declareAnchors",
          iterationId: "iter-1",
          nodeId: "TR-1",
          anchors: [{ scopeKind: "path", pattern: "" }],
        },
        path: "op.anchors[0].pattern",
      },
      {
        op: {
          kind: "declareAnchors",
          iterationId: "iter-1",
          nodeId: "TR-1",
          anchors: [{ scopeKind: "global", pattern: "src/**" }],
        },
        path: "op.anchors[0].pattern",
      },
      {
        op: {
          kind: "declareAnchors",
          iterationId: "iter-1",
          nodeId: "TR-1",
          anchors: [
            { scopeKind: "path", pattern: "a.ts" },
            { scopeKind: "path", pattern: "a.ts" },
          ],
        },
        path: "op.anchors[1]",
      },
    ];
    for (const { op, path } of cases) {
      const result = s.service.write(s.root, op);
      expect(result.ok, path).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("KG_E_SCHEMA");
        expect(result.error.path).toBe(path);
      }
    }
    expect(count(s.root, "anchor_decl")).toBe(0); // 全部拒绝、零写入
  });

  test("④ declareAnchors 声明语义为全集替换：二次声明覆盖一次声明", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    });
    s.service.write(s.root, {
      kind: "declareAnchors",
      iterationId: "iter-1",
      nodeId: "TR-1",
      anchors: [{ scopeKind: "path", pattern: "old/**" }],
    });
    s.service.write(s.root, {
      kind: "declareAnchors",
      iterationId: "iter-2",
      nodeId: "TR-1",
      anchors: [{ scopeKind: "symbol", pattern: "src/x.ts#f" }],
    });
    expect(s.graph.getNode(s.root, "TR-1")?.anchorDeclarations).toEqual([
      { scopeKind: "symbol", pattern: "src/x.ts#f" },
    ]);
  });

  test("⑤ declareAnchors 对不存在节点 → KG_E_ID；空数组 = 清空声明（显式）", () => {
    const s = freshStack();
    const missing = s.service.write(s.root, {
      kind: "declareAnchors",
      iterationId: "iter-1",
      nodeId: "TR-404",
      anchors: [{ scopeKind: "global" }],
    });
    expect(missing).toEqual({
      ok: false,
      error: { code: "KG_E_ID", message: expect.any(String), path: "op.nodeId" },
    });
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    });
    s.service.write(s.root, {
      kind: "declareAnchors",
      iterationId: "iter-1",
      nodeId: "TR-1",
      anchors: [{ scopeKind: "path", pattern: "a.ts" }],
    });
    s.service.write(s.root, { kind: "declareAnchors", iterationId: "iter-2", nodeId: "TR-1", anchors: [] });
    expect(s.graph.getNode(s.root, "TR-1")?.anchorDeclarations).toEqual([]);
  });
});

describe("读面（KnowledgeGraphPort 雏形：search/attachment snapshot）", () => {
  test("① search：name/digest 子串命中、重名多行靠 digest 区分、按 id 确定性排序", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "写点唯一", digest: "甲摘要", scene: "测试场景" },
    });
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "写点唯一", digest: "乙摘要", scene: "测试场景" },
    });
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "entity", name: "无关", digest: "丙摘要", scene: "测试场景" },
    });
    const byName = s.graph.search(s.root, "写点唯一");
    expect(byName.map((row) => row.id)).toEqual(["TR-1", "TR-2"]);
    expect(byName.map((row) => row.digest)).toEqual(["甲摘要", "乙摘要"]);
    expect(s.graph.search(s.root, "乙摘要").map((row) => row.id)).toEqual(["TR-2"]); // digest 命中
    expect(s.graph.search(s.root, "不存在")).toEqual([]);
  });

  test("② attachment 快照：物化锚 join 节点 digest（分组投影，T1.2 匹配层契约）；superseded 节点不进快照", async () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "附着规则", digest: "附着摘要", scene: "测试场景" },
    });
    await s.store.applySync(s.root, batch);
    expect(s.graph.getAttachmentSnapshot(s.root)).toEqual({
      nodes: [{ id: "TR-1", kind: "rule", name: "附着规则", digest: "附着摘要", scene: "测试场景", scopeKind: "symbol" }],
      fileAnchors: [],
      symbolAnchors: [
        // span 从符号层 join（上次 sync 值；缺省表示无法参与 L3 兕底——T1.2 契约）
        { nodeId: "TR-1", path: "src/a.ts", symbol: "handler", span: { startLine: 3, endLine: 9 } },
      ],
      contains: [],
    });
    // supersede 后旧节点不再到达（附着面只呈现现行知识）
    s.service.write(s.root, { kind: "supersede", iterationId: "iter-2", nodeId: "TR-1", reason: "r" });
    expect(s.graph.getAttachmentSnapshot(s.root)).toEqual({
      nodes: [],
      fileAnchors: [],
      symbolAnchors: [],
      contains: [],
    });
  });
});

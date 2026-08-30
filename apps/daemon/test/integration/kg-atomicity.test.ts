import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { AnchorKind, SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层：多表 op 原子性——中途故障（注入 fault）→ 全回滚不落半态
 * （知识层 op 事务 + sync 单事务；AD-9 校验前置 + 崩溃一致）。
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
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-atomic-"));
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

describe("writeKnowledge 多表 op 原子性", () => {
  test("① declareAnchors 中途故障（重复行 PK 冲突，绕过 service 校验直打 port）→ 全回滚：原声明原样、change_log 不增", () => {
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
      anchors: [{ scopeKind: "path", pattern: "old/a.ts" }],
    });
    const before = count(s.root, "change_log"); // create + declare = 2

    // 注入 fault：port 层直接收到重复声明（service 层本会拒绝——此处绕过以验证事务回滚）
    const result = s.store.writeKnowledge(s.root, {
      kind: "declareAnchors",
      iterationId: "iter-9",
      nodeId: "TR-1",
      anchors: [
        { scopeKind: "path", pattern: "new/b.ts" },
        { scopeKind: "path", pattern: "new/b.ts" }, // 第二行触发 PK 冲突（第一行已插入）
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KG_E_INTERNAL");

    // 全回滚：DELETE 旧行被回滚、首行插入被回滚、change_log 零追加
    expect(s.graph.getNode(s.root, "TR-1")?.anchorDeclarations).toEqual([
      { scopeKind: "path", pattern: "old/a.ts" },
    ]);
    expect(count(s.root, "change_log")).toBe(before);
    expect(count(s.root, "anchor_decl")).toBe(1);
  });

  test("② supersede+replacement 中途故障（新号 INSERT 撞库内残留行）→ 全回滚：状态不翻、change_log 不增", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "d", scene: "测试场景" },
    });
    // 注入 fault：库内直插 TR-2（模拟计数器不知情的残留行，如崩溃残留/外部写入）
    // —— replacement 自动发号将得到 TR-2，INSERT 在 status UPDATE 之后撞 PK
    const raw = new Database(kgDbPath(s.root));
    try {
      raw
        .prepare(
          "INSERT INTO nodes (id, kind, name, digest, created_at, updated_at) VALUES ('TR-2', 'rule', '残留', 'd', 't', 't')",
        )
        .run();
    } finally {
      raw.close();
    }

    const result = s.store.writeKnowledge(s.root, {
      kind: "supersede",
      iterationId: "iter-9",
      nodeId: "TR-1",
      reason: "r",
      replacementNodeDraft: { kind: "rule", name: "rep", digest: "d2" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KG_E_INTERNAL");

    // 全回滚：status UPDATE 被回滚（仍 draft）、无新号、change_log 零追加
    expect(s.graph.getNode(s.root, "TR-1")?.node.status).toBe("draft");
    expect(count(s.root, "nodes")).toBe(2); // TR-1 + 残留 TR-2
    expect(count(s.root, "change_log")).toBe(1); // 仅最初 create 行
  });

  test("③ applySync 中途故障（materialized_anchors 非法 anchor_kind 触发表级 CHECK）→ throw + 符号三表/物化/meta 全空", async () => {
    const s = freshStack();
    const faulty: SymbolBatch = {
      files: [{ path: "a.ts", mtime: 1, sha256: "h1" }],
      symbols: [{ name: "f", kind: "function", spanStart: 1, spanEnd: 2, file: "a.ts" }],
      containsEdges: [{ outerSymbol: "A", innerSymbol: "f", file: "a.ts" }],
      materializedAnchors: [
        { nodeId: "TR-1", anchorPath: "a.ts", anchorSymbol: null, anchorKind: "path" },
        { nodeId: "TR-1", anchorPath: "b.ts", anchorSymbol: null, anchorKind: "bogus" as AnchorKind }, // CHECK 拒绝（非法字面量绕过类型层，验证 DB CHECK 兑底）
      ],
      baseline: "2026-08-25T00:00:00.000Z",
      degraded: false,
    };
    await expect(s.store.applySync(s.root, faulty as unknown as SymbolBatch)).rejects.toThrow();
    expect(count(s.root, "files")).toBe(0);
    expect(count(s.root, "symbols")).toBe(0);
    expect(count(s.root, "contains_edges")).toBe(0);
    expect(count(s.root, "materialized_anchors")).toBe(0);
    expect(s.graph.getIndexStatus(s.root).baseline).toBeNull(); // meta 基准戳未落
  });
});

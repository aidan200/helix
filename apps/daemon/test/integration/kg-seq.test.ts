import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层：编号事务内分配（AD-5/AD-16：seq 只增不减永不复用）+
 * 并发双通道（AD-15：API 写与 applySync 按表分域不竞争、各自连接+事务）。
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
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-seq-"));
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

function createOp(iterationId: string, name: string) {
  return {
    kind: "createNode" as const,
    iterationId,
    draft: { kind: "rule" as const, name, digest: "d" },
  };
}

const batch: SymbolBatch = {
  files: [{ path: "src/a.ts", mtime: 1, sha256: "h1" }],
  symbols: [{ name: "handler", kind: "function", spanStart: 3, spanEnd: 9, file: "src/a.ts" }],
  containsEdges: [{ outerSymbol: "Server", innerSymbol: "handler", file: "src/a.ts" }],
  materializedAnchors: [{ nodeId: "TR-1", anchorPath: "src/a.ts", anchorSymbol: "handler", anchorKind: "symbol" }],
  baseline: "2026-08-25T00:00:00.000Z",
  degraded: false,
};

function tableCount(root: string, table: string): number {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("编号事务内分配（AD-16）", () => {
  test("① 同 tick 双 create → 两序号不重（事务内分配）；kind 分空间独立计数", () => {
    const s = freshStack();
    const results = [
      s.service.write(s.root, createOp("iter-1", "r1")),
      s.service.write(s.root, createOp("iter-1", "r2")),
      s.service.write(s.root, { ...createOp("iter-1", "e1"), draft: { kind: "entity" as const, name: "e1", digest: "d" } }),
    ];
    expect(results.map((r) => (r.ok ? r.nodeId : null))).toEqual(["TR-1", "TR-2", "E-1"]);
    expect(tableCount(s.root, "nodes")).toBe(3);
  });

  test("② 显式保号 id 推进计数器：显式 TR-5 后自动发号 → TR-6（永不复用）", () => {
    const s = freshStack();
    expect(
      s.service.write(s.root, { ...createOp("iter-1", "r"), id: "TR-5" }),
    ).toEqual({ ok: true, nodeId: "TR-5" });
    // 显式 id 不抬高时不倒退：显式 TR-3 也合法（低于计数器，但未占用）
    expect(s.service.write(s.root, { ...createOp("iter-1", "r"), id: "TR-3" })).toEqual({
      ok: true,
      nodeId: "TR-3",
    });
    // 计数器只进不退：自动发号从 max(5)+1 起，绝不复用已占用号
    expect(s.service.write(s.root, createOp("iter-2", "auto"))).toEqual({ ok: true, nodeId: "TR-6" });
    expect(s.service.write(s.root, createOp("iter-2", "auto2"))).toEqual({ ok: true, nodeId: "TR-7" });
  });
});

describe("并发双通道（AD-15：知识层写 vs 符号层写按表分域不竞争）", () => {
  test("① applySync（未 await）与 writeKnowledge 并发 → 无死锁、各自表域完整", async () => {
    const s = freshStack();
    const syncStarted = s.store.applySync(s.root, batch); // 符号层通道先行（不 await）
    const apiWrite = s.service.write(s.root, createOp("iter-1", "知识层节点")); // 知识层通道并发写
    await syncStarted;
    await s.store.applySync(s.root, { ...batch, baseline: "2026-08-25T00:00:01.000Z" }); // 二次 sync 推进基准戳

    expect(apiWrite.ok).toBe(true);
    // 知识层表域：API 写完整落库，sync 未越界写知识层
    expect(tableCount(s.root, "nodes")).toBe(1);
    expect(tableCount(s.root, "change_log")).toBe(1);
    // 符号层表域：sync 完整落库（upsert 幂等，二次 sync 不翻倍），API 未越界写符号层
    expect(tableCount(s.root, "files")).toBe(1);
    expect(tableCount(s.root, "symbols")).toBe(1);
    expect(tableCount(s.root, "contains_edges")).toBe(1);
    expect(tableCount(s.root, "materialized_anchors")).toBe(1);
    // meta 基准戳随 sync 推进（时序可判定，AD-15）
    expect(s.graph.getIndexStatus(s.root).baseline).toBe("2026-08-25T00:00:01.000Z");
  });

  test("② getIndexStatus：基准戳/符号计数/degraded 标记位", async () => {
    const s = freshStack();
    // 未 sync：无基准戳、零符号、非降级
    expect(s.graph.getIndexStatus(s.root)).toEqual({ baseline: null, symbolCount: 0, degraded: false });
    await s.store.applySync(s.root, batch);
    expect(s.graph.getIndexStatus(s.root)).toEqual({
      baseline: "2026-08-25T00:00:00.000Z",
      symbolCount: 1,
      degraded: false,
    });
    await s.store.applySync(s.root, { ...batch, degraded: true, baseline: "2026-08-25T00:00:02.000Z" });
    expect(s.graph.getIndexStatus(s.root)).toEqual({
      baseline: "2026-08-25T00:00:02.000Z",
      symbolCount: 1,
      degraded: true,
    });
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KG_TABLES } from "../../src/adapters/driven/sqlite-kg/schema";
import { KgVerifyService } from "../../src/application/services/kg/KgVerifyService";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层（CL-3.A6）：三检查编排在真 .kg 库上「只列不修」——检出清单输出
 * + 执行前后库内容逐字节不变（机械判据）。数据源：T1.1 读面/T2.2 orphan
 * 标记（applySync 两拍：先物化后失效）/知识层写入（KgWriteService）。
 */

const DAY = 86_400_000;
const ITER = "iter-20260825-11fo";

interface Stack {
  readonly root: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
  readonly verify: KgVerifyService;
}

const disposers: Array<() => void> = [];

function freshStack(): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-verify-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const verify = new KgVerifyService({ graph });
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database, store, graph, write, verify };
}

/** 库内容快照：kg.db/kg.db-wal 字节哈希 + 全表规范化 dump（-shm 为瞬态索引不入比对）。 */
function snapshotOf(stack: Stack): string {
  const parts: string[] = [];
  for (const suffix of ["kg.db", "kg.db-wal"]) {
    const file = path.join(path.dirname(kgDbPath(stack.root)), suffix);
    if (!existsSync(file)) continue;
    parts.push(`${suffix}=${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
  }
  const db = stack.database.knowledgeConnection(stack.root);
  for (const table of KG_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    parts.push(`${table}=${JSON.stringify(rows)}`);
  }
  return parts.join("\n");
}

function batch(over: Partial<SymbolBatch> & { baseline: string }): SymbolBatch {
  return { files: [], symbols: [], containsEdges: [], materializedAnchors: [], degraded: false, ...over };
}

/** fixture：冲突边 + 腐烂锚（两拍 sync）+ 活跃度错位 + 孤儿/宽限节点。 */
function seed(stack: Stack): void {
  const w = stack.write;
  const ok = (...results: { ok: boolean }[]) => {
    for (const r of results) expect(r.ok).toBe(true);
  };
  ok(
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "分层依赖单向", digest: "import 只准外层指向内层", status: "confirmed" } }), // TR-1
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "双向往返", digest: "禁止双向 import", status: "confirmed" } }), // TR-2
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "写路径白名单", digest: "落盘写点收口清单", status: "confirmed" } }), // TR-3
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "主代理", digest: "编排实体", status: "confirmed" } }), // E-1 无锚无边（confirmed → 孤儿节点）
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "新近草稿", digest: "今日 findings 落账" } }), // TR-4 draft 新建 → 宽限
  );
  // 双向 governs 矛盾（TR-1 ↔ TR-2）+ 单向合法边（TR-1 → TR-3）
  ok(
    w.write(stack.root, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "TR-2" }),
    w.write(stack.root, { kind: "addEdge", iterationId: ITER, srcId: "TR-2", verb: "governs", dstId: "TR-1" }),
    w.write(stack.root, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "TR-3" }),
  );
  // sync 拍一：TR-1 死锚前身（src/gone.ts#oldFn）+ TR-3 活跃锚（src/hot.ts#savePath）
  const now = Date.now();
  stack.store.applySync(stack.root, batch({
    baseline: "1",
    files: [
      { path: "src/gone.ts", mtime: now - 90 * DAY, sha256: "g1" },
      { path: "src/hot.ts", mtime: now - 1 * DAY, sha256: "h1" },
    ],
    symbols: [{ name: "oldFn", kind: "function", spanStart: 1, spanEnd: 9, file: "src/gone.ts" }, { name: "savePath", kind: "function", spanStart: 1, spanEnd: 9, file: "src/hot.ts" }],
    materializedAnchors: [
      { nodeId: "TR-1", anchorPath: "src/gone.ts", anchorSymbol: "oldFn", anchorKind: "symbol" },
      { nodeId: "TR-3", anchorPath: "src/hot.ts", anchorSymbol: "savePath", anchorKind: "symbol" },
    ],
  }));
  // sync 拍二：src/gone.ts 符号消亡 → TR-1 锚 orphan 标记（T2.2 差集通道）
  stack.store.applySync(stack.root, batch({
    baseline: "2",
    files: [{ path: "src/hot.ts", mtime: now - 1 * DAY, sha256: "h1" }],
    deletedFiles: ["src/gone.ts"],
    orphanedAnchors: [{ nodeId: "TR-1", anchorPath: "src/gone.ts", anchorSymbol: "oldFn", anchorKind: "symbol" }],
  }));
  // 活跃度错位证据：TR-3 知识侧久未动（fixture 直改时间戳；文件 src/hot.ts 昨日仍改）
  stack.database
    .knowledgeConnection(stack.root)
    .prepare("UPDATE nodes SET created_at = ?, updated_at = ? WHERE id = 'TR-3'")
    .run(new Date(now - 60 * DAY).toISOString(), new Date(now - 60 * DAY).toISOString());
}

describe("KgVerifyService：三检查编排（I 层，真 .kg 库）", () => {
  test("① findConflicts：双向 governs 矛盾检出（单向合法边零误报）", () => {
    const s = freshStack();
    seed(s);
    const items = s.verify.findConflicts(s.root);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("mutual_governs");
    expect(items[0]!.nodes.map((n) => n.name).sort()).toEqual(["分层依赖单向", "双向往返"]);
  });

  test("② findOrphans：腐烂锚 + 孤儿节点双口径；宽限草稿不误报", () => {
    const s = freshStack();
    seed(s);
    const items = s.verify.findOrphans(s.root);
    const dead = items.filter((i) => i.kind === "dead_anchor");
    const orphanNodes = items.filter((i) => i.kind === "orphan_node");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.anchor.anchorPath).toBe("src/gone.ts");
    expect(dead[0]!.summary).toContain("src/gone.ts#oldFn");
    // 孤儿节点：E-1（confirmed 无锚无边）；TR-3 有锚、TR-4 draft 宽限 → 不列
    expect(orphanNodes.map((i) => i.node.id)).toEqual(["E-1"]);
    expect(orphanNodes[0]!.node.name).toBe("主代理");
  });

  test("③ findActivityMismatch：高 churn 文件 × 久未动锚 → 疑似条目（含全部限定词）", () => {
    const s = freshStack();
    seed(s);
    const items = s.verify.findActivityMismatch(s.root);
    expect(items).toHaveLength(1);
    expect(items[0]!.node.id).toBe("TR-3");
    expect(items[0]!.anchor.anchorPath).toBe("src/hot.ts");
    expect(items[0]!.summary).toContain("疑似过时");
    expect(items[0]!.summary).toContain("非结论");
    expect(items[0]!.summary).toContain("写路径白名单");
  });

  test("④ CL-3.A6 只列不修：三检查执行前后库内容逐字节不变", async () => {
    const s = freshStack();
    seed(s);
    const before = snapshotOf(s);
    s.verify.findConflicts(s.root);
    s.verify.findOrphans(s.root);
    s.verify.findActivityMismatch(s.root);
    await new Promise((resolve) => setImmediate(resolve)); // 让任何异步残留有机会落盘
    const after = snapshotOf(s);
    expect(after).toBe(before);
  });

  test("⑤ 空库（冷启动首建零数据）→ 三检查全部空清单不抛", () => {
    const s = freshStack();
    expect(s.verify.findConflicts(s.root)).toEqual([]);
    expect(s.verify.findOrphans(s.root)).toEqual([]);
    expect(s.verify.findActivityMismatch(s.root)).toEqual([]);
  });
});

afterAll(() => {
  for (const dispose of disposers) dispose();
});

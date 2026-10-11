/**
 * kg 锚收口对账脚本（批4 WP-G「收口锚对账点」机械面）单测——真 SQLite
 * tmp 库 + 被测写面建点/声明，物化锚行按布景直接 SQL 插入（不走被测写面，
 * kg-update-prune 同款姿势）。
 *
 * 断言面（brief 测试要求）：
 * 1. 对账判定：改动文件 → affected 管辖节点 → 锚健康分类（声明 vs 物化、
 *    orphan 状态）——
 *    ① 无声明旧键 + 节点附着面健康 → 机械可处置（定向 prune，E-9 形态3/R3 同判）；
 *    ② 声明仍在的 tombstone（E-9 形态1 真信号）→ 残量，禁机械处置；
 *    ③ 声明零物化（死声明嫌疑，E-9 文件面/符号面边界）→ 残量；
 *    ④ 节点内混合形态 → prune 粒度为节点级会连带删除保留型 tombstone，
 *       整体降残量需人裁；
 *    ⑤ 零附着节点 tombstone → 残量（归体检 orphan_node 口径）。
 * 2. 只读默认零写：不带 fix 跑对账，物化锚/change_log 零变化。
 * 3. --fix 定向 prune 幂等：只清机械项 tombstone、保留型不动；重跑零可处置
 *    零写（prune op 零删除不落 change_log）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { AnchorDeclaration } from "../../src/domain/kg/types";
import {
  classifyNodeHealth,
  createReconcileStack,
  formatReconcileReport,
  reconcileAnchors,
  type ReconcileStack,
} from "../../scripts/kg-anchor-reconcile";

const ITER = "iter-kg-anchor-reconcile-test";

const disposers: Array<() => void> = [];

afterAll(() => {
  for (const dispose of disposers) dispose();
  disposers.length = 0;
});

function freshStack(): ReconcileStack {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-reconcile-"));
  const stack = createReconcileStack(root);
  disposers.push(() => {
    stack.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return stack;
}

function probe<T>(root: string, sql: string): T[] {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function createNode(stack: ReconcileStack, name: string): string {
  const result = stack.write.write(stack.projectRoot, {
    kind: "createNode",
    iterationId: ITER,
    draft: { kind: "rule", name, digest: "d", scene: "场景" },
  });
  if (!result.ok) throw new Error(`建点失败：${result.error.message}`);
  return result.nodeId!;
}

function declare(stack: ReconcileStack, nodeId: string, anchors: readonly AnchorDeclaration[]): void {
  const result = stack.write.write(stack.projectRoot, {
    kind: "declareAnchors",
    iterationId: ITER,
    nodeId,
    anchors,
  });
  if (!result.ok) throw new Error(`声明失败：${result.error.message}`);
}

/** 布景：直接 SQL 插物化锚行（被测面是读分类，布景不走写面）。 */
function seedMaterialized(
  stack: ReconcileStack,
  rows: readonly { nodeId: string; anchorPath: string; anchorSymbol: string; anchorKind: string; orphan: number }[],
): void {
  const db = stack.database.knowledgeConnection(stack.projectRoot);
  const insert = db.prepare(
    "INSERT INTO materialized_anchors (node_id, anchor_kind, anchor_path, anchor_symbol, orphan) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) insert.run(row.nodeId, row.anchorKind, row.anchorPath, row.anchorSymbol, row.orphan);
}

/** 五节点布景（分类五形态各一）；返回各节点 id。 */
function seedFiveForms(stack: ReconcileStack): { a: string; b: string; c: string; d: string; e: string } {
  const a = createNode(stack, "甲"); // ① 无声明旧键 + 健康 → 可处置
  declare(stack, a, [{ scopeKind: "path", pattern: "src/alive.ts" }]);
  const b = createNode(stack, "乙"); // ② 声明仍在 tombstone → 残量
  declare(stack, b, [{ scopeKind: "symbol", pattern: "src/dead.ts#fn" }]);
  const c = createNode(stack, "丙"); // ③ 声明零物化 → 残量
  declare(stack, c, [{ scopeKind: "path", pattern: "src/never.ts" }]);
  const d = createNode(stack, "丁"); // ④ 混合形态 → 整体降残量
  declare(stack, d, [{ scopeKind: "path", pattern: "src/half.ts" }]);
  const e = createNode(stack, "戊"); // ⑤ 零附着 tombstone → 残量
  seedMaterialized(stack, [
    { nodeId: a, anchorPath: "src/alive.ts", anchorSymbol: "", anchorKind: "path", orphan: 0 },
    { nodeId: a, anchorPath: "src/gone.ts", anchorSymbol: "", anchorKind: "path", orphan: 1 },
    { nodeId: b, anchorPath: "src/dead.ts", anchorSymbol: "fn", anchorKind: "symbol", orphan: 1 },
    { nodeId: d, anchorPath: "src/half.ts", anchorSymbol: "", anchorKind: "path", orphan: 1 },
    { nodeId: d, anchorPath: "src/stray.ts", anchorSymbol: "", anchorKind: "path", orphan: 1 },
    { nodeId: e, anchorPath: "src/z.ts", anchorSymbol: "", anchorKind: "path", orphan: 1 },
  ]);
  return { a, b, c, d, e };
}

const CHANGED = ["src/alive.ts", "src/dead.ts", "src/never.ts", "src/half.ts"];

describe("① 对账判定（affected 管辖节点 → 锚健康分类）", () => {
  test("① 无声明旧键+健康→机械可处置；② 声明仍在→残量；③ 死声明→残量；④ 混合形态→整体降残量", () => {
    const stack = freshStack();
    const { a, b, c, d } = seedFiveForms(stack);
    const report = reconcileAnchors(stack, { files: CHANGED });

    // affected 反查：四文件各命中一个管辖节点
    expect(report.files.map((f) => f.hits.length)).toEqual([1, 1, 1, 1]);
    expect(new Set(report.nodes.map((n) => n.nodeId))).toEqual(new Set([a, b, c, d]));

    // ① 机械可处置恰甲一枚（src/gone.ts 无声明旧键 + 节点有活锚）
    expect(report.fixable).toEqual([
      { nodeId: a, name: "甲", anchors: ["src/gone.ts"] },
    ]);

    // 残量：乙 1（形态1）+ 丙 1（死声明）+ 丁 2（混合整体降残量）= 4
    expect(report.residuals).toHaveLength(4);
    expect(report.residuals.filter((r) => r.nodeId === b)).toHaveLength(1);
    expect(report.residuals.filter((r) => r.nodeId === c)).toHaveLength(1);
    expect(report.residuals.filter((r) => r.nodeId === d)).toHaveLength(2);

    // 判定细节
    const nodeA = report.nodes.find((n) => n.nodeId === a)!;
    expect(nodeA.orphanVerdicts.map((v) => v.disposition)).toEqual(["prune-fixable"]);
    expect(nodeA.prunable).toBe(true);
    const nodeB = report.nodes.find((n) => n.nodeId === b)!;
    expect(nodeB.orphanVerdicts.map((v) => v.disposition)).toEqual(["residual"]);
    expect(nodeB.orphanVerdicts[0]!.reason).toContain("声明仍在");
    expect(nodeB.deadDeclarations).toHaveLength(0);
    const nodeC = report.nodes.find((n) => n.nodeId === c)!;
    expect(nodeC.deadDeclarations.map((decl) => decl.pattern)).toEqual(["src/never.ts"]);
    const nodeD = report.nodes.find((n) => n.nodeId === d)!;
    expect(nodeD.prunable).toBe(false);
    expect(nodeD.orphanVerdicts.map((v) => v.disposition)).toEqual(["residual", "residual"]);

    // 文本报告含两清单标题与判定
    const text = formatReconcileReport(report);
    expect(text).toContain("机械可处置");
    expect(text).toContain("需人判断残量");
    expect(text).toContain("src/gone.ts");
  });

  test("⑤ 零附着节点 tombstone → 残量（纯判定直调，归体检 orphan_node 口径）", () => {
    const stack = freshStack();
    const { e } = seedFiveForms(stack);
    const detail = stack.graph.getNode(stack.projectRoot, e)!;
    const verdict = classifyNodeHealth(detail);
    expect(verdict.prunable).toBe(false);
    expect(verdict.orphanVerdicts.map((v) => v.disposition)).toEqual(["residual"]);
    expect(verdict.orphanVerdicts[0]!.reason).toContain("零附着");
  });
});

describe("② 只读默认零写", () => {
  test("不带 fix 跑对账：物化锚与 change_log 零变化", () => {
    const stack = freshStack();
    seedFiveForms(stack);
    const anchorsBefore = probe(stack.projectRoot, "SELECT * FROM materialized_anchors ORDER BY node_id, anchor_path");
    const logCountBefore = probe<{ n: number }>(stack.projectRoot, "SELECT COUNT(*) AS n FROM change_log")[0]!.n;

    const report = reconcileAnchors(stack, { files: CHANGED });
    expect(report.fixes).toEqual([]);
    expect(report.fixable).toHaveLength(1); // 判定照跑，只是不动手

    const anchorsAfter = probe(stack.projectRoot, "SELECT * FROM materialized_anchors ORDER BY node_id, anchor_path");
    const logCountAfter = probe<{ n: number }>(stack.projectRoot, "SELECT COUNT(*) AS n FROM change_log")[0]!.n;
    expect(anchorsAfter).toEqual(anchorsBefore);
    expect(logCountAfter).toBe(logCountBefore);
  });
});

describe("③ --fix 定向 prune + 幂等", () => {
  test("只清机械项 tombstone，保留型不动；重跑零可处置零写", () => {
    const stack = freshStack();
    const { a, b, d, e } = seedFiveForms(stack);

    const first = reconcileAnchors(stack, { files: CHANGED, fix: true });
    expect(first.fixes).toEqual([{ nodeId: a, name: "甲", prunedCount: 1 }]);

    // 甲的孤儿行已清、活锚保留；乙/丁的保留型 tombstone 原样
    const rows = probe<{ node_id: string; anchor_path: string; orphan: number }>(
      stack.projectRoot,
      "SELECT node_id, anchor_path, orphan FROM materialized_anchors ORDER BY node_id, anchor_path",
    );
    expect(rows).toEqual([
      { node_id: a, anchor_path: "src/alive.ts", orphan: 0 },
      { node_id: b, anchor_path: "src/dead.ts", orphan: 1 },
      { node_id: d, anchor_path: "src/half.ts", orphan: 1 },
      { node_id: d, anchor_path: "src/stray.ts", orphan: 1 },
      { node_id: e, anchor_path: "src/z.ts", orphan: 1 },
    ]);
    const logRows = probe<{ node_id: string }>(
      stack.projectRoot,
      "SELECT node_id FROM change_log WHERE op = 'prune' ORDER BY node_id",
    );
    expect(logRows).toEqual([{ node_id: a }]);

    // 幂等：重跑零可处置、零 prune 写、change_log 不再增长
    const second = reconcileAnchors(stack, { files: CHANGED, fix: true });
    expect(second.fixable).toEqual([]);
    expect(second.fixes).toEqual([]);
    expect(
      probe<{ n: number }>(stack.projectRoot, "SELECT COUNT(*) AS n FROM change_log WHERE op = 'prune'")[0]!.n,
    ).toBe(1);
  });
});

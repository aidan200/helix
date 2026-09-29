import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import { KgViewerService, type KgHealthView } from "../../src/application/services/kg/KgViewerService";
import type { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import type { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import type { KgVerifyService } from "../../src/application/services/kg/KgVerifyService";
import type { OrphanItem } from "../../src/domain/kg/verify/orphans";

/**
 * P2 自动裁决审计面测试：port（listAutoAdjudications——change_log auto: 前缀
 * 聚合）+ viewer（autoAudit stats/切片 + health triageHint 积压提示）。
 *
 * auto: 前缀是机器裁决溯源契约（L0 anchorRelocate/prune 与 kg-triage
 * decideCandidate 共用）；人工写路径 reason 无前缀 → 不入审计面。
 */

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kg-auto-audit-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// ── ① port：真 sqlite 库（auto: 行过滤 + 最新在前） ──────────────────

describe("listAutoAdjudications（port 读面：auto: 前缀过滤）", () => {
  test("只返回 auto: 前缀行（decideCandidate 带 auto: reason），最新在前；人工行（createNode/无前缀）不入", () => {
    const root = makeRoot();
    const database = new KgDatabase();
    const store = new SqliteKnowledgeStore({ database });
    const graph = new SqliteKnowledgeGraph({ database });

    // 造行：候选 1 → applied（auto: reason）+ 候选 2 → discarded（auto: reason）
    //   + createNode（人工 reason 无前缀）+ proposeCandidate（reason=null）
    const c1 = store.writeKnowledge(root, { kind: "proposeCandidate", iterationId: "it", candidateKind: "sediment", title: "t1", body: "b" });
    expect(c1.ok).toBe(true);
    const c2 = store.writeKnowledge(root, { kind: "proposeCandidate", iterationId: "it", candidateKind: "sediment", title: "t2", body: "b" });
    expect(c2.ok).toBe(true);
    const d1 = store.writeKnowledge(root, {
      kind: "decideCandidate",
      iterationId: "it",
      candidateId: (c1 as { nodeId: string }).nodeId,
      decision: "applied",
      reason: "auto: 测试裁决一（证据充分）",
    });
    expect(d1.ok).toBe(true);
    const d2 = store.writeKnowledge(root, {
      kind: "decideCandidate",
      iterationId: "it",
      candidateId: (c2 as { nodeId: string }).nodeId,
      decision: "discarded",
      reason: "auto: 测试裁决二（重复沉淀）",
    });
    expect(d2.ok).toBe(true);
    const n = store.writeKnowledge(root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "e", digest: "d", scene: "测试" },
    });
    expect(n.ok).toBe(true);

    const entries = graph.listAutoAdjudications(root);
    expect(entries.length).toBe(2);
    expect(entries[0]!.reason).toContain("测试裁决二"); // 最新在前
    expect(entries[1]!.reason).toContain("测试裁决一");
    expect(entries.every((e) => e.reason.startsWith("auto: "))).toBe(true);
    expect(entries[0]!.op).toBe("decideCandidate");
    expect(entries[0]!.nodeId.length).toBeGreaterThan(0);
  });

  test("空库 → 空数组（读面不建库不报错）", () => {
    const root = makeRoot();
    const graph = new SqliteKnowledgeGraph({ database: new KgDatabase() });
    expect(graph.listAutoAdjudications(root)).toEqual([]);
  });
});

// ── ② viewer：autoAudit 聚合 + health triageHint（mock 面同 triage 测试范式） ──

function makeViewer(opts: {
  autoEntries?: { op: string; nodeId: string; reason: string; taskId: string | null; ts: string }[];
  candidateCounts?: { pending: number; deferred: number };
  deadAnchors?: number;
}): KgViewerService {
  return new KgViewerService({
    project: {
      hasIndex: () => true,
      resolve: (p: string) => (p === "alpha" ? "/tmp/kg-auto-audit-viewer/alpha" : undefined),
    } as unknown as KgProjectService,
    sync: { isBuilding: () => false, getStatus: () => ({ phase: "synced", symbolCount: 0, syncedAt: null }) } as unknown as KgSyncService,
    report: {} as unknown as import("../../src/application/services/kg/KgReportService").KgReportService,
    write: {} as unknown as import("../../src/application/services/kg/KgWriteService").KgWriteService,
    verify: {
      findConflicts: () => [],
      findOrphans: (): OrphanItem[] =>
        Array.from({ length: opts.deadAnchors ?? 0 }, () => ({ kind: "dead_anchor" }) as OrphanItem),
    } as unknown as KgVerifyService,
    graph: {
      countCandidatesByStatus: () => ({
        pending: opts.candidateCounts?.pending ?? 0,
        deferred: opts.candidateCounts?.deferred ?? 0,
        applied: 0,
        discarded: 0,
      }),
      listAutoAdjudications: () => opts.autoEntries ?? [],
    } as unknown as KnowledgeGraphPort,
  });
}

describe("KgViewerService.autoAudit（stats 聚合 + limit 切片）", () => {
  const e = (op: string, i: number) => ({
    op,
    nodeId: `N-${i}`,
    reason: `auto: 行${i}`,
    taskId: null,
    ts: `2026-10-0${i}T00:00:00Z`,
  });

  test("stats total/byOp 聚合 + entries 最新在前 + limit 切片", () => {
    const svc = makeViewer({ autoEntries: [e("prune", 4), e("decideCandidate", 3), e("anchorRelocate", 2), e("decideCandidate", 1)] });
    const res = svc.autoAudit("alpha", 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stats.total).toBe(4);
    const byOp = new Map(res.value.stats.byOp.map((r) => [r.op, r.count]));
    expect(byOp.get("decideCandidate")).toBe(2);
    expect(byOp.get("anchorRelocate")).toBe(1);
    expect(res.value.entries.length).toBe(2); // limit 切片（最新 2 条）
    expect(res.value.entries[0]!.reason).toContain("行4");
  });

  test("零 auto 行 → 空态（total=0 空数组，不报错）", () => {
    const res = makeViewer({}).autoAudit("alpha");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stats.total).toBe(0);
    expect(res.value.stats.byOp).toEqual([]);
    expect(res.value.entries).toEqual([]);
  });
});

describe("KgViewerService.health triageHint（积压提示，与 triage pendingCount 同口径）", () => {
  test("三计数（pending+deferred+dead_anchor）≥ 10 → suggested；orphan_node 不计入", () => {
    const res = makeViewer({ candidateCounts: { pending: 4, deferred: 3 }, deadAnchors: 3, }).health("alpha");
    expect(res.ok).toBe(true);
    const hint = (res as { value: KgHealthView }).value.triageHint;
    expect(hint).toEqual({ pendingTotal: 10, suggested: true });
  });

  test("三计数 < 10 → suggested=false；阈值下不提示", () => {
    const res = makeViewer({ candidateCounts: { pending: 2, deferred: 2 }, deadAnchors: 2 }).health("alpha");
    expect(res.ok).toBe(true);
    const hint = (res as { value: KgHealthView }).value.triageHint;
    expect(hint).toEqual({ pendingTotal: 6, suggested: false });
  });
});

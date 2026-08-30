import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgReportService } from "../../src/application/services/kg/KgReportService";
import { KgVerifyService } from "../../src/application/services/kg/KgVerifyService";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层（CL-3.A8/A9/A10）：KgReportService 变化报告数据面——按迭代聚合
 * 四类条目；人类可读原则（事件导向因果叙述/因果链完整）与 AD-16 引用
 * 规范（无裸 id）在数据层强制（O-7：查询时现算零写）。报告=通知面非
 * 审核面：条目纯代码事实机械检查/变更流水，不携带 options 行动项。
 */

const DAY = 86_400_000;
const ITER = "iter-20260825-11fo";
const BARE_ID_RE = /TR-AD-\d+|TR-\d+|E-\d+/;

interface Stack {
  readonly root: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
  readonly verify: KgVerifyService;
  readonly report: KgReportService;
}

const disposers: Array<() => void> = [];

function freshStack(): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-report-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const verify = new KgVerifyService({ graph });
  const report = new KgReportService({ graph, verify });
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database, store, graph, write, verify, report };
}

function batch(over: Partial<SymbolBatch> & { baseline: string }): SymbolBatch {
  return { files: [], symbols: [], containsEdges: [], materializedAnchors: [], degraded: false, ...over };
}

function seed(stack: Stack): void {
  const w = stack.write;
  const ok = (...results: { ok: boolean }[]) => {
    for (const r of results) expect(r.ok).toBe(true);
  };
  ok(
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "分层依赖单向", digest: "import 只准外层指向内层\n违反即守护失败", scene: "测试场景", status: "confirmed" } }), // TR-1
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "写路径白名单", digest: "落盘写点收口清单", scene: "测试场景", status: "confirmed" } }), // TR-2
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "双向往返甲", digest: "约束甲", scene: "测试场景", status: "confirmed" } }), // TR-3
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "双向往返乙", digest: "约束乙", scene: "测试场景", status: "confirmed" } }), // TR-4
    w.write(stack.root, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "旧写路径规则", digest: "旧口径", scene: "测试场景", status: "confirmed" } }), // TR-5（被取代者）
  );
  // knowledge_change 五 op 全谱：updateNode / declareAnchors / addEdge / supersede+replacement
  ok(
    w.write(stack.root, { kind: "updateNode", iterationId: ITER, nodeId: "TR-1", patch: { digest: "import 只准外层指向内层（修订版）" } }),
    w.write(stack.root, { kind: "declareAnchors", iterationId: ITER, nodeId: "TR-1", anchors: [{ scopeKind: "symbol", pattern: "src/arch.ts#layerRule" }] }),
    w.write(stack.root, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "TR-2" }),
    w.write(stack.root, { kind: "supersede", iterationId: ITER, nodeId: "TR-5", reason: "写路径口径已演进", replacementNodeDraft: { kind: "rule", name: "新写路径规则", digest: "新口径" } }), // TR-6
  );
  // rule_conflict：TR-3 ↔ TR-4 双向 governs
  ok(
    w.write(stack.root, { kind: "addEdge", iterationId: ITER, srcId: "TR-3", verb: "governs", dstId: "TR-4" }),
    w.write(stack.root, { kind: "addEdge", iterationId: ITER, srcId: "TR-4", verb: "governs", dstId: "TR-3" }),
  );
  // dead_anchor：TR-2 的符号锚两拍 sync 后失效
  const now = Date.now();
  stack.store.applySync(stack.root, batch({
    baseline: "1",
    files: [
      { path: "src/write-path.ts", mtime: now - 90 * DAY, sha256: "w1" },
      { path: "src/hot.ts", mtime: now - 1 * DAY, sha256: "h1" },
    ],
    symbols: [
      { name: "allowWrite", kind: "function", spanStart: 1, spanEnd: 9, file: "src/write-path.ts" },
      { name: "saveSession", kind: "function", spanStart: 1, spanEnd: 9, file: "src/hot.ts" },
    ],
    materializedAnchors: [
      { nodeId: "TR-2", anchorPath: "src/write-path.ts", anchorSymbol: "allowWrite", anchorKind: "symbol" },
      { nodeId: "TR-1", anchorPath: "src/hot.ts", anchorSymbol: "saveSession", anchorKind: "symbol" },
    ],
  }));
  stack.store.applySync(stack.root, batch({
    baseline: "2",
    files: [{ path: "src/hot.ts", mtime: now - 1 * DAY, sha256: "h1" }],
    deletedFiles: ["src/write-path.ts"],
    orphanedAnchors: [{ nodeId: "TR-2", anchorPath: "src/write-path.ts", anchorSymbol: "allowWrite", anchorKind: "symbol" }],
  }));
  // suspect_stale：TR-1 活跃锚在 src/hot.ts（昨日仍改），知识侧久未动
  stack.database
    .knowledgeConnection(stack.root)
    .prepare("UPDATE nodes SET created_at = ?, updated_at = ? WHERE id = 'TR-1'")
    .run(new Date(now - 60 * DAY).toISOString(), new Date(now - 60 * DAY).toISOString());
}

describe("KgReportService：变化报告数据面（I 层，按迭代聚合）", () => {
  test("① CL-3.A10 四类条目齐备 + sev 映射（warn/info/ok）", () => {
    const s = freshStack();
    seed(s);
    const report = s.report.buildChangeReport(s.root, ITER);
    expect(report.iterationId).toBe(ITER);
    const kinds = new Set(report.entries.map((e) => e.kind));
    expect(kinds.has("dead_anchor")).toBe(true);
    expect(kinds.has("rule_conflict")).toBe(true);
    expect(kinds.has("suspect_stale")).toBe(true);
    expect(kinds.has("knowledge_change")).toBe(true);
    for (const entry of report.entries) {
      const expectedSev =
        entry.kind === "dead_anchor" || entry.kind === "rule_conflict" ? "warn" : entry.kind === "suspect_stale" ? "info" : "ok";
      expect(entry.sev).toBe(expectedSev);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  test("② CL-3.A8：事件导向（主语=本迭代+因果连接）/ 因果叙述句；通知面无 options", () => {
    const s = freshStack();
    seed(s);
    const report = s.report.buildChangeReport(s.root, ITER);
    expect(report.entries.length).toBeGreaterThan(0);
    for (const entry of report.entries) {
      expect(entry.body).toContain("本迭代"); // 主语标记（事件导向非节点导向）
      expect(entry.body).toMatch(/——|因此|导致|，而/); // 因果链连接词
      expect(entry.body.endsWith("。")).toBe(true); // 完整叙述句（非枚举片段）
      expect("options" in entry).toBe(false); // 报告=通知面非审核面：无行动项字段
    }
  });

  test("③ CL-3.A7（报告面）：疑似类条目必含「疑似过时」与「非结论」限定", () => {
    const s = freshStack();
    seed(s);
    const suspects = s.report.buildChangeReport(s.root, ITER).entries.filter((e) => e.kind === "suspect_stale");
    expect(suspects.length).toBeGreaterThan(0);
    for (const entry of suspects) {
      expect(entry.body).toContain("疑似过时");
      expect(entry.body).toContain("非结论");
    }
  });

  test("④ CL-3.A9 引用规范：label/body 人类可读字段无裸 id；refs 供全字段（id 仅供链接）", () => {
    const s = freshStack();
    seed(s);
    const report = s.report.buildChangeReport(s.root, ITER);
    expect(report.entries.length).toBeGreaterThan(0);
    for (const entry of report.entries) {
      expect(entry.label).not.toMatch(BARE_ID_RE);
      expect(entry.body).not.toMatch(BARE_ID_RE);
    }
    // refs：知识节点 = id+name+kind+digest 首行；代码符号 = 名+路径
    const dead = report.entries.find((e) => e.kind === "dead_anchor")!;
    expect(dead.refs.nodes.length).toBeGreaterThan(0);
    expect(dead.refs.nodes[0]!.name).toBe("写路径白名单");
    expect(dead.refs.nodes[0]!.kind).toBe("rule");
    expect(dead.refs.nodes[0]!.digestFirstLine.length).toBeGreaterThan(0);
    expect(dead.refs.symbols.length).toBeGreaterThan(0);
    expect(dead.refs.symbols[0]!.path).toBe("src/write-path.ts");
    expect(dead.refs.symbols[0]!.name).toBe("allowWrite");
  });

  test("⑤ knowledge_change 因果叙述：五 op 各有叙述（新增/更新/锚定/加边/取代含理由与接替者）", () => {
    const s = freshStack();
    seed(s);
    const changes = s.report.buildChangeReport(s.root, ITER).entries.filter((e) => e.kind === "knowledge_change");
    const bodies = changes.map((e) => e.body).join("\n");
    expect(bodies).toContain("新增"); // createNode
    expect(bodies).toContain("修订"); // updateNode（digest 修订版）
    expect(bodies).toContain("锚"); // declareAnchors
    expect(bodies).toContain("知识边"); // addEdge（change_log 行不携带 verb——叙述不臆造细节）
    expect(bodies).toContain("写路径口径已演进"); // supersede reason
    expect(bodies).toContain("旧写路径规则"); // 被取代者名
    expect(bodies).toContain("新写路径规则"); // 接替者名
    // supersede 行 refs 含被取代节点引用
    const supersedeEntry = changes.find((e) => e.body.includes("写路径口径已演进"))!;
    expect(supersedeEntry.refs.nodes.map((n) => n.name)).toContain("旧写路径规则");
  });

  test("⑥ 迭代隔离 + 空迭代：他迭代日志不串；无日志迭代只含检查类条目", () => {
    const s = freshStack();
    seed(s);
    // 另一迭代的写入不进本报告
    const r = s.write.write(s.root, { kind: "createNode", iterationId: "iter-other", draft: { kind: "rule", name: "他迭代规则", digest: "他迭代摘要", scene: "测试场景" } });
    expect(r.ok).toBe(true);
    const report = s.report.buildChangeReport(s.root, ITER);
    expect(report.entries.some((e) => e.kind === "knowledge_change" && e.body.includes("他迭代规则"))).toBe(false);
    const otherReport = s.report.buildChangeReport(s.root, "iter-other");
    const otherChanges = otherReport.entries.filter((e) => e.kind === "knowledge_change");
    expect(otherChanges).toHaveLength(1);
    expect(otherChanges[0]!.body).toContain("他迭代规则");
  });

  test("⑦ O-7 查询时聚合零写：buildChangeReport 前后库文件字节不变", () => {
    const s = freshStack();
    seed(s);
    const dbFile = kgDbPath(s.root);
    const before = createHash("sha256").update(readFileSync(dbFile)).digest("hex");
    s.report.buildChangeReport(s.root, ITER);
    const after = createHash("sha256").update(readFileSync(dbFile)).digest("hex");
    expect(after).toBe(before);
  });
});

afterAll(() => {
  for (const dispose of disposers) dispose();
});

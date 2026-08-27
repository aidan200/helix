import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { materializeAnchors } from "../../src/domain/kg/anchor-materialize";
import { parseExistingMax } from "../../src/domain/kg/node-id";
import type { SymbolBatch } from "../../src/domain/kg/types";
import {
  DEACTIVATION_MARKER,
  runApply,
  runDryRun,
  type MigrateStack,
} from "../../../../scripts/oneoff/kg-migrate";

/**
 * T5.2 存量迁移（F2.4，CL-2.A9）：docs/kg md → .helix-kg 单库一次性管道。
 * - 保号映射（AD-16）：旧 id 逐一直等直写；
 * - 锚作用域映射（AD-13）：无锚→global / 目录→path glob / 文件→path / 符号→symbol；
 * - dry-run 对账（R-4）：对账不过不切换；
 * - 幂等 apply：已存在且一致跳过、不一致中止；
 * - md 停用标记 + v2 管道零解析断言（AD-9 SoT 下沉）。
 */

const disposers: Array<() => void> = [];

function freshStack(): MigrateStack & { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-migrate-"));
  const database = new KgDatabase();
  const stack: MigrateStack = {
    database,
    store: new SqliteKnowledgeStore({ database }),
    graph: new SqliteKnowledgeGraph({ database }),
    service: new KgWriteService({ store: new SqliteKnowledgeStore({ database }) }),
  };
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...stack, root };
}

/** fixture：全 id 形态（TR-AD-N / TR-TEST-N / E-n / E-中文）+ anchors 四形态 + 三 verb 边。 */
function writeFixture(root: string): void {
  const docsDir = path.join(root, "docs", "kg");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    path.join(docsDir, "architecture-rules.md"),
    [
      "```kg-node",
      "id: TR-AD-10",
      "kind: rule",
      "graph: tech",
      "layer: arch",
      "name: 目录+文件+符号混合锚规则",
      "status: active",
      "digest: 触发条件甲",
      "derivedFrom:",
      "  - AD-12",
      '  - "AD-4②（iter：含冒号: 与引号的溯源）"',
      "anchors:",
      "  implementedBy:",
      "    - apps/daemon/src/domain/",
      "    - apps/daemon/src/infrastructure/container.ts",
      "    - apps/daemon/src/domain/session/Session.ts#applySteer",
      "  testedBy:",
      "    - apps/daemon/test/arch-guard/arch-guard.test.ts",
      "relations:",
      "  governs:",
      "    - E-客户",
      "    - E-3",
      "```",
      "",
      "## 规则",
      "混合锚规则正文；提及 E-客户（与 governs 强边去重，不产 references）。",
      "",
      "## 理由",
      "fixture 覆盖目录/文件/符号三形态。",
      "",
      "```kg-node",
      "id: TR-AD-11",
      "kind: rule",
      "graph: tech",
      "layer: convention",
      "name: 无锚规则",
      "status: active",
      "digest: 触发条件乙",
      "relations:",
      "  dependsOn:",
      "    - TR-AD-10",
      "```",
      "",
      "## 规则",
      "无锚正文（→ global 声明）；提及 E-Only-Prose（产 references 弱边）；提及 TR-AD-10（v1 词表 TR-* 不产边）。",
      "",
      "```kg-node",
      "id: TR-TEST-2",
      "kind: rule",
      "graph: tech",
      "layer: convention",
      "name: 测试域复合前缀规则",
      "status: active",
      "digest: 触发条件丙",
      "anchors:",
      "  testedBy:",
      "    - package.json#scripts.prepare",
      "    - package.json#scripts.verify",
      "relations:",
      "  governs:",
      "    - E-客户",
      "```",
      "",
      "## 规则",
      "测试域规则正文。",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(docsDir, "domain.md"),
    [
      "```kg-node",
      "id: E-客户",
      "kind: entity",
      "graph: business",
      "name: 客户聚合",
      "status: active",
      "digest: 客户聚合实体",
      "anchors:",
      "  implementedBy:",
      "    - apps/daemon/src/domain/customer.ts",
      "```",
      "",
      "## 描述",
      "客户聚合描述。",
      "",
      "```kg-node",
      "id: E-3",
      "kind: entity",
      "graph: business",
      "name: 数字尾缀实体",
      "status: active",
      "digest: 数字尾缀实体",
      "```",
      "",
      "## 描述",
      "无锚实体（→ global）。",
      "",
      "```kg-node",
      "id: E-Only-Prose",
      "kind: entity",
      "graph: business",
      "name: 仅弱边实体",
      "status: active",
      "digest: 仅被正文提及",
      "anchors:",
      "  implementedBy:",
      "    - packages/protocol/",
      "```",
      "",
      "## 描述",
      "目录级锚实体。",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(docsDir, "decisions.md"), "# 决策档案（零 kg-node 块）\n");
  writeFileSync(path.join(docsDir, "candidates.md"), "# 候选台账（零 kg-node 块）\n");
}

/** 全部 fixture md 原文（停用断言用：除头部标记行外字节不变）。 */
function snapshotDocs(root: string): Map<string, string> {
  const docsDir = path.join(root, "docs", "kg");
  const out = new Map<string, string>();
  for (const f of readdirSync(docsDir)) {
    if (f.endsWith(".md")) out.set(f, readFileSync(path.join(docsDir, f), "utf8"));
  }
  return out;
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

describe("T5.2 kg-migrate：dry-run 对账（R-4 对账不过不切换）", () => {
  test("① 全量对账通过：6 节点逐 id 直等、5 边全迁入、锚四形态映射、差异注记在报告", () => {
    const { root, ...stack } = freshStack();
    writeFixture(root);
    const report = runDryRun(root, stack);
    expect(report.ok).toBe(true);
    expect(report.diffs).toEqual([]);
    expect(report.nodeCount).toBe(6);
    expect(report.edgeCount).toBe(5);
    // 边词表核对：governs×3 + dependsOn×1 + references×1（E-Only-Prose 弱边；TR-* 提及不产边）
    expect(report.edgeVerbHistogram).toEqual({ governs: 3, dependsOn: 1, references: 1 });
    // 锚形态直方图：dir 2 / file 3 / symbol 3；无锚节点 2（→global）
    expect(report.anchorFormHistogram).toEqual({ dir: 2, file: 3, symbol: 3, none: 2 });
    // 计数对账注记（决策口径 vs md 实测差异显式列出）
    expect(report.notes.length).toBeGreaterThan(0);
    expect(report.summary).toContain("6");
  });

  test("② 坏源（重复 id）→ dry-run 失败且 apply 拒绝执行、零写入", () => {
    const { root, ...stack } = freshStack();
    writeFixture(root);
    const domainPath = path.join(root, "docs", "kg", "domain.md");
    writeFileSync(
      domainPath,
      readFileSync(domainPath, "utf8") +
        "\n```kg-node\nid: E-3\nkind: entity\ngraph: business\nname: 重复\ndigest: 重复\n```\n\n## 描述\n重复块。\n",
    );
    const report = runDryRun(root, stack);
    expect(report.ok).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
    const applied = runApply(root, stack);
    expect(applied.ok).toBe(false);
    expect(applied.created).toEqual([]);
    expect(stack.graph.countNodes(root)).toBe(0);
  });
});

describe("T5.2 kg-migrate：apply 保号入库（AD-16）", () => {
  test("③ 旧 id 原样可查（getNode/search）、字段零 diff、锚声明三类映射正确", () => {
    const { root, ...stack } = freshStack();
    writeFixture(root);
    const before = snapshotDocs(root);
    const applied = runApply(root, stack);
    expect(applied.ok).toBe(true);
    expect([...applied.created].sort()).toEqual(["E-3", "E-Only-Prose", "E-客户", "TR-AD-10", "TR-AD-11", "TR-TEST-2"]);

    // 保号：getNode 同 id 可查（含复合前缀/中文尾缀/数字尾缀全形态）
    for (const id of applied.created) {
      const detail = stack.graph.getNode(root, id);
      expect(detail).not.toBeNull();
    }
    expect(stack.graph.search(root, "客户聚合").map((r) => r.id)).toEqual(["E-客户"]);

    // 字段：digest/body/domain/status 保真（body 含 v1 derivedFrom 脚注）
    const tr10 = stack.graph.getNode(root, "TR-AD-10")!;
    expect(tr10.node.domain).toBe("tech");
    expect(tr10.node.status).toBe("confirmed");
    expect(tr10.node.digest).toBe("触发条件甲");
    expect(tr10.node.body).toContain("混合锚规则正文");
    expect(tr10.node.body).toContain("derivedFrom");
    expect(tr10.node.body).toContain("AD-4②");

    // 锚声明：目录→path glob、文件→path、符号→symbol、无锚→global
    const decls = (id: string) =>
      stack.graph.getNode(root, id)!.anchorDeclarations.map((d) => `${d.scopeKind}:${d.pattern ?? ""}`).sort();
    expect(decls("TR-AD-10")).toEqual([
      "path:apps/daemon/src/domain/**",
      "path:apps/daemon/src/infrastructure/container.ts",
      "path:apps/daemon/test/arch-guard/arch-guard.test.ts",
      "symbol:apps/daemon/src/domain/session/Session.ts#applySteer",
    ]);
    expect(decls("TR-AD-11")).toEqual(["global:"]);
    expect(decls("TR-TEST-2")).toEqual(["symbol:package.json#scripts.prepare", "symbol:package.json#scripts.verify"]);
    expect(decls("E-客户")).toEqual(["path:apps/daemon/src/domain/customer.ts"]);
    expect(decls("E-3")).toEqual(["global:"]);
    expect(decls("E-Only-Prose")).toEqual(["path:packages/protocol/**"]);

    // 边全迁入（triples 逐一相等）
    const view = stack.graph.getVerifyView(root);
    expect(view.edges.map((e) => `${e.srcId}-${e.verb}->${e.dstId}`).sort()).toEqual([
      "TR-AD-10-governs->E-3",
      "TR-AD-10-governs->E-客户",
      "TR-AD-11-dependsOn->TR-AD-10",
      "TR-AD-11-references->E-Only-Prose",
      "TR-TEST-2-governs->E-客户",
    ]);

    // md 停用标记：全部 docs/kg md 头部含标记，其余内容字节不变
    for (const [file, original] of before) {
      const migrated = readFileSync(path.join(root, "docs", "kg", file), "utf8");
      expect(migrated.startsWith(DEACTIVATION_MARKER)).toBe(true);
      expect(migrated.slice(DEACTIVATION_MARKER.length)).toBe(original);
    }
  });

  test("④ 迁移后新发号 = 全空间 max+1（含 TR-AD-N/TR-TEST-N 复合前缀提取）", () => {
    const { root, ...stack } = freshStack();
    writeFixture(root);
    runApply(root, stack);
    const ids = stack.graph.getVerifyView(root).nodes.map((n) => n.id);
    expect(parseExistingMax(ids)).toEqual({ rule: 11, entity: 3 });
    // 计数器口径与 parseExistingMax 一致：自动发号从 max+1 起
    const nextRule = stack.service.write(root, { kind: "createNode", iterationId: "iter-x", draft: { kind: "rule", name: "新规则", digest: "d" } });
    expect(nextRule).toEqual({ ok: true, nodeId: "TR-12" });
    const nextEntity = stack.service.write(root, { kind: "createNode", iterationId: "iter-x", draft: { kind: "entity", name: "新实体", digest: "d" } });
    expect(nextEntity).toEqual({ ok: true, nodeId: "E-4" });
  });

  test("⑤ 幂等：重跑 apply 零新增零覆盖；字段不一致 → 中止不污染", () => {
    const { root, ...stack } = freshStack();
    writeFixture(root);
    runApply(root, stack);
    const nodesBefore = stack.graph.countNodes(root);
    const logBefore = stack.graph.getChangeLog(root, "iter-20260825-11fo").length;

    const rerun = runApply(root, stack);
    expect(rerun.ok).toBe(true);
    expect(rerun.created).toEqual([]);
    expect(rerun.skipped.sort()).toEqual(["E-3", "E-Only-Prose", "E-客户", "TR-AD-10", "TR-AD-11", "TR-TEST-2"]);
    expect(stack.graph.countNodes(root)).toBe(nodesBefore);
    expect(stack.graph.getChangeLog(root, "iter-20260825-11fo").length).toBe(logBefore);

    // 构造不一致（人工改 digest）→ 中止报冲突，不覆盖
    const mutated = stack.service.write(root, {
      kind: "updateNode",
      iterationId: "iter-x",
      nodeId: "E-3",
      patch: { digest: "人工改写后的 digest" },
    });
    expect(mutated.ok).toBe(true);
    const conflict = runApply(root, stack);
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts).toContain("E-3");
    expect(stack.graph.getNode(root, "E-3")!.node.digest).toBe("人工改写后的 digest");
    expect(stack.graph.countNodes(root)).toBe(nodesBefore);
  });

  test("⑥ v1 库原位不动（AF-21 二次裁决 2026-08-26）：v2 落 .helix-kg 独立目录，.kg 不读不写不改名", () => {
    const { root, ...stack } = freshStack();
    writeFixture(root);
    const kgDir = path.join(root, ".kg");
    mkdirSync(kgDir, { recursive: true });
    const v1Path = path.join(kgDir, "kg.db");
    const v1 = new Database(v1Path);
    v1.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT)");
    v1.exec("CREATE TABLE unresolved_refs (source TEXT)");
    v1.exec("INSERT INTO nodes (id, name) VALUES ('TR-AD-1', 'v1')");
    v1.close();
    const v1Bytes = readFileSync(v1Path);

    const applied = runApply(root, stack);
    expect(applied.ok).toBe(true);
    // v1 原位不动：字节不变、内容可查、零 *.v1.bak 退役产物
    expect(readFileSync(v1Path)).toEqual(v1Bytes);
    const reopen = new Database(v1Path, { readonly: true });
    expect((reopen.query("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c).toBe(1);
    reopen.close();
    expect(readdirSync(kgDir).sort()).toEqual(["kg.db"]);
    // v2 新库落 .helix-kg：全部存量节点在新库可查
    expect(existsSync(path.join(root, ".helix-kg", "kg.db"))).toBe(true);
    expect(stack.graph.countNodes(root)).toBe(6);
    expect(stack.graph.getNode(root, "TR-AD-10")).not.toBeNull();
  });

  test("⑦ 迁移后锚声明可被 T2.2 物化消费（sync 演示）：path/symbol 锚落 materialized_anchors、global 永不物化", async () => {
    const { root, ...stack } = freshStack();
    writeFixture(root);
    runApply(root, stack);
    const view = stack.graph.getVerifyView(root);
    const filePaths = [
      "apps/daemon/src/domain/customer.ts",
      "apps/daemon/src/domain/session/Session.ts",
      "apps/daemon/src/domain/other.ts",
      "apps/daemon/src/infrastructure/container.ts",
      "apps/daemon/test/arch-guard/arch-guard.test.ts",
      "packages/protocol/x.ts",
    ];
    const symbols = [
      { name: "applySteer", kind: "method", file: "apps/daemon/src/domain/session/Session.ts" },
      { name: "unrelated", kind: "function", file: "packages/protocol/x.ts" },
    ];
    const materialized = materializeAnchors({ declarations: view.anchorDeclarations, filePaths, symbols });
    const batch: SymbolBatch = {
      files: filePaths.map((p) => ({ path: p, mtime: 1, sha256: "h" })),
      symbols: symbols.map((s) => ({ ...s, spanStart: 1, spanEnd: 2 })),
      containsEdges: [],
      materializedAnchors: materialized,
      baseline: "2026-08-26T00:00:00.000Z",
      degraded: false,
    };
    await stack.store.applySync(root, batch);
    const anchors = stack.graph.getVerifyView(root).anchors;
    expect(anchors.map((a) => `${a.nodeId}@${a.anchorKind}:${a.anchorPath}${a.anchorSymbol ? "#" + a.anchorSymbol : ""}`).sort()).toEqual([
      "E-Only-Prose@path:packages/protocol/x.ts",
      "E-客户@path:apps/daemon/src/domain/customer.ts",
      "TR-AD-10@path:apps/daemon/src/domain/customer.ts",
      "TR-AD-10@path:apps/daemon/src/domain/other.ts",
      "TR-AD-10@path:apps/daemon/src/domain/session/Session.ts",
      "TR-AD-10@path:apps/daemon/src/infrastructure/container.ts",
      "TR-AD-10@path:apps/daemon/test/arch-guard/arch-guard.test.ts",
      "TR-AD-10@symbol:apps/daemon/src/domain/session/Session.ts#applySteer",
    ]);
    // global 声明（TR-AD-11 / E-3）永不物化
    expect(anchors.filter((a) => a.nodeId === "TR-AD-11" || a.nodeId === "E-3")).toEqual([]);
  });
});

describe("T5.2 md 停用断言（AD-9：v2 管道零解析 docs/kg）", () => {
  test("⑧ apps/daemon/src 全源码不含 docs/kg 解析面（零调用）", () => {
    const srcDir = path.resolve(import.meta.dir, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && readFileSync(full, "utf8").includes("docs/kg")) offenders.push(full);
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe("T5.2 显式保号 id 路径（上游 T1.1 契约修正：存量形态直写）", () => {
  test("⑨ TR-AD-47 / TR-TEST-8 / E-客户 显式 id 合法；SPEC-2 / 前缀与 kind 不符拒绝", () => {
    const { root, service } = freshStack();
    const ruleDraft = { kind: "rule" as const, name: "r", digest: "d" };
    expect(service.write(root, { kind: "createNode", iterationId: "iter-1", draft: ruleDraft, id: "TR-AD-47" })).toEqual({ ok: true, nodeId: "TR-AD-47" });
    expect(service.write(root, { kind: "createNode", iterationId: "iter-1", draft: ruleDraft, id: "TR-TEST-8" })).toEqual({ ok: true, nodeId: "TR-TEST-8" });
    const entityDraft = { kind: "entity" as const, name: "e", digest: "d" };
    expect(service.write(root, { kind: "createNode", iterationId: "iter-1", draft: entityDraft, id: "E-客户" })).toEqual({ ok: true, nodeId: "E-客户" });
    // 非数字尾缀不推进计数器：下一自动号从 47+1 起（TR-TEST-8 已 bump 到 8、TR-AD-47 到 47）
    const next = service.write(root, { kind: "createNode", iterationId: "iter-1", draft: ruleDraft });
    expect(next).toEqual({ ok: true, nodeId: "TR-48" });

    const bad1 = service.write(root, { kind: "createNode", iterationId: "iter-1", draft: ruleDraft, id: "SPEC-2" });
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) expect(bad1.error.code).toBe("KG_E_SCHEMA");
    const bad2 = service.write(root, { kind: "createNode", iterationId: "iter-1", draft: ruleDraft, id: "E-7" });
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.error.code).toBe("KG_E_SCHEMA");
  });
});

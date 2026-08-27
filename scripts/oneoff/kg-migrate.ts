/**
 * T5.2 存量迁移一次性管道（F2.4，CL-2.A9）：helix docs/kg/*.md 的 v1
 * kg-node 块 → 保号映射 → dry-run 对账 → 经 KgWriteService 正式入库 →
 * md 体系停用标记。
 *
 * 架构锚：iter-20260825-11fo architecture.md §10（AD-9 SoT 下沉 / AD-16
 * 保号迁移 / AD-13 锚作用域映射 / R-4 对账不过不切换）。
 *
 * 纪律：
 * - 唯一写入口：全部落库经 KgWriteService（createNode 显式保号 id /
 *   declareAnchors / addEdge），不走旁路直写；
 * - apply 前置 dry-run（R-4）：对账不过不切换，CLI 退出码非零；
 * - 幂等：目标 id 已存在且字段一致 → 跳过；不一致 → 中止报冲突；
 * - v1 库原位不动（AF-21 二次裁决 2026-08-26）：v2 写独立目录
 *   <projectRoot>/.helix-kg/kg.db（KgDatabase 定位），v1 .kg/kg.db 不读
 *   不写不改名；.helix-kg/kg.db 已存在时走既有幂等逻辑；
 * - md 停用：仅头部追加标记行，不改写/不删除既有内容（历史资产保留）。
 *
 * 用法：bun scripts/oneoff/kg-migrate.ts [--root <projectRoot>] [--apply]
 * （默认 dry-run；退出码 0=通过 / 1=失败）。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase } from "../../apps/daemon/src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../apps/daemon/src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../apps/daemon/src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService, validateKnowledgeWriteOp } from "../../apps/daemon/src/application/services/kg/KgWriteService";
import { parseExistingMax } from "../../apps/daemon/src/domain/kg/node-id";
import { EDGE_VERBS } from "../../apps/daemon/src/domain/kg/types";
import type {
  AnchorDeclaration,
  EdgeVerb,
  KnowledgeNode,
  KnowledgeWriteOp,
  VerifyView,
} from "../../apps/daemon/src/domain/kg/types";
import { parseKgMdFiles, V1_STATUS_TO_V2 } from "./kg-md-parser";
import type { ParsedKgNode, ParseIssue } from "./kg-md-parser";

/** 迁移 change_log 落账迭代 id（审计链：v2 change_log 从零积累，迁移为第一笔）。 */
export const MIGRATION_ITERATION = "iter-20260825-11fo";

/** md 停用标记（docs/kg 各文档头部追加；原文一字不改）。 */
export const DEACTIVATION_MARKER =
  "> 【已停用】SoT 已下沉 .kg 单库（iter-20260825-11fo 迁移）；本文件不再被任何管道解析\n\n";

/** 决策文档口径参考值（§10：69 节点 / 110 边——dry-run 差异解释用）。 */
const REFERENCE_FIGURES = { nodes: 69, edges: 110 };

export interface MigrateStack {
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly service: KgWriteService;
}

// ── 映射（保号 + 锚三级作用域 + 边词表） ─────────────────────

interface NodePlan {
  readonly source: ParsedKgNode;
  readonly createOp: KnowledgeWriteOp & { kind: "createNode"; id: string };
  readonly anchorDecls: readonly AnchorDeclaration[];
}

interface MigrationPlan {
  readonly nodes: readonly NodePlan[];
  /** 全局去重的边三元组（src, verb, dst 升序稳定）。 */
  readonly edges: readonly { srcId: string; verb: EdgeVerb; dstId: string }[];
}

/** v1 anchors 清单项 → 三级作用域声明（按 v1 锚形态判定：目录→path glob / 文件→path / 符号→symbol）。 */
export function classifyAnchor(item: string): { form: "dir" | "file" | "symbol"; decl: AnchorDeclaration } {
  if (item.includes("#")) return { form: "symbol", decl: { scopeKind: "symbol", pattern: item } };
  if (item.endsWith("/")) return { form: "dir", decl: { scopeKind: "path", pattern: `${item}**` } };
  return { form: "file", decl: { scopeKind: "path", pattern: item } };
}

/** 正文映射：owned prose + derivedFrom 脚注（v2 无 derivedFrom 字段，溯源保进 SoT 正文）。 */
function migrationBody(node: ParsedKgNode): string {
  const footer =
    node.derivedFrom.length > 0
      ? `\n\n> derivedFrom（v1 保号迁移保留）: ${node.derivedFrom.join("、")}`
      : "";
  return node.body + footer;
}

function mapToPlan(nodes: readonly ParsedKgNode[]): MigrationPlan {
  const plans: NodePlan[] = nodes.map((node) => {
    const items = [...node.anchors.implementedBy, ...node.anchors.testedBy];
    const decls = new Map<string, AnchorDeclaration>();
    for (const item of items) {
      const { decl } = classifyAnchor(item);
      decls.set(`${decl.scopeKind}\u0000${decl.pattern ?? ""}`, decl);
    }
    const anchorDecls =
      decls.size === 0 ? [{ scopeKind: "global" } as AnchorDeclaration] : [...decls.values()];
    const createOp = {
      kind: "createNode" as const,
      iterationId: MIGRATION_ITERATION,
      id: node.id,
      draft: {
        kind: node.kind,
        name: node.name,
        digest: node.digest,
        body: migrationBody(node),
        domain: node.graph,
        status: V1_STATUS_TO_V2[node.status] ?? "confirmed",
      },
    };
    return { source: node, createOp, anchorDecls };
  });

  const triples = new Map<string, { srcId: string; verb: EdgeVerb; dstId: string }>();
  for (const node of nodes) {
    for (const edge of node.edges) {
      const key = `${node.id}\u0000${edge.verb}\u0000${edge.target}`;
      if (!triples.has(key)) triples.set(key, { srcId: node.id, verb: edge.verb as EdgeVerb, dstId: edge.target });
    }
  }
  const edges = [...triples.values()].sort((a, b) =>
    a.srcId < b.srcId ? -1 : a.srcId > b.srcId ? 1 : `${a.verb}${a.dstId}` < `${b.verb}${b.dstId}` ? -1 : 1,
  );
  return { nodes: plans, edges };
}

// ── dry-run：解析 → 映射 → 与源逐节点字段比对 → 对账报告（R-4） ──

export interface DryRunReport {
  readonly ok: boolean;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly anchorDeclCount: number;
  readonly edgeVerbHistogram: Record<string, number>;
  readonly anchorFormHistogram: AnchorFormCounts;
  readonly diffs: string[];
  readonly issues: readonly ParseIssue[];
  readonly notes: string[];
  readonly summary: string;
}

/** 锚形态计数（dir/文件/符号/无锚）。 */
export interface AnchorFormCounts {
  dir: number;
  file: number;
  symbol: number;
  none: number;
}

function readDocs(projectRoot: string): { docPath: string; markdown: string }[] {
  const docsDir = path.join(projectRoot, "docs", "kg");
  if (!existsSync(docsDir)) return [];
  return readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ docPath: `docs/kg/${f}`, markdown: readFileSync(path.join(docsDir, f), "utf8") }));
}

export function runDryRun(projectRoot: string, stack: MigrateStack): DryRunReport {
  const docs = readDocs(projectRoot);
  const parsed = parseKgMdFiles(docs);
  const plan = mapToPlan(parsed.nodes);
  const diffs: string[] = [];
  const notes: string[] = [];

  const ids = new Set(plan.nodes.map((p) => p.createOp.id));
  const edgeVerbHistogram: Record<string, number> = {};
  const anchorFormHistogram: AnchorFormCounts = { dir: 0, file: 0, symbol: 0, none: 0 };

  // 逐节点字段比对（源 vs 映射）：保号直等 + 字段直等 + 锚形态一一对应
  for (const p of plan.nodes) {
    const s = p.source;
    const draft = p.createOp.draft;
    if (p.createOp.id !== s.id) diffs.push(`[${s.id}] 保号断言失败：映射 id=${p.createOp.id}`);
    if (draft.name !== s.name) diffs.push(`[${s.id}] name：源=${s.name} 映射=${draft.name}`);
    if (draft.digest !== s.digest) diffs.push(`[${s.id}] digest：源=${s.digest} 映射=${draft.digest}`);
    if (draft.domain !== s.graph) diffs.push(`[${s.id}] domain：源=${s.graph} 映射=${draft.domain}`);
    if (draft.status !== V1_STATUS_TO_V2[s.status]) diffs.push(`[${s.id}] status：源=${s.status} 映射=${draft.status}`);
    if (draft.body !== migrationBody(s)) diffs.push(`[${s.id}] body 与源正文+脚注不一致`);
    // 锚双射：源锚项 ↔ 声明一一对应（无锚 → 恰一枚 global）
    const srcItems = [...s.anchors.implementedBy, ...s.anchors.testedBy];
    if (srcItems.length === 0) {
      if (p.anchorDecls.length !== 1 || p.anchorDecls[0]!.scopeKind !== "global") {
        diffs.push(`[${s.id}] 无锚节点应映射为恰一枚 global 声明，实得 ${p.anchorDecls.length} 枚`);
      }
      anchorFormHistogram.none += 1;
    } else {
      const expected = new Map(srcItems.map((item) => {
        const c = classifyAnchor(item);
        return [`${c.decl.scopeKind}\u0000${c.decl.pattern ?? ""}`, { item, form: c.form }];
      }));
      const mapped = new Set(p.anchorDecls.map((d) => `${d.scopeKind}\u0000${d.pattern ?? ""}`));
      for (const [key, { item, form }] of expected) {
        if (!mapped.has(key)) diffs.push(`[${s.id}] 源锚 ${item}（${form}）未映射为对应声明`);
        else {
          mapped.delete(key);
          anchorFormHistogram[form] += 1;
        }
      }
      for (const extra of mapped) diffs.push(`[${s.id}] 多出无源声明：${extra.split("\u0000").join(":")}`);
    }
    // API 形态校验（真实守卫预检：映射产物必须能过 KgWriteService）
    const error = validateKnowledgeWriteOp(p.createOp);
    if (error !== null) diffs.push(`[${s.id}] createOp 未过 schema 校验：${error.code} ${error.message}`);
    const anchorError = validateKnowledgeWriteOp({
      kind: "declareAnchors",
      iterationId: MIGRATION_ITERATION,
      nodeId: p.createOp.id,
      anchors: p.anchorDecls,
    });
    if (anchorError !== null) diffs.push(`[${s.id}] 锚声明未过 schema 校验：${anchorError.message}`);
  }

  // 边词表核对 + 悬空目标 + 全迁入（解析三元组并集 === 映射三元组集）
  const parsedTriples = new Set<string>();
  for (const node of parsed.nodes) {
    for (const e of node.edges) {
      parsedTriples.add(`${node.id}\u0000${e.verb}\u0000${e.target}`);
      edgeVerbHistogram[e.verb] = (edgeVerbHistogram[e.verb] ?? 0) + 1;
    }
  }
  for (const e of plan.edges) {
    if (!(EDGE_VERBS as readonly string[]).includes(e.verb)) diffs.push(`[边] 越界 verb：${e.srcId}-${e.verb}->${e.dstId}`);
    if (!ids.has(e.dstId)) diffs.push(`[边] 悬空目标：${e.srcId}-${e.verb}->${e.dstId}（目标不在节点集）`);
    if (!ids.has(e.srcId)) diffs.push(`[边] 悬空起点：${e.srcId}-${e.verb}->${e.dstId}`);
  }
  for (const t of parsedTriples) {
    const [srcId, verb, dstId] = t.split("\u0000");
    if (!plan.edges.some((e) => e.srcId === srcId && e.verb === verb && e.dstId === dstId)) {
      diffs.push(`[边] 解析边未迁入：${srcId}-${verb}->${dstId}`);
    }
  }
  if (parsed.nodes.length !== plan.nodes.length) diffs.push(`[计数] 解析节点 ${parsed.nodes.length} ≠ 映射节点 ${plan.nodes.length}`);

  // 计数对账注记（决策口径 / v1 索引实测 vs md 源实测差异显式解释）
  notes.push(
    `md 源实测（迁移权威源）：${parsed.nodes.length} 节点 / ${plan.edges.length} 边；决策文档口径 ${REFERENCE_FIGURES.nodes} 节点 / ${REFERENCE_FIGURES.edges} 边——口径滞后于 md 演进，以 md 为准。`,
  );
  const v1 = probeV1Db(projectRoot);
  if (v1 !== null) {
    notes.push(
      `v1 .kg/kg.db 索引实测：${v1.nodeCount} 节点 / ${v1.edgeCount} 边（索引滞后，md 侧多 ${parsed.nodes.length - v1.nodeCount} 节点：${listMissing(ids, v1.nodeIds)}）；v1 库原位不动（AF-21 二次裁决 2026-08-26）。`,
    );
  }
  const max = parseExistingMax([...ids]);
  notes.push(`迁移后新发号起点（全空间 max+1，O-3 裁决并入 TR-n 空间）：TR-${max.rule + 1} / E-${max.entity + 1}。`);
  notes.push("字段弃置清单（v2 无对应落点，md 原文保留）：layer(arch/convention/common) / scope / stack / createdIn / updatedIn；implementedBy·testedBy 角色区分并入锚声明（scopeKind 不分角色）。");

  const ok = diffs.length === 0 && parsed.issues.length === 0;
  const summary = renderDryRunSummary({ ok, parsed, plan, edgeVerbHistogram, anchorFormHistogram, diffs, notes });
  return {
    ok,
    nodeCount: parsed.nodes.length,
    edgeCount: plan.edges.length,
    anchorDeclCount: plan.nodes.reduce((n, p) => n + p.anchorDecls.length, 0),
    edgeVerbHistogram,
    anchorFormHistogram,
    diffs,
    issues: parsed.issues,
    notes,
    summary,
  };
}

function listMissing(ids: Set<string>, v1Ids: readonly string[]): string {
  const v1Set = new Set(v1Ids);
  const missing = [...ids].filter((id) => !v1Set.has(id)).sort();
  if (missing.length === 0) return "无";
  return missing.join(", ");
}

// ── apply：dry-run 门禁 → v1 库退役 → 幂等入库 → 后验 → md 停用 ──

export interface ApplyResult {
  readonly ok: boolean;
  readonly created: string[];
  readonly skipped: string[];
  readonly conflicts: string[];
  readonly edgesWritten: number;
  readonly deactivated: string[];
  readonly errors: string[];
  readonly report: string;
}

export function runApply(projectRoot: string, stack: MigrateStack): ApplyResult {
  // R-4：对账不过不切换（apply 内置门禁，不依赖调用方纪律）
  const dry = runDryRun(projectRoot, stack);
  if (!dry.ok) {
    return {
      ok: false, created: [], skipped: [], conflicts: [], edgesWritten: 0,
      deactivated: [], errors: [...dry.issues.map((i) => `${i.docPath}:${i.line} ${i.message}`), ...dry.diffs],
      report: `dry-run 对账未通过（R-4 不切换）：\n${[...dry.issues.map((i) => `  ${i.docPath}:${i.line} ${i.message}`), ...dry.diffs.map((d) => `  ${d}`)].join("\n")}`,
    };
  }
  const docs = readDocs(projectRoot);
  const plan = mapToPlan(parseKgMdFiles(docs).nodes);

  const created: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const errors: string[] = [];

  // 幂等入库：已存在且字段一致 → 跳过；不一致 → 中止（一次性管道不得二次污染）
  const view = stack.graph.getVerifyView(projectRoot);
  const existing = new Map(view.nodes.map((n) => [n.id, n]));
  const declsByNode = new Map<string, string[]>();
  for (const row of view.anchorDeclarations) {
    const list = declsByNode.get(row.nodeId);
    if (list === undefined) declsByNode.set(row.nodeId, [`${row.scopeKind}:${row.pattern}`]);
    else list.push(`${row.scopeKind}:${row.pattern}`);
  }

  for (const p of plan.nodes) {
    const prior = existing.get(p.createOp.id);
    if (prior !== undefined) {
      if (nodeMatches(prior, p, declsByNode.get(p.createOp.id) ?? [])) {
        skipped.push(p.createOp.id);
        continue;
      }
      conflicts.push(p.createOp.id);
      return abort(projectRoot, { created, skipped, conflicts, edgesWritten: 0, errors });
    }
    const createdResult = stack.service.write(projectRoot, p.createOp);
    if (!createdResult.ok) {
      errors.push(`[${p.createOp.id}] createNode 失败：${createdResult.error.code} ${createdResult.error.message}`);
      return abort(projectRoot, { created, skipped, conflicts, edgesWritten: 0, errors });
    }
    created.push(p.createOp.id);
    const anchorResult = stack.service.write(projectRoot, {
      kind: "declareAnchors",
      iterationId: MIGRATION_ITERATION,
      nodeId: p.createOp.id,
      anchors: p.anchorDecls,
    });
    if (!anchorResult.ok) {
      errors.push(`[${p.createOp.id}] declareAnchors 失败：${anchorResult.error.code} ${anchorResult.error.message}`);
      return abort(projectRoot, { created, skipped, conflicts, edgesWritten: 0, errors });
    }
  }

  // 边迁入（OR IGNORE 幂等；只补缺失三元组）
  const existingTriples = new Set(view.edges.map((e) => `${e.srcId}\u0000${e.verb}\u0000${e.dstId}`));
  let edgesWritten = 0;
  for (const e of plan.edges) {
    if (existingTriples.has(`${e.srcId}\u0000${e.verb}\u0000${e.dstId}`)) continue;
    const result = stack.service.write(projectRoot, {
      kind: "addEdge",
      iterationId: MIGRATION_ITERATION,
      srcId: e.srcId,
      verb: e.verb,
      dstId: e.dstId,
    });
    if (!result.ok) {
      errors.push(`[边] ${e.srcId}-${e.verb}->${e.dstId} 失败：${result.error.code} ${result.error.message}`);
      return abort(projectRoot, { created, skipped, conflicts, edgesWritten, errors });
    }
    edgesWritten += 1;
  }

  // 后验：库内实际状态与计划全等（字段/锚/边）
  const post = verifyAgainstPlan(projectRoot, stack, plan);
  if (post.length > 0) {
    errors.push(...post);
    return abort(projectRoot, { created, skipped, conflicts, edgesWritten, errors });
  }

  // md 停用标记（全部成功后追加；不改写既有内容）
  const deactivated = deactivateDocs(projectRoot);
  return {
    ok: true, created, skipped, conflicts: [], edgesWritten, deactivated, errors: [],
    report: renderApplySummary({ created, skipped, edgesWritten, deactivated, plan }),
  };
}

function abort(projectRoot: string, partial: Omit<ApplyResult, "ok" | "deactivated" | "report">): ApplyResult {
  return {
    ...partial,
    ok: false,
    deactivated: [],
    report:
      `apply 中止（已写节点保持幂等可重跑，md 停用未执行）：\n` +
      (partial.conflicts.length > 0 ? `  冲突节点：${partial.conflicts.join(", ")}\n` : "") +
      partial.errors.map((e) => `  ${e}`).join("\n"),
  };
}

/** 库内节点与计划全等判定（幂等跳过 / 冲突中止单点口径）。 */
function nodeMatches(existing: KnowledgeNode, plan: NodePlan, declKeys: readonly string[]): boolean {
  const draft = plan.createOp.draft;
  if (existing.name !== draft.name) return false;
  if (existing.digest !== draft.digest) return false;
  if (existing.body !== draft.body) return false;
  if (existing.domain !== draft.domain) return false;
  if ((existing.layer ?? null) !== (draft.layer ?? null)) return false;
  if (existing.status !== draft.status) return false;
  const expected = plan.anchorDecls.map((d) => `${d.scopeKind}:${d.pattern ?? ""}`).sort();
  return JSON.stringify([...declKeys].sort()) === JSON.stringify(expected);
}

/** 后验：getVerifyView 与计划逐项全等比对，返回差异清单（空 = 通过）。 */
function verifyAgainstPlan(projectRoot: string, stack: MigrateStack, plan: MigrationPlan): string[] {
  const view: VerifyView = stack.graph.getVerifyView(projectRoot);
  const diffs: string[] = [];
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const declsByNode = new Map<string, string[]>();
  for (const row of view.anchorDeclarations) {
    const list = declsByNode.get(row.nodeId);
    if (list === undefined) declsByNode.set(row.nodeId, [`${row.scopeKind}:${row.pattern}`]);
    else list.push(`${row.scopeKind}:${row.pattern}`);
  }
  for (const p of plan.nodes) {
    const node = byId.get(p.createOp.id);
    if (node === undefined) {
      diffs.push(`[${p.createOp.id}] 后验缺失`);
      continue;
    }
    if (!nodeMatches(node, p, declsByNode.get(p.createOp.id) ?? [])) {
      diffs.push(`[${p.createOp.id}] 后验字段/锚声明不一致`);
    }
  }
  if (view.nodes.length !== plan.nodes.length) diffs.push(`[计数] 库内节点 ${view.nodes.length} ≠ 计划 ${plan.nodes.length}`);
  const triples = view.edges.map((e) => `${e.srcId}\u0000${e.verb}\u0000${e.dstId}`).sort();
  const expectedTriples = plan.edges.map((e) => `${e.srcId}\u0000${e.verb}\u0000${e.dstId}`).sort();
  if (JSON.stringify(triples) !== JSON.stringify(expectedTriples)) diffs.push("[边] 后验边三元组与计划不一致");
  return diffs;
}

// ── md 停用 / v1 探查 ────────────────────────────────

/** v2 表签名（anchor_decl 为 v2 独有表；v1 无此表即判 v1 形态）。 */
function isV2KgDb(dbPath: string): boolean {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    return tables.has("anchor_decl") && tables.has("materialized_anchors") && tables.has("change_log");
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** v1 库只读探查（dry-run 计数对账注记；无库/不可读 → null）。v1 定位恒
 * <projectRoot>/.kg/kg.db（AF-21 二次裁决 2026-08-26：原位不动，v2 已迁 .helix-kg）。 */
function probeV1Db(projectRoot: string): { nodeCount: number; edgeCount: number; nodeIds: readonly string[] } | null {
  const dbPath = path.join(projectRoot, ".kg", "kg.db");
  if (!existsSync(dbPath) || isV2KgDb(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    const nodeIds = (db.query("SELECT id FROM nodes").all() as { id: string }[]).map((r) => r.id);
    const edgeCount = (db.query("SELECT COUNT(*) AS c FROM edges").get() as { c: number }).c;
    db.close();
    return { nodeCount: nodeIds.length, edgeCount, nodeIds };
  } catch {
    return null;
  }
}

/** docs/kg 全部 md 头部追加停用标记（幂等：已标记跳过；原文一字不改）。 */
function deactivateDocs(projectRoot: string): string[] {
  const docsDir = path.join(projectRoot, "docs", "kg");
  if (!existsSync(docsDir)) return [];
  const done: string[] = [];
  for (const f of readdirSync(docsDir).filter((x) => x.endsWith(".md")).sort()) {
    const full = path.join(docsDir, f);
    const original = readFileSync(full, "utf8");
    if (original.startsWith(DEACTIVATION_MARKER)) continue;
    writeFileSync(full, DEACTIVATION_MARKER + original);
    done.push(`docs/kg/${f}`);
  }
  return done;
}

// ── 报告渲染 ────────────────────────────────────────────────

function renderDryRunSummary(r: {
  ok: boolean;
  parsed: ReturnType<typeof parseKgMdFiles>;
  plan: MigrationPlan;
  edgeVerbHistogram: Record<string, number>;
  anchorFormHistogram: AnchorFormCounts;
  diffs: string[];
  notes: string[];
}): string {
  const lines = [
    `dry-run 对账${r.ok ? "通过" : "未通过"}：${r.parsed.nodes.length} 节点 / ${r.plan.edges.length} 边 / ${r.plan.nodes.reduce((n, p) => n + p.anchorDecls.length, 0)} 锚声明`,
    `边词表分布：${Object.entries(r.edgeVerbHistogram).map(([k, v]) => `${k}×${v}`).join(" ") || "(无)"}`,
    `锚形态分布：${Object.entries(r.anchorFormHistogram).map(([k, v]) => `${k}×${v}`).join(" ")}`,
    ...r.parsed.issues.map((i) => `解析问题 ${i.docPath}:${i.line} ${i.message}`),
    ...r.diffs.map((d) => `字段差异 ${d}`),
    ...r.notes.map((n) => `注记 ${n}`),
  ];
  return lines.join("\n");
}

function renderApplySummary(r: {
  created: string[];
  skipped: string[];
  edgesWritten: number;
  deactivated: string[];
  plan: MigrationPlan;
}): string {
  return [
    `apply 完成：新建 ${r.created.length} 节点、幂等跳过 ${r.skipped.length}、写入 ${r.edgesWritten} 边（计划全集 ${r.plan.edges.length}）`,
    `v2 库落位 .helix-kg/kg.db（v1 .kg/kg.db 原位不动，AF-21 二次裁决 2026-08-26）`,
    r.deactivated.length > 0 ? `md 停用标记：${r.deactivated.join(", ")}` : "md 停用标记：已标记（幂等跳过）",
  ].join("\n");
}

// ── CLI ─────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const rootIdx = args.indexOf("--root");
  const projectRoot = path.resolve(rootIdx >= 0 ? args[rootIdx + 1]! : process.cwd());
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const stack: MigrateStack = {
    database,
    store,
    graph: new SqliteKnowledgeGraph({ database }),
    service: new KgWriteService({ store }),
  };
  if (apply) {
    const result = runApply(projectRoot, stack);
    console.log(result.report);
    process.exit(result.ok ? 0 : 1);
  }
  const report = runDryRun(projectRoot, stack);
  console.log(report.summary);
  process.exit(report.ok ? 0 : 1);
}

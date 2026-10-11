#!/usr/bin/env bun
/**
 * kg 锚收口对账脚本（批4 WP-G「收口锚对账点」机械面）——任务收口时对改动面
 * 做锚对账的工程层工具，**不进 daemon 运行时**（daemon 收口钩子机械化为后续批）。
 *
 * ## 这是什么
 *
 * 工程纪律②「收口锚对账点」的机械面：改动文件 → affected 反查 → 锚健康
 * （声明 vs 物化、orphan 状态）→ 机械可处置项清单 / 需人判断残量清单。
 * 缺省只读（判定照跑零落库）；`--fix` 才写——经 KgWriteService prune op
 * 定向清理孤儿物化锚（不裸 SQL），与 kg-update prune 同一写面同一审计。
 *
 * ## 判定口径（E-9 orphan 三形态 / E-228 R3，勿另造语义）
 *
 * - orphan 行「当前声明集无法再产生该锚」（无声明旧键）+ 节点附着面健康
 *   （有其他活锚或有声明）→ **机械可处置**：定向 prune（E-9 形态3 / R3 同判）；
 * - orphan 行声明仍在（形态1 符号消亡/声明撤销类真信号）→ **残量**：
 *   tombstone 保留，节点去留/声明修订需内容判断（高置信 rename 复位归
 *   sync 管道 L0 机械重定位 E-228，本工具不重复造）；
 * - 零附着节点 tombstone → **残量**（归体检 orphan_node 口径，节点去留需内容判断）；
 * - 声明零物化（死声明嫌疑，E-9 文件面/符号面边界）→ **残量**：声明去留需内容判断；
 * - 节点内混合形态（可处置与保留型 tombstone 并存）→ 整体降残量：prune 粒度
 *   为节点级，机械清会连带删除保留型 tombstone，需人裁。
 *
 * **边界**：凡涉及「节点内容还对不对」的（supersede/正文修订）走 findings→
 * 候选人审通道——内容人审边界与锚机械维护严格分开（本工具只做后者）。
 *
 * ## 用法
 *
 *   bun apps/daemon/scripts/kg-anchor-reconcile.ts --files a.ts,b.ts [--project <root>] [--fix]
 *   bun apps/daemon/scripts/kg-anchor-reconcile.ts --diff <git-range> [--fix] [--out <报告.md>]
 *
 *   --files    改动文件清单（逗号分隔，相对项目根）
 *   --diff     git diff 范围（等价改动面输入：`git diff --name-only <range>`）
 *   --project  项目根（缺省 = 本仓根，即 <root>/.helix-kg/kg.db 定位锚）
 *   --fix      执行机械项（定向 prune 孤儿物化锚）；缺省只读
 *   --out      对账报告落盘路径（缺省打印到 stdout）
 *   --iteration-id  prune 审计归属（缺省 "kg-anchor-reconcile"）
 *
 * 幂等：--fix 重跑零可处置零写（prune 零删除不落 change_log）。
 * 形态裁决：daemon 域脚本落 apps/daemon/scripts/（backfill-kg-vectors 先例
 * 形态裁决同款——需直接 import src 面，顶层 scripts/ 是构建/工具链域）。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { KgDatabase } from "../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../src/application/services/kg/KgWriteService";
import { KgQueryService, type KgAffectedHit } from "../src/application/services/kg/KgQueryService";
import { globToRegExp } from "../src/domain/kg/anchor-materialize";
import type { KnowledgeGraphPort } from "../src/application/ports/outbound/KnowledgeGraphPort";
import type { AnchorDeclaration, NodeDetail } from "../src/domain/kg/types";

// ── 组装面（测试可注入替身；CLI 走真栈） ──────────────────────────

export interface ReconcileStack {
  readonly projectRoot: string;
  readonly database: KgDatabase;
  readonly graph: KnowledgeGraphPort;
  readonly query: KgQueryService;
  readonly write: KgWriteService;
  dispose(): void;
}

/** 真栈组装（read 面 = SqliteKnowledgeGraph；写面唯一 = KgWriteService）。 */
export function createReconcileStack(projectRoot: string): ReconcileStack {
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const query = new KgQueryService({ graph, projects: () => [projectRoot] });
  return { projectRoot, database, graph, query, write, dispose: () => database.closeAll() };
}

// ── 判定面（纯函数，E-9/E-228 语义） ──────────────────────────

/** 锚键归一展示（path#symbol；path 锚不带 #）。 */
export function anchorLabel(a: { anchorPath: string; anchorSymbol: string | null }): string {
  return a.anchorSymbol === null ? a.anchorPath : `${a.anchorPath}#${a.anchorSymbol}`;
}

/** 声明能否再产生该锚（pattern 级 producibility，E-228 R3「当前声明集无法再产生该锚」判据）：
 *  global 永不物化；path 声明只产 path 锚；symbol 声明只产同名 symbol 锚（glob 走
 *  anchor-materialize 同源 globToRegExp）。 */
export function declarationProduces(
  decl: AnchorDeclaration,
  anchor: { anchorPath: string; anchorSymbol: string | null; anchorKind: string },
): boolean {
  const pattern = decl.pattern ?? "";
  if (decl.scopeKind === "global" || pattern === "") return false;
  if (decl.scopeKind === "path") {
    return anchor.anchorKind === "path" && anchor.anchorSymbol === null && globToRegExp(pattern).test(anchor.anchorPath);
  }
  const idx = pattern.indexOf("#");
  if (idx <= 0 || idx >= pattern.length - 1) return false;
  return (
    anchor.anchorKind === "symbol" &&
    anchor.anchorSymbol === pattern.slice(idx + 1) &&
    globToRegExp(pattern.slice(0, idx)).test(anchor.anchorPath)
  );
}

export interface OrphanVerdict {
  readonly anchorPath: string;
  readonly anchorSymbol: string | null;
  readonly anchorKind: string;
  readonly disposition: "prune-fixable" | "residual";
  readonly reason: string;
}

export interface NodeReconcile {
  readonly nodeId: string;
  readonly name: string;
  readonly status: string;
  readonly declarations: readonly AnchorDeclaration[];
  readonly materialized: readonly { anchorPath: string; anchorSymbol: string | null; anchorKind: string; orphan: boolean }[];
  readonly orphanVerdicts: readonly OrphanVerdict[];
  readonly deadDeclarations: readonly AnchorDeclaration[];
  /** 可整体定向 prune：存在 orphan 行且全部为 prune-fixable（prune 粒度节点级，混合形态禁机械清）。 */
  readonly prunable: boolean;
}

/** 节点锚健康分类（声明 vs 物化、orphan 状态 → 机械可处置 / 残量）。 */
export function classifyNodeHealth(detail: NodeDetail): NodeReconcile {
  const declarations = detail.anchorDeclarations;
  const materialized = detail.materializedAnchors.map((a) => ({
    anchorPath: a.anchorPath,
    anchorSymbol: a.anchorSymbol,
    anchorKind: a.anchorKind as string,
    orphan: a.orphan === true,
  }));
  const attachmentHealthy = materialized.some((a) => !a.orphan) || declarations.length > 0;

  const verdicts: OrphanVerdict[] = [];
  for (const anchor of materialized.filter((a) => a.orphan)) {
    const base = { anchorPath: anchor.anchorPath, anchorSymbol: anchor.anchorSymbol, anchorKind: anchor.anchorKind };
    const declared = declarations.some((d) => declarationProduces(d, anchor));
    if (declared) {
      // E-9 形态1：声明仍在 = 真信号，tombstone 保留（L0 高置信复位归 sync 管道 E-228，歧义残留即此）
      verdicts.push({ ...base, disposition: "residual", reason: "声明仍在（E-9 形态1：符号消亡/声明撤销类真信号）——tombstone 保留，节点去留/声明修订需内容判断" });
    } else if (attachmentHealthy) {
      verdicts.push({ ...base, disposition: "prune-fixable", reason: "无声明旧键（E-9 形态3）+ 节点附着面健康——可定向 prune（E-228 R3 同判）" });
    } else {
      verdicts.push({ ...base, disposition: "residual", reason: "零附着节点的 tombstone（E-9 形态3 例外）——保留归体检 orphan_node 口径，节点去留需内容判断" });
    }
  }

  // 混合形态整体降残量：prune op 粒度为节点级，机械清会连带删除保留型 tombstone
  const mixed = verdicts.some((v) => v.disposition === "residual") && verdicts.some((v) => v.disposition === "prune-fixable");
  const finalVerdicts = mixed
    ? verdicts.map((v) =>
        v.disposition === "prune-fixable"
          ? {
              ...v,
              disposition: "residual" as const,
              reason: `${v.reason}；但节点内混合形态（prune 粒度节点级会连带删除保留型 tombstone），整体转残量需人裁`,
            }
          : v,
      )
    : verdicts;

  const deadDeclarations = declarations.filter((d) => !materialized.some((a) => declarationProduces(d, a)));
  const prunable = finalVerdicts.length > 0 && finalVerdicts.every((v) => v.disposition === "prune-fixable");
  return {
    nodeId: detail.node.id,
    name: detail.node.name,
    status: detail.node.status,
    declarations,
    materialized,
    orphanVerdicts: finalVerdicts,
    deadDeclarations,
    prunable,
  };
}

// ── 对账编排 ──────────────────────────────────────────────

export interface ReconcileFileEntry {
  readonly file: string;
  readonly hits: readonly KgAffectedHit[];
}

export interface ResidualItem {
  readonly nodeId: string;
  readonly name: string;
  readonly text: string;
}

export interface FixResult {
  readonly nodeId: string;
  readonly name: string;
  readonly prunedCount: number;
}

export interface ReconcileReport {
  readonly projectRoot: string;
  readonly files: readonly ReconcileFileEntry[];
  readonly nodes: readonly NodeReconcile[];
  readonly fixable: readonly { nodeId: string; name: string; anchors: readonly string[] }[];
  readonly residuals: readonly ResidualItem[];
  /** --fix 执行结果（缺省只读时恒为空）。 */
  readonly fixes: readonly FixResult[];
}

export interface ReconcileInput {
  readonly files: readonly string[];
  readonly fix?: boolean;
  /** prune 审计归属（缺省 "kg-anchor-reconcile"）。 */
  readonly iterationId?: string;
}

/** 对账编排：改动文件 → affected 管辖节点 → 锚健康分类 →（fix 时）定向 prune。 */
export function reconcileAnchors(stack: ReconcileStack, input: ReconcileInput): ReconcileReport {
  const files: ReconcileFileEntry[] = [];
  const nodeOrder: string[] = [];
  const nodeNames = new Map<string, string>();
  const seen = new Set<string>();
  for (const rawFile of input.files) {
    const file = rawFile.replaceAll("\\", "/").replace(/^\.\//, "");
    const hits = stack.query.affected(file);
    files.push({ file, hits });
    for (const hit of hits) {
      if (seen.has(hit.nodeId)) continue;
      seen.add(hit.nodeId);
      nodeOrder.push(hit.nodeId);
      nodeNames.set(hit.nodeId, hit.name);
    }
  }

  const nodes: NodeReconcile[] = [];
  for (const nodeId of nodeOrder) {
    const detail = stack.graph.getNode(stack.projectRoot, nodeId);
    if (detail === null) continue; // affected 命中与详情读取同库，防御不静默吞
    nodes.push(classifyNodeHealth(detail));
  }

  const fixable = nodes
    .filter((n) => n.prunable)
    .map((n) => ({ nodeId: n.nodeId, name: n.name, anchors: n.orphanVerdicts.map((v) => anchorLabel(v)) }));
  const residuals: ResidualItem[] = [];
  for (const n of nodes) {
    for (const v of n.orphanVerdicts) {
      if (v.disposition !== "residual") continue;
      residuals.push({ nodeId: n.nodeId, name: n.name, text: `孤儿物化锚 ${anchorLabel(v)} —— ${v.reason}` });
    }
    for (const d of n.deadDeclarations) {
      residuals.push({
        nodeId: n.nodeId,
        name: n.name,
        text: `声明零物化 ${d.scopeKind} ${d.pattern}（死声明嫌疑，E-9 文件面/符号面边界）——声明去留需内容判断`,
      });
    }
  }

  const fixes: FixResult[] = [];
  if (input.fix === true) {
    for (const item of fixable) {
      const result = stack.write.write(stack.projectRoot, {
        kind: "prune",
        nodeId: item.nodeId,
        iterationId: input.iterationId ?? "kg-anchor-reconcile",
      });
      if (!result.ok) throw new Error(`prune ${item.nodeId} 失败：${result.error.message}`);
      fixes.push({ nodeId: item.nodeId, name: item.name, prunedCount: result.prunedCount ?? 0 });
    }
  }

  return { projectRoot: stack.projectRoot, files, nodes, fixable, residuals, fixes };
}

// ── 报告渲染 ──────────────────────────────────────────────

/** 对账报告 markdown（两清单口径：机械可处置 / 需人判断残量——残量可直接交代用户）。 */
export function formatReconcileReport(report: ReconcileReport): string {
  const lines: string[] = [];
  lines.push("# kg 锚收口对账报告", "");
  lines.push(`- 项目根：${report.projectRoot}`);
  lines.push(`- 改动文件 ${report.files.length} 个 · 管辖节点 ${report.nodes.length} 个`);
  lines.push(
    `- 机械可处置 ${report.fixable.length} 项 · 需人判断残量 ${report.residuals.length} 项 · 已执行 prune ${report.fixes.length} 节点${report.fixes.length === 0 ? "（未带 --fix 时为待执行）" : ""}`,
    "",
  );

  lines.push("## 改动面 → 管辖节点（affected 反查）", "");
  for (const f of report.files) {
    lines.push(`### ${f.file}`);
    if (f.hits.length === 0) {
      lines.push("- （无管辖节点——该文件无锚命中）", "");
      continue;
    }
    for (const hit of f.hits) {
      lines.push(
        `- ${hit.nodeId} ${hit.name}（${hit.viaDecl ? "声明反查" : "物化锚"}：${hit.anchorPath}${hit.anchorSymbol === null ? "" : `#${hit.anchorSymbol}`}）`,
      );
    }
    lines.push("");
  }

  lines.push("## 节点锚健康（声明 vs 物化 / orphan）", "");
  for (const n of report.nodes) {
    lines.push(`### ${n.nodeId} ${n.name}（status=${n.status}）`);
    lines.push(
      `- 声明 ${n.declarations.length} 条：${n.declarations.map((d) => `${d.scopeKind} ${d.pattern}`).join("；") || "（无）"}`,
    );
    lines.push(
      `- 物化 ${n.materialized.length} 枚（活 ${n.materialized.filter((a) => !a.orphan).length} / 孤儿 ${n.orphanVerdicts.length}）：${n.materialized.map((a) => `${anchorLabel(a)}${a.orphan ? "[orphan]" : ""}`).join("；") || "（无）"}`,
    );
    for (const v of n.orphanVerdicts) {
      lines.push(`- 判定[${v.disposition === "prune-fixable" ? "机械可处置" : "残量"}] ${anchorLabel(v)} —— ${v.reason}`);
    }
    for (const d of n.deadDeclarations) {
      lines.push(`- 判定[residual] 声明零物化 ${d.scopeKind} ${d.pattern} —— 死声明嫌疑，声明去留需内容判断`);
    }
    lines.push("");
  }

  lines.push("## 机械可处置项（--fix 执行：定向 prune 孤儿物化锚）", "");
  if (report.fixable.length === 0) lines.push("- （无）", "");
  for (const item of report.fixable) {
    lines.push(`- prune ${item.nodeId} ${item.name}：${item.anchors.join("；")}`);
  }
  if (report.fixable.length > 0) lines.push("");

  lines.push("## 需人判断残量（直接交代用户，不留台账等体检）", "");
  if (report.residuals.length === 0) lines.push("- （无）", "");
  for (const r of report.residuals) {
    lines.push(`- ${r.nodeId} ${r.name}：${r.text}`);
  }
  if (report.residuals.length > 0) lines.push("");

  lines.push("## --fix 执行结果", "");
  if (report.fixes.length === 0) lines.push("- （未执行——缺省只读；带 --fix 时此处落 prune 回执）", "");
  for (const fix of report.fixes) {
    lines.push(`- ${fix.nodeId} ${fix.name}：prunedCount=${fix.prunedCount}`);
  }
  if (report.fixes.length > 0) lines.push("");

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────

export interface CliOptions {
  readonly projectRoot: string;
  readonly files: readonly string[];
  readonly fix: boolean;
  readonly out: string | null;
  readonly iterationId: string | undefined;
}

/** argv → 选项（--files / --diff 二选一；--diff 走 git diff --name-only 取改动面）。 */
export function parseArgs(argv: readonly string[], defaultProjectRoot: string): CliOptions {
  let projectRoot = defaultProjectRoot;
  let fix = false;
  let out: string | null = null;
  let iterationId: string | undefined;
  let filesArg: string | null = null;
  let diffArg: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 缺参数值`);
      i += 1;
      return value;
    };
    if (arg === "--project") projectRoot = next();
    else if (arg === "--files") filesArg = next();
    else if (arg === "--diff") diffArg = next();
    else if (arg === "--fix") fix = true;
    else if (arg === "--out") out = next();
    else if (arg === "--iteration-id") iterationId = next();
    else throw new Error(`未知参数：${arg}`);
  }
  if (filesArg !== null && diffArg !== null) throw new Error("--files 与 --diff 二选一");
  let files: string[] = [];
  if (filesArg !== null) files = filesArg.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
  else if (diffArg !== null) {
    const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", diffArg], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    files = output.split("\n").map((f) => f.trim()).filter((f) => f.length > 0);
  } else {
    throw new Error("必须给改动面输入：--files <清单> 或 --diff <git 范围>");
  }
  return { projectRoot, files, fix, out, iterationId };
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv, path.join(import.meta.dir, "..", ".."));
  const stack = createReconcileStack(options.projectRoot);
  try {
    const report = reconcileAnchors(stack, {
      files: options.files,
      fix: options.fix,
      iterationId: options.iterationId,
    });
    const text = formatReconcileReport(report);
    if (options.out === null) console.log(text);
    else {
      writeFileSync(options.out, text);
      console.log(`对账报告已落盘：${options.out}`);
    }
    return 0;
  } finally {
    stack.dispose();
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`kg-anchor-reconcile：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

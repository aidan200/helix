/**
 * 锚机械重定位（kg-auto-adjudication-design.md §4 L0，P0）。
 *
 * 输入只收**存量 tombstone**（orphan=1 行，含断链快照 evidence）——断链轮
 * 仅落快照标记、下一轮 sync 才消化，天然实现稳定期门（§4.2：tombstone 需
 * 连续 2 次 sync 仍 orphan 才处置）。degraded 门由调用方（syncOnce）保证：
 * degraded 轮不调本函数（索引面不可信时不做锚处置）。
 *
 * 规则与 E-9（锚实体）orphan 三形态的映射——误挂率 0 目标（误挂是隐性
 * 污染：知识安静附着在错误符号上继续注入；失效是显性信号）：
 * - R1b symbol 跨文件迁移（形态2 主形态，生产实证 sweepBatches 族）：旧
 *   path 消失 + 唯一新文件有同名同 kind 符号 + 声明 pathGlob 为精确路径
 *   → 重写声明 pattern 指新文件；
 * - R1 path 精确声明文件移动：旧 path 消失 + 唯一新文件符号名集 Jaccard
 *   ≥0.9（断链快照）→ 重写精确路径声明；
 * - R2 同文件符号改名：旧名消失 + 唯一同 kind 候选 span 重叠 ≥0.5 → 只换
 *   声明 symbol 名（pathGlob 原样——文件没动）；
 * - R3 无声明旧键（形态3，物化声明驱动永不自愈）：当前声明集无法再产生
 *   该锚 + 节点附着面健康（有其他活锚或有声明）→ 机械 prune；
 * - 形态1 符号消亡（声明仍在）→ 不动，保留 tombstone 信号（归 L1 裁决）。
 *
 * 复位机制（E-9 实证）：重写声明后物化全量重算在新位置命中 → upsert 新
 * 键行 orphan=0；旧 tombstone 行随本次 prunes 通道物理删（审计行随行）。
 */

import type { AnchorDeclRow, AnchorDeclRewrite, MaterializedAnchor } from "./types";
import { globToRegExp } from "./anchor-materialize";

export type { AnchorDeclRewrite };

/** span 级符号（sync 管道当前面；spanStart/spanEnd 1-based 闭区间行号）。 */
export interface SpanSymbol {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly spanStart: number;
  readonly spanEnd: number;
}

/** 存量 tombstone（RelocatableAnchor：MaterializedAnchor + 断链快照）。 */
export interface RelocatableAnchor extends MaterializedAnchor {
  /** 断链时刻快照（JSON：symbol 锚 {kind,spanStart,spanEnd} / path 锚 {symbolNames}）。 */
  readonly evidence?: string;
}

export interface RelocateInput {
  readonly tombstones: readonly RelocatableAnchor[];
  readonly declarations: readonly AnchorDeclRow[];
  /** 本轮物化（判节点附着面健康）。 */
  readonly materialized: readonly MaterializedAnchor[];
  readonly filePaths: readonly string[];
  readonly symbols: readonly SpanSymbol[];
}

export type RelocateRule = AnchorDeclRewrite["rule"];

export interface RelocationResult {
  readonly rewrites: readonly AnchorDeclRewrite[];
  /** 物理删 tombstone 行（R1/R1b/R2 重写成功的旧行 + R3 无声明旧键）。 */
  readonly prunes: readonly MaterializedAnchor[];
}

/** 断链快照（symbol 锚）。 */
interface SymbolSnapshot {
  readonly kind: string;
  readonly spanStart: number;
  readonly spanEnd: number;
}

/** 断链快照（path 锚）。 */
interface PathSnapshot {
  readonly symbolNames: readonly string[];
}

function parseSnapshot<T>(evidence: string | undefined): T | null {
  if (evidence === undefined || evidence === "") return null;
  try {
    return JSON.parse(evidence) as T;
  } catch {
    return null; // 防御：非法快照不判（宁可漏判不误判）
  }
}

/** span 重叠率（对旧 span 归一）：|交集行| / |旧 span 行|；旧 span 非法 → 0。 */
function spanOverlap(candidate: SpanSymbol, snapshot: SymbolSnapshot): number {
  const oldLen = snapshot.spanEnd - snapshot.spanStart + 1;
  if (oldLen <= 0) return 0;
  const overlap = Math.min(snapshot.spanEnd, candidate.spanEnd) - Math.max(snapshot.spanStart, candidate.spanStart) + 1;
  return overlap <= 0 ? 0 : overlap / oldLen;
}

/** Jaccard 相似度（符号名集）。 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0; // 双空不构成证据
  let inter = 0;
  for (const name of a) if (b.has(name)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** pattern 是否精确路径（无通配符——glob 声明的语义是人的意图表达，机械不改写）。 */
function isExactPath(pattern: string): boolean {
  return !pattern.includes("*") && !pattern.includes("?");
}

/** symbol pattern 拆分（与 anchor-materialize 同语义：首个 # 分割）。 */
function splitSymbolPattern(pattern: string): { pathGlob: string; symbolName: string } | null {
  const idx = pattern.indexOf("#");
  if (idx <= 0 || idx >= pattern.length - 1) return null;
  return { pathGlob: pattern.slice(0, idx), symbolName: pattern.slice(idx + 1) };
}

/** 当前声明集中能否再产生该物化锚行（R3 判据的一半：声明撤销检测）。 */
function canStillProduce(t: MaterializedAnchor, declarations: readonly AnchorDeclRow[]): boolean {
  if (t.anchorKind === "path") {
    return declarations.some(
      (d) => d.nodeId === t.nodeId && d.scopeKind === "path" && globToRegExp(d.pattern).test(t.anchorPath),
    );
  }
  return declarations.some((d) => {
    if (d.nodeId !== t.nodeId || d.scopeKind !== "symbol") return false;
    const split = splitSymbolPattern(d.pattern);
    return split !== null && split.symbolName === (t.anchorSymbol ?? "") && globToRegExp(split.pathGlob).test(t.anchorPath);
  });
}

export function relocateAnchors(input: RelocateInput): RelocationResult {
  const filePathSet = new Set(input.filePaths);
  const symbolsByFile = new Map<string, SpanSymbol[]>();
  for (const sym of input.symbols) {
    const list = symbolsByFile.get(sym.file);
    if (list === undefined) symbolsByFile.set(sym.file, [sym]);
    else list.push(sym);
  }
  const rewrites: AnchorDeclRewrite[] = [];
  const prunes: MaterializedAnchor[] = [];
  const relocatedKeys = new Set<string>();

  for (const t of input.tombstones) {
    const rewrite = t.anchorKind === "symbol" ? relocateSymbol(t, input.declarations, filePathSet, symbolsByFile) : relocatePath(t, input.declarations, filePathSet, symbolsByFile);
    if (rewrite !== null) {
      rewrites.push(rewrite);
      prunes.push(t);
      relocatedKeys.add(anchorKeyOf(t));
    }
  }

  // R3：无声明旧键 + 节点附着面健康 → 机械 prune（形态3 永不自愈项）
  const healthyNodeIds = new Set<string>();
  for (const m of input.materialized) healthyNodeIds.add(m.nodeId);
  const declaredNodeIds = new Set(input.declarations.filter((d) => d.scopeKind !== "global").map((d) => d.nodeId));
  for (const t of input.tombstones) {
    if (relocatedKeys.has(anchorKeyOf(t))) continue;
    if (canStillProduce(t, input.declarations)) continue; // 形态1 符号消亡：声明仍在 → 真信号保留
    const healthy = healthyNodeIds.has(t.nodeId) || declaredNodeIds.has(t.nodeId);
    if (!healthy) continue; // 节点零附着：保留 tombstone（归体检/orphan_node 口径）
    prunes.push(t);
  }

  return { rewrites, prunes };
}

function anchorKeyOf(a: MaterializedAnchor): string {
  return `${a.nodeId}\u0000${a.anchorKind}\u0000${a.anchorPath}\u0000${a.anchorSymbol ?? ""}`;
}

/**
 * 断链快照构建（断链轮）：从上一轮符号表（getSyncBaseline 内存面）为断链锚
 * 组 evidence JSON——symbol 锚 {kind,spanStart,spanEnd} / path 锚
 * {symbolNames}。无证据（符号表无该行/空集）→ 不入 map（下一轮不判，防误挂）。
 */
export function buildOrphanEvidence(
  orphans: readonly MaterializedAnchor[],
  prevSymbols: readonly SpanSymbol[],
): Map<string, string> {
  const out = new Map<string, string>();
  const prevByFile = new Map<string, SpanSymbol[]>();
  for (const sym of prevSymbols) {
    const list = prevByFile.get(sym.file);
    if (list === undefined) prevByFile.set(sym.file, [sym]);
    else list.push(sym);
  }
  for (const t of orphans) {
    if (t.anchorKind === "symbol") {
      const row = (prevByFile.get(t.anchorPath) ?? []).find((s) => s.name === (t.anchorSymbol ?? ""));
      if (row !== undefined) out.set(anchorKeyOf(t), JSON.stringify({ kind: row.kind, spanStart: row.spanStart, spanEnd: row.spanEnd }));
    } else {
      const names = (prevByFile.get(t.anchorPath) ?? []).map((s) => s.name);
      if (names.length > 0) out.set(anchorKeyOf(t), JSON.stringify({ symbolNames: names }));
    }
  }
  return out;
}

/**
 * 声明重写应用（消化轮）：rewrites 逐条替换声明行 (nodeId, scopeKind,
 * oldPattern) → newPattern；未命中行原样保留（并发改走场景由 applySync
 * 行级 UPDATE 零行命中兜底）。
 */
export function applyDeclRewrites(
  declarations: readonly AnchorDeclRow[],
  rewrites: readonly AnchorDeclRewrite[],
): readonly AnchorDeclRow[] {
  if (rewrites.length === 0) return declarations;
  const keyOf = (nodeId: string, scopeKind: string, pattern: string): string => `${nodeId}\u0000${scopeKind}\u0000${pattern}`;
  const rewriteKeys = new Set(rewrites.map((rw) => keyOf(rw.nodeId, rw.scopeKind, rw.oldPattern)));
  const byKey = new Map(rewrites.map((rw) => [keyOf(rw.nodeId, rw.scopeKind, rw.oldPattern), rw]));
  return declarations.map((d) => {
    const rw = byKey.get(keyOf(d.nodeId, d.scopeKind, d.pattern));
    if (rw === undefined || !rewriteKeys.has(keyOf(d.nodeId, d.scopeKind, d.pattern))) return d;
    return { nodeId: d.nodeId, scopeKind: d.scopeKind, pattern: rw.newPattern };
  });
}

/** R1b（跨文件同名搬家）+ R2（同文件改名）：symbol 锚重定位。 */
function relocateSymbol(
  t: RelocatableAnchor,
  declarations: readonly AnchorDeclRow[],
  filePathSet: ReadonlySet<string>,
  symbolsByFile: ReadonlyMap<string, SpanSymbol[]>,
): AnchorDeclRewrite | null {
  const symbolName = t.anchorSymbol ?? "";
  const snapshot = parseSnapshot<SymbolSnapshot>(t.evidence);
  if (snapshot === null) return null; // 无断链快照：不判（防误挂）

  // 产生该锚的声明：symbolName 等值 ∧ pathGlob 匹配旧 path；恰一条才动（多 glob 交叠 = 歧义）
  const producers = declarations.filter((d) => {
    if (d.nodeId !== t.nodeId || d.scopeKind !== "symbol") return false;
    const split = splitSymbolPattern(d.pattern);
    return split !== null && split.symbolName === symbolName && globToRegExp(split.pathGlob).test(t.anchorPath);
  });
  if (producers.length !== 1) return null;
  const split = splitSymbolPattern(producers[0]!.pattern)!;

  const fileExists = filePathSet.has(t.anchorPath);
  const fileSymbols = symbolsByFile.get(t.anchorPath) ?? [];

  if (fileExists) {
    // R2 同文件改名：旧名消失 + 唯一同 kind 候选 span 重叠 ≥0.5
    if (fileSymbols.some((s) => s.name === symbolName)) return null; // 符号还在（不应发生——tombstone 由断链产生）
    const candidates = fileSymbols.filter(
      (s) => s.name !== symbolName && s.kind === snapshot.kind && spanOverlap(s, snapshot) >= 0.5,
    );
    if (candidates.length !== 1) return null; // 零候选/歧义 → 归 L1
    const cand = candidates[0]!;
    return {
      nodeId: t.nodeId,
      scopeKind: "symbol",
      oldPattern: producers[0]!.pattern,
      newPattern: `${split.pathGlob}#${cand.name}`,
      rule: "R2-symbol-rename",
      evidence: `${t.anchorPath}#${symbolName} → ${t.anchorPath}#${cand.name}（kind=${snapshot.kind}, span 重叠 ${spanOverlap(cand, snapshot).toFixed(2)}）`,
    };
  }

  // R1b 跨文件迁移：唯一其他文件有同名同 kind 符号 + 声明 pathGlob 为精确路径
  if (!isExactPath(split.pathGlob)) return null; // glob 是意图表达，机械不改写
  const hosts = new Set<string>();
  const hostKinds = new Map<string, string>();
  for (const [file, syms] of symbolsByFile) {
    if (file === t.anchorPath) continue;
    for (const s of syms) {
      if (s.name === symbolName) {
        hosts.add(file);
        hostKinds.set(file, s.kind);
      }
    }
  }
  if (hosts.size !== 1) return null; // 零宿主/多宿主 → 归 L1
  const host = [...hosts][0]!;
  if (hostKinds.get(host) !== snapshot.kind) return null; // kind 不符 = 同名不同物
  return {
    nodeId: t.nodeId,
    scopeKind: "symbol",
    oldPattern: producers[0]!.pattern,
    newPattern: `${host}#${symbolName}`,
    rule: "R1b-symbol-cross-file",
    evidence: `${t.anchorPath}#${symbolName} → ${host}#${symbolName}（唯一同名同 kind 宿主）`,
  };
}

/** R1（path 精确声明文件移动）：path 锚重定位。 */
function relocatePath(
  t: RelocatableAnchor,
  declarations: readonly AnchorDeclRow[],
  filePathSet: ReadonlySet<string>,
  symbolsByFile: ReadonlyMap<string, SpanSymbol[]>,
): AnchorDeclRewrite | null {
  if (filePathSet.has(t.anchorPath)) return null; // 文件还在（不应发生）
  const snapshot = parseSnapshot<PathSnapshot>(t.evidence);
  if (snapshot === null || !Array.isArray(snapshot.symbolNames) || snapshot.symbolNames.length === 0) return null;

  // 产生该锚的声明：精确路径等值（glob 声明不重写）；恰一条
  const producers = declarations.filter(
    (d) => d.nodeId === t.nodeId && d.scopeKind === "path" && d.pattern === t.anchorPath,
  );
  if (producers.length !== 1) return null;

  const oldNames = new Set(snapshot.symbolNames);
  let host: string | null = null;
  let hostCount = 0;
  for (const [file, syms] of symbolsByFile) {
    if (file === t.anchorPath) continue;
    const names = new Set(syms.map((s) => s.name));
    if (jaccard(oldNames, names) >= 0.9) {
      host = file;
      hostCount += 1;
    }
  }
  if (hostCount !== 1 || host === null) return null; // 唯一高相似宿主才动
  return {
    nodeId: t.nodeId,
    scopeKind: "path",
    oldPattern: producers[0]!.pattern,
    newPattern: host,
    rule: "R1-path-move",
    evidence: `${t.anchorPath} → ${host}（符号名集 Jaccard ${jaccard(oldNames, new Set((symbolsByFile.get(host) ?? []).map((s) => s.name))).toFixed(2)}）`,
  };
}

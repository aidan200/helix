/**
 * 逻辑冲突判定纯逻辑（T5.1，F3.2，AD-6「只列不修」的判定面）。
 *
 * 机械确定性检出三类（brief 决策消解词表）：
 * ① mutual_governs：A governs B 且 B governs A（双向治理矛盾）——同对象
 *    受双向约束，语义矛盾；
 * ② self_loop：src=dst 自环边——不承载知识语义，写入错误；
 * ③ unknown_verb：verb 不在 EDGE_VERBS 封闭词表——词表封闭性破坏
 *    （service 层校验是防线，此检查兜住存量/漂移数据）。
 *
 * 输出叙述面（summary）遵守 AD-16：以节点 name 叙述，不出现裸 id；
 * NodeRef 携带 id 仅供详情链接。零写路径（纯函数）。
 */

import { EDGE_VERBS, toNodeRef as toNodeRefOf } from "../types";
import type { KnowledgeNode, NodeId, NodeRef, RawEdgeRow } from "../types";

/** 冲突类别（机械确定性判定的封闭集）。 */
export type ConflictKind = "mutual_governs" | "self_loop" | "unknown_verb";

/** 冲突清单项：类别 + 参与边（机械审计）+ 节点引用（人类面）+ 叙述句。 */
export interface ConflictItem {
  readonly kind: ConflictKind;
  readonly edges: readonly RawEdgeRow[];
  readonly nodes: readonly NodeRef[];
  readonly summary: string;
}

/** 扫描输入：全边集（原始行）+ id→节点映射（叙述用）。 */
export interface ConflictScanInput {
  readonly edges: readonly RawEdgeRow[];
  readonly nodesById: ReadonlyMap<NodeId, KnowledgeNode>;
}

const VERB_VOCABULARY = new Set<string>(EDGE_VERBS);

function kindLabelOf(kind: KnowledgeNode["kind"]): string {
  return kind === "rule" ? "规则" : "实体";
}

function refOf(nodesById: ReadonlyMap<NodeId, KnowledgeNode>, id: NodeId): NodeRef | null {
  const node = nodesById.get(id);
  return node === undefined ? null : toNodeRefOf(node);
}

/**
 * 全边集 → 冲突清单（只列不修）。输出顺序确定：
 * mutual_governs（对键序）→ self_loop（节点序）→ unknown_verb（边键序）。
 */
export function findEdgeConflicts(input: ConflictScanInput): ConflictItem[] {
  const { edges, nodesById } = input;
  const items: ConflictItem[] = [];

  // ① 双向 governs：governs 边键集合化，A→B 与 B→A 并存即矛盾（对去重）
  const governsKeys = new Set(
    edges.filter((e) => e.verb === "governs").map((e) => `${e.srcId}\u0000${e.dstId}`),
  );
  const seenPairs = new Set<string>();
  for (const edge of [...edges].sort(byEdgeKey)) {
    if (edge.verb !== "governs" || edge.srcId === edge.dstId) continue; // 自环归 ②
    if (!governsKeys.has(`${edge.dstId}\u0000${edge.srcId}`)) continue;
    const pairKey = [edge.srcId, edge.dstId].sort().join("\u0000");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const reverse = edges.find((e) => e.srcId === edge.dstId && e.dstId === edge.srcId && e.verb === "governs");
    const nodes = [refOf(nodesById, edge.srcId), refOf(nodesById, edge.dstId)].filter(
      (n): n is NodeRef => n !== null,
    );
    items.push({
      kind: "mutual_governs",
      edges: reverse === undefined ? [edge] : [edge, reverse],
      nodes,
      summary:
        nodes.length === 2
          ? `${kindLabelOf(nodes[0]!.kind)}「${nodes[0]!.name}」与${kindLabelOf(nodes[1]!.kind)}「${nodes[1]!.name}」互相 governs——同一对象受双向治理约束，知识语义矛盾，需人工裁决治理方向。`
          : "存在互相 governs 的双向边（节点信息缺失）——同一对象受双向治理约束，需人工裁决治理方向。",
    });
  }

  // ② 自环边
  for (const edge of [...edges].sort(byEdgeKey)) {
    if (edge.srcId !== edge.dstId) continue;
    const ref = refOf(nodesById, edge.srcId);
    items.push({
      kind: "self_loop",
      edges: [edge],
      nodes: ref === null ? [] : [ref],
      summary:
        ref === null
          ? "存在指向自身的自环边——自环不承载知识语义，应为写入错误，需人工修正或移除。"
          : `${kindLabelOf(ref.kind)}「${ref.name}」存在指向自身的 ${edge.verb} 边（自环）——自环不承载知识语义，应为写入错误，需人工修正或移除。`,
    });
  }

  // ③ 词表外 verb
  for (const edge of [...edges].sort(byEdgeKey)) {
    if (VERB_VOCABULARY.has(edge.verb)) continue;
    const nodes = [refOf(nodesById, edge.srcId), refOf(nodesById, edge.dstId)].filter(
      (n): n is NodeRef => n !== null,
    );
    items.push({
      kind: "unknown_verb",
      edges: [edge],
      nodes,
      summary: `知识边存在封闭词表外的动词「${edge.verb}」（词表仅接受 ${EDGE_VERBS.join("/")}）——词表封闭性被破坏，需人工修正为合法动词。`,
    });
  }

  return items;
}

function byEdgeKey(a: RawEdgeRow, b: RawEdgeRow): number {
  return a.srcId < b.srcId ? -1 : a.srcId > b.srcId ? 1 : a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : a.dstId < b.dstId ? -1 : a.dstId > b.dstId ? 1 : 0;
}

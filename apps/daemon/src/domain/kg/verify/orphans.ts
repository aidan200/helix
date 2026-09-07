/**
 * 孤儿/腐烂锚判定纯逻辑（T5.1，F3.2，AD-6「只列不修」的判定面）。
 *
 * 三口径（brief 决策消解）：
 * ① dead_anchor：物化锚 orphan=1（T2.2 符号消亡/声明撤销的失效标记，
 *    行保留可查）——superseded 节点的死锚不列（历史节点无需活锚）；
 * ② orphan_node：无锚（任何物化锚行都算有锚——死锚失效由 ① 口径负责）
 *    且无边（入/出任一即算有边）且非「draft 新建 7 天内」（宽限防误报：
 *    closure 落账的新草稿尚未挂锚是常态）——有 anchor_decl 作用域声明的
 *    节点豁免（global 等声明是刻意的锚定决策，永不物化不是孤儿）。
 * ③ unanchored_node：无锚且无锚声明但**有边**（入/出任一）——② 的边豁免
 *    掩盖形态：节点互相连边逃过孤儿判定，但无锚知识永远无法被锚反查/
 *    附着命中（改动现场永不注入），bootstrap 规范 4 要求每节点带锚，
 *    与边无关。与 ② 互补不重叠：全无进 ②，有边无锚进 ③。豁免口径同 ②
 *    （draft 宽限 / superseded 对称豁免 / NaN 防御）。
 *
 * 叙述面（summary）遵守 AD-16：节点 name 叙述，无裸 id。零写路径。
 */

import { toNodeRef } from "../types";
import type {
  AnchorDeclRow,
  KnowledgeNode,
  MaterializedAnchor,
  NodeRef,
  RawEdgeRow,
} from "../types";

/** draft 新建宽限（brief：7 天；防 findings 落账新草稿误报）。 */
export const ORPHAN_DRAFT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** 腐烂锚项：失效物化锚 + 所属节点引用 + 叙述句。 */
export interface DeadAnchorItem {
  readonly kind: "dead_anchor";
  readonly anchor: MaterializedAnchor;
  readonly node: NodeRef;
  readonly summary: string;
}

/** 孤儿节点项：无锚无边（且过宽限期）的节点引用 + 叙述句。 */
export interface OrphanNodeItem {
  readonly kind: "orphan_node";
  readonly node: NodeRef;
  readonly summary: string;
}

/** 无锚节点项：无锚无锚声明但有边（② 边豁免的掩盖形态）的节点引用 + 叙述句。 */
export interface UnanchoredNodeItem {
  readonly kind: "unanchored_node";
  readonly node: NodeRef;
  readonly summary: string;
}

export type OrphanItem = DeadAnchorItem | OrphanNodeItem | UnanchoredNodeItem;

/** 扫描输入：全节点/全边/全物化锚（含 orphan 标记）/锚声明全集/当前时刻。 */
export interface OrphanScanInput {
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly RawEdgeRow[];
  readonly anchors: readonly MaterializedAnchor[];
  readonly anchorDeclarations: readonly AnchorDeclRow[];
  readonly now: number;
}

function kindLabelOf(kind: KnowledgeNode["kind"]): string {
  return kind === "rule" ? "规则" : "实体";
}

/** 锚叙述名：符号锚 path#symbol；文件锚 path。 */
function anchorLabel(anchor: MaterializedAnchor): string {
  return anchor.anchorSymbol === null || anchor.anchorSymbol === ""
    ? anchor.anchorPath
    : `${anchor.anchorPath}#${anchor.anchorSymbol}`;
}

function deadAnchorSummary(anchor: MaterializedAnchor, ref: NodeRef): string {
  const head = `${kindLabelOf(ref.kind)}「${ref.name}」的`;
  const tail = "——知识失去代码落点，需人工重挂到现行符号或废弃该锚声明。";
  if (anchor.anchorSymbol === null || anchor.anchorSymbol === "") {
    return `${head}文件锚 ${anchor.anchorPath} 已失效（锚定文件已从符号面消失）${tail}`;
  }
  return `${head}符号锚 ${anchorLabel(anchor)} 已失效（锚定符号已在代码中消亡）${tail}`;
}

/**
 * 全库状态 → 孤儿清单（只列不修）。输出顺序确定：dead_anchor 按
 * （nodeId, anchorPath, anchorSymbol）序在前，orphan_node / unanchored_node
 * 各按 id 序在后。
 */
export function findOrphanItems(input: OrphanScanInput): OrphanItem[] {
  const { nodes, edges, anchors, anchorDeclarations, now } = input;
  const nodesById = new Map(nodes.map((n) => [n.id, n] as const));
  const items: OrphanItem[] = [];

  // ① 腐烂锚：orphan 标记 + 节点存在 + 非 superseded
  const deadCandidates = anchors
    .filter((a) => a.orphan === true)
    .map((a) => ({ anchor: a, node: nodesById.get(a.nodeId) }))
    .filter((c): c is { anchor: MaterializedAnchor; node: KnowledgeNode } => c.node !== undefined && c.node.status !== "superseded")
    .sort((x, y) =>
      x.anchor.nodeId < y.anchor.nodeId ? -1 : x.anchor.nodeId > y.anchor.nodeId ? 1 : anchorCompare(x.anchor, y.anchor),
    );
  for (const { anchor, node } of deadCandidates) {
    const ref = toNodeRef(node);
    items.push({ kind: "dead_anchor", anchor, node: ref, summary: deadAnchorSummary(anchor, ref) });
  }

  // ② 孤儿节点：无任何物化锚行 + 无入出边 + 无锚声明 + 过 draft 宽限 +
  // 非 superseded（与 ① dead_anchor 口径对称——CAND-3：留史节点无活锚是
  // 常态，superseded 重建链就是它的挂接面，不应误报孤儿）
  const anchoredNodeIds = new Set(anchors.map((a) => a.nodeId));
  const declaredNodeIds = new Set(anchorDeclarations.map((d) => d.nodeId));
  const edgedNodeIds = new Set<string>();
  for (const edge of edges) {
    edgedNodeIds.add(edge.srcId);
    edgedNodeIds.add(edge.dstId);
  }
  const orphanCandidates = [...nodes]
    .filter((n) => !anchoredNodeIds.has(n.id))
    .filter((n) => !edgedNodeIds.has(n.id))
    .filter((n) => !declaredNodeIds.has(n.id))
    // M1：createdAt 不可解析（NaN）→ 防御跳过不列（对齐 activity-mismatch 同目录口径；
    // NaN 参与比较恒 false，会穿透宽限把新近草稿误报为孤儿）
    .filter((n) => {
      if (n.status !== "draft") return true;
      const createdMs = Date.parse(n.createdAt);
      if (Number.isNaN(createdMs)) return false;
      return now - createdMs >= ORPHAN_DRAFT_GRACE_MS;
    })
    .filter((n) => n.status !== "superseded")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const node of orphanCandidates) {
    const ref = toNodeRef(node);
    items.push({
      kind: "orphan_node",
      node: ref,
      summary: `${kindLabelOf(ref.kind)}「${ref.name}」既无任何锚点也无关系边，且已脱离新近草稿宽限期——游离知识，需人工挂锚或建立关联。`,
    });
  }

  // ③ 无锚节点：无任何物化锚行 + 无锚声明 + 有边（入/出任一）——② 的边豁免
  // 掩盖形态。关系边不能让知识在改动现场被锚反查命中：无锚 = 开工链路永不
  // 注入的死知识（bootstrap 规范 4：每节点必带锚，与边无关）。宽限/豁免口径
  // 与 ② 完全对齐。
  const unanchoredCandidates = [...nodes]
    .filter((n) => !anchoredNodeIds.has(n.id))
    .filter((n) => !declaredNodeIds.has(n.id))
    .filter((n) => edgedNodeIds.has(n.id))
    .filter((n) => {
      if (n.status !== "draft") return true;
      const createdMs = Date.parse(n.createdAt);
      if (Number.isNaN(createdMs)) return false;
      return now - createdMs >= ORPHAN_DRAFT_GRACE_MS;
    })
    .filter((n) => n.status !== "superseded")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const node of unanchoredCandidates) {
    const ref = toNodeRef(node);
    items.push({
      kind: "unanchored_node",
      node: ref,
      summary: `${kindLabelOf(ref.kind)}「${ref.name}」没有任何锚点与锚声明（仅有关系边与主图相连），且已脱离新近草稿宽限期——无锚知识无法被锚反查/附着命中，改动现场永不注入，需人工挂锚（实体/契约符号域锚，规则按三级作用域声明）。`,
    });
  }

  return items;
}

function anchorCompare(a: MaterializedAnchor, b: MaterializedAnchor): number {
  if (a.anchorPath !== b.anchorPath) return a.anchorPath < b.anchorPath ? -1 : 1;
  const sa = a.anchorSymbol ?? "";
  const sb = b.anchorSymbol ?? "";
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * draft 处置需求三分类（P3 L0 读面，纯函数零写路径）。
 *
 * 三类（分类机制确认结论见 docs/temp/kg-classification-funnel-design.md §一/§三）：
 * ① ready：draft 且有活锚（orphan≠1）且 ≤ 7 天宽限——只差裁决动作
 *    （kg-triage ④ 路输入：内容 vs 代码现实核对 → confirmed(auto:) / supersede）；
 * ② stale：ready 态但超 7 天宽限——同一裁决通道的超龄版，面板标积压信号
 *    （宽限语义与 findOrphanItems passesDraftGrace 同源：新近草稿的正常等待期）；
 * ③ anchor-debt：draft 且无活锚且无锚声明——需先挂锚再裁决（triage ③ 路
 *    输入：读正文 → 定位管辖符号 → declareAnchors）。**全死锚也归此类**：
 *    重挂与补挂是同一处置动作；死锚行本身另归 dead_anchor（① 路）独立流转。
 *
 * 豁免口径（与 findOrphanItems ②③ 完全对齐，防双报与误报）：
 * - 非 draft 节点不列（本读面只管草稿；confirmed 节点走体检/语义通道）；
 * - 有锚声明的草稿不列（global 等声明是刻意的锚定决策，永不物化不是缺锚）；
 * - 设计偏差记录：ready 判据为「≥1 活锚」而非设计稿的「锚全活」——死锚有
 *   自己的漏斗通道（dead_anchor → L0 复位/L1 裁决），不阻塞内容裁决。
 *
 * NaN createdAt 防御：按 stale 列（ageDays=null）——可见性优先于精确：
 * 错列可被裁决纠正，漏列永不消化。
 *
 * 叙述面（summary）遵守 AD-16：节点 name 叙述，无裸 id。零写路径。
 */

import { kindLabelOf } from "./labels";
import { toNodeRef } from "../types";
import { ORPHAN_DRAFT_GRACE_MS } from "./orphans";
import type { AnchorDeclRow, KnowledgeNode, MaterializedAnchor, NodeRef } from "../types";

/** draft 处置需求分类（裁决通道分流的数据源）。 */
export type DraftItemKind = "anchor-debt" | "ready" | "stale";

/** 草稿分类项：节点引用 + 分类 + 人读叙述 + 落账天数（NaN 防御 = null）。 */
export interface DraftItem {
  readonly kind: DraftItemKind;
  readonly node: NodeRef;
  readonly summary: string;
  /** createdAt 至今天数（floor）；createdAt 不可解析 = null（按 stale 列）。 */
  readonly ageDays: number | null;
}

/** 扫描输入：全节点（仅 draft 参与分类）/全物化锚（含 orphan 标记）/锚声明全集/当前时刻。 */
export interface DraftScanInput {
  readonly nodes: readonly KnowledgeNode[];
  readonly anchors: readonly MaterializedAnchor[];
  readonly anchorDeclarations: readonly AnchorDeclRow[];
  readonly now: number;
}

/** 节点是否有活锚（任一物化行 orphan≠1）。 */
function hasAliveAnchor(nodeId: string, anchors: readonly MaterializedAnchor[]): boolean {
  return anchors.some((a) => a.nodeId === nodeId && a.orphan !== true);
}

/** 落账天数（floor）；不可解析返回 null。 */
function ageDaysOf(node: KnowledgeNode, now: number): number | null {
  const createdMs = Date.parse(node.createdAt);
  if (Number.isNaN(createdMs)) return null;
  return Math.floor((now - createdMs) / 86_400_000);
}

function readySummary(ref: NodeRef): string {
  return `${kindLabelOf(ref.kind)}「${ref.name}」为草稿且锚点健康——内容待裁决转正，可交 kg-triage 消化（④ 路）。`;
}

function staleSummary(ref: NodeRef, ageDays: number | null): string {
  const age = ageDays === null ? "（落账时间不可解析）" : `已 ${ageDays} 天`;
  return `${kindLabelOf(ref.kind)}「${ref.name}」草稿${age}未裁决（锚点健康）——超龄积压，建议 kg-triage 消化（④ 路）。`;
}

function anchorDebtSummary(ref: NodeRef): string {
  return `${kindLabelOf(ref.kind)}「${ref.name}」草稿无活锚且无锚声明——需先挂锚（kg-triage 定位管辖符号，③ 路）再裁决转正。`;
}

/**
 * 全库状态 → 草稿三分类清单。输出顺序确定：按节点 id 升序（②③ orphan
 * 清单同序）。只列 draft；豁免口径见模块注释。
 */
export function classifyDrafts(input: DraftScanInput): DraftItem[] {
  const { nodes, anchors, anchorDeclarations, now } = input;
  const declaredNodeIds = new Set(anchorDeclarations.map((d) => d.nodeId));
  const items: DraftItem[] = [];
  for (const node of nodes) {
    if (node.status !== "draft") continue; // 只管草稿
    if (declaredNodeIds.has(node.id)) continue; // 有声明 = 刻意锚定决策，豁免
    const ageDays = ageDaysOf(node, now);
    const ref = toNodeRef(node);
    if (!hasAliveAnchor(node.id, anchors)) {
      items.push({ kind: "anchor-debt", node: ref, summary: anchorDebtSummary(ref), ageDays });
      continue;
    }
    const fresh = ageDays !== null && now - Date.parse(node.createdAt) < ORPHAN_DRAFT_GRACE_MS;
    items.push(
      fresh
        ? { kind: "ready", node: ref, summary: readySummary(ref), ageDays }
        : { kind: "stale", node: ref, summary: staleSummary(ref, ageDays), ageDays },
    );
  }
  return items.sort((a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
}

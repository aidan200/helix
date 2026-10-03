/**
 * draft 处置需求三分类（P3 L0 读面，纯函数零写路径）。
 *
 * 三类（分类机制确认结论见 docs/temp/kg-classification-funnel-design.md §一/§三）：
 * ① ready：draft 且锚定就绪（≥1 活锚，或仅 global 声明——刻意不物化不是
 *    缺锚）且 ≤ 7 天宽限——只差裁决动作（kg-triage ④ 路输入：内容 vs
 *    代码现实核对 → confirmed(auto:) / supersede）；
 * ② stale：锚定就绪但超 7 天宽限——同一裁决通道的超龄版，面板标积压信号
 *    （宽限语义与 findOrphanItems passesDraftGrace 同源：新近草稿的正常等待期）；
 * ③ anchor-debt：draft 且锚定未就绪——无声明（补挂），或声明含 path/symbol
 *    但无一活锚（未物化/全死；死锚行本身另归 dead_anchor ① 路独立流转，
 *    重挂与补挂是同一处置动作）（triage ③ 路输入：declareAnchors）。
 *
 * 豁免口径（与 findOrphanItems ②③ 对齐，防双报与误报）：
 * - 非 draft 节点不列（本读面只管草稿；confirmed 节点走体检/语义通道）；
 * - 仅 global 声明不算锚债（②③ 对声明节点的豁免同因）——但**不豁免出
 *   ready/stale**：刻意的 global 锚定无需锚工作，内容裁决照常可做。
 *   修复记录：P3 首版一刀切豁免了所有带声明的草稿（本读面是裁决输入面
 *   非报告面，漏列=永不消化），带活锚的 ready 类在判定前即被吞，④ 路输入
 *   恒空——2026-09-29 triage 首跑暴露（5 草稿 0 进 ④ 路）。
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

/** 草稿分类项：节点引用 + 分类 + 人读叙述 + 落账天数（NaN 防御 = null）+ 是否带锚声明（③ 路区分补挂/重挂；带声明 anchor-debt ②③ 按声明豁免不报，须由本读面直接供入）+ 升级留痕（change_log escalate: 前缀最新行，service 层 join——纯函数不产，无则 undefined）。 */
export interface DraftItem {
  readonly kind: DraftItemKind;
  readonly node: NodeRef;
  readonly summary: string;
  /** createdAt 至今天数（floor）；createdAt 不可解析 = null（按 stale 列）。 */
  readonly ageDays: number | null;
  /** 是否带锚声明（仅 global / path / symbol 任一）。 */
  readonly declared: boolean;
  /** 人审升级留痕（最新一条白话裁决问题）；未被升级过的草稿 undefined。 */
  readonly note?: string;
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
  return `${kindLabelOf(ref.kind)}「${ref.name}」为草稿且锚定就绪（活锚或刻意 global 锚定）——内容待裁决转正，可交 kg-triage 消化（④ 路）。`;
}

function staleSummary(ref: NodeRef, ageDays: number | null): string {
  const age = ageDays === null ? "（落账时间不可解析）" : `已 ${ageDays} 天`;
  return `${kindLabelOf(ref.kind)}「${ref.name}」草稿${age}未裁决（锚定就绪）——超龄积压，建议 kg-triage 消化（④ 路）。`;
}

function anchorDebtSummary(ref: NodeRef, declared: boolean): string {
  const act = declared ? "锚声明在但无一活，需重挂锚（声明 pattern 指向已变符号）" : "无锚声明，需补挂锚（读正文定位管辖符号）";
  return `${kindLabelOf(ref.kind)}「${ref.name}」草稿锚定未就绪——${act}，kg-triage ③ 路；重挂/补挂后下轮走 ④ 裁决。`;
}

/**
 * 全库状态 → 草稿三分类清单。输出顺序确定：按节点 id 升序（②③ orphan
 * 清单同序）。只列 draft；豁免口径见模块注释。
 */
export function classifyDrafts(input: DraftScanInput): DraftItem[] {
  const { nodes, anchors, anchorDeclarations, now } = input;
  const declsByNode = new Map<string, AnchorDeclRow[]>();
  for (const d of anchorDeclarations) {
    const list = declsByNode.get(d.nodeId);
    if (list) list.push(d);
    else declsByNode.set(d.nodeId, [d]);
  }
  const items: DraftItem[] = [];
  for (const node of nodes) {
    if (node.status !== "draft") continue; // 只管草稿
    const ref = toNodeRef(node);
    const ageDays = ageDaysOf(node, now);
    // 锚定就绪 = 有活锚，或锚定是刻意的仅-global 决策（永不物化不是缺锚）。
    // 带声明但无一活（path/symbol 未物化或全死）不算就绪——归 anchor-debt
    // （重挂与补挂同动作；死锚行另归 dead_anchor ① 路独立流转）。
    const decls = declsByNode.get(node.id) ?? [];
    const declared = decls.length > 0;
    const anchored =
      hasAliveAnchor(node.id, anchors) || (declared && decls.every((d) => d.scopeKind === "global"));
    if (!anchored) {
      items.push({ kind: "anchor-debt", node: ref, summary: anchorDebtSummary(ref, declared), ageDays, declared });
      continue;
    }
    const fresh = ageDays !== null && now - Date.parse(node.createdAt) < ORPHAN_DRAFT_GRACE_MS;
    items.push(
      fresh
        ? { kind: "ready", node: ref, summary: readySummary(ref), ageDays, declared }
        : { kind: "stale", node: ref, summary: staleSummary(ref, ageDays), ageDays, declared },
    );
  }
  return items.sort((a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
}

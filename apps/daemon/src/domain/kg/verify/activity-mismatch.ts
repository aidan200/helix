/**
 * 活跃度错位启发排序（T5.1，F3.2；AD-14 漏网兜底第二层）。
 *
 * 输入信号（brief 决策消解）：文件 churn 证据（files 表 mtime——最近一次
 * 修改时刻，作为「代码高频变更」的可达代理）× 知识侧最后更新
 * （nodes.updated_at——锚/知识长期未动的可达代理）。
 *
 * 候选 = 文件近期仍在变更（mtime 距 now 在 churn 窗口内）且知识滞后
 * （mtime − updated_at ≥ staleGap）；排序 = 滞后时长降序（churn 高且锚
 * 久未动者排前），并列按节点 id/锚路径稳定排序。
 *
 * **启发式非结论**（CL-3.A7）：每条输出 summary 必含「疑似过时」与
 * 「非结论」限定词——排序供人审变化报告终裁（AD-14 第三层），处置权
 * 在人。零写路径（纯函数）。
 */

import { toNodeRef } from "../types";
import type { KnowledgeNode, MaterializedAnchor, NodeRef } from "../types";

/** churn 窗口缺省：文件 30 天内有修改视为「仍在变更」。 */
export const DEFAULT_CHURN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 滞后门槛缺省：知识落后代码改动 7 天以上视为错位。 */
export const DEFAULT_STALE_GAP_MS = 7 * 24 * 60 * 60 * 1000;

/** 单锚活跃度信号：节点 + 活跃物化锚 + 锚定文件 mtime（无记录=null）。 */
export interface ActivitySignal {
  readonly node: KnowledgeNode;
  readonly anchor: MaterializedAnchor;
  readonly fileMtime: number | null;
}

/** 疑似过时项：节点引用 + 锚 + 滞后时长 + 叙述句（含强制限定词）。 */
export interface SuspectItem {
  readonly node: NodeRef;
  readonly anchor: MaterializedAnchor;
  readonly lagMs: number;
  readonly summary: string;
}

export interface ActivitySortOptions {
  readonly now?: number;
  readonly churnWindowMs?: number;
  readonly staleGapMs?: number;
}

function kindLabelOf(kind: KnowledgeNode["kind"]): string {
  return kind === "rule" ? "规则" : "实体";
}

/** 滞后时长的人类叙述（<1 天显示「不足 1 天」）。 */
function lagLabel(lagMs: number): string {
  const days = Math.floor(lagMs / (24 * 60 * 60 * 1000));
  return days >= 1 ? `${days} 天` : "不足 1 天";
}

/**
 * 活跃度信号全集 → 疑似过时排序清单（只列不修）。确定性：滞后降序 →
 * 节点 id → 锚路径。
 */
export function sortActivityMismatch(
  signals: readonly ActivitySignal[],
  options: ActivitySortOptions = {},
): SuspectItem[] {
  const now = options.now ?? Date.now();
  const churnWindowMs = options.churnWindowMs ?? DEFAULT_CHURN_WINDOW_MS;
  const staleGapMs = options.staleGapMs ?? DEFAULT_STALE_GAP_MS;

  const candidates: SuspectItem[] = [];
  for (const signal of signals) {
    const { node, anchor, fileMtime } = signal;
    if (fileMtime === null) continue; // 无文件记录 → 无 churn 证据
    if (fileMtime < now - churnWindowMs) continue; // 文件久未改 → 不在活跃 churn 窗口
    const updatedAtMs = Date.parse(node.updatedAt);
    if (Number.isNaN(updatedAtMs)) continue; // 时间戳不可解析 → 防御跳过
    const lagMs = fileMtime - updatedAtMs;
    if (lagMs < staleGapMs) continue; // 知识未显著滞后于代码
    const ref = toNodeRef(node);
    const label = anchor.anchorSymbol === null || anchor.anchorSymbol === "" ? anchor.anchorPath : `${anchor.anchorPath}#${anchor.anchorSymbol}`;
    candidates.push({
      node: ref,
      anchor,
      lagMs,
      summary: `本迭代启发式检查发现：文件 ${anchor.anchorPath} 近期仍在变更，而锚定它的${kindLabelOf(ref.kind)}「${ref.name}」（锚点 ${label}）已 ${lagLabel(lagMs)} 未随知识更新——疑似过时（启发式排序，非结论，处置权在人）。`,
    });
  }

  return candidates.sort((a, b) =>
    a.lagMs !== b.lagMs ? b.lagMs - a.lagMs : a.node.id !== b.node.id ? (a.node.id < b.node.id ? -1 : 1) : a.anchor.anchorPath < b.anchor.anchorPath ? -1 : a.anchor.anchorPath > b.anchor.anchorPath ? 1 : 0,
  );
}

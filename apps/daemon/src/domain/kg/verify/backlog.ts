/**
 * triage 待办积压计数（评审 F1 单点提取）。
 *
 * 为什么存在：KgTriageService.pendingCount（kg-triage 准入计数——零待办
 * 即 nothing_pending 拒发）与 KgViewerService.health triageHint（面板积压
 * 提示，阈值 10）原先各自内联同一口径，2026-09-29 pendingCount 补「带声明
 * anchor-debt」项时 viewer 侧未跟——积压提示低于准入计数、阈值失真
 * （评审实证）。计数逻辑收口本纯函数，两消费面共用（口径同源由机械保证
 * 而非注释维系）。
 *
 * 口径（与 KgTriageService.pendingCount 历史语义逐项等价）：
 * - 候选 pending + deferred（台账两在途态）；
 * - dead_anchor（① 路：L0 复位/L1 裁决）；
 * - orphan_node / unanchored_node（②③ 路无锚节点）；
 * - draft ready + stale（④ 路内容裁决）+ **带声明 anchor-debt**（③ 路重挂；
 *   无声明 anchor-debt 不重复计数——过宽限即入无锚节点计数，宽限内是
 *   刚落账的正常等待；带声明类 ②③ 按声明豁免永不浮现，漏计会
 *   nothing_pending 拒发——2026-09-29 修复口径）。
 */

import type { CandidateStatusCounts } from "../types";
import type { OrphanItem } from "./orphans";
import type { DraftItem } from "./drafts";

/** 积压计数输入（三读面各取一次，纯函数零 IO）。 */
export interface TriageBacklogInput {
  readonly candidates: CandidateStatusCounts;
  readonly orphans: readonly OrphanItem[];
  readonly drafts: readonly DraftItem[];
}

/** triage 待办积压总数（kg-triage 准入计数与面板 triageHint 共用单点）。 */
export function countTriageBacklog(input: TriageBacklogInput): number {
  const deadAnchors = input.orphans.filter((o) => o.kind === "dead_anchor").length;
  const unanchored = input.orphans.filter((o) => o.kind === "orphan_node" || o.kind === "unanchored_node").length;
  const drafts = input.drafts.filter(
    (d) => d.kind === "ready" || d.kind === "stale" || (d.kind === "anchor-debt" && d.declared),
  ).length;
  return input.candidates.pending + input.candidates.deferred + deadAnchors + unanchored + drafts;
}

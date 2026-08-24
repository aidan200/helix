/**
 * instance 投影域 —— 实例归属判定 / 条目排序 / spawn 锚权威计算
 * （iter-20260821-dg90 T3.1 / M4 投资批，CL-4）。
 *
 * 迁并来源（三方共引单源化）：
 * - isMainInstance / entrySortKey：daemon EntryDtoMapper ↔ shell snapshot
 *   两份同构实现收敛（message/tool 用 ts（epoch ms）；thinking/compaction
 *   用 createdAt（ISO）——两类字段同一时间轴，契约 §6.1）；
 * - lastMainAnchorId / computeAnchorEntryId：迁自 daemon ws-server
 *   SpawnAnchor.ts（契约 v0.3 §1 三分支；原前端快照推导上收后的权威计算，
 *   T3.1 起 shell 零推导直读 DTO——本模块供 daemon 组装面调用）。
 *
 * 纯数据进纯数据出（无 IO / framework-free）。
 */
import { MAIN_INSTANCE_ID } from "../envelope";
import type { EntryDto } from "../types/session";

// ── 实例归属判定（§10.1/§17.11 T10：缺省或字面 "main" = legacy 主实例读侧推断）──

/** 主实例归属判定（legacy 读侧推断单点：undefined 缺省或字面 "main" = main；
 *  现行写侧全实例显式携带 agent-<唯一串>，main 归属判别走 kind，不经本函数）。 */
export function isMainInstance(instanceId: string | undefined): boolean {
  return (instanceId ?? MAIN_INSTANCE_ID) === MAIN_INSTANCE_ID;
}

// ── 条目排序基元（daemon entrySortKey ↔ shell entryTimelineKey 同构收敛） ──

/** 排序统一键：message/tool 用 ts（epoch ms）；thinking/compaction 用
 *  createdAt（ISO，契约 §6.1）——两类字段同一时间轴。 */
export function entrySortKey(entry: EntryDto): number {
  return "ts" in entry ? entry.ts : Date.parse(entry.createdAt);
}

// ── spawn 锚权威计算（契约 v0.3 §1，AD-5/Q-1a） ──────────────

/** 锚点扫描基元结构最小型——DTO（EntryDto）与 domain 条目数据共用。 */
export interface AnchorScanEntry {
  readonly id: string;
  readonly instanceId?: string;
  readonly kind?: string;
}

/** 锚计算所需的实例引用面（结构最小型；daemon InstanceSnapshotEntry 结构兼容）。 */
export interface AnchorInstanceRef {
  readonly kind: "main" | "subagent";
  readonly instanceId: string;
  /** spawn 时值（视图携带；缺省 = 恢复边界退化尾部推导）。 */
  readonly spawnAnchorEntryId?: string | null;
}

/**
 * 锚点扫描基元（纯函数）：entries[0, end) 内按数组序最后一条 main 归属或
 * compaction entry 的 id（无 → null 流首）。只用聚合 entries 数组序，不掺
 * ts 排序（explorer 排序陷阱注记：并列稳定问题规避）。
 */
export function lastMainAnchorId(entries: readonly AnchorScanEntry[], end: number = entries.length): string | null {
  let anchor: string | null = null;
  for (let i = 0; i < end; i++) {
    const e = entries[i]!;
    if (isMainInstance(e.instanceId) || e.kind === "compaction") {
      anchor = e.id;
    }
  }
  return anchor;
}

/**
 * spawn 锚权威计算（契约 v0.3 §1 三分支机械判定；纯函数——同输入同输出）：
 * ① 实例已有 Entry → 首条非 compaction 归属 Entry 前最后一条 main/compaction
 *    entry id（无 → null 流首）；首 Entry 后 append 的 main entry 不影响锚
 *   （append-only，[0, firstIdx) 稳定域）；
 * ② 实例尚无 Entry → spawn 时值（视图携带，不按当前尾部重算）；
 * ③ 主实例 → 不携带（undefined）。
 * 恢复边界（契约记录在案）：重启后仍无 Entry 的实例 spawn 时值不可重建
 * （视图缺省），退化为规则①的尾部推导值（best-effort）。
 */
export function computeAnchorEntryId(
  entries: readonly AnchorScanEntry[],
  instance: AnchorInstanceRef,
): string | null | undefined {
  if (instance.kind === "main") return undefined; // 规则③
  const firstIdx = entries.findIndex(
    (e) => e.kind !== "compaction" && (e.instanceId ?? MAIN_INSTANCE_ID) === instance.instanceId,
  );
  if (firstIdx >= 0) return lastMainAnchorId(entries, firstIdx); // 规则①
  if (instance.spawnAnchorEntryId !== undefined) return instance.spawnAnchorEntryId; // 规则②
  return lastMainAnchorId(entries); // 恢复边界：spawn 时值缺位 → 尾部推导
}

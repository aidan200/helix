/**
 * SpawnAnchor —— spawn 锚权威计算（T2.1 契约 v0.3 §1，AD-5/Q-1a）。
 * 零依赖纯函数模块（仅 import type domain 视图 + protocol 常量）；
 * 自 DtoMapper.ts 四域拆分落位（T3.1，TR-AD-25④ 逐行搬移）。
 */
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import type { InstanceSnapshotEntry } from "../../../application/ports/inbound/SessionPort";

// ── spawn 锚权威计算（T2.1 契约 v0.3 §1，AD-5/Q-1a） ──────────────

/** 锚点扫描基元结构最小型——DTO（EntryDto）与 domain 条目数据（SessionEntryData）共用。 */
export interface AnchorScanEntry {
  readonly id: string;
  readonly instanceId?: string;
  readonly kind?: string;
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
    if ((e.instanceId ?? MAIN_INSTANCE_ID) === MAIN_INSTANCE_ID || e.kind === "compaction") {
      anchor = e.id;
    }
  }
  return anchor;
}

/**
 * spawn 锚权威计算（契约 v0.3 §1 三分支机械判定；纯函数——同输入同输出；
 * 原前端快照推导同规上收 daemon，T3.1 起 shell 零推导直读 DTO）：
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
  instance: InstanceSnapshotEntry,
): string | null | undefined {
  if (instance.kind === "main") return undefined; // 规则③
  const firstIdx = entries.findIndex(
    (e) => e.kind !== "compaction" && (e.instanceId ?? MAIN_INSTANCE_ID) === instance.instanceId,
  );
  if (firstIdx >= 0) return lastMainAnchorId(entries, firstIdx); // 规则①
  if (instance.spawnAnchorEntryId !== undefined) return instance.spawnAnchorEntryId; // 规则②
  return lastMainAnchorId(entries); // 恢复边界：spawn 时值缺位 → 尾部推导
}

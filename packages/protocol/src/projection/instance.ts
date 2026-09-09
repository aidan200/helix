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
import type { EntryDto } from "../types/session";

// ── 实例归属判定（§10.1/§17.11 T10：缺省或字面 "main" = legacy 主实例读侧推断）──

/**
 * legacy 主实例 id 字面（T10c 常量退役后本模块自持）：历史行/历史帧的
 * instance_id="main" 读侧推断专用——MAIN_INSTANCE_ID 常量（@helix/common
 * 定义 + envelope re-export）已随 shell 段 T10c 整体删除，全仓零残留；
 * legacy 判别由读侧 helper（本函数 / shell isMainChannel）承担。
 */
const LEGACY_MAIN_INSTANCE_ID = "main";

/** 主实例归属判定（legacy 读侧推断单点：undefined 缺省或字面 "main" = main；
 *  现行写侧全实例显式携带 agent-<唯一串>，main 归属判别走 kind，不经本函数）。 */
export function isMainInstance(instanceId: string | undefined): boolean {
  return (instanceId ?? LEGACY_MAIN_INSTANCE_ID) === LEGACY_MAIN_INSTANCE_ID;
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
  /** 时间键源（message/tool = ts epoch ms；thinking/compaction = createdAt ISO，
   *  entrySortKey 同口径）——仅恢复边界 createdAt 截断推导使用；双缺 = 不可比
   *  （不作锚候选）。 */
  readonly ts?: number;
  readonly createdAt?: string;
}

/** 锚计算所需的实例引用面（结构最小型；daemon InstanceSnapshotEntry 结构兼容）。 */
export interface AnchorInstanceRef {
  readonly kind: "main" | "subagent";
  readonly instanceId: string;
  /** spawn 时值（视图携带；缺省 = 恢复边界按 createdAt 截断推导）。 */
  readonly spawnAnchorEntryId?: string | null;
  /** 实例创建时刻（ISO；恢复链自 agent.spawned 事件 occurredAt 原值重建）——
   *  恢复边界截断推导的时间基准；缺省/不可解析 = 退防御尾部推导。 */
  readonly createdAt?: string;
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

/** 恢复边界锚推导（spawn 时刻截断；模块内私有——唯一消费 =
 *  computeAnchorEntryId 恢复边界分支，导出面登记不动）：聚合数组序内时间键
 *  ≤ spawnKey 的最后一条 main/compaction entry id（无 → null 流首）。时间键
 *  = ts ?? Date.parse(createdAt)（entrySortKey 同口径）；双缺/不可解析条目
 *  不可比，跳过不作锚。输入已按 entrySortKey 排序时 = 截断点最大值（并列保
 *  数组序）。 */
function anchorIdBeforeSpawn(entries: readonly AnchorScanEntry[], spawnKey: number): string | null {
  let anchor: string | null = null;
  for (const e of entries) {
    const key = e.ts ?? (e.createdAt !== undefined ? Date.parse(e.createdAt) : NaN);
    if (!Number.isFinite(key) || key > spawnKey) continue;
    if (isMainInstance(e.instanceId) || e.kind === "compaction") anchor = e.id;
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
 * 恢复边界：重启后仍无 Entry 的实例 spawn 时值不可重建（视图缺省）→ 按实例
 * createdAt（恢复链自 agent.spawned 事件 occurredAt 原值重建）截断推导 spawn
 * 时刻锚——与规则②同语义近似（best-effort，不另建持久化事实源）；createdAt
 * 缺位/不可解析才退防御性尾部推导（旧边界行为，仅存于缺 createdAt 的调用方）。
 */
export function computeAnchorEntryId(
  entries: readonly AnchorScanEntry[],
  instance: AnchorInstanceRef,
): string | null | undefined {
  if (instance.kind === "main") return undefined; // 规则③
  const firstIdx = entries.findIndex(
    (e) => e.kind !== "compaction" && (e.instanceId ?? LEGACY_MAIN_INSTANCE_ID) === instance.instanceId,
  );
  if (firstIdx >= 0) return lastMainAnchorId(entries, firstIdx); // 规则①
  if (instance.spawnAnchorEntryId !== undefined) return instance.spawnAnchorEntryId; // 规则②
  // 恢复边界：spawn 时值缺位 → createdAt 截断推导（同规则②语义近似）
  if (instance.createdAt !== undefined) {
    const spawnKey = Date.parse(instance.createdAt);
    if (Number.isFinite(spawnKey)) return anchorIdBeforeSpawn(entries, spawnKey);
  }
  return lastMainAnchorId(entries); // 防御尾巴：createdAt 缺位/不可解析 → 旧尾部推导
}

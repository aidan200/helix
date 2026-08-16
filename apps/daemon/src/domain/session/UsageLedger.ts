import type { SessionUsageSummary, UsageSummary } from "./SessionSnapshot";

/**
 * UsageLedger —— 会话账目纯语义（iter-20260816-uzvg T3.2，AD-4：账目是
 * domain 权威状态，事件 + 快照投影）。
 *
 * 【模型】入账事实 = usage.recorded 领域事件（每 turn 一条 / 每次 compaction
 * 一条——「流式中不动账」由事件源头结构性保证：delta 分支不产生本事件）。
 * 账本（本文件）是这些事件的纯函数投影：
 * - applyUsage：一条入账 → per-instance 小计七字段各自累加；source=
 *   "compaction" 同时计入会话级 compaction 小计（归属 main 实例小计但
 *   独立展示，AD-9③）；
 * - aggregateSession：小计 → 会话聚合（SessionUsageSummary 形状，契约
 *   §6.2）——total = Σ 全部实例（含 main 与 agent-N）。
 *
 * 【自洽判据（决策消解）】Σ instances[].usage.totalTokens = total.totalTokens
 * 且 compaction 小计 ⊆ total——由「compaction 同步计入实例小计与独立小计」
 * 结构性成立，无需后置校验。
 *
 * 【持久化】事件即账（TR-AD-5）：账本不单独落盘，重启恢复 = 重放
 * domain_events 的 usage.recorded 行（RestoreService 调 applyUsage 重建，
 * 见 usageLedgerFromEvents）。
 *
 * 纯数据 + 纯函数（零依赖可单测）；运行期唯一持有在组合根（fan-out
 * projection 单写点），service 只发事件不触账本。
 */

/** 入账来源（契约 §5.2 usage.recorded.source 同构）。 */
export type UsageSource = "turn" | "compaction";

/** 账本数据（纯数据值对象；快照组装/恢复重放均以本形状往返）。 */
export interface UsageLedgerData {
  /** per-instance 小计（instanceId → 七字段累加；popover 行数据源）。 */
  readonly instances: Readonly<Record<string, UsageSummary>>;
  /** compaction 摘要小计（session 级独立行；含在 total 内，AD-9③）。 */
  readonly compaction: UsageSummary;
}

/** 零值用量（七字段全 0；provider 未报/空账占位，账目行保持完整）。 */
export const ZERO_USAGE: UsageSummary = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: 0,
};

/** 空账本。 */
export function emptyUsageLedger(): UsageLedgerData {
  return { instances: {}, compaction: { ...ZERO_USAGE } };
}

/**
 * 一条入账 → 新账本（不可变：返回新值不改写入参）。
 * compaction 来源计入实例小计的同时计入独立小计（compaction 归属 main
 * 实例执行——归属实例小计 + 独立展示行，两者都来自同一事件）。
 */
export function applyUsage(
  ledger: UsageLedgerData,
  instanceId: string,
  usage: UsageSummary,
  source: UsageSource,
): UsageLedgerData {
  return {
    instances: { ...ledger.instances, [instanceId]: addUsage(ledger.instances[instanceId], usage) },
    compaction: source === "compaction" ? addUsage(ledger.compaction, usage) : ledger.compaction,
  };
}

/** per-instance 小计（未见过的实例 = 零值形状，不隐式登记）。 */
export function instanceUsageOf(ledger: UsageLedgerData, instanceId: string): UsageSummary {
  return ledger.instances[instanceId] ?? { ...ZERO_USAGE };
}

/** 聚合：total = Σ 全部实例小计；compaction = 独立小计直通（契约 §6.2）。 */
export function aggregateSession(ledger: UsageLedgerData): SessionUsageSummary {
  let total: UsageSummary = { ...ZERO_USAGE };
  for (const id of Object.keys(ledger.instances)) {
    total = addUsage(total, ledger.instances[id]!);
  }
  return { total, compaction: { ...ledger.compaction } };
}

/** 七字段各自累加（cost 以 pi 直算值只加不改写）。 */
function addUsage(a: UsageSummary | undefined, b: UsageSummary): UsageSummary {
  if (a === undefined) return { ...b };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

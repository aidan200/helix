/**
 * usage 投影域 —— 会话账目纯语义（iter-20260821-dg90 T3.1 / M4 投资批，CL-4；
 * 迁自 daemon domain/session/UsageLedger.ts——iter-20260816-uzvg T3.2 语义
 * 原样单源化，daemon/shell 双消费面改调本模块）。
 *
 * 【模型】入账事实 = usage.recorded 领域事件（每 turn 一条 / 每次 compaction
 * 一条——「流式中不动账」由事件源头结构性保证）。账本是这些事件的纯函数
 * 投影（AD-4 事件即账）：
 * - applyUsage：一条入账 → per-instance 小计七字段各自累加（**source 无关——
 *   compaction 也计入实例小计**，归属 main 实例执行）+ source="compaction"
 *   同时计入会话级独立小计（AD-9③「compaction ⊆ total」结构性成立）；
 * - aggregateSession：小计 → 会话聚合（total = Σ 全部实例小计）。
 *
 * 【口径权威（AF-2 统一裁决）】本模块是 compaction 口径的唯一定义点：
 * daemon 账本（计入实例小计）为准；shell 增量路径（T3.1 前不计入）已改调
 * 本模块对齐——同一 store 增量/快照两路径 byInstance 口径一致。
 *
 * 【边界】纯数据进纯数据出（无 IO / framework-free）；权威状态与入账时机
 * 归 daemon（TR-AD-5：账本不单独落盘，重启恢复 = daemon 侧重放事件重建）。
 */

import type { SessionUsageDto, UsageDto } from "../types/usage";

/** 入账来源（契约 §5.2 usage.recorded.source 同构）。 */
export type UsageSource = "turn" | "compaction";

/** 账本数据（纯数据值对象；daemon 组装/恢复重放以此形状往返）。 */
export interface UsageLedgerData {
  /** per-instance 小计（instanceId → 七字段累加；popover 行数据源）。 */
  readonly instances: Readonly<Record<string, UsageDto>>;
  /** compaction 摘要小计（session 级独立行；含在 total 内，AD-9③）。 */
  readonly compaction: UsageDto;
  /**
   * 上下文水位（instanceId → 该实例最后一条 turn 源用量的 totalTokens，
   * 即最近一次调用的窗口占用；观察面 TR-59——账目累计只增，水位只覆写）。
   * turn 入账覆写；compaction 摘要入账不覆写（其 input 是压缩前全文，
   * 不代表压缩后窗口）；compaction.completed 重置为 tokensAfter
   * （applyCompaction）。重启恢复 = 事件重放同规则重建（终态实例也精确）。
   */
  readonly ctx: Readonly<Record<string, number>>;
  /**
   * per-turn 账目（additive，轮末 token 用量显示面）：turnId → 该轮入账
   * 累计（usage.recorded 携带 turnId 时入账，同 turnId 多条累加）。与
   * instances/compaction 同一事件流的挂载投影（不双计）；重放同规则
   * 重建。键缺席 = 旧账本/未携带（快照 SessionUsageDto.byTurn 不下发）。
   */
  readonly byTurn?: Readonly<Record<string, UsageDto>>;
}

/** 零值用量（七字段全 0；provider 未报/空账占位，账目行保持完整）。 */
export const ZERO_USAGE: UsageDto = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: 0,
};

/** 七字段各自累加（cost 以 pi 直算值只加不改写；未见基线 = 首条拷贝）。 */
export function addUsage(a: UsageDto | undefined, b: UsageDto): UsageDto {
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

/** 空账本。 */
export function emptyUsageLedger(): UsageLedgerData {
  return { instances: {}, compaction: { ...ZERO_USAGE }, ctx: {} };
}

/**
 * 一条入账 → 新账本（不可变：返回新值不改写入参）。
 * compaction 来源计入实例小计（归属 main 实例执行）的同时计入独立小计
 * （两者来自同一事件，AD-9③）。
 */
export function applyUsage(
  ledger: UsageLedgerData,
  instanceId: string,
  usage: UsageDto,
  source: UsageSource,
  turnId?: string,
): UsageLedgerData {
  return {
    instances: { ...ledger.instances, [instanceId]: addUsage(ledger.instances[instanceId], usage) },
    compaction: source === "compaction" ? addUsage(ledger.compaction, usage) : ledger.compaction,
    ctx: source === "turn" ? { ...ledger.ctx, [instanceId]: usage.totalTokens } : ledger.ctx,
    // per-turn 挂载投影：携带 turnId 才入账（同 turnId 累加）；无 turnId 入账保留既有槽
    ...(turnId !== undefined
      ? { byTurn: { ...ledger.byTurn, [turnId]: addUsage(ledger.byTurn?.[turnId], usage) } }
      : ledger.byTurn !== undefined
        ? { byTurn: ledger.byTurn }
        : {}),
  };
}

/**
 * compaction.completed → 水位重置（窗口被摘要替换为 tokensAfter；与 shell
 * 活路径消费语义同构，TR-59 双面口径）。账目面不动（compaction 入账走
 * applyUsage 的独立 usage.recorded 事件——事件序：completed 先、摘要入账后）。
 */
export function applyCompaction(
  ledger: UsageLedgerData,
  instanceId: string,
  tokensAfter: number,
): UsageLedgerData {
  return { ...ledger, ctx: { ...ledger.ctx, [instanceId]: tokensAfter } };
}

/** per-instance 小计（未见过的实例 = 零值形状，不隐式登记）。 */
export function instanceUsageOf(ledger: UsageLedgerData, instanceId: string): UsageDto {
  return ledger.instances[instanceId] ?? { ...ZERO_USAGE };
}

/** 聚合：total = Σ 全部实例小计；compaction = 独立小计直通（契约 §6.2）；ctx = 水位直通（观察面，恢复种子）。 */
export function aggregateSession(ledger: UsageLedgerData): SessionUsageDto {
  let total: UsageDto = { ...ZERO_USAGE };
  for (const id of Object.keys(ledger.instances)) {
    total = addUsage(total, ledger.instances[id]!);
  }
  return {
    total,
    compaction: { ...ledger.compaction },
    ctx: { ...ledger.ctx },
    // per-turn 账目直通（additive：空/缺席不下发，旧端兼容）
    ...(ledger.byTurn !== undefined && Object.keys(ledger.byTurn).length > 0
      ? { byTurn: { ...ledger.byTurn } }
      : {}),
  };
}

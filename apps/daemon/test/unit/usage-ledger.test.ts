import { describe, expect, test } from "bun:test";
// T3.1 投影收敛：账目纯语义单源 @helix/protocol projection（原 domain
// UsageLedger 迁出）——仅 import 换源，期望值零改动（等价对账基线不变）。
import {
  aggregateSession,
  applyUsage,
  emptyUsageLedger,
  instanceUsageOf,
  type UsageLedgerData,
} from "@helix/protocol";
import type { UsageSummary } from "../../src/domain/session/SessionSnapshot";

/**
 * T3.2 RED：domain 账目纯语义（AD-4：账目是 domain 权威状态）——
 * T3.1（M4 投资批）纯函数迁 @helix/protocol projection 单源后，本文件经
 * 协议包引用保持同等价对账：
 * applyUsage per-instance 七字段累加 / source 分流（turn/compaction）/
 * aggregateSession 聚合自洽（Σ instances = total；compaction 小计 ⊆ total）/
 * 空账零值形状。零依赖单测（纯函数，不触 service/adapter）。
 */

const u = (over: Partial<UsageSummary>): UsageSummary => ({
  input: over.input ?? 0,
  output: over.output ?? 0,
  cacheRead: over.cacheRead ?? 0,
  cacheWrite: over.cacheWrite ?? 0,
  reasoning: over.reasoning ?? 0,
  totalTokens: over.totalTokens ?? 0,
  cost: over.cost ?? 0,
});

describe("T3.2 domain UsageLedger 纯语义", () => {
  test("空账零值形状：aggregate 全零、未知实例小计零形状", () => {
    const empty = emptyUsageLedger();
    expect(aggregateSession(empty)).toEqual({
      total: u({}),
      compaction: u({}),
      ctx: {}, // 水位空形状（TR-59：无事件 → 无水位 → shell 全降级 "—"）
    });
    expect(instanceUsageOf(empty, "main")).toEqual(u({}));
    expect(instanceUsageOf(empty, "agent-9")).toEqual(u({}));
  });

  test("多实例多 turn 累加：七字段各自累加、互不串账", () => {
    let ledger: UsageLedgerData = emptyUsageLedger();
    ledger = applyUsage(ledger, "main", u({ input: 10, output: 20, cacheRead: 1, totalTokens: 31, cost: 0.1 }), "turn");
    ledger = applyUsage(ledger, "main", u({ input: 5, reasoning: 7, cacheWrite: 2, totalTokens: 14, cost: 0.05 }), "turn");
    ledger = applyUsage(ledger, "agent-1", u({ input: 100, output: 200, totalTokens: 300, cost: 0.5 }), "turn");

    const { cost, ...mainRest } = instanceUsageOf(ledger, "main");
    expect(mainRest).toEqual({
      input: 15,
      output: 20,
      cacheRead: 1,
      cacheWrite: 2,
      reasoning: 7,
      totalTokens: 45,
    });
    expect(cost).toBeCloseTo(0.15, 10); // 浮点直加（pi 直算值只加不改写）
    expect(instanceUsageOf(ledger, "agent-1")).toEqual(u({ input: 100, output: 200, totalTokens: 300, cost: 0.5 }));
    // 原账本不可变（applyUsage 返回新值，不改写入参）
    expect(instanceUsageOf(emptyUsageLedger(), "main")).toEqual(u({}));
  });

  test("source 分流：compaction 计入实例小计与 compaction 小计、turn 不动 compaction 小计", () => {
    let ledger: UsageLedgerData = emptyUsageLedger();
    ledger = applyUsage(ledger, "main", u({ input: 40, output: 6, totalTokens: 46, cost: 0.01 }), "compaction");
    ledger = applyUsage(ledger, "main", u({ input: 10, totalTokens: 10 }), "turn");
    ledger = applyUsage(ledger, "main", u({ input: 70, output: 4, totalTokens: 74, cost: 0.02 }), "compaction");

    // compaction 归属 main（实例小计含全部来源）
    expect(instanceUsageOf(ledger, "main")).toEqual(u({ input: 120, output: 10, totalTokens: 130, cost: 0.03 }));
    // compaction 小计独立（popover 独立行，AD-9③）
    expect(aggregateSession(ledger).compaction).toEqual(u({ input: 110, output: 10, totalTokens: 120, cost: 0.03 }));
  });

  test("聚合合计自洽：Σ instances[].totalTokens = total.totalTokens 且 compaction ⊆ total", () => {
    let ledger: UsageLedgerData = emptyUsageLedger();
    ledger = applyUsage(ledger, "main", u({ input: 10, totalTokens: 11, cost: 0.01 }), "turn");
    ledger = applyUsage(ledger, "agent-1", u({ input: 20, totalTokens: 21, cost: 0.02 }), "turn");
    ledger = applyUsage(ledger, "agent-2", u({ input: 30, totalTokens: 31, cost: 0.03 }), "turn");
    ledger = applyUsage(ledger, "main", u({ input: 40, output: 6, totalTokens: 46, cost: 0.04 }), "compaction");

    const agg = aggregateSession(ledger);
    const instanceSum = (["main", "agent-1", "agent-2"] as const)
      .map((id) => instanceUsageOf(ledger, id).totalTokens)
      .reduce((a, b) => a + b, 0);
    expect(agg.total.totalTokens).toBe(instanceSum);
    expect(agg.total.totalTokens).toBe(11 + 21 + 31 + 46);
    expect(agg.total.input).toBe(100);
    expect(agg.total.cost).toBe(0.1);
    // compaction 小计 ⊆ total（归属 main 但独立展示）
    expect(agg.compaction.totalTokens).toBe(46);
    expect(agg.compaction.totalTokens).toBeLessThanOrEqual(agg.total.totalTokens);
    expect(agg.compaction.cost).toBeLessThanOrEqual(agg.total.cost);
  });
});

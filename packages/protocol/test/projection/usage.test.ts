import { describe, expect, test } from "bun:test";
import {
  ZERO_USAGE,
  addUsage,
  aggregateSession,
  applyCompaction,
  applyUsage,
  emptyUsageLedger,
  instanceUsageOf,
  type UsageDto,
  type UsageLedgerData,
} from "../../src/index";

/**
 * TP-3.1a usage 域纯函数单测（M4 投资批，iter-20260821-dg90 T3.1）。
 *
 * 期望值基线 = 既有 daemon usage-ledger.test.ts（iter-20260816-uzvg T3.2
 * 红先行锚定的账目语义原样迁入）+ shell session-reducer-v01.test.ts usage
 * 聚合 case 的 compaction 段（AF-2 口径统一：compaction 计入实例小计——
 * AD-9③ daemon 口径为准，本模块是该口径的唯一定义点）。
 *
 * 纯函数纪律（TP-3.1d）：无 IO / framework-free / 纯数据进纯数据出。
 */

const u = (over: Partial<UsageDto>): UsageDto => ({
  input: over.input ?? 0,
  output: over.output ?? 0,
  cacheRead: over.cacheRead ?? 0,
  cacheWrite: over.cacheWrite ?? 0,
  reasoning: over.reasoning ?? 0,
  totalTokens: over.totalTokens ?? 0,
  cost: over.cost ?? 0,
});

describe("usage 域：账本纯函数（基线 = daemon usage-ledger.test.ts）", () => {
  test("空账零值形状：aggregate 全零、未知实例小计零形状", () => {
    const empty = emptyUsageLedger();
    expect(aggregateSession(empty)).toEqual({ total: u({}), compaction: u({}), ctx: {} });
    expect(instanceUsageOf(empty, "main")).toEqual(u({}));
    expect(instanceUsageOf(empty, "agent-9")).toEqual(u({}));
  });

  test("多实例多 turn 累加：七字段各自累加、互不串账；原账本不可变", () => {
    let ledger: UsageLedgerData = emptyUsageLedger();
    const frozen = ledger;
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
    // applyUsage 返回新值，不改写入参（不可变投影）
    expect(aggregateSession(frozen)).toEqual({ total: u({}), compaction: u({}), ctx: {} });
  });

  test("source 分流：compaction 计入实例小计与 compaction 小计、turn 不动 compaction 小计（AD-9③）", () => {
    let ledger: UsageLedgerData = emptyUsageLedger();
    ledger = applyUsage(ledger, "main", u({ input: 40, output: 6, totalTokens: 46, cost: 0.01 }), "compaction");
    ledger = applyUsage(ledger, "main", u({ input: 10, totalTokens: 10 }), "turn");
    ledger = applyUsage(ledger, "main", u({ input: 70, output: 4, totalTokens: 74, cost: 0.02 }), "compaction");

    // compaction 归属 main（实例小计含全部来源——AF-2 口径统一基准）
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

describe("usage 域：累加基元（基线 = shell 增量路径 addUsage 私有副本语义）", () => {
  test("addUsage：undefined 基线 = 首条拷贝；七字段累加恒新对象", () => {
    expect(addUsage(undefined, u({ input: 3 }))).toEqual(u({ input: 3 }));
    expect(addUsage(u({ input: 1, cost: 0.1 }), u({ input: 2, cost: 0.2 })).input).toBe(3);
    expect(addUsage(u({ input: 1, cost: 0.1 }), u({ input: 2, cost: 0.2 })).cost).toBeCloseTo(0.3, 10); // 浮点直加
    expect(addUsage(ZERO_USAGE, ZERO_USAGE)).toEqual(u({}));
  });

  test("增量序列与账本投影数值一致：逐条 addUsage 平铺 == applyUsage+aggregate（AF-2 口径统一判据）", () => {
    // shell 增量路径（平铺 byInstance/total/compaction 三槽逐条累加）与
    // daemon 账本路径（applyUsage + aggregateSession）在统一口径下数值恒等。
    const events: Array<[string, UsageDto, "turn" | "compaction"]> = [
      ["main", u({ totalTokens: 40, cost: 0.25 }), "turn"],
      ["agent-1", u({ totalTokens: 8, cost: 0.5 }), "turn"],
      ["main", u({ totalTokens: 12, cost: 0.125 }), "turn"],
      ["main", u({ totalTokens: 32, cost: 0.0625 }), "compaction"],
    ];
    // 平铺增量（shell 形状）
    let total = u({});
    let compaction = u({});
    const byInstance: Record<string, UsageDto> = {};
    for (const [iid, usage, source] of events) {
      total = addUsage(total, usage);
      byInstance[iid] = addUsage(byInstance[iid], usage); // turn/compaction 同计实例小计（统一口径）
      if (source === "compaction") compaction = addUsage(compaction, usage);
    }
    // 账本投影（daemon 形状）
    let ledger = emptyUsageLedger();
    for (const [iid, usage, source] of events) ledger = applyUsage(ledger, iid, usage, source);
    const agg = aggregateSession(ledger);
    expect(total).toEqual(agg.total);
    expect(compaction).toEqual(agg.compaction);
    expect(byInstance["main"]).toEqual(instanceUsageOf(ledger, "main")); // main 小计含 compaction 贡献
    expect(byInstance["agent-1"]).toEqual(instanceUsageOf(ledger, "agent-1"));
    expect(byInstance["main"]!.totalTokens).toBe(40 + 12 + 32); // 基线 = shell v01 compaction 段统一后值
  });

  test("水位投影（TR-59 观察面）：turn 覆写 / compaction 摘要不覆写 / completed 重置；账目面不动", () => {
    let ledger = emptyUsageLedger();
    // turn 入账 → 水位 = 该次 totalTokens（窗口占用，只覆写不累加）
    ledger = applyUsage(ledger, "main", u({ input: 10, totalTokens: 11 }), "turn");
    ledger = applyUsage(ledger, "main", u({ input: 20, totalTokens: 21 }), "turn");
    ledger = applyUsage(ledger, "agent-1", u({ input: 30, totalTokens: 31 }), "turn");
    expect(ledger.ctx).toEqual({ main: 21, "agent-1": 31 });
    // compaction 摘要入账不动水位（其 input = 压缩前全文，不代表压缩后窗口）
    ledger = applyUsage(ledger, "main", u({ input: 40, output: 6, totalTokens: 46 }), "compaction");
    expect(ledger.ctx).toEqual({ main: 21, "agent-1": 31 });
    // compaction.completed → 重置为 tokensAfter；实例小计不变（账目面归 usage.recorded）
    const before = instanceUsageOf(ledger, "main").totalTokens;
    ledger = applyCompaction(ledger, "main", 5_000);
    expect(ledger.ctx).toEqual({ main: 5_000, "agent-1": 31 });
    expect(instanceUsageOf(ledger, "main").totalTokens).toBe(before);
    // 重置后再 turn → 水位收敛到新值；聚合透出 ctx（快照恢复种子）
    ledger = applyUsage(ledger, "main", u({ input: 60, totalTokens: 61 }), "turn");
    expect(ledger.ctx).toEqual({ main: 61, "agent-1": 31 });
    expect(aggregateSession(ledger).ctx).toEqual({ main: 61, "agent-1": 31 });
    // 空账水位空形状（重启旧库：无事件 → 无水位 → shell 全降级 "—"）
    expect(aggregateSession(emptyUsageLedger()).ctx).toEqual({});
  });
});

describe("usage 域：per-turn 账目（byTurn——轮末用量显示面挂载，additive）", () => {
  test("applyUsage 携带 turnId → byTurn[turnId] 入账；aggregateSession 携带 byTurn", () => {
    let ledger = emptyUsageLedger();
    ledger = applyUsage(ledger, "main", u({ input: 10, output: 20, totalTokens: 30, cost: 0.01 }), "turn", "turn-1");
    ledger = applyUsage(ledger, "main", u({ input: 5, output: 5, totalTokens: 10, cost: 0.005 }), "turn", "turn-2");
    expect(ledger.byTurn?.["turn-1"]).toEqual(u({ input: 10, output: 20, totalTokens: 30, cost: 0.01 }));
    expect(ledger.byTurn?.["turn-2"]).toEqual(u({ input: 5, output: 5, totalTokens: 10, cost: 0.005 }));
    const agg = aggregateSession(ledger);
    expect(agg.byTurn?.["turn-1"]).toEqual(u({ input: 10, output: 20, totalTokens: 30, cost: 0.01 }));
    expect(agg.byTurn?.["turn-2"]).toEqual(u({ input: 5, output: 5, totalTokens: 10, cost: 0.005 }));
  });

  test("同一 turnId 多条入账累加（同轮多次 message_end 不丢账、不重写）", () => {
    let ledger = emptyUsageLedger();
    ledger = applyUsage(ledger, "main", u({ input: 10, totalTokens: 10, cost: 0.01 }), "turn", "turn-1");
    ledger = applyUsage(ledger, "main", u({ input: 20, totalTokens: 20, cost: 0.02 }), "turn", "turn-1");
    expect(ledger.byTurn?.["turn-1"]).toEqual(u({ input: 30, totalTokens: 30, cost: 0.03 }));
  });

  test("无 turnId / compaction 源入账不触 byTurn；空账本 byTurn 键缺席（additive 旧端兼容）", () => {
    let ledger = emptyUsageLedger();
    expect(ledger.byTurn).toBeUndefined();
    ledger = applyUsage(ledger, "main", u({ input: 40, totalTokens: 40 }), "compaction");
    expect(ledger.byTurn).toBeUndefined();
    ledger = applyUsage(ledger, "main", u({ input: 10, totalTokens: 10 }), "turn"); // 无 turnId（SubAgent 路径）
    expect(ledger.byTurn).toBeUndefined();
    expect(aggregateSession(ledger).byTurn).toBeUndefined(); // 空 byTurn 不下发（缺省 = 未携带）
  });

  test("既有 byTurn 在无 turnId 入账时保留（不被清掉）", () => {
    let ledger = emptyUsageLedger();
    ledger = applyUsage(ledger, "main", u({ input: 10, totalTokens: 10 }), "turn", "turn-1");
    ledger = applyUsage(ledger, "agent-9", u({ input: 99, totalTokens: 99 }), "turn"); // SubAgent 无 turnId
    expect(ledger.byTurn?.["turn-1"]).toEqual(u({ input: 10, totalTokens: 10 }));
  });
});

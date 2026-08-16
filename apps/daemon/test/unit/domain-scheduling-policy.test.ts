import { describe, expect, test } from "bun:test";
import {
  SchedulingPolicy,
  DEFAULT_SCHEDULING,
} from "../../src/domain/agent/SchedulingPolicy";

/**
 * F1.3（unit）+ C-7（AD-7）：SchedulingPolicy 纯语义单测。
 *
 * ① decideSpawn 三分支边界：running<maxConcurrent → run（=3 恰值不再 run）；
 *    超限 → queued<maxQueued → enqueue（=8 恰值不再 enqueue）；
 *    3 running + 8 queued → reject（预算真实耗尽）。
 * ② nextPosition FIFO 位次（1 起；queued 计数为入队前长度）。
 * ③ isStalled 阈值边界（毫秒注入，K1）：idleMs > 阈值才判 stalled（恰值不算）。
 * ④ 缺省值（maxConcurrent=3 / maxQueued=8 / stalled 5min）+ 非法参数 fail-fast。
 */

describe("① decideSpawn 三分支（边界恰值）", () => {
  const policy = new SchedulingPolicy();

  test("running < maxConcurrent → run（含 0/1/2；空队列满队列同判）", () => {
    expect(policy.decideSpawn(0, 0)).toEqual({ action: "run" });
    expect(policy.decideSpawn(2, 0)).toEqual({ action: "run" });
    // 队列已满但运行位空 → 仍 run（run 判定优先于队列水位）
    expect(policy.decideSpawn(2, 8)).toEqual({ action: "run" });
  });

  test("running = 3（恰值耗尽）→ 不再 run；queued < 8 → enqueue", () => {
    expect(policy.decideSpawn(3, 0)).toEqual({ action: "enqueue" });
    expect(policy.decideSpawn(3, 7)).toEqual({ action: "enqueue" });
  });

  test("3 running + 8 queued（队列恰值满）→ reject", () => {
    expect(policy.decideSpawn(3, 8)).toEqual({ action: "reject" });
    expect(policy.decideSpawn(4, 8)).toEqual({ action: "reject" });
  });

  test("可配小值（K4：maxConcurrent/maxQueued 构造注入）", () => {
    const small = new SchedulingPolicy({ maxConcurrent: 1, maxQueued: 2 });
    expect(small.decideSpawn(0, 0)).toEqual({ action: "run" });
    expect(small.decideSpawn(1, 0)).toEqual({ action: "enqueue" });
    expect(small.decideSpawn(1, 1)).toEqual({ action: "enqueue" });
    expect(small.decideSpawn(1, 2)).toEqual({ action: "reject" });
  });
});

describe("② nextPosition FIFO 位次（1 起）", () => {
  const policy = new SchedulingPolicy();

  test("入队前队列长度 → 新实例位次（0→1、1→2、7→8）", () => {
    expect(policy.nextPosition(0)).toBe(1);
    expect(policy.nextPosition(1)).toBe(2);
    expect(policy.nextPosition(7)).toBe(8);
  });

  test("位次语义即 FIFO：出队后剩余整体递减由调用方以队列序重算（纯函数无副作用）", () => {
    // 模拟出队：队列 [a,b,c] 头 a 出队 → [b,c]，b 位次 = nextPosition(0) = 1
    const afterDequeue = 0; // b 前方已无实例
    expect(policy.nextPosition(afterDequeue)).toBe(1);
    expect(policy.nextPosition(afterDequeue + 1)).toBe(2); // c
  });
});

describe("③ isStalled 阈值判定（毫秒注入，K1）", () => {
  test("idleMs > 阈值 → true；恰等于阈值 → false（严格大于）", () => {
    const policy = new SchedulingPolicy({ stalledThresholdMs: 100 });
    expect(policy.isStalled(0, 100)).toBe(false); // 恰 100ms：不算
    expect(policy.isStalled(0, 101)).toBe(true); // 101ms：算
    expect(policy.isStalled(50, 150)).toBe(false); // 100ms 恰值
    expect(policy.isStalled(50, 151)).toBe(true);
  });

  test("缺省阈值 5min（300_000ms）", () => {
    const policy = new SchedulingPolicy();
    expect(policy.isStalled(0, 300_000)).toBe(false);
    expect(policy.isStalled(0, 300_001)).toBe(true);
  });
});

describe("④ 缺省值与非法参数 fail-fast", () => {
  test("缺省 maxConcurrent=3 / maxQueued=8 / stalledThresholdMs=300_000", () => {
    const policy = new SchedulingPolicy();
    expect(policy.maxConcurrent).toBe(3);
    expect(policy.maxQueued).toBe(8);
    expect(policy.stalledThresholdMs).toBe(300_000);
    expect(DEFAULT_SCHEDULING).toEqual({ maxConcurrent: 3, maxQueued: 8, stalledThresholdMs: 300_000 });
  });

  test("非法参数抛错：maxConcurrent=0、maxQueued=-1、stalledThresholdMs=0", () => {
    expect(() => new SchedulingPolicy({ maxConcurrent: 0 })).toThrow();
    expect(() => new SchedulingPolicy({ maxQueued: -1 })).toThrow();
    expect(() => new SchedulingPolicy({ stalledThresholdMs: 0 })).toThrow();
    expect(() => new SchedulingPolicy({ maxConcurrent: 1.5 })).toThrow(); // 非整数
  });
});

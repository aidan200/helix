/**
 * ActivationPolicy 测试（批 4a：E-250 升级接点——光球在场信号）。
 *
 * 判据穷举：presence(面板 ∨ 光球 TTL) ∧ recentAsk(衰减窗)。
 * 关键新行为：光球在场、无面板订阅 → 激活（原判据此场景恒不激活）。
 */
import { describe, expect, test } from "bun:test";
import { computeActivation, isOrbPresent, type ActivationInput } from "../../src/domain/steward/perception/ActivationPolicy";

const BASE: ActivationInput = {
  panelSubscribed: false,
  orbPresentAt: null,
  lastAskAt: 1_000,
  now: 10_000,
  askWindowMs: 300_000,
  presenceTtlMs: 90_000,
};

describe("isOrbPresent（光球位 TTL）", () => {
  test("null/负值 = 从未上报 → 不在场", () => {
    expect(isOrbPresent(null, 0, 90_000)).toBe(false);
    expect(isOrbPresent(-1, 0, 90_000)).toBe(false);
  });
  test("TTL 内在场；超时离场", () => {
    expect(isOrbPresent(10_000, 100_000, 90_000)).toBe(true); // 恰 TTL 边界
    expect(isOrbPresent(10_000, 100_001, 90_000)).toBe(false); // 过边界
  });
});

describe("computeActivation（激活判定）", () => {
  test("原行为保留：面板订阅 + 近期 ask → 激活（无光球信号）", () => {
    expect(computeActivation({ ...BASE, panelSubscribed: true })).toBe(true);
  });

  test("E-250 接点兑现：光球在场、无面板订阅 → 激活（新行为）", () => {
    expect(computeActivation({ ...BASE, orbPresentAt: 9_000 })).toBe(true);
  });

  test("双缺：无面板无光球 → 不激活", () => {
    expect(computeActivation(BASE)).toBe(false);
  });

  test("光球 TTL 过期（断连残留防御）→ 不激活", () => {
    expect(computeActivation({ ...BASE, orbPresentAt: 1_000, now: 200_000 })).toBe(false);
  });

  test("ask 衰减窗外 → 不激活（原 D12-⑪ 语义保留）", () => {
    expect(
      computeActivation({ ...BASE, orbPresentAt: 9_000, lastAskAt: 1_000, now: 400_000 }),
    ).toBe(false);
  });

  test("从未 ask → 不激活", () => {
    expect(computeActivation({ ...BASE, orbPresentAt: 9_000, lastAskAt: -1 })).toBe(false);
  });

  test("面板与光球任一在场即过 presence 半判据（并集）", () => {
    // 光球过期但面板在
    expect(computeActivation({ ...BASE, panelSubscribed: true, orbPresentAt: 1_000, now: 200_000 })).toBe(true);
  });
});

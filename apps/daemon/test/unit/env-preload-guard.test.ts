import { describe, expect, test } from "bun:test";

/**
 * 宿主 HELIX_* 注入结构性免疫守护（CAND-581 结构性解——preload 剥离在位证明）。
 *
 * 守护两件事：
 * 1. preload 机制在位：探针键 __HELIX_TEST_ENV_PRELOADED__ 由
 *    test/helpers/helix-env-strip.ts（bunfig [test] preload 接线）设置——
 *    preload 被删 / bunfig 接线丢失时本断言红（防免疫静默失效）。
 * 2. 剥离生效：bun test 进程 env 零 HELIX_ 前缀键（会话内跑测试时宿主注入
 *    全族已剥；干净 CI 环境本断言恒真，由第 1 项承担守护力度）。
 *
 * 注意：本测试不适用「测试内自设 HELIX_*」的豁免——若其他测试 afterEach
 * 泄漏 HELIX_ 残键导致本断言红，那是真泄漏（测试卫生问题），按清单修复。
 */
describe("宿主 HELIX_* 注入结构性免疫（preload 剥离守护）", () => {
  test("preload 在位：探针键存在（bunfig [test] preload → helix-env-strip.ts）", () => {
    expect(process.env.__HELIX_TEST_ENV_PRELOADED__).toBe("1");
  });

  test("env 已净：bun test 进程零 HELIX_ 前缀键（宿主注入全族剥离）", () => {
    const leaked = Object.keys(process.env).filter((k) => k.startsWith("HELIX_"));
    expect(leaked).toEqual([]);
  });
});

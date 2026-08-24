/**
 * thinking-capability 纯函数测试（thinking 批 T3：P-2 开关 on 默认档规则）。
 *
 * 机械判据（用户决策原话：「所有模型的推理强度默认都取中间档位，如果只有
 * 两个档位则取第一档位，最高档位默认都不选」→ levels[Math.floor((n-1)/2)]）：
 * - 空能力集 → undefined（不写槽位，开关 on 后停 off 呈现）；
 * - n=1 唯一档 → 该档（无选择，属例外）；
 * - n=2 两档 → 低档（floor(1/2)=0）；
 * - n=3 三档 → 中位档；n=4 → 低中位（floor(3/2)=1）；
 * - n=5/n=6 → idx2 中位（六档 canonical → low）；
 * - 最高档不默认选（负断言：n≥2 时返回值 ≠ levels[n-1]）。
 */
import { describe, expect, it } from "vitest";
import { defaultLevelFor } from "./thinking-capability";

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];

describe("defaultLevelFor（P-2 开关 on 且槽位空 → 默认写入档·中位规则）", () => {
  it("空能力集 → undefined（不写）", () => {
    expect(defaultLevelFor([])).toBeUndefined();
  });

  it("n=1 唯一档 → 该档（无选择，例外）", () => {
    expect(defaultLevelFor(["medium"])).toBe("medium");
    expect(defaultLevelFor(["low"])).toBe("low");
  });

  it("n=2 两档 → 低档（floor(1/2)=0）", () => {
    expect(defaultLevelFor(["low", "high"])).toBe("low");
    expect(defaultLevelFor(["medium", "high"])).toBe("medium");
  });

  it("n=3 三档 → 中位档", () => {
    expect(defaultLevelFor(["low", "medium", "high"])).toBe("medium");
    expect(defaultLevelFor(["low", "high", "max"])).toBe("high");
  });

  it("n=4 四档 → 低中位（floor(3/2)=1）", () => {
    expect(defaultLevelFor(["minimal", "low", "medium", "high"])).toBe("low");
  });

  it("n=5/n=6 → idx2 中位（六档 canonical → medium）", () => {
    expect(defaultLevelFor(["a", "b", "c", "d", "e"])).toBe("c");
    expect(defaultLevelFor(SIX)).toBe("medium");
  });

  it("负断言：n≥2 时最高档不默认选", () => {
    for (const levels of [["low", "high"], ["low", "medium", "high"], ["minimal", "low", "medium", "high"], SIX]) {
      expect(defaultLevelFor(levels)).not.toBe(levels[levels.length - 1]);
    }
  });
});

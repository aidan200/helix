// @vitest-environment jsdom
/**
 * useRunningElapsed 计时口径测试（running 态耗时展示）。
 *
 * - 停表 → 再活跃翻转：now 与挂载锚同刻收（否则停表期 now 停留旧刻、锚取当前
 *   刻 → now-anchor 为负，首秒闪现负数耗时）；
 * - 真实锚点（startedAtMs/baseMs）优先于挂载钟。
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunningElapsed } from "./useRunningElapsed";

const T0 = 1_700_000_000_000;

describe("useRunningElapsed（running 耗时口径）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("停表后 active 翻转 true：首拍不闪现负数耗时", () => {
    let nowMs = T0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { result, rerender } = renderHook((p: { active: boolean }) => useRunningElapsed(p.active), {
      initialProps: { active: false },
    });
    expect(result.current).toBe("0.0s");
    nowMs += 5_000; // 停表期时钟前移（interval 已清，now 停留旧刻）
    rerender({ active: true });
    expect(result.current).toBe("0.0s"); // 0.0s 而非 -5.0s
    nowMs += 1_000;
    rerender({ active: true });
    expect(result.current).toBe("0.0s"); // interval 未推进 → 仍以收锚刻计
  });

  it("真实锚点优先：startedAtMs/baseMs 在场时总时长 = 基线 + (now - 段起点)", () => {
    let nowMs = T0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { result } = renderHook(() => useRunningElapsed(true, T0 - 2_000, 3_000));
    // 挂载锚与 now 同刻收 → 显示 (3000 + 2000)ms
    expect(result.current).toBe("5.0s");
  });
});

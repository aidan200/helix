// @vitest-environment jsdom
/**
 * ProgressFill 单测（M9 #2.31 修复：挂载置 0 仅首次——旧实现 effect 依赖含
 * ratio，building 轮询每 tick 先重置 scaleX(0) 再双 rAF 重播动画，进度条
 * 反复跳 0；修复后后续 ratio 变更直接落值交 CSS transition）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ProgressFill } from "./kg-progress";

/** rAF 桩：同步记录回调，flush 依次触发（模拟双 rAF 帧序）。 */
function stubRaf() {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    flush() {
      while (queue.length > 0) queue.shift()!(0);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProgressFill（M9 #2.31：挂载置零仅首次）", () => {
  it("首挂：先置 scaleX(0)，双 rAF 后落目标值（入场动画保留）", () => {
    const raf = stubRaf();
    const { container } = render(<ProgressFill ratio={0.4} />);
    const el = container.querySelector(".kg-progress-fill") as HTMLElement;
    expect(el.style.transform).toBe("scaleX(0)");
    act(() => raf.flush());
    expect(el.style.transform).toBe("scaleX(0.4)");
  });

  it("ratio 更新：直接落新值，不重置 scaleX(0)（进度条不跳 0 重播）", () => {
    const raf = stubRaf();
    const { container, rerender } = render(<ProgressFill ratio={0.2} />);
    const el = container.querySelector(".kg-progress-fill") as HTMLElement;
    act(() => raf.flush());
    expect(el.style.transform).toBe("scaleX(0.2)");
    rerender(<ProgressFill ratio={0.6} />);
    expect(el.style.transform).toBe("scaleX(0.6)"); // 直接落值——未先回 0
    rerender(<ProgressFill ratio={0.9} />);
    expect(el.style.transform).toBe("scaleX(0.9)");
  });

  it("indeterminate：纯 CSS 不确定态（零 rAF 逻辑）", () => {
    stubRaf();
    const { container } = render(<ProgressFill indeterminate />);
    const el = container.querySelector(".kg-progress-fill") as HTMLElement;
    expect(el.classList.contains("indeterminate")).toBe(true);
    expect(el.style.transform).toBe("");
  });
});

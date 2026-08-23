// @vitest-environment jsdom
/**
 * ThinkingLevelSlider 原子组件单测（features/thinking-level；thinking 批 T2.1；
 * P-1/P-2 双消费位共用——props 契约：levels/value/ghostValue/disabled/peak/onSelect）。
 *
 * 机械判据（test-design §2.6/§2.7）：
 * - 刻度数 = levels.length（能力位驱动，不硬编码六档）；单档 pct 防除零；
 * - 选档三通道：拖动（最近刻度吸附 + 同档去重）/ 点刻度 / 方向键（边界钳制）；
 * - 滑块位置/强调 = value（生效档）；ghostValue 仅预览位（空心 thumb、刻度去强调）；
 * - disabled → 三通道全不响应；peak → .peak class（thumb 辉光样式挂载点）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import ThinkingLevelSlider from "./ThinkingLevelSlider";

afterEach(cleanup);

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];
const TRI = ["low", "medium", "high"];

function setup(levels: string[], value: string | null, extra: Partial<Parameters<typeof ThinkingLevelSlider>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ThinkingLevelSlider
      levels={levels}
      value={value}
      onSelect={onSelect}
      ariaLabel="推理强度档位"
      {...extra}
    />,
  );
  const track = document.querySelector<HTMLElement>(".tl-track")!;
  // jsdom 无布局：轨道宽度 mock 为 100px（clientX 即百分比）
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 0, right: 100, top: 0, bottom: 40, width: 100, height: 40, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return { onSelect, track };
}

describe("ThinkingLevelSlider · 刻度渲染（能力位驱动）", () => {
  it("刻度数 = levels.length（六档变体）；档位标签小写原名；当前档 .cur 高亮", () => {
    setup(SIX, "medium");
    const ticks = Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-tick"));
    expect(ticks.map((b) => b.dataset.level)).toEqual(SIX);
    expect(ticks.map((b) => b.textContent)).toEqual(SIX);
    expect(ticks[2]!.classList.contains("cur")).toBe(true);
    // 已过刻度 .on（0..curIdx）
    expect(ticks.map((b) => b.classList.contains("on"))).toEqual([true, true, true, false, false, false]);
    // thumb/fill 位置 = curIdx/(n-1)
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.style.left).toBe("40%");
    expect(document.querySelector<HTMLElement>(".tl-fill")!.style.width).toBe("40%");
  });

  it("三档变体：3 刻度；最高档 high 当前位 pct=100%", () => {
    setup(TRI, "high");
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(3);
    expect(document.querySelector<HTMLElement>(".tl-thumb")!.style.left).toBe("100%");
  });

  it("单档变体：pct 防除零（0%，无 NaN）", () => {
    setup(["medium"], "medium");
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.style.left).toBe("0%");
    expect(thumb.style.left).not.toContain("NaN");
    expect(document.querySelector<HTMLElement>(".tl-fill")!.style.width).toBe("0%");
  });

  it("aria：role=slider + valuemin/max/now/valuetext 同步", () => {
    setup(SIX, "high");
    const track = document.querySelector<HTMLElement>(".tl-track")!;
    expect(track.getAttribute("role")).toBe("slider");
    expect(track.getAttribute("aria-valuemin")).toBe("1");
    expect(track.getAttribute("aria-valuemax")).toBe("6");
    expect(track.getAttribute("aria-valuenow")).toBe("4");
    expect(track.getAttribute("aria-valuetext")).toBe("high");
  });
});

describe("ThinkingLevelSlider · 选档三通道（F1.1）", () => {
  it("点刻度 → onSelect 正确档位", () => {
    const { onSelect } = setup(SIX, "medium");
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tl-tick[data-level="xhigh"]')!);
    expect(onSelect).toHaveBeenCalledWith("xhigh");
  });

  it("拖动：pointerdown/move 最近刻度吸附；同档去重（不重复发令）；pointerup 收束", () => {
    const { onSelect, track } = setup(SIX, "medium");
    fireEvent.pointerDown(track, { clientX: 80, pointerId: 1 }); // 80% → idx 4 = xhigh
    expect(onSelect).toHaveBeenCalledWith("xhigh");
    fireEvent.pointerMove(track, { clientX: 81, pointerId: 1 }); // 同档：去重不重发
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 }); // idx 5 = max
    expect(onSelect).toHaveBeenCalledWith("max");
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(track.classList.contains("dragging")).toBe(false);
  });

  it("方向键：ArrowRight/Up 升档、ArrowLeft/Down 降档；边界钳制（不越界不越档）", () => {
    const { onSelect, track } = setup(SIX, "medium");
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("high");
    fireEvent.keyDown(track, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("low");
    cleanup();
    const min = setup(SIX, "minimal");
    fireEvent.keyDown(min.track, { key: "ArrowLeft" }); // 边界钳制：不发令
    expect(min.onSelect).not.toHaveBeenCalled();
    cleanup();
    const max = setup(SIX, "max");
    fireEvent.keyDown(max.track, { key: "ArrowUp" }); // 边界钳制：不发令
    expect(max.onSelect).not.toHaveBeenCalled();
  });
});

describe("ThinkingLevelSlider · 修饰态", () => {
  it("disabled：三通道全不响应 + 不可聚焦", () => {
    const { onSelect, track } = setup(SIX, "medium", { disabled: true });
    fireEvent.pointerDown(track, { clientX: 80, pointerId: 1 });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tl-tick[data-level="max"]')!);
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(track.getAttribute("tabindex")).toBe("-1");
  });

  it("peak → track 挂 .peak（thumb 辉光样式挂载点）", () => {
    setup(SIX, "max", { peak: true });
    expect(document.querySelector(".tl-track")!.classList.contains("peak")).toBe(true);
  });

  it("ghostValue：value=null 时空心 thumb 停 ghost 位、刻度去强调（无 .on/.cur）", () => {
    setup(TRI, null, { ghostValue: "medium" });
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.style.left).toBe("50%");
    expect(thumb.classList.contains("ghost")).toBe(true);
    expect(document.querySelector(".tl-tick.cur")).toBeNull();
    expect(document.querySelector(".tl-tick.on")).toBeNull();
  });
});

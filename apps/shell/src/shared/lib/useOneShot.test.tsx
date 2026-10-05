// @vitest-environment jsdom
/**
 * useOneShot 单测（一次性意图槽消费——StrictMode 双效应幂等）。
 *
 * 修复背景：ChatPage restoreToast effect 双弹 bug——「弹 toast（副作用）+
 * dispatch 消费（异步生效）」两步在 StrictMode 双效应下二次进入时消费尚未
 * 落地，同一槽值被消费两次（实证 2026-10-05 会话 ba24d84c 开启时两条相同
 * 恢复提示）。本 hook 把幂等守卫收口单点：claimed ref 同步占位（引用同一性
 * 判据），双跑第二遍被挡。
 *
 * - StrictMode 双跑：槽到达 → fire/consume 恰好各一次（核心红绿判据）；
 * - 槽 null：零调用；
 * - 同引用重渲染（父重渲槽不变）：不重复 fire；
 * - 新引用（新意图槽）：再次 fire + consume；
 * - fire/consume 内联箭头（每渲染新引用）：不误重触发（回调 ref 化）；
 * - 消费后槽 A → null → 新槽 B：B 再 fire（新意图不被旧占位误挡）。
 */
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useOneShot } from "./useOneShot";

/** StrictMode wrapper（dev 构建下 effect mount→unmount→remount 双跑）。 */
const strictWrapper = (props: { children?: React.ReactNode }) => (
  <StrictMode>{props.children}</StrictMode>
);

afterEach(() => cleanup());

describe("useOneShot（一次性意图槽消费）", () => {
  it("StrictMode 双跑 → fire/consume 恰好各一次（幂等守卫核心）", () => {
    const slot = { kind: "restore", count: 2 } as const;
    const fire = vi.fn();
    const consume = vi.fn();
    renderHook(() => useOneShot(slot, fire, consume), { wrapper: strictWrapper });
    expect(fire).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(slot);
  });

  it("槽 null → 零 fire 零 consume", () => {
    const fire = vi.fn();
    const consume = vi.fn();
    renderHook(() => useOneShot(null, fire, consume), { wrapper: strictWrapper });
    expect(fire).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("同引用重渲染 → 不重复 fire（父重渲槽不变）", () => {
    const slot = { v: 1 };
    const fire = vi.fn();
    const consume = vi.fn();
    const { rerender } = renderHook(({ s }: { s: object | null } = { s: slot }) => useOneShot(s, fire, consume), {
      wrapper: strictWrapper,
    });
    rerender({ s: slot }); // 同引用再来
    expect(fire).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("新引用槽（新意图）→ 再次 fire + consume", () => {
    const fire = vi.fn();
    const consume = vi.fn();
    const { rerender } = renderHook(
      ({ s }: { s: object | null } = { s: { v: 1 } }) => useOneShot(s, fire, consume),
      { wrapper: strictWrapper },
    );
    expect(fire).toHaveBeenCalledTimes(1);
    rerender({ s: { v: 2 } }); // 新引用 = 新意图
    expect(fire).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("fire/consume 内联箭头（每渲染新引用）→ 不误重触发", () => {
    const slot = { v: 1 };
    const fire: Mock = vi.fn();
    const consume: Mock = vi.fn();
    const { rerender } = renderHook(
      ({ s, n }: { s: object | null; n: number } = { s: slot, n: 0 }) =>
        useOneShot(s, (v) => fire(v, n), () => consume(n)), // eslint-disable-line react-hooks/exhaustive-deps -- 测试面：每渲染新回调
      { wrapper: strictWrapper },
    );
    rerender({ s: slot, n: 1 }); // 回调引用漂移，槽未变
    expect(fire).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("槽 A 消费 → null → 新槽 B：B 再 fire（新意图不被旧占位误挡）", () => {
    const fire = vi.fn();
    const consume = vi.fn();
    const { rerender } = renderHook(
      ({ s }: { s: object | null } = { s: { v: 1 } }) => useOneShot(s, fire, consume),
    );
    rerender({ s: null }); // 消费后槽空
    rerender({ s: { v: 2 } }); // 新意图
    expect(fire).toHaveBeenCalledTimes(2);
  });
});

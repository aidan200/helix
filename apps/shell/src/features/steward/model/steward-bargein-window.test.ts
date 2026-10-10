/**
 * BargeInIntentWindow 测试（批 4b：意图窗状态机收口——TDD 红→绿）。
 *
 * 收口职责（从 useStewardVoice 迁出的纯状态机）：
 * - 窗开/关/超时（timer 由类自持；幂等）；
 * - duck 三轨记账（player/legacy/welcome——原值记账恢复写回，非偏好重算）；
 * - 开窗 mark 锚（声纹取样——批 3b 防自声污染）；
 * - 行为等价锚：窗已开幂等零重开；未 duck 幂等恢复；超时收口不真停。
 */
import { describe, expect, test, vi } from "vitest";
import { BargeInIntentWindow } from "./steward-bargein-window";

/** 假音轨面（三轨 get/set 记账验证）。 */
function makeTracks() {
  const state = { player: 1, legacy: 0.9, welcome: 0.8 };
  return {
    state,
    setPlayerVolume: vi.fn((v: number) => (state.player = v)),
    getLegacyVolume: () => state.legacy,
    setLegacyVolume: vi.fn((v: number) => (state.legacy = v)),
    getWelcomeVolume: () => state.welcome,
    setWelcomeVolume: vi.fn((v: number) => (state.welcome = v)),
  };
}

function makeWindow(tracks = makeTracks()) {
  const mark = vi.fn();
  const onTimeout = vi.fn();
  const w = new BargeInIntentWindow({ tracks, mark, onTimeout, windowMs: 5000 });
  return { w, tracks, mark, onTimeout };
}

describe("BargeInIntentWindow（意图窗状态机）", () => {
  test("open：置位 + duck 三轨 + mark 锚 + 超时计时器挂", () => {
    vi.useFakeTimers();
    const { w, tracks, mark, onTimeout } = makeWindow();
    expect(w.isActive()).toBe(false);
    w.open(0.2);
    expect(w.isActive()).toBe(true);
    expect(mark).toHaveBeenCalledTimes(1); // 声纹取样锚（开窗点）
    expect(tracks.setPlayerVolume).toHaveBeenCalledWith(0.2);
    expect(tracks.state.legacy).toBeCloseTo(0.9 * 0.2);
    expect(tracks.state.welcome).toBeCloseTo(0.8 * 0.2);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5001);
    expect(onTimeout).toHaveBeenCalledTimes(1); // 窗超时兕底（噪音过门没说话）
    vi.useRealTimers();
  });

  test("open 幂等：窗已开零重开（mark/duck 不重复）", () => {
    const { w, mark, tracks } = makeWindow();
    w.open(0.2);
    w.open(0.2);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(tracks.setPlayerVolume).toHaveBeenCalledTimes(1);
  });

  test("settle（不真停）：清位 + 恢复三轨原值 + 清 timer", () => {
    vi.useFakeTimers();
    const { w, tracks, onTimeout } = makeWindow();
    w.open(0.2);
    tracks.setPlayerVolume.mockClear();
    w.settle();
    expect(w.isActive()).toBe(false);
    expect(tracks.setPlayerVolume).toHaveBeenCalledWith(1); // player 恢复面恒 1
    expect(tracks.state.legacy).toBeCloseTo(0.9);
    expect(tracks.state.welcome).toBeCloseTo(0.8);
    vi.advanceTimersByTime(6000);
    expect(onTimeout).not.toHaveBeenCalled(); // timer 已清
    vi.useRealTimers();
  });

  test("settle 幂等：未开窗零操作（音量零写）", () => {
    const { w, tracks } = makeWindow();
    w.settle();
    expect(tracks.setPlayerVolume).not.toHaveBeenCalled();
  });

  test("中途改音量不突跳：恢复写回 duck 前原值（非偏好重算）", () => {
    const { w, tracks } = makeWindow();
    w.open(0.2);
    // duck 期间用户把 legacy 音量调到 0.5（偏好变化）
    tracks.state.legacy = 0.5;
    w.settle();
    expect(tracks.state.legacy).toBeCloseTo(0.9); // 恢复 = duck 前记账值
  });

  test("dispose：清 timer + 清位（duplex 收口/卸载面）", () => {
    vi.useFakeTimers();
    const { w, onTimeout } = makeWindow();
    w.open(0.2);
    w.dispose();
    expect(w.isActive()).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

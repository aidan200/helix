/**
 * rms-meter 帧特征纯计算测试（B3 双参载荷：RMS + ZCR；TDD 红→绿）。
 *
 * computeMeterFrame 是 worklet 主路径与 AnalyserNode 兜底的同口径帧计算
 * 提取面（worklet 内联同构实现——Blob 源码不可 import）：零音频环境可测。
 */
import { describe, expect, it } from "vitest";
import { computeMeterFrame } from "./rms-meter";

describe("computeMeterFrame（帧特征：RMS + 过零率 ZCR）", () => {
  it("空样本 → 零帧（不抛错）", () => {
    expect(computeMeterFrame(new Float32Array(0))).toEqual({ rms: 0, zcr: 0 });
  });

  it("常量正值 → rms = 幅值、zcr = 0（零过零——直流）", () => {
    const f = computeMeterFrame(new Float32Array([0.5, 0.5, 0.5, 0.5]));
    expect(f.rms).toBeCloseTo(0.5, 6);
    expect(f.zcr).toBe(0);
  });

  it("全零 → {0, 0}", () => {
    expect(computeMeterFrame(new Float32Array(8))).toEqual({ rms: 0, zcr: 0 });
  });

  it("交替方波 → 每样本一过零（zcr = (n-1)/n）；rms = 幅值", () => {
    const f = computeMeterFrame(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    expect(f.rms).toBeCloseTo(0.5, 6);
    expect(f.zcr).toBeCloseTo(3 / 4, 6);
  });

  it("触零不漏计：零样本跳过符号追踪，越零变号仍计一次", () => {
    // [1, 0, -1, 0, 1]：+→-（i2）与 -→+（i4）两次变号（零样本不另计）
    const f = computeMeterFrame(new Float32Array([1, 0, -1, 0, 1]));
    expect(f.zcr).toBeCloseTo(2 / 5, 6);
  });
});

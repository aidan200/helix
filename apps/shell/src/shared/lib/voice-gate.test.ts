/**
 * voice-gate 测试（人声判据共基面：两门共用的单帧判定 + ZCR 带判据 +
 * 底噪校准纯函数；TDD 红→绿）。
 *
 - isVoiceLikeFrame 判据表：rms 不足 / rms 过阈 zcr 带内 / rms 过阈 zcr 带外
   （键盘噪声）/ voiceCheck 关放行 / zcr undefined fail-open / 容忍带端点映射；
 - VOICE_RMS_THRESHOLD 迁入等值（0.012 旧值不动）+ useVoiceInput /
   steward-voice-machine re-export 兼容面（既有导入零断）；
 - 底噪校准纯函数：noiseFloorEstimate 低百分位（TTS 尖峰鲁棒）/
   effectiveRmsThreshold max(偏好, 底噪×2.5) 与 null 回落。
 */
import { describe, expect, it } from "vitest";
import {
  VOICE_RMS_THRESHOLD,
  VOICE_ZCR_MAX_LENIENT,
  VOICE_ZCR_MAX_STRICT,
  VOICE_ZCR_MIN,
  VOICE_ZCR_TOLERANCE_DEFAULT,
  VOICE_NOISE_CALIB_MIN_FRAMES,
  VOICE_NOISE_CALIB_WINDOW_MS,
  VOICE_NOISE_FLOOR_SCALE,
  effectiveRmsThreshold,
  isVoiceLikeFrame,
  noiseFloorEstimate,
  zcrInVoiceBand,
  zcrVoiceBandCeiling,
} from "./voice-gate";
// re-export 兼容面（既有导入零断——迁移后仍从旧路径可取）
import { VOICE_RMS_THRESHOLD as REEXPORT_RMS } from "./useVoiceInput";

const ZCR_VOICE = 0.08; // 人声浊音带内（缺省容忍带上界 0.35 内）
const ZCR_KEYBOARD = 0.6; // 宽带脉冲（带外——键盘噪声特征）

describe("isVoiceLikeFrame（两门共基单帧判据）", () => {
  it("rms 不足 → 非人声帧（阈值边界：等值过、微低不过）", () => {
    expect(isVoiceLikeFrame({ rms: 0.012, zcr: ZCR_VOICE }, { threshold: 0.012 })).toBe(true);
    expect(isVoiceLikeFrame({ rms: 0.0119, zcr: ZCR_VOICE }, { threshold: 0.012 })).toBe(false);
    expect(isVoiceLikeFrame({ rms: 0.001, zcr: ZCR_VOICE }, { threshold: 0.012 })).toBe(false);
  });

  it("rms 过阈 + zcr 带内 → 人声帧", () => {
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: ZCR_VOICE }, { threshold: 0.012 })).toBe(true);
  });

  it("rms 过阈 + zcr 带外（键盘噪声）→ 非人声帧（voiceCheck 开）", () => {
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: ZCR_KEYBOARD }, { threshold: 0.012, voiceCheck: true })).toBe(false);
  });

  it("voiceCheck 关 → 带外 zcr 放行（单参 RMS 回退行为）", () => {
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: ZCR_KEYBOARD }, { threshold: 0.012, voiceCheck: false })).toBe(true);
  });

  it("zcr undefined → fail-open（meter 无 zcr 帧——行为同旧）", () => {
    expect(isVoiceLikeFrame({ rms: 0.05 }, { threshold: 0.012 })).toBe(true);
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: undefined }, { threshold: 0.012, voiceCheck: true })).toBe(true);
  });

  it("容忍带强度端点映射：0 → 严格上界 / 100 → 宽容上界（边界值进出）", () => {
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: VOICE_ZCR_MAX_STRICT }, { threshold: 0.012, zcrTolerance: 0 })).toBe(true);
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: VOICE_ZCR_MAX_STRICT + 0.01 }, { threshold: 0.012, zcrTolerance: 0 })).toBe(false);
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: VOICE_ZCR_MAX_LENIENT }, { threshold: 0.012, zcrTolerance: 100 })).toBe(true);
    expect(isVoiceLikeFrame({ rms: 0.05, zcr: VOICE_ZCR_MAX_LENIENT + 0.01 }, { threshold: 0.012, zcrTolerance: 100 })).toBe(false);
    // 缺省容忍带 = 中档 50（上界 0.35）
    expect(zcrVoiceBandCeiling()).toBeCloseTo((VOICE_ZCR_MAX_STRICT + VOICE_ZCR_MAX_LENIENT) / 2, 5);
    expect(zcrVoiceBandCeiling(VOICE_ZCR_TOLERANCE_DEFAULT)).toBe(zcrVoiceBandCeiling());
    expect(zcrInVoiceBand(VOICE_ZCR_MIN, undefined)).toBe(true); // 下界含
    expect(zcrInVoiceBand(VOICE_ZCR_MIN - 0.005)).toBe(false); // 下界外（直流/低频隆隆）
  });
});

describe("共基常量与 re-export 兼容面", () => {
  it("VOICE_RMS_THRESHOLD 迁入等值（0.012 旧值不动）+ useVoiceInput re-export 同值", () => {
    expect(VOICE_RMS_THRESHOLD).toBe(0.012);
    expect(REEXPORT_RMS).toBe(VOICE_RMS_THRESHOLD);
  });
});

describe("底噪校准纯函数（两门共基阈值）", () => {
  it("noiseFloorEstimate：低百分位——TTS 回灌尖峰不拉高底噪估计", () => {
    // 20 帧底噪 0.02 + 5 帧尖峰 0.3（欢迎语回灌）：估计贴底噪而非均值
    const samples = [...Array<number>(20).fill(0.02), ...Array<number>(5).fill(0.3)];
    expect(noiseFloorEstimate(samples)).toBeCloseTo(0.02, 6);
    // 纯底噪序列：估计 = 底噪
    expect(noiseFloorEstimate(Array<number>(12).fill(0.008))).toBeCloseTo(0.008, 6);
  });

  it("effectiveRmsThreshold：max(偏好, 底噪×2.5)；null（未校准/回落）= 纯偏好", () => {
    expect(VOICE_NOISE_FLOOR_SCALE).toBe(2.5);
    expect(effectiveRmsThreshold(0.012, 0.02)).toBeCloseTo(0.05, 6); // 底噪抬升生效
    expect(effectiveRmsThreshold(0.036, 0.002)).toBeCloseTo(0.036, 6); // 偏好更高（用户调钝优先）
    expect(effectiveRmsThreshold(0.012, null)).toBe(0.012); // 未校准回落纯偏好
    expect(effectiveRmsThreshold(0.012, 0)).toBe(0.012); // 零底噪：×2.5 仍低于偏好 → 不抬
  });

  it("校准窗常量（2.5s 窗 / 最少 10 帧）", () => {
    expect(VOICE_NOISE_CALIB_WINDOW_MS).toBe(2_500);
    expect(VOICE_NOISE_CALIB_MIN_FRAMES).toBe(10);
  });
});

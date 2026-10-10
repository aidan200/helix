/**
 * NoiseCalibration 测试（批 4b：底噪校准采样窗状态机收口——TDD 红→绿）。
 *
 * 行为等价锚（迁自 useStewardVoice 的 4 refs + markDuplex + onEarFrame 内联逻辑）：
 * - 开窗即重采（旧样本/旧估计作废）；关会话清位；
 * - 采样窗内：发言租约期帧不入样本（校准污染防御）；
 * - 窗到期定稿：≥最小帧数取 P20 估计，不足回落 null（纯偏好）；
 * - 定稿后继续 feed 零副作用（窗已关）。
 */
import { describe, expect, test } from "vitest";
import { NoiseCalibration } from "./steward-ear-calibration";
import { VOICE_NOISE_CALIB_MIN_FRAMES, VOICE_NOISE_CALIB_WINDOW_MS } from "@/shared/lib/voice-gate";

describe("NoiseCalibration（底噪校准采样窗）", () => {
  test("开窗即重采：open 清样本清估计", () => {
    const c = new NoiseCalibration();
    expect(c.estimate()).toBeNull(); // 从未开窗
    c.open(1000);
    c.feed(0.01, false, 1000);
    c.finalizeIfDue(1000 + VOICE_NOISE_CALIB_WINDOW_MS + 1); // 不够帧数 → null
    expect(c.estimate()).toBeNull();
    c.open(2000); // 重开：全清
    expect(c.estimate()).toBeNull();
  });

  test("窗内非发言帧入样本；发言租约期帧不入（校准污染防御）", () => {
    const c = new NoiseCalibration();
    c.open(0);
    // 前 8 帧发言期（不入样本）+ 后 12 帧非发言 → 12 帧样本 ≥ 10 下限定稿
    for (let i = 0; i < 20; i++) c.feed(0.01, i < 8, i * 100);
    c.finalizeIfDue(VOICE_NOISE_CALIB_WINDOW_MS + 1);
    expect(c.estimate()).not.toBeNull(); // 12 帧非发言样本足额 → 有估计
    // 对比：发言期帧全不入的极端——样本不足回落 null
    const all = new NoiseCalibration();
    all.open(0);
    for (let i = 0; i < 20; i++) all.feed(0.01, true, i * 100); // 全发言期
    all.finalizeIfDue(VOICE_NOISE_CALIB_WINDOW_MS + 1);
    expect(all.estimate()).toBeNull(); // 零样本 → 回落纯偏好
  });

  test("定稿：≥最小帧数取估计；不足回落 null", () => {
    const enough = new NoiseCalibration();
    enough.open(0);
    for (let i = 0; i < VOICE_NOISE_CALIB_MIN_FRAMES; i++) enough.feed(0.02, false, i * 100);
    enough.finalizeIfDue(VOICE_NOISE_CALIB_WINDOW_MS + 1);
    expect(enough.estimate()).not.toBeNull();

    const tooFew = new NoiseCalibration();
    tooFew.open(0);
    for (let i = 0; i < VOICE_NOISE_CALIB_MIN_FRAMES - 1; i++) tooFew.feed(0.02, false, i * 100);
    tooFew.finalizeIfDue(VOICE_NOISE_CALIB_WINDOW_MS + 1);
    expect(tooFew.estimate()).toBeNull(); // 不足回落纯偏好
  });

  test("close 清位：估计与样本全清（duplex 落——不携旧底噪）", () => {
    const c = new NoiseCalibration();
    c.open(0);
    for (let i = 0; i < 15; i++) c.feed(0.02, false, i * 100);
    c.finalizeIfDue(VOICE_NOISE_CALIB_WINDOW_MS + 1);
    expect(c.estimate()).not.toBeNull();
    c.close();
    expect(c.estimate()).toBeNull();
  });

  test("窗内到达帧数但窗未到期：不定稿（窗口期完整采样）", () => {
    const c = new NoiseCalibration();
    c.open(0);
    for (let i = 0; i < 20; i++) c.feed(0.02, false, i * 50);
    c.finalizeIfDue(1000); // 窗未到
    expect(c.estimate()).toBeNull(); // 仍在采样
  });
});

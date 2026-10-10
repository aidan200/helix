/**
 * pcm-ring 测试（M3-c 声纹批）——授权点音频环：帧入环 + 取尾部语音段。
 *
 * 关键行为：从尾部回溯找最后一段连续语音（尾部静音跳过、头端静音截断、
 * 边距保留、段长上下限、全静音 → null）。
 */
import { describe, expect, it } from "vitest";
import {
  PCM_RING_SECONDS,
  PCM_RMS_GATE,
  createPcmRing,
  frameRms,
  selectUtterancePcm,
  type PcmRingFrame,
} from "./pcm-ring";

/** 造帧：1600 样本（100ms@16k），有声帧 = 定幅正弦，静音帧 = 全零。 */
function frame(loud: boolean, seed = 1): PcmRingFrame {
  const samples = new Int16Array(1600);
  if (loud) {
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000 + seed));
  }
  return { samples, rms: frameRms(samples) };
}

describe("mark 取样锚（barge-in 声纹防自声污染）", () => {
  /** 场景复现：管家 duck 自声持续过门限（无静音边界）+ 尾部用户插话。 */
  function pushFrame(ring: ReturnType<typeof createPcmRing>, samples: Int16Array): void {
    const copy = samples.slice().buffer;
    ring.push(copy);
  }
  const loud = (): Int16Array => {
    const s = new Int16Array(1600);
    for (let i = 0; i < s.length; i++) s[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
    return s;
  };
  const quiet = (): Int16Array => new Int16Array(1600);

  it("fromMark：标记前帧不入选（窗前管家独白被排除）", () => {
    const ring = createPcmRing();
    for (let i = 0; i < 30; i++) pushFrame(ring, loud()); // 3s 管家独白
    ring.mark(); // 开窗点
    for (let i = 0; i < 10; i++) pushFrame(ring, loud()); // 1s 用户插话（自声叠加模拟——同过门限）
    const seg = ring.takeUtterance({ fromMark: true });
    expect(seg).not.toBeNull();
    // 只含标记后 10 帧（+头端边距 2 帧也标记后）→ 约 12 帧× 1600 样本内
    expect(seg!.length).toBeLessThanOrEqual(12 * 1600);
    expect(seg!.length).toBeGreaterThanOrEqual(10 * 1600);
  });

  it("fromMark 无标记：回退常规选取（防御——不炸）", () => {
    const ring = createPcmRing();
    for (let i = 0; i < 10; i++) pushFrame(ring, loud());
    const seg = ring.takeUtterance({ fromMark: true });
    expect(seg).not.toBeNull();
  });

  it("mark 后全静音（噪音过门后用户没说话）：null", () => {
    const ring = createPcmRing();
    for (let i = 0; i < 20; i++) pushFrame(ring, loud());
    ring.mark();
    for (let i = 0; i < 10; i++) pushFrame(ring, quiet());
    expect(ring.takeUtterance({ fromMark: true })).toBeNull();
  });

  it("clear 后标记失效：回退常规选取", () => {
    const ring = createPcmRing();
    for (let i = 0; i < 10; i++) pushFrame(ring, loud());
    ring.mark();
    ring.clear();
    for (let i = 0; i < 5; i++) pushFrame(ring, loud());
    const seg = ring.takeUtterance({ fromMark: true });
    expect(seg).not.toBeNull(); // 回退常规（含全 15 帧）
    expect(seg!.length).toBeGreaterThanOrEqual(5 * 1600);
  });

  it("常规取样不受 mark 影响（无参 takeUtterance 行为不变）", () => {
    const ring = createPcmRing();
    for (let i = 0; i < 30; i++) pushFrame(ring, loud());
    ring.mark();
    for (let i = 0; i < 10; i++) pushFrame(ring, loud());
    const seg = ring.takeUtterance();
    // 常规路径：无静音边界 → 扩到 6s 上限（60 帧）
    expect(seg!.length).toBeLessThanOrEqual(60 * 1600);
  });
});

describe("frameRms", () => {
  it("静音=0；正弦定幅≈幅度/√2（Int16 域）", () => {
    expect(frameRms(new Int16Array(1600))).toBe(0);
    const s = new Int16Array(1600);
    for (let i = 0; i < s.length; i++) s[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
    expect(frameRms(s)).toBeGreaterThan(1800);
    expect(frameRms(s)).toBeLessThan(2200);
  });
});

describe("selectUtterancePcm（尾部语音段选取）", () => {
  it("尾部静音跳过：取最后一段有声帧（含边距）", () => {
    const frames = [
      frame(true, 0), // 0 声
      frame(false), // 1 静
      frame(true, 1), // 2 声 ← 目标段
      frame(true, 2), // 3 声
      frame(false), // 4 尾静音
      frame(false), // 5 尾静音
    ];
    const pcm = selectUtterancePcm(frames);
    expect(pcm).not.toBeNull();
    // lastLoud=帧3，往头扩展：帧2 声、帧1 静（仅 1 帧未达 8 帧断离）、帧0 声
    // → 段含帧 0..3（两段有声被短静音隔开时合连——客错）；0.4s 下限判定归
    // verifyGate（audio-too-short），本层只负责选段
    expect(pcm!.length).toBe(4 * 1600);
  });

  it("全静音环 → null", () => {
    expect(selectUtterancePcm([frame(false), frame(false)])).toBeNull();
    expect(selectUtterancePcm([])).toBeNull();
  });

  it("段长上限：超长语音段从尾部截断（保留最近 PCM_RING_SECONDS 内上限）", () => {
    const frames: PcmRingFrame[] = [];
    for (let i = 0; i < 120; i++) frames.push(frame(true, i % 7)); // 12s 连续有声
    const pcm = selectUtterancePcm(frames);
    // 上限 = 6s = 60 帧（保留最近）
    expect(pcm!.length).toBe(60 * 1600);
  });
});

describe("createPcmRing（环缓冲）", () => {
  it("超过容量丢最旧帧（PCM_RING_SECONDS 容量）", () => {
    const ring = createPcmRing();
    const capacity = PCM_RING_SECONDS * 10; // 100ms/帧
    for (let i = 0; i < capacity + 5; i++) {
      const samples = new Int16Array(1600);
      if (i % 2 === 0) for (let k = 0; k < samples.length; k++) samples[k] = 2000;
      ring.push(samples.buffer);
    }
    const pcm = ring.takeUtterance();
    expect(pcm).not.toBeNull();
    // 最旧 5 帧已被淘汰——总帧数 = capacity
    expect(pcm!.length).toBeLessThanOrEqual(capacity * 1600);
  });

  it("clear 后取段 → null", () => {
    const ring = createPcmRing();
    const samples = new Int16Array(1600).fill(2000);
    ring.push(samples.buffer);
    ring.clear();
    expect(ring.takeUtterance()).toBeNull();
  });

  it("takeUtterance 不消费（可重复取同一段）", () => {
    const ring = createPcmRing();
    const samples = new Int16Array(1600).fill(2000);
    ring.push(samples.buffer);
    ring.push(samples.buffer);
    ring.push(samples.buffer);
    const a = ring.takeUtterance();
    const b = ring.takeUtterance();
    expect(a!.length).toBe(b!.length);
  });
});

describe("PCM_RMS_GATE（门限常量）", () => {
  it("Int16 域门限 ≈ float 域 0.02 同源（655）", () => {
    expect(PCM_RMS_GATE).toBe(655);
  });
});

/**
 * speaker-verify 纯函数域测试（M3-c 声纹批）。
 *
 * 覆盖：余弦相似度、模板合成（均值+L2 归一）、判定三态（阈值边界）。
 */
import { describe, expect, it } from "vitest";
import {
  VOICEPRINT_MATCH_THRESHOLD,
  cosineSimilarity,
  decideVerify,
  synthesizeTemplate,
  utteranceVectorsOf,
} from "./speaker-verify";

describe("cosineSimilarity", () => {
  it("同向量=1、反向=-1、正交=0", () => {
    const a = new Float32Array([1, 0, 2]);
    expect(cosineSimilarity(a, new Float32Array([1, 0, 2]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, new Float32Array([-1, 0, -2]))).toBeCloseTo(-1, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 3]))).toBeCloseTo(0, 6);
  });

  it("零向量防御（返回 0 不 NaN）", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0);
  });
});

describe("synthesizeTemplate（均值 + L2 归一）", () => {
  it("三句合成：均值方向 + 单位范数 + 记录句数", () => {
    const v1 = new Float32Array([1, 0, 0]);
    const v2 = new Float32Array([0, 1, 0]);
    const v3 = new Float32Array([1, 1, 0]);
    const t = synthesizeTemplate([v1, v2, v3]);
    expect(t.dim).toBe(3);
    expect(t.utterances).toBe(3);
    const norm = Math.hypot(...t.vector);
    expect(norm).toBeCloseTo(1, 6);
    // 均值 = (2/3, 2/3, 0) → 归一后方向一致
    expect(t.vector[0]!).toBeCloseTo(t.vector[1]!, 6);
    expect(t.vector[2]!).toBeCloseTo(0, 6);
    expect(t.createdAt).toBeGreaterThan(0);
  });

  it("utteranceVectorsOf（模板 → 句向量域回读投影）", () => {
    const t = synthesizeTemplate([new Float32Array([3, 4])]);
    expect(t.dim).toBe(2);
    expect([...utteranceVectorsOf(t)][0]).toBeCloseTo(0.6, 6);
    expect([...utteranceVectorsOf(t)][1]).toBeCloseTo(0.8, 6);
  });

  it("逐句明细随模板落盘：vectors 同构拷贝（槽位编辑数据面）", () => {
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0, 1]);
    const t = synthesizeTemplate([v1, v2]);
    expect(t.vectors).toHaveLength(2);
    expect([...t.vectors[0]!]).toEqual([1, 0]);
    v1[0] = 99; // 底座变异不影响已落模板（拷贝语义）
    expect(t.vectors[0]![0]).toBe(1);
  });
});

describe("decideVerify（阈值判定）", () => {
  it("阈值边界：>= 阈值 pass、< 阈值 reject（带 score）", () => {
    expect(decideVerify(VOICEPRINT_MATCH_THRESHOLD)).toEqual({ kind: "pass" });
    expect(decideVerify(VOICEPRINT_MATCH_THRESHOLD - 0.0001)).toEqual({
      kind: "reject",
      score: VOICEPRINT_MATCH_THRESHOLD - 0.0001,
    });
    expect(decideVerify(1)).toEqual({ kind: "pass" });
    expect(decideVerify(0)).toMatchObject({ kind: "reject" });
  });

  it("自定义阈值（设置页调参）：0.9 阈值下 0.85 reject、0.95 pass", () => {
    expect(decideVerify(0.95, 0.9)).toEqual({ kind: "pass" });
    expect(decideVerify(0.85, 0.9)).toEqual({ kind: "reject", score: 0.85 });
  });
});

/**
 * 向量余弦相似度纯函数单测（批2 WP-C 查重闸的比对内核；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. 同向 = 1 / 正交 = 0 / 反向 = -1（方向语义，不做截断）；
 * 2. 一般夹角值正确（浮点容差）；
 * 3. 维度不齐抛错（调用方（KgDedupService）捕获降级 warn——绝不静默算错）；
 * 4. 零向量抛错（余弦无定义——同降级路径）。
 */
import { describe, expect, test } from "bun:test";
import { cosineSimilarity } from "../../src/domain/kg/node-vector";

describe("cosineSimilarity（查重闸比对内核）", () => {
  test("① 同向 1 / 正交 0 / 反向 -1", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0, 0]), Float32Array.from([2, 0, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(Float32Array.from([1, 0, 0]), Float32Array.from([0, 5, 0]))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(Float32Array.from([1, 0, 0]), Float32Array.from([-3, 0, 0]))).toBeCloseTo(-1, 6);
  });

  test("② 一般夹角（cos θ = 0.87 / 0.95 量级）", () => {
    const x = Float32Array.from([1, 0]);
    for (const c of [0.87, 0.95, 0.5]) {
      const y = Float32Array.from([c, Math.sqrt(1 - c * c)]);
      expect(cosineSimilarity(x, y)).toBeCloseTo(c, 5);
    }
  });

  test("③ 维度不齐抛错（降级路径输入面）", () => {
    expect(() => cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toThrow();
  });

  test("④ 零向量抛错（余弦无定义）", () => {
    expect(() => cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toThrow();
  });
});

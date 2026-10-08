// @vitest-environment jsdom
/**
 * voiceprint-store 序列化契约（槽位编辑批）：逐句向量明细 round-trip +
 * 旧版模板（无 vectors 字段）兼容回读（明细空数组，校验走均值向量）+
 * 病态明细整份拒收。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalVoiceprintStore, VOICEPRINT_STORE_KEY } from "./voiceprint-store";
import type { VoiceprintTemplate } from "./speaker-verify";

function templateOf(vectors: number[][]): VoiceprintTemplate {
  return {
    dim: 2,
    vector: new Float32Array([1, 0]),
    vectors: vectors.map((v) => new Float32Array(v)),
    utterances: vectors.length,
    createdAt: 42,
  };
}

describe("voiceprint-store（localStorage 序列化）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("逐句明细 round-trip：vectors 内容与句数一致", () => {
    const store = createLocalVoiceprintStore(localStorage);
    store.write(templateOf([[1, 0], [0, 1]]));
    const t = store.read();
    expect(t).not.toBeNull();
    expect(t!.vectors).toHaveLength(2);
    expect([...t!.vectors[1]!]).toEqual([0, 1]);
    expect(t!.utterances).toBe(2);
  });

  it("旧版模板（无 vectors 字段）兼容：明细回读空数组、均值向量照旧", () => {
    localStorage.setItem(
      VOICEPRINT_STORE_KEY,
      JSON.stringify({ dim: 2, vector: [1, 0], utterances: 3, createdAt: 1 }),
    );
    const t = createLocalVoiceprintStore(localStorage).read();
    expect(t).not.toBeNull();
    expect(t!.vectors).toEqual([]);
    expect(t!.utterances).toBe(3);
    expect([...t!.vector]).toEqual([1, 0]);
  });

  it("病态明细（维度不齐）整份拒收（按未注册处理）", () => {
    localStorage.setItem(
      VOICEPRINT_STORE_KEY,
      JSON.stringify({ dim: 2, vector: [1, 0], vectors: [[1, 0], [0]], utterances: 2, createdAt: 1 }),
    );
    expect(createLocalVoiceprintStore(localStorage).read()).toBeNull();
  });
});

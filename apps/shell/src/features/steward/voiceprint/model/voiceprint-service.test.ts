/**
 * voiceprint-service 契约测试（M3-c 声纹批；注入假推理引擎 + 假存储）。
 *
 * 契约面（brief 测试要求）：
 * - 注册（3-5 句）→ 模板存在（可 isRegistered / test / remove）；
 * - 校验通过 → pass（消费卡放行的判定面）；
 * - 不匹配 → reject（拒绝 + score——卡保留/语音明示归授权点消费方）；
 * - 未注册 → skip(unregistered) 且**零引擎调用**；
 * - 引擎加载失败 → skip(engine-unavailable) + WARN；
 * - 推理抛错 → skip(inference-error) + WARN；
 * - 音频过短（<0.4s）→ skip(audio-too-short)；
 * - 删除 → 模板彻底移除（未注册形态回归）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceprintService, type EmbedEngine } from "./voiceprint-service";
import { createMemoryVoiceprintStore, type VoiceprintStore } from "./voiceprint-store";
import { VOICEPRINT_MATCH_THRESHOLD } from "./speaker-verify";

/** 假引擎：固定向量 + 调用记录 + 可编程失败。 */
function fakeEngine(vector: number[], opts?: { embedThrows?: boolean }) {
  const calls: number[] = [];
  const engine: EmbedEngine = {
    embed: async (samples: Float32Array) => {
      calls.push(samples.length);
      if (opts?.embedThrows) throw new Error("inference boom");
      return new Float32Array(vector);
    },
  };
  return { engine, calls };
}

function loaderOf(engine: EmbedEngine | Error) {
  let loaded = 0;
  const loader = () => {
    loaded += 1;
    if (engine instanceof Error) return Promise.reject(engine);
    return Promise.resolve(engine);
  };
  return { loader, loadedCount: () => loaded };
}

/** 一句 1.5s 的有声 PCM（Int16 域正弦）。 */
function utterance(seconds = 1.5): Float32Array {
  const n = Math.round(16000 * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  return out;
}

describe("注册契约", () => {
  let store: VoiceprintStore;
  beforeEach(() => {
    store = createMemoryVoiceprintStore();
  });

  it("3 句注册 → 模板存在（isRegistered=true，句数记录）", async () => {
    const { engine } = fakeEngine([1, 0, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    expect(svc.isRegistered()).toBe(false);
    const t = await svc.register([utterance(), utterance(), utterance()]);
    expect(t.utterances).toBe(3);
    expect(svc.isRegistered()).toBe(true);
  });

  it("5 句上限内可注册；<3 句拒绝；>5 句拒绝", async () => {
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    const five = await svc.register([utterance(), utterance(), utterance(), utterance(), utterance()]);
    expect(five.utterances).toBe(5);
    await expect(svc.register([utterance(), utterance()])).rejects.toThrow(/min-utterances/);
    await expect(
      svc.register([utterance(), utterance(), utterance(), utterance(), utterance(), utterance()]),
    ).rejects.toThrow(/max-utterances/);
  });

  it("句长不足（<1.2s）→ 注册拒绝（不落模板）", async () => {
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await expect(svc.register([utterance(0.8), utterance(), utterance()])).rejects.toThrow(/utterance-too-short/);
    expect(svc.isRegistered()).toBe(false);
  });

  it("删除 → 彻底移除（回到未注册）", async () => {
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await svc.register([utterance(), utterance(), utterance()]);
    svc.remove();
    expect(svc.isRegistered()).toBe(false);
  });
});

describe("verifyGate 契约（授权点判定）", () => {
  let store: VoiceprintStore;
  beforeEach(() => {
    store = createMemoryVoiceprintStore();
  });

  it("校验通过（相似度 >= 阈值）→ pass", async () => {
    const { engine } = fakeEngine([1, 0, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await svc.register([utterance(), utterance(), utterance()]); // 模板 = [1,0,0]
    const r = await svc.verifyGate(utterance(2));
    expect(r).toEqual({ kind: "pass" });
  });

  it("不匹配（低相似度）→ reject + score", async () => {
    const { engine: regEngine } = fakeEngine([1, 0, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(regEngine), store });
    await svc.register([utterance(), utterance(), utterance()]);
    // 换引擎：返回正交向量（相似度 0 < 阈值）
    const { engine: probeEngine } = fakeEngine([0, 1, 0]);
    const svc2 = createVoiceprintService({ engineLoader: () => Promise.resolve(probeEngine), store });
    const r = await svc2.verifyGate(utterance(2));
    expect(r.kind).toBe("reject");
    expect((r as { score: number }).score).toBeLessThan(VOICEPRINT_MATCH_THRESHOLD);
  });

  it("未注册 → skip(unregistered) 且零引擎调用", async () => {
    const { engine, calls } = fakeEngine([1, 0]);
    const { loader, loadedCount } = loaderOf(engine);
    const svc = createVoiceprintService({ engineLoader: loader, store });
    const r = await svc.verifyGate(utterance(2));
    expect(r).toEqual({ kind: "skip", reason: "unregistered" });
    expect(loadedCount()).toBe(0); // loader 零调用（更零 embed）
    expect(calls.length).toBe(0);
  });

  it("音频过短（<0.4s）/ null → skip(audio-too-short)", async () => {
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await svc.register([utterance(), utterance(), utterance()]);
    const r = await svc.verifyGate(utterance(0.2));
    expect(r).toEqual({ kind: "skip", reason: "audio-too-short" });
    const r2 = await svc.verifyGate(null);
    expect(r2).toEqual({ kind: "skip", reason: "audio-too-short" });
  });

  it("引擎加载失败 → skip(engine-unavailable) + WARN", async () => {
    const warn = vi.fn();
    const svc = createVoiceprintService({
      engineLoader: () => Promise.reject(new Error("model download failed")),
      store,
      warn,
    });
    await svc.register([utterance(), utterance(), utterance()]).catch(() => undefined);
    // 直接种模板（不经引擎）再测 gate：
    store.write({ dim: 2, vector: new Float32Array([1, 0]), vectors: [], utterances: 3, createdAt: 1 });
    const r = await svc.verifyGate(utterance(2));
    expect(r).toEqual({ kind: "skip", reason: "engine-unavailable" });
    expect(warn).toHaveBeenCalled();
  });

  it("引擎加载失败不永锁：瞬时失败恢复后下次调用重载成功（不再永久 skip）", async () => {
    const { engine } = fakeEngine([1, 0]);
    let fail = true;
    let loaded = 0;
    const loader = () => {
      loaded += 1;
      return fail ? Promise.reject(new Error("transient ort init failure")) : Promise.resolve(engine);
    };
    store.write({ dim: 2, vector: new Float32Array([1, 0]), vectors: [], utterances: 3, createdAt: 1 });
    const svc = createVoiceprintService({ engineLoader: loader, store });
    const r1 = await svc.verifyGate(utterance(2));
    expect(r1).toEqual({ kind: "skip", reason: "engine-unavailable" }); // 首载瞬时失败
    fail = false; // 模型归位/抖动过去
    const r2 = await svc.verifyGate(utterance(2));
    expect(r2).toEqual({ kind: "pass" }); // 修复前：rejected promise 永久缓存 → 本会话永远 skip
    expect(loaded).toBe(2); // 重试过一次 loader
  });

  it("推理抛错 → skip(inference-error) + WARN", async () => {
    const warn = vi.fn();
    store.write({ dim: 2, vector: new Float32Array([1, 0]), vectors: [], utterances: 3, createdAt: 1 });
    const { engine } = fakeEngine([1, 0], { embedThrows: true });
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store, warn });
    const r = await svc.verifyGate(utterance(2));
    expect(r).toEqual({ kind: "skip", reason: "inference-error" });
    expect(warn).toHaveBeenCalled();
  });
});

describe("test 契约（注册页测试按钮）", () => {
  it("返回与模板的实时相似度得分", async () => {
    const store = createMemoryVoiceprintStore();
    store.write({ dim: 2, vector: new Float32Array([1, 0]), vectors: [], utterances: 3, createdAt: 1 });
    const { engine } = fakeEngine([0.9, 0.1]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    const score = await svc.test(utterance(1.5));
    expect(score).toBeGreaterThan(0.95);
  });
});

describe("阈值注入（设置页调参即时生效）", () => {
  it("threshold getter 现读生效：同一得分高阈值 reject、低阈值 pass", async () => {
    const store = createMemoryVoiceprintStore();
    store.write({ dim: 2, vector: new Float32Array([1, 0]), vectors: [], utterances: 3, createdAt: 1 });
    const { engine } = fakeEngine([0.9, 0.1]); // cos ≈ 0.994
    let threshold = 0.995;
    const svc = createVoiceprintService({
      engineLoader: () => Promise.resolve(engine),
      store,
      threshold: () => threshold,
    });
    const rejected = await svc.verifyGate(utterance(2));
    expect(rejected.kind).toBe("reject");
    threshold = 0.5; // 调参后无需重建服务——下一次 gate 现读即生效
    const passed = await svc.verifyGate(utterance(2));
    expect(passed).toEqual({ kind: "pass" });
  });
});

describe("槽位编辑契约（单槽重录/删除——逐句向量明细）", () => {
  it("注册落逐句明细：vectors 句数与 utterances 一致", async () => {
    const store = createMemoryVoiceprintStore();
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    const t = await svc.register([utterance(), utterance(), utterance()]);
    expect(t.vectors).toHaveLength(3);
    expect(t.utterances).toBe(3);
    expect(svc.getTemplate()?.vectors).toHaveLength(3);
  });

  it("recordSlot 重录（index < 句数）→ 该槽向量换新 + 模板重合成", async () => {
    const store = createMemoryVoiceprintStore();
    let next: number[] = [1, 0];
    const engine: EmbedEngine = {
      embed: async () => new Float32Array(next),
    };
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await svc.register([utterance(), utterance(), utterance()]);
    next = [0, 1];
    const t = await svc.recordSlot(1, utterance());
    expect(Array.from(t.vectors[1]!)).toEqual([0, 1]);
    expect(Array.from(t.vectors[0]!)).toEqual([1, 0]);
    expect(t.utterances).toBe(3);
  });

  it("recordSlot 补录（index === 句数）→ 句数 +1（上限 5）", async () => {
    const store = createMemoryVoiceprintStore();
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await svc.register([utterance(), utterance(), utterance()]);
    const t = await svc.recordSlot(3, utterance());
    expect(t.utterances).toBe(4);
    await expect(svc.recordSlot(4, utterance())).resolves.toMatchObject({ utterances: 5 });
    await expect(svc.recordSlot(5, utterance())).rejects.toMatchObject({ code: "max-utterances" });
  });

  it("守卫：未注册 not-registered / 旧模板 slots-unavailable / 越界 slot-range / 短句 utterance-too-short", async () => {
    const store = createMemoryVoiceprintStore();
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await expect(svc.recordSlot(0, utterance())).rejects.toMatchObject({ code: "not-registered" });
    store.write({ dim: 2, vector: new Float32Array([1, 0]), vectors: [], utterances: 3, createdAt: 1 });
    await expect(svc.recordSlot(0, utterance())).rejects.toMatchObject({ code: "slots-unavailable" });
    await expect(svc.deleteSlot(0)).rejects.toMatchObject({ code: "slots-unavailable" });
    await svc.remove();
    await svc.register([utterance(), utterance(), utterance()]);
    await expect(svc.recordSlot(4, utterance())).rejects.toMatchObject({ code: "slot-range" });
    await expect(svc.recordSlot(-1, utterance())).rejects.toMatchObject({ code: "slot-range" });
    await expect(svc.recordSlot(0, utterance(0.5))).rejects.toMatchObject({ code: "utterance-too-short" });
  });

  it("deleteSlot → 句数 -1 重合成；3 句保底拒删（min-utterances）", async () => {
    const store = createMemoryVoiceprintStore();
    const { engine } = fakeEngine([1, 0]);
    const svc = createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store });
    await svc.register([utterance(), utterance(), utterance(), utterance()]);
    const t = await svc.deleteSlot(1);
    expect(t.utterances).toBe(3);
    await expect(svc.deleteSlot(0)).rejects.toMatchObject({ code: "min-utterances" });
    await expect(svc.deleteSlot(3)).rejects.toMatchObject({ code: "slot-range" });
  });
});

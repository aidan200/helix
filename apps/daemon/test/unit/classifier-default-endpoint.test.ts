/**
 * 默认分类端点（D1 渐进收编）单测——fake RuntimeConfig 内存表，零网络零原生库。
 *
 * 断言面：
 * 1. setDefault(kind="classifier") 校验三拒：条目不存在 / kind≠classifier
 *    （指向向量端点）/ 未 verify——任一不满足拒绝且 KV 零写入；全过 → 落
 *    classifier.defaultEndpointId（embedding.defaultEndpointId 零扰动）；
 *    kind 缺省 = embedding 语义回归（E-306 契约零变化）；
 * 2. resolveDefault 分 kind：resolveDefault()/resolveDefaultRecord() embedding
 *    契约零变化（classifier 默认不进向量取用）；resolveDefaultRecord("classifier")
 *    / resolveDefaultClassifierRecord() 只认 classifier 默认引用（悬空/误指
 *    向量端点 → null）；
 * 3. resolveJudgeRecord 判官端点兜底层三档矩阵（渐进收编单点）：
 *    显式引用优先（悬空/误指 = null 不落默认）＞ 未配置取默认分类端点 ＞
 *    无默认 = null（判官缺席，维持现状降级）。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import {
  CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY,
  EMBEDDING_DEFAULT_ENDPOINT_ID_KEY,
  EMBEDDING_ENDPOINTS_KEY,
  EmbeddingConfigService,
  resolveJudgeRecord,
  type EmbeddingEndpointRecord,
  type JudgeEndpointLookup,
} from "../../src/application/embedding/EmbeddingConfigService";

/** 内存 KV fake（RuntimeConfigPort 最小实现）。 */
function memoryConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { dump(): Record<string, string | undefined> } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
    dump: () => Object.fromEntries(store.entries()),
  };
}

function fakeProbe(): (cfg: import("../../src/application/ports/outbound/EmbeddingPort").EmbeddingEndpointConfig) => EmbeddingPort {
  return () => ({
    embed: async (): Promise<EmbeddingResult> => ({ vectors: [Float32Array.from([0.1, 0.2])], dim: 2 }),
    endpointLabel: () => "fake",
  });
}

function judgeProbe(): import("../../src/application/ports/outbound/JudgePort").JudgePort {
  return {
    noul: async () => 0.95,
    endpointLabel: () => "fake-judge",
  };
}

function svcOf(config: RuntimeConfigPort): EmbeddingConfigService {
  return new EmbeddingConfigService({ config, createProbe: fakeProbe(), createJudgeProbe: judgeProbe });
}

/** 直落 KV 端点清单（构造 fixture——不经 set 免 verifiedAt 语义耦合）。 */
function seedEndpoints(config: RuntimeConfigPort, records: readonly EmbeddingEndpointRecord[]): void {
  void config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(records));
}

const VERIFIED: EmbeddingEndpointRecord = {
  id: "ep-vec",
  name: "Ollama 本地",
  baseUrl: "http://localhost:11434/v1",
  model: "bge-m3",
  verifiedAt: 1000,
};
const UNVERIFIED_VEC: EmbeddingEndpointRecord = {
  id: "ep-vec2",
  name: "未验证向量端点",
  baseUrl: "http://localhost:11436/v1",
  model: "bge-m3",
};
const CLASSIFIER_OK: EmbeddingEndpointRecord = {
  id: "ep-j",
  name: "Jev",
  baseUrl: "https://judge.example/v1",
  model: "jev-latest",
  kind: "classifier",
  verifiedAt: 1000,
};
const CLASSIFIER_UNVERIFIED: EmbeddingEndpointRecord = {
  id: "ep-j2",
  name: "Jev 未验证",
  baseUrl: "https://judge2.example/v1",
  model: "jev-latest",
  kind: "classifier",
};

describe("setDefault kind 维度（D1）：classifier 默认端点三拒 + 成功路径", () => {
  test("三拒① 条目不存在 → 拒绝（错误含定位）+ 两键零写入", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [CLASSIFIER_OK]);
    const outcome = await svcOf(config).setDefault("ep-404", "classifier");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("ep-404");
    expect(config.get(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
  });

  test("三拒② kind≠classifier（指向向量端点）→ 拒绝", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [VERIFIED]);
    const outcome = await svcOf(config).setDefault("ep-vec", "classifier");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("classifier");
    expect(config.get(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
  });

  test("三拒③ 未 verify → 拒绝（提示先连通验证）", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [CLASSIFIER_UNVERIFIED]);
    const outcome = await svcOf(config).setDefault("ep-j2", "classifier");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("连通验证");
    expect(config.get(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
  });

  test("全过 → 落 classifier.defaultEndpointId（单选覆盖；embedding 默认零扰动）", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [VERIFIED, CLASSIFIER_OK, CLASSIFIER_UNVERIFIED]);
    const svc = svcOf(config);
    expect((await svc.setDefault("ep-vec")).ok).toBe(true); // kind 缺省 = embedding（E-306 回归）
    expect((await svc.setDefault("ep-j", "classifier")).ok).toBe(true);
    expect(config.get(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-j");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-vec"); // 向量默认零扰动
    // 换默认 = 引用覆盖（无级联）
    seedEndpoints(config, [VERIFIED, CLASSIFIER_OK, { ...CLASSIFIER_UNVERIFIED, verifiedAt: 2000 }]);
    expect((await svc.setDefault("ep-j2", "classifier")).ok).toBe(true);
    expect(config.get(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-j2");
    // classifier 端点不进向量默认（E-306 三拒② 语义不变）
    expect((await svc.setDefault("ep-j", "embedding")).ok).toBe(false);
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-vec");
  });
});

describe("resolveDefault 分 kind（D1）：embedding 契约零变化 + classifier 对称扩展", () => {
  test("resolveDefault()/resolveDefaultRecord() 只认向量默认（classifier 默认零影响）", () => {
    const config = memoryConfig();
    seedEndpoints(config, [VERIFIED, CLASSIFIER_OK]);
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-j");
    const svc = svcOf(config);
    expect(svc.resolveDefault()).toBeNull(); // 未设向量默认 → null（契约零变化；classifier 默认零影响）
    expect(svc.resolveDefaultRecord()).toBeNull();
    void config.set(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY, "ep-vec");
    expect(svc.resolveDefault()).toEqual({ baseUrl: VERIFIED.baseUrl, model: VERIFIED.model });
    expect(svc.resolveDefaultRecord()?.id).toBe("ep-vec");
    expect(svc.resolveDefaultRecord("classifier")?.id).toBe("ep-j"); // 分类默认独立于向量默认（互不串面）
  });

  test("resolveDefaultClassifierRecord()：在场回记录（含 variant）/ 未设 null / 悬空 null / 误指向量端点 null", () => {
    const config = memoryConfig();
    seedEndpoints(config, [VERIFIED, { ...CLASSIFIER_OK, variant: "pi-ai" }]);
    const svc = svcOf(config);
    expect(svc.resolveDefaultClassifierRecord()).toBeNull(); // 未设
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-gone");
    expect(svc.resolveDefaultClassifierRecord()).toBeNull(); // 悬空
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-vec");
    expect(svc.resolveDefaultClassifierRecord()).toBeNull(); // 误指向量端点
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-j");
    expect(svc.resolveDefaultClassifierRecord()).toEqual({ ...CLASSIFIER_OK, variant: "pi-ai" });
    expect(svc.resolveDefaultRecord("classifier")?.id).toBe("ep-j"); // kind 参数面同源
    // 向量默认不受分类默认牵动
    void config.set(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY, "ep-vec");
    expect(svc.resolveDefault()).toEqual({ baseUrl: VERIFIED.baseUrl, model: VERIFIED.model });
  });
});

describe("resolveJudgeRecord 判官端点兜底层（D1 渐进收编单点）三档矩阵", () => {
  /** 以真实服务为 lookup（生产消费面同姿势）。 */
  function lookupOf(config: RuntimeConfigPort): JudgeEndpointLookup {
    return svcOf(config);
  }

  test("① 显式引用优先：judgeEndpointId 在场 → 用显式端点（默认端点另设也只认显式）", () => {
    const config = memoryConfig();
    seedEndpoints(config, [CLASSIFIER_OK, { ...CLASSIFIER_UNVERIFIED, id: "ep-def", verifiedAt: 5 }]);
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-def");
    expect(resolveJudgeRecord("ep-j", lookupOf(config))?.id).toBe("ep-j");
  });

  test("①b 显式引用悬空/误指向量端点 → null（不静默落默认）", () => {
    const config = memoryConfig();
    seedEndpoints(config, [CLASSIFIER_OK, VERIFIED]);
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-j");
    expect(resolveJudgeRecord("ep-gone", lookupOf(config))).toBeNull();
    expect(resolveJudgeRecord("ep-vec", lookupOf(config))).toBeNull();
  });

  test("② 未配置（undefined/空串）→ 取默认分类端点（有默认 = 判官在场）", () => {
    const config = memoryConfig();
    seedEndpoints(config, [CLASSIFIER_OK, { ...CLASSIFIER_UNVERIFIED, id: "ep-def", verifiedAt: 5 }]);
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-def");
    expect(resolveJudgeRecord(undefined, lookupOf(config))?.id).toBe("ep-def");
    expect(resolveJudgeRecord("", lookupOf(config))?.id).toBe("ep-def");
    expect(resolveJudgeRecord("  ", lookupOf(config))?.id).toBe("ep-def");
  });

  test("③ 无默认（未设/悬空/误指）→ null（判官缺席——维持现状降级）", () => {
    const config = memoryConfig();
    seedEndpoints(config, [CLASSIFIER_OK, VERIFIED]);
    expect(resolveJudgeRecord(undefined, lookupOf(config))).toBeNull();
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-gone");
    expect(resolveJudgeRecord(undefined, lookupOf(config))).toBeNull();
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-vec");
    expect(resolveJudgeRecord(undefined, lookupOf(config))).toBeNull();
  });
});

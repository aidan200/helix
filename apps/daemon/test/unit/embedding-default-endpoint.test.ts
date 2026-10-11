/**
 * 全局默认 embedding 端点（批1 WP-A）单测——fake RuntimeConfig 内存表，
 * 零网络零原生库。
 *
 * 断言面：
 * 1. setDefault 校验三拒：条目不存在 / kind≠embedding（判官端点）/ 未 verify
 *    ——任一不满足拒绝且 KV 零写入；全过 → 落 embedding.defaultEndpointId；
 * 2. resolveDefault：悬空（引用条目已删）回 null / 未设回 null / kind 误指
 *    classifier 回 null / 条目在场回端点配置（apiKey 只进配置不出回执）；
 * 3. migrateMemoryEndpointToDefault（一次性幂等迁移）：
 *    - 默认端点为空 ∧ memory.endpointId 所指条目存在 ∧ kind=embedding → 迁为
 *      默认端点 + 清 memory.endpointId；
 *    - 所指条目不存在 / kind≠embedding / 已有默认端点 → 丢弃（warn 留档）+ 清键；
 *    - 无旧值 → 零改写（含空串——二次启动零改写判据）。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import {
  EmbeddingConfigService,
  EMBEDDING_DEFAULT_ENDPOINT_ID_KEY,
  EMBEDDING_ENDPOINTS_KEY,
  type EmbeddingEndpointRecord,
} from "../../src/application/embedding/EmbeddingConfigService";
import {
  MEMORY_ENDPOINT_ID_KEY,
  migrateMemoryEndpointToDefault,
} from "../../src/application/memory/memoryConfig";

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

function fakeProbeFactory(): (cfg: import("../../src/application/ports/outbound/EmbeddingPort").EmbeddingEndpointConfig) => EmbeddingPort {
  return () => ({
    embed: async () => ({ vectors: [Float32Array.from([0.1, 0.2, 0.3])], dim: 3 }) satisfies EmbeddingResult,
    endpointLabel: () => "fake",
  });
}

function noopJudgeProbe(): import("../../src/application/ports/outbound/JudgePort").JudgePort {
  return {
    noul: async () => {
      throw new Error("noop judge：默认端点用例不应走到判官探测");
    },
    endpointLabel: () => "noop-judge",
  };
}

function svcOf(config: RuntimeConfigPort): EmbeddingConfigService {
  return new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
}

/** 直落 KV 端点清单（构造 fixture——不经 set 免 verifiedAt 语义耦合）。 */
function seedEndpoints(config: RuntimeConfigPort, records: readonly EmbeddingEndpointRecord[]): void {
  void config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(records));
}

const VERIFIED: EmbeddingEndpointRecord = {
  id: "ep-a",
  name: "Ollama 本地",
  baseUrl: "http://localhost:11434/v1",
  model: "bge-m3",
  verifiedAt: 1000,
};
const UNVERIFIED: EmbeddingEndpointRecord = {
  id: "ep-b",
  name: "未验证端点",
  baseUrl: "http://localhost:11435/v1",
  model: "bge-m3",
};
const CLASSIFIER: EmbeddingEndpointRecord = {
  id: "ep-j",
  name: "Jev",
  baseUrl: "https://judge.example/v1",
  model: "jev-latest",
  kind: "classifier",
  verifiedAt: 1000,
};

describe("setDefault：全局默认 embedding 端点校验（批1）", () => {
  test("三拒① 条目不存在 → 拒绝（错误含定位）+ KV 零写入", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [VERIFIED]);
    const outcome = await svcOf(config).setDefault("ep-404");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("ep-404");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
  });

  test("三拒② kind≠embedding（判官端点）→ 拒绝", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [CLASSIFIER]);
    const outcome = await svcOf(config).setDefault("ep-j");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("classifier");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
  });

  test("三拒③ 未 verify → 拒绝（提示先连通验证）", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [UNVERIFIED]);
    const outcome = await svcOf(config).setDefault("ep-b");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("连通验证");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
  });

  test("全过 → 落 KV（单选语义：重复设默认 = 覆盖引用）", async () => {
    const config = memoryConfig();
    seedEndpoints(config, [VERIFIED, UNVERIFIED, CLASSIFIER]);
    const svc = svcOf(config);
    expect((await svc.setDefault("ep-a")).ok).toBe(true);
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-a");
    // kind=embedding ∧ 已 verify 的第二条可换默认（引用覆盖，无级联）
    await config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify([{ ...UNVERIFIED, verifiedAt: 2000 }]));
    expect((await svc.setDefault("ep-b")).ok).toBe(true);
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-b");
  });
});

describe("resolveDefault：全消费面唯一取用单点（批1）", () => {
  test("未设默认 → null", () => {
    const config = memoryConfig();
    seedEndpoints(config, [VERIFIED]);
    expect(svcOf(config).resolveDefault()).toBeNull();
  });

  test("悬空（引用条目已删）→ null", () => {
    const config = memoryConfig({ [EMBEDDING_DEFAULT_ENDPOINT_ID_KEY]: "ep-gone" });
    seedEndpoints(config, [VERIFIED]);
    expect(svcOf(config).resolveDefault()).toBeNull();
  });

  test("误指 kind=classifier 条目 → null（判官端点不进向量语义）", () => {
    const config = memoryConfig({ [EMBEDDING_DEFAULT_ENDPOINT_ID_KEY]: "ep-j" });
    seedEndpoints(config, [CLASSIFIER]);
    expect(svcOf(config).resolveDefault()).toBeNull();
  });

  test("条目在场 → 回端点配置（baseUrl/model/apiKey）", () => {
    const config = memoryConfig({ [EMBEDDING_DEFAULT_ENDPOINT_ID_KEY]: "ep-a" });
    seedEndpoints(config, [{ ...VERIFIED, apiKey: "sk-secret" }]);
    expect(svcOf(config).resolveDefault()).toEqual({
      baseUrl: "http://localhost:11434/v1",
      model: "bge-m3",
      apiKey: "sk-secret",
    });
    // resolveDefaultRecord：回记录（含 id/name 元数据）
    expect(svcOf(config).resolveDefaultRecord()?.name).toBe("Ollama 本地");
  });
});

describe("migrateMemoryEndpointToDefault：memory.endpointId 退役迁移（一次性幂等）", () => {
  test("① 默认端点为空 ∧ 所指条目存在 ∧ kind=embedding → 迁为默认端点 + 清旧键", async () => {
    const config = memoryConfig({ [MEMORY_ENDPOINT_ID_KEY]: "ep-a" });
    seedEndpoints(config, [VERIFIED]);
    const warns: string[] = [];
    const outcome = await migrateMemoryEndpointToDefault(config, svcOf(config), (m) => warns.push(m));
    expect(outcome).toBe("migrated");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-a");
    expect(config.get(MEMORY_ENDPOINT_ID_KEY)).toBe("");
    expect(warns).toEqual([]);
  });

  test("② 所指条目不存在 → 丢弃（warn 留档）+ 清旧键", async () => {
    const config = memoryConfig({ [MEMORY_ENDPOINT_ID_KEY]: "ep-gone" });
    seedEndpoints(config, [VERIFIED]);
    const warns: string[] = [];
    const outcome = await migrateMemoryEndpointToDefault(config, svcOf(config), (m) => warns.push(m));
    expect(outcome).toBe("discarded");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
    expect(config.get(MEMORY_ENDPOINT_ID_KEY)).toBe("");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("ep-gone");
  });

  test("②b 所指条目 kind≠embedding → 丢弃（warn）+ 清旧键", async () => {
    const config = memoryConfig({ [MEMORY_ENDPOINT_ID_KEY]: "ep-j" });
    seedEndpoints(config, [CLASSIFIER]);
    const warns: string[] = [];
    const outcome = await migrateMemoryEndpointToDefault(config, svcOf(config), (m) => warns.push(m));
    expect(outcome).toBe("discarded");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBeUndefined();
    expect(config.get(MEMORY_ENDPOINT_ID_KEY)).toBe("");
    expect(warns).toHaveLength(1);
  });

  test("②c 已有默认端点 → memory.endpointId 丢弃（warn）+ 清旧键（新域优先）", async () => {
    const config = memoryConfig({
      [EMBEDDING_DEFAULT_ENDPOINT_ID_KEY]: "ep-a",
      [MEMORY_ENDPOINT_ID_KEY]: "ep-b",
    });
    seedEndpoints(config, [VERIFIED, UNVERIFIED]);
    const warns: string[] = [];
    const outcome = await migrateMemoryEndpointToDefault(config, svcOf(config), (m) => warns.push(m));
    expect(outcome).toBe("discarded");
    expect(config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY)).toBe("ep-a"); // 不覆盖
    expect(config.get(MEMORY_ENDPOINT_ID_KEY)).toBe("");
    expect(warns).toHaveLength(1);
  });

  test("③ 幂等：二次启动零改写（无旧值/已清空 → none + KV 快照不变）", async () => {
    const config = memoryConfig({ [MEMORY_ENDPOINT_ID_KEY]: "ep-a" });
    seedEndpoints(config, [VERIFIED]);
    expect(await migrateMemoryEndpointToDefault(config, svcOf(config))).toBe("migrated");
    const snapshot = new Map(
      Object.entries(config.dump()).filter(([, v]) => v !== undefined) as [string, string][],
    );
    expect(await migrateMemoryEndpointToDefault(config, svcOf(config))).toBe("none");
    expect([...Object.entries(config.dump()).filter(([, v]) => v !== undefined)]).toEqual([...snapshot.entries()]);
    // 键缺席形态同样零改写
    const fresh = memoryConfig();
    seedEndpoints(fresh, [VERIFIED]);
    expect(await migrateMemoryEndpointToDefault(fresh, svcOf(fresh))).toBe("none");
    expect(fresh.get(MEMORY_ENDPOINT_ID_KEY)).toBeUndefined();
  });
});

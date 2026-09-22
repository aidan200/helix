/**
 * EmbeddingConfigService 单测（管家记忆 B2 批——fake RuntimeConfig 内存表，
 * 零网络零原生库）。
 *
 * 断言面：
 * 1. CRUD：set 缺省 id 新增（uuid 生成）/ 带 id 更新（name/baseUrl/model 覆盖，
 *    apiKey 空串清除、缺省不动）；delete 按 id；list 全量；
 * 2. 凭据卫生：listView 只回 hasApiKey（apiKey 原值永不出库）+ verifiedAt；
 * 3. verify：ok → verifiedAt 落盘 + 回实测 dim；fail → error 定位信息 +
 *    verifiedAt 不动；
 * 4. resolve：endpointId → EmbeddingEndpointConfig（条目完整才可用；id 不存在
 *    → null）；
 * 5. 一次性迁移：旧 KV steward.memory.embedding（B1 三字段）存在且
 *    embedding_endpoints 为空 → 迁成首条端点（name="默认端点"）+
 *    steward.memory.endpointId 指向 + 清旧键；embedding_endpoints 非空 →
 *    不迁移不清旧键（幂等安全）；旧键不存在 → 零动作。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import {
  EmbeddingConfigService,
  EMBEDDING_ENDPOINTS_KEY,
} from "../../src/application/embedding/EmbeddingConfigService";
import { STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY } from "../../src/application/steward/StewardMemoryService";

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

/** fake 探测端口工厂（可控成功/失败——verify 连通测试面）。 */
function fakeProbeFactory(behavior: { vectors?: number[][]; error?: string } = { vectors: [[0.1, 0.2, 0.3]] }) {
  return (cfg: import("../../src/application/ports/outbound/EmbeddingPort").EmbeddingEndpointConfig): EmbeddingPort => ({
    embed: async (texts) => {
      if (behavior.error !== undefined) throw new Error(behavior.error);
      const vectors = (behavior.vectors ?? [[0.1, 0.2, 0.3]]).map((v) => Float32Array.from(v));
      return { vectors, dim: vectors[0]!.length } satisfies EmbeddingResult;
    },
    endpointLabel: () => `fake @ ${cfg.baseUrl}`,
  });
}

/** noop 判官探测工厂（embedding 域旧用例——构造器必填面兼容，不会被走到）。 */
function noopJudgeProbe(): import("../../src/application/ports/outbound/JudgePort").JudgePort {
  return {
    noul: async () => {
      throw new Error("noop judge：embedding 用例不应走到判官探测");
    },
    endpointLabel: () => "noop-judge",
  };
}

describe("EmbeddingConfigService：端点 CRUD", () => {
  test("set 缺省 id = 新增（uuid 生成 + KV 落盘）", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    const outcome = await svc.set({ name: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "bge-m3" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const raw = JSON.parse(config.get(EMBEDDING_ENDPOINTS_KEY)!) as { id: string; name: string }[];
    expect(raw).toHaveLength(1);
    expect(raw[0]!.name).toBe("Ollama 本地");
    expect(raw[0]!.id).not.toBe("");
  });

  test("set 带 id = 更新（apiKey 空串清除 / 缺省不动）", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    const created = await svc.set({ name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-abc1234567", model: "text-embedding-3-small" });
    if (!created.ok) throw new Error("unreachable");
    // apiKey 缺省 = 不动（凭据只进不出——编辑面无原值可回填）
    const renamed = await svc.set({ id: created.id, name: "OpenAI 云端", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-large" });
    expect(renamed.ok).toBe(true);
    expect(svc.list()).toHaveLength(1);
    const first = svc.list()[0]!;
    expect(first.name).toBe("OpenAI 云端");
    expect(first.apiKey).toBe("sk-abc1234567");
    // apiKey 空串 = 清除
    await svc.set({ id: created.id, name: "OpenAI 云端", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "text-embedding-3-large" });
    expect(svc.list()[0]!.apiKey).toBeUndefined();
  });

  test("set 更新不存在 id → error；空 name/baseUrl/model → error", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    const missing = await svc.set({ id: "ep-nope", name: "x", baseUrl: "http://x/v1", model: "m" });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.error).toContain("不存在");
    const blank = await svc.set({ name: "", baseUrl: "http://x/v1", model: "m" });
    expect(blank.ok).toBe(false);
  });

  test("delete 按 id（不存在 → error）", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    const created = await svc.set({ name: "n", baseUrl: "http://x/v1", model: "m" });
    if (!created.ok) throw new Error("unreachable");
    await svc.delete(created.id);
    expect(svc.list()).toHaveLength(0);
    const missing = await svc.delete(created.id);
    expect(missing.ok).toBe(false);
  });
});

describe("EmbeddingConfigService：凭据卫生与 verify", () => {
  test("listView 只回 hasApiKey/verifiedAt——apiKey 原值不出库", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    await svc.set({ name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-secret", model: "m" });
    const view = svc.listView();
    expect(view).toHaveLength(1);
    expect(view[0]!.hasApiKey).toBe(true);
    expect(view[0]!.keyMasked).toBe("····cret");
    expect(JSON.stringify(view)).not.toContain("sk-secret");
    expect(view[0]!.verifiedAt).toBeNull();
  });

  test("verify ok → verifiedAt 落盘 + 回实测 dim；fail → error 含定位 + verifiedAt 不动", async () => {
    const config = memoryConfig();
    const ok = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory({ vectors: [[1, 2, 3, 4]] }), createJudgeProbe: noopJudgeProbe });
    const created = await ok.set({ name: "n", baseUrl: "http://x/v1", model: "m" });
    if (!created.ok) throw new Error("unreachable");
    const verified = await ok.verify(created.id);
    expect(verified.state).toBe("ok");
    if (verified.state === "ok" && "dim" in verified) expect(verified.dim).toBe(4);
    expect(ok.listView()[0]!.verifiedAt).not.toBeNull();

    const fail = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory({ error: "连接超时" }), createJudgeProbe: noopJudgeProbe });
    const failed = await fail.verify(created.id);
    expect(failed.state).toBe("fail");
    if (failed.state === "fail") expect(failed.error).toContain("连接超时");
    // fail 不改 verifiedAt（上次成功时间保留）
    expect(fail.listView()[0]!.verifiedAt).not.toBeNull();

    const missing = await ok.verify("ep-nope");
    expect(missing.state).toBe("fail");
  });
});

describe("EmbeddingConfigService：resolve + 一次性迁移", () => {
  test("resolve：endpointId → EmbeddingEndpointConfig；条目删除/不存在 → null", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    const created = await svc.set({ name: "n", baseUrl: "http://localhost:11434/v1", apiKey: "k", model: "bge-m3" });
    if (!created.ok) throw new Error("unreachable");
    const resolved = svc.resolve(created.id);
    expect(resolved?.baseUrl).toBe("http://localhost:11434/v1");
    expect(resolved?.model).toBe("bge-m3");
    expect(resolved?.apiKey).toBe("k");
    expect(svc.resolve("ep-nope")).toBeNull();
    await svc.delete(created.id);
    expect(svc.resolve(created.id)).toBeNull();
  });

  test("migrate：旧 steward.memory.embedding 存在且 embedding_endpoints 空 → 迁首条 + endpointId 指向 + 清旧键", async () => {
    const config = memoryConfig({
      [STEWARD_MEMORY_EMBEDDING_KEY]: JSON.stringify({ baseUrl: "http://localhost:11434/v1", apiKey: "legacy-key", model: "bge-m3" }),
    });
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    const migrated = await svc.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY);
    expect(migrated).not.toBeNull();
    if (migrated === null) throw new Error("unreachable");
    const list = svc.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("默认端点");
    expect(list[0]!.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.get(STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBe(migrated);
    expect(config.get(STEWARD_MEMORY_EMBEDDING_KEY)).toBe(""); // 旧键清空（B1 读面空串视同未配置）
  });

  test("migrate：embedding_endpoints 非空 → 不迁移（旧键保留——不破坏既有数据）", async () => {
    const config = memoryConfig({
      [STEWARD_MEMORY_EMBEDDING_KEY]: JSON.stringify({ baseUrl: "http://old/v1", model: "old-m" }),
    });
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    await svc.set({ name: "新端点", baseUrl: "http://new/v1", model: "new-m" });
    expect(await svc.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBeNull();
    expect(svc.list()).toHaveLength(1);
    expect(config.get(STEWARD_MEMORY_EMBEDDING_KEY)).toBeDefined();
  });

  test("migrate：旧键不存在 / 形态非法 → 零动作", async () => {
    const empty = memoryConfig();
    const svcEmpty = new EmbeddingConfigService({ config: empty, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    expect(await svcEmpty.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBeNull();

    const broken = memoryConfig({ [STEWARD_MEMORY_EMBEDDING_KEY]: "not-json{{" });
    const svcBroken = new EmbeddingConfigService({ config: broken, createProbe: fakeProbeFactory(), createJudgeProbe: noopJudgeProbe });
    expect(await svcBroken.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBeNull();
    expect(svcBroken.list()).toHaveLength(0);
  });
});

describe("EmbeddingConfigService：kind 维度（B4a——分类端点）", () => {
  /** fake 判官探测端口工厂（verifyJudge 面——可控概率/失败）。 */
  function fakeJudgeFactory(behavior: { prob?: number; error?: string } = { prob: 0.87 }) {
    return (cfg: import("../../src/application/ports/outbound/EmbeddingPort").EmbeddingEndpointConfig): import("../../src/application/ports/outbound/JudgePort").JudgePort => ({
      noul: async () => {
        if (behavior.error !== undefined) throw new Error(behavior.error);
        return behavior.prob ?? 0.87;
      },
      endpointLabel: () => `judge-fake @ ${cfg.baseUrl}`,
    });
  }

  test("set kind=classifier 新增；list 回 kind；listView 回 kind（存量缺席 = embedding 兼容）", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({
      config,
      createProbe: fakeProbeFactory(),
      createJudgeProbe: fakeJudgeFactory(),
    });
    const emb = await svc.set({ name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "bge-m3" });
    const cls = await svc.set({ name: "Jev", baseUrl: "https://api.typesafe.ai/v1", apiKey: "ts-live-9f2e8c7d5a3b", model: "jev-latest", kind: "classifier" });
    expect(emb.ok).toBe(true);
    expect(cls.ok).toBe(true);
    // 新增缺省 kind = embedding；显式 classifier 落盘
    expect(svc.list()[0]!.kind).toBe("embedding");
    expect(svc.list()[1]!.kind).toBe("classifier");
    // 回执视图同步透出 kind
    expect(svc.listView()[0]!.kind).toBe("embedding");
    expect(svc.listView()[1]!.kind).toBe("classifier");
    expect(svc.listView()[1]!.keyMasked).toBe("····5a3b");
  });

  test("旧 KV 无 kind 字段（存量端点）→ 解析视同 embedding（零迁移兼容）", async () => {
    const config = memoryConfig({
      [EMBEDDING_ENDPOINTS_KEY]: JSON.stringify([
        { id: "ep-old", name: "旧端点", baseUrl: "http://old/v1", model: "old-m", verifiedAt: 1234567890 },
      ]),
    });
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: fakeJudgeFactory() });
    expect(svc.list()[0]!.kind).toBe("embedding");
    expect(svc.listView()[0]!.kind).toBe("embedding");
  });

  test("编辑 kind 缺省不动（与 apiKey 同款——编辑面只改别的字段不丢 kind）；显式传 kind 覆盖", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory(), createJudgeProbe: fakeJudgeFactory() });
    const created = await svc.set({ name: "Jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier" });
    if (!created.ok) throw new Error("unreachable");
    // 只改名：kind 缺省 → 保留 classifier
    await svc.set({ id: created.id, name: "Jev 云端", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest" });
    expect(svc.list()[0]!.kind).toBe("classifier");
    // 显式改回 embedding
    await svc.set({ id: created.id, name: "Jev 云端", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "embedding" });
    expect(svc.list()[0]!.kind).toBe("embedding");
  });

  test("verify 分叉：classifier 端点走 judge 探测（noul 概率回执），embedding 走向量探测", async () => {
    const config = memoryConfig();
    let judgeCalls = 0;
    let embedCalls = 0;
    const svc = new EmbeddingConfigService({
      config,
      createProbe: () => ({
        embed: async () => {
          embedCalls += 1;
          return { vectors: [Float32Array.from([1, 2, 3])], dim: 3 } satisfies EmbeddingResult;
        },
        endpointLabel: () => "emb-fake",
      }),
      createJudgeProbe: () => ({
        noul: async () => {
          judgeCalls += 1;
          return 0.87;
        },
        endpointLabel: () => "judge-fake",
      }),
    });
    const emb = await svc.set({ name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "bge-m3" });
    const cls = await svc.set({ name: "Jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier" });
    if (!emb.ok || !cls.ok) throw new Error("unreachable");

    const embVerified = await svc.verify(emb.id);
    expect(embVerified.state).toBe("ok");
    if (embVerified.state === "ok" && "dim" in embVerified) expect(embVerified.dim).toBe(3);
    expect(judgeCalls).toBe(0);

    const clsVerified = await svc.verify(cls.id);
    expect(clsVerified.state).toBe("ok");
    if (clsVerified.state === "ok" && "prob" in clsVerified) expect(clsVerified.prob).toBeCloseTo(0.87);
    expect(embedCalls).toBe(1); // 只有 embedding 端点用了向量探测
    expect(svc.listView().find((r) => r.id === cls.id)!.verifiedAt).not.toBeNull();
  });

  test("verify classifier fail → error 定位 + verifiedAt 不动", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({
      config,
      createProbe: fakeProbeFactory(),
      createJudgeProbe: fakeJudgeFactory({ error: "401 unauthorized" }),
    });
    const created = await svc.set({ name: "Jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier" });
    if (!created.ok) throw new Error("unreachable");
    const outcome = await svc.verify(created.id);
    expect(outcome.state).toBe("fail");
    if (outcome.state === "fail") expect(outcome.error).toContain("401");
    expect(svc.listView()[0]!.verifiedAt).toBeNull();
  });
});

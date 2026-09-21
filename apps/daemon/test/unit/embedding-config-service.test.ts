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

describe("EmbeddingConfigService：端点 CRUD", () => {
  test("set 缺省 id = 新增（uuid 生成 + KV 落盘）", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
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
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
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
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
    const missing = await svc.set({ id: "ep-nope", name: "x", baseUrl: "http://x/v1", model: "m" });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.error).toContain("不存在");
    const blank = await svc.set({ name: "", baseUrl: "http://x/v1", model: "m" });
    expect(blank.ok).toBe(false);
  });

  test("delete 按 id（不存在 → error）", async () => {
    const config = memoryConfig();
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
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
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
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
    const ok = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory({ vectors: [[1, 2, 3, 4]] }) });
    const created = await ok.set({ name: "n", baseUrl: "http://x/v1", model: "m" });
    if (!created.ok) throw new Error("unreachable");
    const verified = await ok.verify(created.id);
    expect(verified.state).toBe("ok");
    if (verified.state === "ok") expect(verified.dim).toBe(4);
    expect(ok.listView()[0]!.verifiedAt).not.toBeNull();

    const fail = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory({ error: "连接超时" }) });
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
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
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
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
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
    const svc = new EmbeddingConfigService({ config, createProbe: fakeProbeFactory() });
    await svc.set({ name: "新端点", baseUrl: "http://new/v1", model: "new-m" });
    expect(await svc.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBeNull();
    expect(svc.list()).toHaveLength(1);
    expect(config.get(STEWARD_MEMORY_EMBEDDING_KEY)).toBeDefined();
  });

  test("migrate：旧键不存在 / 形态非法 → 零动作", async () => {
    const empty = memoryConfig();
    const svcEmpty = new EmbeddingConfigService({ config: empty, createProbe: fakeProbeFactory() });
    expect(await svcEmpty.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBeNull();

    const broken = memoryConfig({ [STEWARD_MEMORY_EMBEDDING_KEY]: "not-json{{" });
    const svcBroken = new EmbeddingConfigService({ config: broken, createProbe: fakeProbeFactory() });
    expect(await svcBroken.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBeNull();
    expect(svcBroken.list()).toHaveLength(0);
  });
});

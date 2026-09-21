/**
 * StewardMemoryService 单测（管家记忆 B1 批——fake embedding + fake store，
 * 零网络零原生库）。
 *
 * 断言面：
 * 1. 召回注入：query 嵌入 → topK → system prompt 记忆段文本（kind 中文标注
 *    + 参考性声明）；空命中 → undefined；
 * 2. 降级三面：开关关 / 端点未配 / 存储缺席 → recall undefined 零 embed
 *    调用；embed 抛错 → undefined + warn（召回绝不挡对话）；
 * 3. 写入：remember → embed → append（kind/source/createdAt/vector 全字段）；
 *    不可用 → 抛错（写路径不静默）；
 * 4. 维度切换重建：storedDim ≠ embed dim → resetVectors + 全量条目分批
 *    重嵌入回填（换模型零数据损失）；
 * 5. 配置写面：开启前端点必填校验 / 端点三字段 KV 持久化 / apiKey 空串清除；
 * 6. 凭据卫生：getMemoryState 只回 hasApiKey（apiKey 永不出库）。
 */
import { describe, expect, test } from "bun:test";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type {
  StewardMemoryAppendItem,
  StewardMemoryEntry,
  StewardMemoryHit,
  StewardMemoryPort,
} from "../../src/application/ports/outbound/StewardMemoryPort";
import {
  StewardMemoryService,
  STEWARD_MEMORY_ENABLED_KEY,
  STEWARD_MEMORY_EMBEDDING_KEY,
  STEWARD_MEMORY_RECALL_TOP_K,
} from "../../src/application/steward/StewardMemoryService";

const ENDPOINT = JSON.stringify({ baseUrl: "http://localhost:11434/v1", apiKey: "sk-x", model: "bge-m3" });

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key) => kv.get(key),
    set: async (key, value) => {
      kv.set(key, value);
    },
  };
}

function fakeEmbedding(dim = 3, fail = false): EmbeddingPort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      calls.push([...texts]);
      if (fail) throw new Error("端点不可达");
      return {
        vectors: texts.map((_, i) => Float32Array.from({ length: dim }, (_v, j) => 0.1 * (i + j + 1))),
        dim,
      };
    },
  };
}

function fakeStore(dim: number | null = 3): StewardMemoryPort & {
  appended: StewardMemoryAppendItem[];
  resets: number[];
  puts: { id: number }[];
  entries: StewardMemoryEntry[];
} {
  const state = {
    appended: [] as StewardMemoryAppendItem[],
    resets: [] as number[],
    puts: [] as { id: number }[],
    entries: [] as StewardMemoryEntry[],
    dim,
  };
  return {
    ...state,
    append(items) {
      state.appended.push(...items);
      for (const item of items) {
        state.entries.push({
          id: state.entries.length + 1,
          kind: item.kind,
          text: item.text,
          source: item.source,
          createdAt: item.createdAt,
        });
      }
    },
    search(query, topK): readonly StewardMemoryHit[] {
      return state.entries.slice(0, topK).map((e) => ({ ...e, score: 0.9 }));
    },
    list: () => state.entries,
    forget: (id) => {
      const before = state.entries.length;
      state.entries = state.entries.filter((e) => e.id !== id);
      return state.entries.length < before;
    },
    count: () => state.entries.length,
    storedDim: () => state.dim,
    resetVectors(newDim) {
      state.resets.push(newDim);
      state.dim = newDim;
    },
    putVector(id) {
      state.puts.push({ id });
    },
    close: () => {},
  };
}

const ENABLED_KV = {
  [STEWARD_MEMORY_ENABLED_KEY]: "1",
  [STEWARD_MEMORY_EMBEDDING_KEY]: ENDPOINT,
};

describe("StewardMemoryService", () => {
  test("① 召回注入：记忆段文本（kind 中文标注 + 参考性声明）；空命中 → undefined", async () => {
    const store = fakeStore();
    store.entries.push({ id: 1, kind: "preference", text: "回复要简洁", source: "s", createdAt: 1 });
    store.entries.push({ id: 2, kind: "fact", text: "项目在 helix 仓", source: "s", createdAt: 2 });
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      store,
    });
    const section = await svc.recallSection("怎么改代码风格");
    expect(section).toContain("## 长期记忆");
    expect(section).toContain("[偏好] 回复要简洁");
    expect(section).toContain("[事实] 项目在 helix 仓");
    expect(section).toContain("以本轮指令为准");
    // 空命中 → undefined（无记忆段）
    const empty = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      store: fakeStore(),
    });
    expect(await empty.recallSection("x")).toBeUndefined();
  });

  test("② 降级三面 + embed 失败静默（recall 绝不挡对话）", async () => {
    const embedding = fakeEmbedding();
    // 开关关
    const off = new StewardMemoryService({ config: fakeConfig({ [STEWARD_MEMORY_EMBEDDING_KEY]: ENDPOINT }), embedding, store: fakeStore() });
    expect(await off.recallSection("x")).toBeUndefined();
    // 端点未配
    const noCfg = new StewardMemoryService({ config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1" }), embedding, store: fakeStore() });
    expect(await noCfg.recallSection("x")).toBeUndefined();
    // 存储缺席
    const noStore = new StewardMemoryService({ config: fakeConfig(ENABLED_KV), embedding });
    expect(await noStore.recallSection("x")).toBeUndefined();
    expect(embedding.calls.length).toBe(0); // 降级路径零 embed 调用
    // embed 抛错 → undefined + warn
    const warns: string[] = [];
    const failing = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(3, true),
      store: fakeStore(),
      logger: { warn: (m) => warns.push(m) },
    });
    expect(await failing.recallSection("x")).toBeUndefined();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("降级");
  });

  test("③ 写入：remember 全字段 append；不可用 → 抛错（写路径不静默）", async () => {
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      store,
      clock: () => 42000,
    });
    const { id } = await svc.remember("用户偏好简洁回复", "preference", "steward-turn");
    expect(id).toBe(1);
    expect(store.appended.length).toBe(1);
    expect(store.appended[0]!.kind).toBe("preference");
    expect(store.appended[0]!.text).toBe("用户偏好简洁回复");
    expect(store.appended[0]!.source).toBe("steward-turn");
    expect(store.appended[0]!.createdAt).toBe(42000);
    expect(store.appended[0]!.vector.length).toBe(3);
    // 不可用 → 抛错
    const off = new StewardMemoryService({ config: fakeConfig(), embedding: fakeEmbedding(), store: fakeStore() });
    await expect(off.remember("x", "fact", "s")).rejects.toThrow("未启用");
  });

  test("④ 维度切换重建：resetVectors + 全量条目重嵌入回填", async () => {
    const store = fakeStore(3);
    store.entries.push({ id: 7, kind: "fact", text: "旧条目甲", source: "s", createdAt: 1 });
    store.entries.push({ id: 8, kind: "fact", text: "旧条目乙", source: "s", createdAt: 2 });
    const embedding = fakeEmbedding(4); // 新模型 4 维
    const svc = new StewardMemoryService({ config: fakeConfig(ENABLED_KV), embedding, store });
    await svc.remember("新条目", "fact", "steward-turn");
    expect(store.resets).toEqual([4]); // 维度切换触发一次重建
    // 两条旧条目重嵌入回填（一次批量调用）+ 新条目 append
    expect(store.puts.map((p) => p.id).sort()).toEqual([7, 8]);
    expect(embedding.calls.some((c) => c.join() === "旧条目甲,旧条目乙")).toBe(true);
  });

  test("⑤ 配置写面：开启前端点必填 / 端点持久化 / apiKey 空串清除", async () => {
    const config = fakeConfig();
    const svc = new StewardMemoryService({ config, embedding: fakeEmbedding(), store: fakeStore() });
    // 开启前端点必填
    const denied = await svc.setMemoryConfig({ enabled: true });
    expect(denied.ok).toBe(false);
    // 端点三字段持久化
    const ok = await svc.setMemoryConfig({ baseUrl: "http://localhost:11434/v1", model: "bge-m3", apiKey: "sk-1" });
    expect(ok.ok).toBe(true);
    expect(JSON.parse(config.kv.get(STEWARD_MEMORY_EMBEDDING_KEY)!)).toEqual({
      baseUrl: "http://localhost:11434/v1",
      model: "bge-m3",
      apiKey: "sk-1",
    });
    // 开启（端点已配 → 放行）
    expect((await svc.setMemoryConfig({ enabled: true })).ok).toBe(true);
    expect(config.kv.get(STEWARD_MEMORY_ENABLED_KEY)).toBe("1");
    // apiKey 空串清除（本地免 key 端点）
    await svc.setMemoryConfig({ apiKey: "" });
    expect(JSON.parse(config.kv.get(STEWARD_MEMORY_EMBEDDING_KEY)!).apiKey).toBeUndefined();
  });

  test("⑥ 凭据卫生：getMemoryState 只回 hasApiKey（apiKey 不出库）", () => {
    const svc = new StewardMemoryService({ config: fakeConfig(ENABLED_KV), embedding: fakeEmbedding(), store: fakeStore() });
    const state = svc.getMemoryState();
    expect(state.available).toBe(true);
    expect(state.endpoint!.hasApiKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain("sk-x");
    expect(state.dim).toBe(3);
    expect(state.entryCount).toBe(0);
  });
});

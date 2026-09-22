/**
 * StewardMemoryService 单测（管家记忆 B1 批落地 + B2 配置域化改造——
 * fake embedding + fake store + fake 配置域查询面，零网络零原生库）。
 *
 * 断言面：
 * 1. 召回注入：query 嵌入 → topK → system prompt 记忆段文本（kind 中文标注
 *    + 参考性声明）；空命中 → undefined；
 * 2. 降级四面（B2）：开关关 / endpointId 未设 / endpointId 悬空（条目已删）/
 *    存储缺席 → recall undefined 零 embed 调用；embed 抛错 → undefined +
 *    warn（召回绝不挡对话）；
 * 3. 写入：remember → embed → append（kind/source/createdAt/vector 全字段）；
 *    不可用 → 抛错（写路径不静默）；
 * 4. 维度切换重建：storedDim ≠ embed dim → resetVectors + 全量条目分批
 *    重嵌入回填（换模型零数据损失）；
 * 5. 配置写面（B2）：开关 + endpointId 引用（空串 = 清除）；先开后配合法
 *    （引用悬空自然降级待命）；
 * 6. 凭据卫生（B2 引用态）：getMemoryState 只回 id/name/model/hasApiKey
 *    （apiKey/baseUrl 永不出库）；
 * 7. 条目管理三面（B2 命令路径）：appendMemoryEntry（manual 来源 + kind
 *    缺省 fact）/ updateMemoryEntry（重嵌重写）/ forgetEntry。
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
import type { EmbeddingEndpointRecord } from "../../src/application/embedding/EmbeddingConfigService";
import {
  StewardMemoryService,
  STEWARD_MEMORY_ENABLED_KEY,
  STEWARD_MEMORY_ENDPOINT_ID_KEY,
  STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY,
  STEWARD_MEMORY_RECALL_TOP_K,
  STEWARD_MEMORY_DEDUP_THRESHOLD,
  STEWARD_MEMORY_RECALL_MIN_SCORE,
  type EmbeddingConfigLookup,
} from "../../src/application/steward/StewardMemoryService";

const EP_ID = "ep-bge";
const ENDPOINT_RECORD: EmbeddingEndpointRecord = {
  id: EP_ID,
  name: "Ollama 本地",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "sk-x",
  model: "bge-m3",
};

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

/** 配置域查询面 fake（可撤条目——悬空引用测试面）。 */
function fakeLookup(record: EmbeddingEndpointRecord | null = ENDPOINT_RECORD): EmbeddingConfigLookup & { drop(): void } {
  let current = record;
  return {
    resolveRecord: (endpointId) => (current !== null && current.id === endpointId ? current : null),
    drop: () => {
      current = null;
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
  updated: { id: number; text: string }[];
} {
  const state = {
    appended: [] as StewardMemoryAppendItem[],
    resets: [] as number[],
    puts: [] as { id: number }[],
    entries: [] as StewardMemoryEntry[],
    updated: [] as { id: number; text: string }[],
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
    updateEntry(id, text) {
      state.updated.push({ id, text });
      if (!state.entries.some((e) => e.id === id)) return false;
      state.entries = state.entries.map((e) => (e.id === id ? { ...e, text } : e));
      return true;
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
  [STEWARD_MEMORY_ENDPOINT_ID_KEY]: EP_ID,
};

describe("StewardMemoryService", () => {
  test("① 召回注入：记忆段文本（kind 中文标注 + 参考性声明）；空命中 → undefined", async () => {
    const store = fakeStore();
    store.entries.push({ id: 1, kind: "preference", text: "回复要简洁", source: "s", createdAt: 1 });
    store.entries.push({ id: 2, kind: "fact", text: "项目在 helix 仓", source: "s", createdAt: 2 });
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
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
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    expect(await empty.recallSection("x")).toBeUndefined();
  });

  test("② 降级四面（B2）+ embed 失败静默（recall 绝不挡对话）", async () => {
    const embedding = fakeEmbedding();
    // 开关关
    const off = new StewardMemoryService({
      config: fakeConfig({ [STEWARD_MEMORY_ENDPOINT_ID_KEY]: EP_ID }),
      embedding,
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    expect(await off.recallSection("x")).toBeUndefined();
    // endpointId 未设
    const noRef = new StewardMemoryService({
      config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1" }),
      embedding,
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    expect(await noRef.recallSection("x")).toBeUndefined();
    // endpointId 悬空（引用的条目已删——B2 引用态降级面）
    const lookup = fakeLookup();
    const dangling = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding,
      embeddingConfig: lookup,
      store: fakeStore(),
    });
    lookup.drop();
    expect(dangling.getMemoryState().available).toBe(false);
    expect(await dangling.recallSection("x")).toBeUndefined();
    // 存储缺席
    const noStore = new StewardMemoryService({ config: fakeConfig(ENABLED_KV), embedding, embeddingConfig: fakeLookup() });
    expect(await noStore.recallSection("x")).toBeUndefined();
    expect(embedding.calls.length).toBe(0); // 降级路径零 embed 调用
    // embed 抛错 → undefined + warn
    const warns: string[] = [];
    const failing = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(3, true),
      embeddingConfig: fakeLookup(),
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
      embeddingConfig: fakeLookup(),
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
    const off = new StewardMemoryService({ config: fakeConfig(), embedding: fakeEmbedding(), embeddingConfig: fakeLookup(), store: fakeStore() });
    await expect(off.remember("x", "fact", "s")).rejects.toThrow("未启用");
  });

  test("④ 维度切换重建：resetVectors + 全量条目重嵌入回填", async () => {
    const store = fakeStore(3);
    store.entries.push({ id: 7, kind: "fact", text: "旧条目甲", source: "s", createdAt: 1 });
    store.entries.push({ id: 8, kind: "fact", text: "旧条目乙", source: "s", createdAt: 2 });
    const embedding = fakeEmbedding(4); // 新模型 4 维
    const svc = new StewardMemoryService({ config: fakeConfig(ENABLED_KV), embedding, embeddingConfig: fakeLookup(), store });
    await svc.remember("新条目", "fact", "steward-turn");
    expect(store.resets).toEqual([4]); // 维度切换触发一次重建
    // 两条旧条目重嵌入回填（一次批量调用）+ 新条目 append
    expect(store.puts.map((p) => p.id).sort()).toEqual([7, 8]);
    expect(embedding.calls.some((c) => c.join() === "旧条目甲,旧条目乙")).toBe(true);
  });

  test("⑤ 配置写面（B2）：开关 + endpointId 引用（空串 = 清除）；先开后配合法", async () => {
    const config = fakeConfig();
    const svc = new StewardMemoryService({ config, embedding: fakeEmbedding(), embeddingConfig: fakeLookup(), store: fakeStore() });
    // 先开开关（endpointId 未配）——写面放行，可用性待命
    const turnedOn = await svc.setMemoryConfig({ enabled: true });
    expect(turnedOn.ok).toBe(true);
    expect(config.kv.get(STEWARD_MEMORY_ENABLED_KEY)).toBe("1");
    expect(svc.getMemoryState().available).toBe(false); // 待命：引用未配
    // endpointId 补齐 → 自动生效（available 翻真）
    const ok = await svc.setMemoryConfig({ endpointId: EP_ID });
    expect(ok.ok).toBe(true);
    expect(config.kv.get(STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBe(EP_ID);
    expect(svc.getMemoryState().available).toBe(true);
    // 空串 = 清除引用（显式解绑）
    await svc.setMemoryConfig({ endpointId: "" });
    expect(config.kv.get(STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBe("");
    expect(svc.getMemoryState().available).toBe(false);
  });

  test("⑥ 凭据卫生（B2 引用态）：getMemoryState 只回 id/name/model/hasApiKey", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    const state = svc.getMemoryState();
    expect(state.available).toBe(true);
    expect(state.endpoint!.id).toBe(EP_ID);
    expect(state.endpoint!.name).toBe("Ollama 本地");
    expect(state.endpoint!.model).toBe("bge-m3");
    expect(state.endpoint!.hasApiKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain("sk-x");
    expect(JSON.stringify(state)).not.toContain("baseUrl");
    expect(state.dim).toBe(3);
    expect(state.entryCount).toBe(0);
  });

  test("⑦ 条目管理三面（B2 命令路径）：append manual / update 重嵌 / forget", async () => {
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => 1000,
    });
    // append：source=manual + kind 缺省 fact
    const appended = await svc.appendMemoryEntry("手动记一条");
    expect(appended.ok).toBe(true);
    expect(store.appended[0]!.source).toBe("manual");
    expect(store.appended[0]!.kind).toBe("fact");
    const pref = await svc.appendMemoryEntry("偏好简洁", "preference");
    expect(pref.ok).toBe(true);
    expect(store.appended[1]!.kind).toBe("preference");
    // append 空文本 → error outcome（不抛——命令回执 error 判别）
    const blank = await svc.appendMemoryEntry("  ");
    expect(blank.ok).toBe(false);
    // update：重嵌 + 文本重写
    const updated = await svc.updateMemoryEntry(1, "手动记一条（改）");
    expect(updated.ok).toBe(true);
    expect(store.updated).toEqual([{ id: 1, text: "手动记一条（改）" }]);
    // fake 的 entries 是展开快照引用——读面经 listEntries()（list 读最新 state）
    expect(svc.listEntries()[0]!.text).toBe("手动记一条（改）");
    // update 不存在 id / 空文本 → error
    expect((await svc.updateMemoryEntry(99, "x")).ok).toBe(false);
    expect((await svc.updateMemoryEntry(1, "")).ok).toBe(false);
    // forget
    expect(svc.forgetEntry(1)).toBe(true);
    expect(svc.forgetEntry(1)).toBe(false);
    expect(svc.listEntries()).toHaveLength(1);
    // 不可用（开关关）→ append/update error outcome
    const disabled = new StewardMemoryService({ config: fakeConfig(), embedding: fakeEmbedding(), embeddingConfig: fakeLookup(), store: fakeStore() });
    expect((await disabled.appendMemoryEntry("x")).ok).toBe(false);
    expect((await disabled.updateMemoryEntry(1, "x")).ok).toBe(false);
  });
});

describe("StewardMemoryService B3：写入去重 + 召回阈值", () => {
  /** B3 专用 fake：search 分数可控（去重/阈值判定素材）。 */
  function scoreStore(topScore: number): StewardMemoryPort & { appended: StewardMemoryAppendItem[]; updated: { id: number; text: string }[] } {
    const entries: StewardMemoryEntry[] = [
      { id: 7, kind: "preference", text: "回复要简洁", source: "steward-turn", createdAt: 1000 },
    ];
    const appended: StewardMemoryAppendItem[] = [];
    const updated: { id: number; text: string }[] = [];
    return {
      appended,
      updated,
      append(items) {
        appended.push(...items);
        entries.push({ id: 8, kind: items[0]!.kind, text: items[0]!.text, source: items[0]!.source, createdAt: items[0]!.createdAt });
      },
      search: () => [{ ...entries[0]!, score: topScore }],
      list: () => entries,
      forget: () => true,
      updateEntry(id, text) {
        updated.push({ id, text });
        return true;
      },
      count: () => entries.length,
      storedDim: () => 3,
      resetVectors: () => {},
      putVector: () => {},
      close: () => {},
    };
  }

  function b3Service(topScore: number) {
    return new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(3),
      embeddingConfig: fakeLookup(),
      store: scoreStore(topScore),
    });
  }

  test("⑧ 写入去重：top1 ≥ 阈值 → updateEntry 覆盖（append 零调用），返回 updated:true", async () => {
    const svc = b3Service(0.95);
    const saved = await svc.remember("回复务必简短", "preference", "steward-turn");
    expect(saved).toEqual({ id: 7, updated: true });
  });

  test("⑨ 非重复：top1 < 阈值 → append 正常路径，updated:false", async () => {
    const svc = b3Service(0.5);
    const saved = await svc.remember("项目在 helix 仓", "fact", "steward-turn");
    expect(saved.updated).toBe(false);
  });

  test("⑩ 边界：score 恰等于 DEDUP_THRESHOLD → 判重覆盖", async () => {
    const svc = b3Service(STEWARD_MEMORY_DEDUP_THRESHOLD);
    const saved = await svc.remember("回复要简洁明了", "preference", "steward-turn");
    expect(saved.updated).toBe(true);
  });

  test("⑪ 召回阈值：score ≥ RECALL_MIN_SCORE 达标注入；全低于 → undefined", async () => {
    const ok = await b3Service(0.8).recallSection("随便什么");
    expect(ok).toContain("回复要简洁");
    const filtered = await b3Service(STEWARD_MEMORY_RECALL_MIN_SCORE - 0.01).recallSection("随便什么");
    expect(filtered).toBeUndefined();
  });
});

// ── 管家记忆 B4a：判官面（judgeEndpointId 引用 + kind 校验 + 判定调用面）─────

describe("管家记忆 B4a：判官面（judgeEndpointId 引用 + kind 校验）", () => {
  const JUDGE_RECORD: EmbeddingEndpointRecord = {
    id: "ep-jev",
    name: "Jev",
    baseUrl: "https://api.typesafe.ai/v1",
    apiKey: "sk-judge",
    model: "jev-latest",
    kind: "classifier",
  };

  function fakeJudge(probability = 0.8, fail = false) {
    const calls: { state: string; question: string }[] = [];
    return {
      calls,
      endpointLabel: () => "fake-judge",
      async noul(state: string, question: string): Promise<number> {
        calls.push({ state, question });
        if (fail) throw new Error("判官 HTTP 500");
        return probability;
      },
    };
  }

  function judgeLookup(): EmbeddingConfigLookup {
    return {
      resolveRecord: (endpointId) => {
        if (endpointId === JUDGE_RECORD.id) return JUDGE_RECORD;
        if (endpointId === ENDPOINT_RECORD.id) return ENDPOINT_RECORD;
        return null;
      },
    };
  }

  test("① 判官可用性：enabled ∧ judgeEndpointId 有效(classifier) ∧ judge port 注入 → true", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1", [STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(),
    });
    expect(svc.judgeSedimentAvailable()).toBe(true);
  });

  test("② kind 校验：judgeEndpointId 指向 kind=embedding（kind 缺席同判）端点 → 不可用", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1", [STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: ENDPOINT_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(),
    });
    expect(svc.judgeSedimentAvailable()).toBe(false);
  });

  test("③ 降级三面：开关关 / judgeEndpointId 未设 / judge port 缺席 → 静默不可用", () => {
    const base = { embedding: fakeEmbedding(3), embeddingConfig: judgeLookup(), judge: fakeJudge() };
    expect(new StewardMemoryService({ ...base, config: fakeConfig({ [STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }) }).judgeSedimentAvailable()).toBe(false);
    expect(new StewardMemoryService({ ...base, config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1" }) }).judgeSedimentAvailable()).toBe(false);
    const noJudge = new StewardMemoryService({
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1", [STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
    });
    expect(noJudge.judgeSedimentAvailable()).toBe(false);
  });

  test("④ judgeSediment：透传 state/question 返校准概率；判官抛错原样上抛", async () => {
    const judge = fakeJudge(0.7);
    const svc = new StewardMemoryService({
      config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1", [STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge,
    });
    expect(await svc.judgeSediment("用户：以后别用 bun test", "值得长期记忆吗？")).toBe(0.7);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toContain("bun test");
    const failing = new StewardMemoryService({
      config: fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1", [STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(0.5, true),
    });
    await expect(failing.judgeSediment("x", "y")).rejects.toThrow("判官 HTTP 500");
  });

  test("⑤ 配置写面：judgeEndpointId 可选更新（空串 = 清除引用）；getMemoryState 判官引用态凭据卫生", async () => {
    const config = fakeConfig({ [STEWARD_MEMORY_ENABLED_KEY]: "1" });
    const svc = new StewardMemoryService({
      config,
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(),
    });
    await svc.setMemoryConfig({ judgeEndpointId: JUDGE_RECORD.id });
    expect(config.kv.get(STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY)).toBe(JUDGE_RECORD.id);
    const state = svc.getMemoryState();
    expect(state.judgeEndpoint).toEqual({ id: JUDGE_RECORD.id, name: "Jev", model: "jev-latest", hasApiKey: true });
    expect(state.judgeEndpoint !== null && "baseUrl" in state.judgeEndpoint).toBe(false);
    await svc.setMemoryConfig({ judgeEndpointId: "" });
    expect(svc.getMemoryState().judgeEndpoint).toBeNull();
    expect(svc.judgeSedimentAvailable()).toBe(false);
  });
});

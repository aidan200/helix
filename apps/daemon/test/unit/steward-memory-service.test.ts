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
  STEWARD_MEMORY_DEDUP_RECALL_THRESHOLD,
  STEWARD_MEMORY_DEDUP_FALLBACK_THRESHOLD,
  STEWARD_MEMORY_SAME_THRESHOLD,
  STEWARD_MEMORY_RECALL_MIN_SCORE,
  STEWARD_MEMORY_SOFT_CAP,
  memoryStrength,
  pickFadeCandidates,
  pickPurgeCandidates,
  type EmbeddingConfigLookup,
} from "../../src/application/steward/StewardMemoryService";
import {
  MEMORY_ENABLED_KEY,
  MEMORY_ENDPOINT_ID_KEY,
  MEMORY_JUDGE_ENDPOINT_ID_KEY,
  MEMORY_RECALL_MIN_SCORE_KEY,
  MEMORY_RECALL_TOP_K_KEY,
} from "../../src/application/memory/memoryConfig";

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

/** 配置域查询面 fake（可撤条目——悬空引用测试面；批1：resolveDefault =
 *  全局默认端点单点——record 在场即视为默认在场）。 */
function fakeLookup(record: EmbeddingEndpointRecord | null = ENDPOINT_RECORD): EmbeddingConfigLookup & { drop(): void } {
  let current = record;
  return {
    resolveRecord: (endpointId) => (current !== null && current.id === endpointId ? current : null),
    resolveDefault: () =>
      current === null
        ? null
        : { baseUrl: current.baseUrl, model: current.model, ...(current.apiKey !== undefined ? { apiKey: current.apiKey } : {}) },
    resolveDefaultClassifierRecord: () => null,
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

/** 遗忘机制批内联构造糖：补缺省生命周期字段（显式携带位覆盖缺省）。 */
function life(
  e: Pick<StewardMemoryEntry, "id" | "kind" | "text" | "source" | "createdAt" | "updatedAt"> & Partial<StewardMemoryEntry>,
): StewardMemoryEntry {
  return { lastRecalledAt: e.updatedAt, recallCount: 0, fadedAt: 0, pinned: false, ...e };
}

function fakeStore(dim: number | null = 3): StewardMemoryPort & {
  appended: StewardMemoryAppendItem[];
  resets: number[];
  puts: { id: number }[];
  entries: StewardMemoryEntry[];
  updated: { id: number; text: string }[];
  recalled: { ids: number[]; at: number }[];
  fades: number[];
  pins: { id: number; pinned: boolean }[];
  restores: number[];
} {
  const state = {
    appended: [] as StewardMemoryAppendItem[],
    resets: [] as number[],
    puts: [] as { id: number }[],
    entries: [] as StewardMemoryEntry[],
    updated: [] as { id: number; text: string }[],
    recalled: [] as { ids: number[]; at: number }[],
    fades: [] as number[],
    pins: [] as { id: number; pinned: boolean }[],
    restores: [] as number[],
    dim,
  };
  return {
    ...state,
    append(items) {
      state.appended.push(...items);
      const ids: number[] = [];
      for (const item of items) {
        const id = state.entries.length + 1;
        ids.push(id);
        // 遗忘机制批：新条目满强度起步（与真 store 同口径——last_recalled_at = createdAt）
        state.entries.push(
          life({ id, kind: item.kind, text: item.text, source: item.source, createdAt: item.createdAt, updatedAt: item.createdAt }),
        );
      }
      return ids;
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
    findProgressId(sessionId: string): number | null {
      const hit = state.entries.find((e) => e.kind === "progress" && e.sessionId === sessionId);
      return hit !== undefined ? hit.id : null;
    },
    markRecalled(ids, at) {
      state.recalled.push({ ids: [...ids], at });
      const hit = new Set(ids);
      state.entries = state.entries.map((e) => (hit.has(e.id) ? { ...e, lastRecalledAt: at, recallCount: e.recallCount + 1 } : e));
    },
    setPinned(id, pinned, at) {
      if (!state.entries.some((e) => e.id === id)) return false;
      state.pins.push({ id, pinned });
      state.entries = state.entries.map((e) =>
        e.id === id ? (pinned ? { ...e, pinned: true, fadedAt: 0, updatedAt: at } : { ...e, pinned: false }) : e,
      );
      return true;
    },
    restore(id, at) {
      if (!state.entries.some((e) => e.id === id && e.fadedAt !== 0)) return false;
      state.restores.push(id);
      state.entries = state.entries.map((e) => (e.id === id ? { ...e, fadedAt: 0, updatedAt: at } : e));
      return true;
    },
    fadeMany(ids, at) {
      const hit = new Set(ids);
      state.fades.push(...ids);
      state.entries = state.entries.map((e) => (hit.has(e.id) && e.fadedAt === 0 ? { ...e, fadedAt: at } : e));
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
  [MEMORY_ENABLED_KEY]: "1",
  [MEMORY_ENDPOINT_ID_KEY]: EP_ID,
};

// ── 文件级判官 helper（B5 两段闸段与 B4a 判官面段共用）────────────────────

const JUDGE_RECORD_TOP: EmbeddingEndpointRecord = {
  id: "ep-jev",
  name: "Jev",
  baseUrl: "https://api.typesafe.ai/v1",
  apiKey: "sk-judge",
  model: "jev-latest",
  kind: "classifier",
};

function fakeJudgeTop(probability = 0.8, fail = false) {
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
      if (endpointId === "ep-jev") return JUDGE_RECORD_TOP;
      if (endpointId === EP_ID) return { id: EP_ID, name: "Ollama", baseUrl: "http://localhost:11434", model: "bge-m3" };
      return null;
    },
    resolveDefault: () => ({ baseUrl: "http://localhost:11434", model: "bge-m3" }),
    resolveDefaultClassifierRecord: () => null,
  };
}

describe("StewardMemoryService", () => {
  test("① 召回注入：记忆段文本（kind 中文标注 + 参考性声明）；空命中 → undefined", async () => {
    const store = fakeStore();
    store.entries.push(life({ id: 1, kind: "preference", text: "回复要简洁", source: "s", createdAt: 1, updatedAt: 1 }));
    store.entries.push(life({ id: 2, kind: "fact", text: "项目在 helix 仓", source: "s", createdAt: 2, updatedAt: 2 }));
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
      config: fakeConfig({ [MEMORY_ENDPOINT_ID_KEY]: EP_ID }),
      embedding,
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    expect(await off.recallSection("x")).toBeUndefined();
    // 默认端点未设（批1：向量端点取用走 resolveDefault——null = 向量面不可用）
    const noRef = new StewardMemoryService({
      config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1" }),
      embedding,
      embeddingConfig: fakeLookup(null),
      store: fakeStore(),
    });
    expect(await noRef.recallSection("x")).toBeUndefined();
    // 默认端点悬空（引用的条目已删——引用态降级面）
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

  test("③b remember 回执 id 取 append 返回的新 id（时钟回拨下尾元素推断错 id）", async () => {
    // 真库 list() = ORDER BY created_at ASC：时钟回拨（或同毫秒并列写入）时
    // 新条目不在尾位——旧实现以 list() 尾元素推断 id，回执与 memory_written
    // 通知会指向别的条目。fake 对齐真库口径：append 返回新 id，list 按
    // created_at 升序。
    let clockNow = 5_000;
    const entries: StewardMemoryEntry[] = [
      life({ id: 42, kind: "fact", text: "存量条目", source: "steward-turn", createdAt: 5_000, updatedAt: 5_000 }),
    ];
    let nextId = 43;
    const appended: StewardMemoryAppendItem[] = [];
    const store: StewardMemoryPort = {
      append(items) {
        appended.push(...items);
        const ids: number[] = [];
        for (const item of items) {
          ids.push(nextId);
          entries.push(
            life({ id: nextId++, kind: item.kind, text: item.text, source: item.source, createdAt: item.createdAt, updatedAt: item.createdAt }),
          );
        }
        return ids;
      },
      search: () => [],
      list: () => [...entries].sort((a, b) => a.createdAt - b.createdAt), // 真库口径：created_at ASC
      forget: () => true,
      updateEntry: () => true,
      findProgressId: () => null,
      markRecalled: () => {},
      setPinned: () => false,
      restore: () => false,
      fadeMany: () => {},
      count: () => entries.length,
      storedDim: () => 3,
      resetVectors: () => {},
      putVector: () => {},
      close: () => {},
    };
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => clockNow,
    });
    clockNow = 1_000; // 时钟回拨：新条目 created_at 早于存量 → list() 尾元素是存量（id=42）
    const r = await svc.remember("新记忆", "fact", "steward-turn");
    expect(r.updated).toBe(false);
    expect(r.id).toBe(43); // 新写入条目的 id，而非尾元素推断出的 42
    expect(appended.length).toBe(1);
  });

  test("④ 维度切换重建：resetVectors + 全量条目重嵌入回填", async () => {
    const store = fakeStore(3);
    store.entries.push(life({ id: 7, kind: "fact", text: "旧条目甲", source: "s", createdAt: 1, updatedAt: 1 }));
    store.entries.push(life({ id: 8, kind: "fact", text: "旧条目乙", source: "s", createdAt: 2, updatedAt: 2 }));
    const embedding = fakeEmbedding(4); // 新模型 4 维
    const svc = new StewardMemoryService({ config: fakeConfig(ENABLED_KV), embedding, embeddingConfig: fakeLookup(), store });
    await svc.remember("新条目", "fact", "steward-turn");
    expect(store.resets).toEqual([4]); // 维度切换触发一次重建
    // 两条旧条目重嵌入回填（一次批量调用）+ 新条目 append
    expect(store.puts.map((p) => p.id).sort()).toEqual([7, 8]);
    expect(embedding.calls.some((c) => c.join() === "旧条目甲,旧条目乙")).toBe(true);
  });

  test("⑤ 配置写面（批1 收编）：开关写面放行；endpointId 参数退役——向量端点选择归 embedding.defaultEndpointId", async () => {
    const config = fakeConfig();
    const lookup = fakeLookup(null);
    const svc = new StewardMemoryService({ config, embedding: fakeEmbedding(), embeddingConfig: lookup, store: fakeStore() });
    // 先开开关（默认端点未配）——写面放行，可用性待命
    const turnedOn = await svc.setMemoryConfig({ enabled: true });
    expect(turnedOn.ok).toBe(true);
    expect(config.kv.get(MEMORY_ENABLED_KEY)).toBe("1");
    expect(svc.getMemoryState().available).toBe(false); // 待命：默认端点不在场
    // 默认端点在场（resolveDefault 非 null）→ 自动生效（available 翻真）——
    // 记忆不再自持 endpointId，setMemoryConfig 无该参数
    const ok = await svc.setMemoryConfig({ judgeEndpointId: "" });
    expect(ok.ok).toBe(true);
    expect(svc.getMemoryState().available).toBe(false);
    expect(config.kv.get(MEMORY_ENDPOINT_ID_KEY)).toBeUndefined(); // 退役键零写入
  });

  test("⑥ 凭据卫生（批1）：getMemoryState 不再回 endpoint（向量端点归全局默认，回执不回 endpointId）", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    const state = svc.getMemoryState();
    expect(state.available).toBe(true);
    expect("endpoint" in state).toBe(false);
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

describe("StewardMemoryService B5：写入查重两段闸 + 召回阈值", () => {
  /** B5 专用 fake：search 分数可控 + 判官可选注入（两段闸判定素材）。 */
  function scoreStore(
    topScore: number,
  ): StewardMemoryPort & { appended: StewardMemoryAppendItem[]; updated: { id: number; text: string; updatedAt: number }[] } {
    const entries: StewardMemoryEntry[] = [
      life({ id: 7, kind: "preference", text: "回复要简洁", source: "steward-turn", createdAt: 1000, updatedAt: 1000 }),
    ];
    const appended: StewardMemoryAppendItem[] = [];
    const updated: { id: number; text: string; updatedAt: number }[] = [];
    return {
      appended,
      updated,
      append(items) {
        appended.push(...items);
        entries.push(life({ id: 8, kind: items[0]!.kind, text: items[0]!.text, source: items[0]!.source, createdAt: items[0]!.createdAt, updatedAt: items[0]!.createdAt }));
        return [8];
      },
      search: () => [{ ...entries[0]!, score: topScore }],
      list: () => entries,
      forget: () => true,
      updateEntry(id, text, _vector, updatedAt) {
        updated.push({ id, text, updatedAt });
        return true;
      },
      findProgressId: () => null,
      markRecalled: () => {},
      setPinned: () => false,
      restore: () => false,
      fadeMany: () => {},
      count: () => entries.length,
      storedDim: () => 3,
      resetVectors: () => {},
      putVector: () => {},
      close: () => {},
    };
  }

  function b5Service(topScore: number, judge?: ReturnType<typeof fakeJudgeTop>) {
    return new StewardMemoryService({
      config: judge === undefined
        ? fakeConfig(ENABLED_KV)
        : fakeConfig({ ...ENABLED_KV, [MEMORY_JUDGE_ENDPOINT_ID_KEY]: "ep-jev" }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      store: scoreStore(topScore),
      ...(judge === undefined ? {} : { judge }),
      clock: () => 5000,
    });
  }

  test("⑧ 判官缺席回退：top1 ≥ 0.92 高阈值 → 覆盖更新（updatedAt 刷新）；0.85~0.92 区间 → 保守新增", async () => {
    // 0.95（≥ 0.92）→ 判重覆盖
    const high = b5Service(0.95);
    const savedHigh = await high.remember("回复务必简短", "preference", "steward-turn");
    expect(savedHigh).toEqual({ id: 7, updated: true });
    // 0.88（粗筛达标但无判官精判，< 0.92 回退线）→ 保守新增
    const mid = b5Service(0.88);
    const savedMid = await mid.remember("回复务必简短", "preference", "steward-turn");
    expect(savedMid.updated).toBe(false);
  });

  test("⑨ 判官在场精判：≥ 0.85 粗筛 + noul ≥ 0.5 → 覆盖；noul < 0.5 → 新增（不同侧面共存）", async () => {
    const same = b5Service(0.88, fakeJudgeTop(0.9));
    const savedSame = await same.remember("回复务必简短", "preference", "steward-turn");
    expect(savedSame).toEqual({ id: 7, updated: true });
    const diff = b5Service(0.88, fakeJudgeTop(0.2));
    const savedDiff = await diff.remember("项目用 helix 仓", "fact", "steward-turn");
    expect(savedDiff.updated).toBe(false);
  });

  test("⑩ 判官抛错降级：回退 0.92 纯向量（≥ 0.92 覆盖、< 0.92 新增），不挡写入", async () => {
    const failHigh = b5Service(0.95, fakeJudgeTop(0.9, true));
    expect((await failHigh.remember("回复务必简短", "preference", "steward-turn")).updated).toBe(true);
    const failMid = b5Service(0.88, fakeJudgeTop(0.9, true));
    expect((await failMid.remember("回复务必简短", "preference", "steward-turn")).updated).toBe(false);
  });

  test("⑪ 粗筛下沿：top1 < 0.85 → 零精判零判重，直接新增", async () => {
    const judge = fakeJudgeTop(0.9);
    const svc = b5Service(0.84, judge);
    const saved = await svc.remember("项目在 helix 仓", "fact", "steward-turn");
    expect(saved.updated).toBe(false);
    expect(judge.calls).toHaveLength(0); // 粗筛未过零精判调用
  });

  test("⑫ 召回阈值：score ≥ RECALL_MIN_SCORE 达标注入；全低于 → undefined", async () => {
    const ok = await b5Service(0.8).recallSection("随便什么");
    expect(ok).toContain("回复要简洁");
    const filtered = await b5Service(STEWARD_MEMORY_RECALL_MIN_SCORE - 0.01).recallSection("随便什么");
    expect(filtered).toBeUndefined();
  });

  test("⑬ 覆盖更新时间：updateEntry 收到服务层时钟（updatedAt 刷新非 createdAt）", async () => {
    const store = scoreStore(0.95);
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(3),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => 5000,
    });
    await svc.remember("回复务必简短", "preference", "steward-turn");
    expect(store.updated).toEqual([{ id: 7, text: "回复务必简短", updatedAt: 5000 }]);
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
      resolveDefault: () => ({ baseUrl: ENDPOINT_RECORD.baseUrl, model: ENDPOINT_RECORD.model }),
      resolveDefaultClassifierRecord: () => null,
    };
  }

  test("① 判官可用性：enabled ∧ judgeEndpointId 有效(classifier) ∧ judge port 注入 → true", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(),
    });
    expect(svc.judgeSedimentAvailable()).toBe(true);
  });

  test("② kind 校验：judgeEndpointId 指向 kind=embedding（kind 缺席同判）端点 → 不可用", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_JUDGE_ENDPOINT_ID_KEY]: ENDPOINT_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(),
    });
    expect(svc.judgeSedimentAvailable()).toBe(false);
  });

  test("③ 降级三面：开关关 / judgeEndpointId 未设 / judge port 缺席 → 静默不可用", () => {
    const base = { embedding: fakeEmbedding(3), embeddingConfig: judgeLookup(), judge: fakeJudge() };
    expect(new StewardMemoryService({ ...base, config: fakeConfig({ [MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }) }).judgeSedimentAvailable()).toBe(false);
    expect(new StewardMemoryService({ ...base, config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1" }) }).judgeSedimentAvailable()).toBe(false);
    const noJudge = new StewardMemoryService({
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
    });
    expect(noJudge.judgeSedimentAvailable()).toBe(false);
  });

  test("④ judgeSame（B5 同一性精判）：state 含既有+新句，question 为同一性问句；判官抛错原样上抛", async () => {
    const judge = fakeJudge(0.7);
    const svc = new StewardMemoryService({
      config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge,
    });
    expect(await svc.judgeSame("回复要简洁", "回复务必简短")).toBe(0.7);
    expect(judge.calls[0]!.state).toContain("既有：回复要简洁");
    expect(judge.calls[0]!.state).toContain("新写入：回复务必简短");
    // question 为同一性问句（非增量判定——B5 重新定位）
    expect(judge.calls[0]!.question).toContain("同一条用户偏好或事实");
    expect(judge.calls).toHaveLength(1);
    const failing = new StewardMemoryService({
      config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id }),
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(0.5, true),
    });
    await expect(failing.judgeSame("x", "y")).rejects.toThrow("判官 HTTP 500");
  });

  test("⑤ 配置写面：judgeEndpointId 可选更新（空串 = 清除引用）；getMemoryState 判官引用态凭据卫生", async () => {
    const config = fakeConfig({ [MEMORY_ENABLED_KEY]: "1" });
    const svc = new StewardMemoryService({
      config,
      embedding: fakeEmbedding(3),
      embeddingConfig: judgeLookup(),
      judge: fakeJudge(),
    });
    await svc.setMemoryConfig({ judgeEndpointId: JUDGE_RECORD.id });
    expect(config.kv.get(MEMORY_JUDGE_ENDPOINT_ID_KEY)).toBe(JUDGE_RECORD.id);
    const state = svc.getMemoryState();
    expect(state.judgeEndpoint).toEqual({ id: JUDGE_RECORD.id, name: "Jev", model: "jev-latest", hasApiKey: true });
    expect(state.judgeEndpoint !== null && "baseUrl" in state.judgeEndpoint).toBe(false);
    await svc.setMemoryConfig({ judgeEndpointId: "" });
    expect(svc.getMemoryState().judgeEndpoint).toBeNull();
    expect(svc.judgeSedimentAvailable()).toBe(false);
  });
});

// ── 遗忘机制批：强度/召回融合/GC 三段/pin·restore/软上限 ─────────

describe("StewardMemoryService 遗忘机制批", () => {
  const DAY = 24 * 3_600_000;

  test("① memoryStrength：半衰计算/强化倍率/封顶/manual·pinned 恒满", () => {
    const far = 400 * DAY;
    const base = { kind: "preference" as const, source: "steward-turn", createdAt: 0, updatedAt: 0, lastRecalledAt: 0, pinned: false };
    // anchor = 0，直接传流逝时刻：一个半衰期（preference 30d）→ 0.5
    expect(memoryStrength({ ...base, recallCount: 0 }, 30 * DAY)).toBeCloseTo(0.5, 5);
    // fact 半衰 60d → 0.5
    expect(memoryStrength({ ...base, kind: "fact", recallCount: 0 }, 60 * DAY)).toBeCloseTo(0.5, 5);
    // 强化：被想起 2 次（半衰 ×4 = 120d）→ 120d 后仍 0.5
    expect(memoryStrength({ ...base, recallCount: 2 }, 120 * DAY)).toBeCloseTo(0.5, 5);
    // 封顶：强化 8 次（×256）→ 半衰钉在 365d
    expect(memoryStrength({ ...base, recallCount: 8 }, 365 * DAY)).toBeCloseTo(0.5, 3);
    // manual/pinned 恒满（千年不衰）
    expect(memoryStrength({ ...base, source: "manual", recallCount: 0 }, far + 1000 * 365 * DAY)).toBe(1);
    expect(memoryStrength({ ...base, pinned: true, recallCount: 0 }, far + 1000 * 365 * DAY)).toBe(1);
  });

  test("② pickFadeCandidates：公平期豁免/manual·pinned 豁免/已 fade 不重复/强度线", () => {
    const now = 400 * DAY;
    const fresh = life({ id: 1, kind: "preference", text: "新", source: "s", createdAt: now - 10 * DAY, updatedAt: now - 10 * DAY });
    const stale = life({ id: 2, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 });
    const manualOld = life({ id: 3, kind: "preference", text: "手写", source: "manual", createdAt: 0, updatedAt: 0 });
    const pinnedOld = { ...life({ id: 4, kind: "preference", text: "置顶", source: "s", createdAt: 0, updatedAt: 0 }), pinned: true };
    const alreadyFaded = { ...life({ id: 5, kind: "preference", text: "已淡", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - 5 * DAY };
    const recentlyRecalled = { ...life({ id: 6, kind: "preference", text: "常用", source: "s", createdAt: 0, updatedAt: 0 }), lastRecalledAt: now - 5 * DAY, recallCount: 3 };
    const picked = pickFadeCandidates([fresh, stale, manualOld, pinnedOld, alreadyFaded, recentlyRecalled], now);
    expect(picked.map((e) => e.id)).toEqual([2]);
  });

  test("③ pickPurgeCandidates：观察窗外删除；窗内保留", () => {
    const now = 100 * DAY;
    const inWindow = { ...life({ id: 1, kind: "fact", text: "a", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - 10 * DAY };
    const outWindow = { ...life({ id: 2, kind: "fact", text: "b", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - 31 * DAY };
    expect(pickPurgeCandidates([inWindow, outWindow], now).map((e) => e.id)).toEqual([2]);
  });

  test("④ 召回融合：faded 不出线；时间权重只影响竞争位；幸存者回写（陪跑不记）", async () => {
    const store = fakeStore();
    const now = 100 * DAY;
    store.entries.push(
      life({ id: 1, kind: "preference", text: "老偏好", source: "s", createdAt: 0, updatedAt: 0 }),
      life({ id: 2, kind: "preference", text: "新偏好", source: "s", createdAt: now - DAY, updatedAt: now - DAY }),
      { ...life({ id: 3, kind: "preference", text: "淡忘条目", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - DAY },
    );
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    const section = await svc.recallSection("偏好");
    expect(section).toContain("新偏好");
    expect(section).toContain("老偏好"); // topK=5 内仍出线（资格闸不受时间权重影响）
    expect(section).not.toContain("淡忘条目");
    // 回写：注入幸存者（排序后 [新, 老]——新条目强度高胜出首位）；faded 3 号不记
    expect(store.recalled).toEqual([{ ids: [2, 1], at: now }]);
    expect(store.list().find((e) => e.id === 2)!.recallCount).toBe(1);
    expect(store.list().find((e) => e.id === 3)!.recallCount).toBe(0);
  });

  test("⑤ 唯一强相关的老条目仍能出线并复活（资格与排序解耦）", async () => {
    const store = fakeStore();
    const now = 400 * DAY; // 强度≈0（远超三个半衰期）
    store.entries.push(life({ id: 9, kind: "fact", text: "孤本事实", source: "s", createdAt: 0, updatedAt: 0 }));
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    const section = await svc.recallSection("孤本");
    expect(section).toContain("孤本事实");
    expect(store.recalled[0]!.ids).toEqual([9]); // 出线即回写复活（锄点刷新）
  });

  test("⑥ GC 三段：fade（观察窗内不删）→ 观察窗外物理删；复活重置观察窗", () => {
    const store = fakeStore();
    let now = 400 * DAY;
    store.entries.push(
      life({ id: 1, kind: "preference", text: "旧A", source: "s", createdAt: 0, updatedAt: 0 }),
      life({ id: 2, kind: "preference", text: "旧B", source: "s", createdAt: 0, updatedAt: 0 }),
    );
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    svc.gcNow();
    expect(store.fades.sort()).toEqual([1, 2]); // 第一轮：fade
    expect(store.list()).toHaveLength(2); // 观察窗内不物理删
    // 复活 1 号（重置观察窗）
    now += 10 * DAY;
    expect(svc.restoreMemoryEntry(1)).toBe(true);
    // 观察窗外第二轮：只删 2（1 号已复活不在 purge 候选）
    now += 31 * DAY;
    svc.gcNow();
    expect(store.list().map((e) => e.id)).toEqual([1]);
    expect(store.list()[0]!.fadedAt).toBe(0);
  });

  test("⑦ maybeGc 节流：窗口内二连零动作；窗口外放行", () => {
    const store = fakeStore();
    let now = 400 * DAY;
    store.entries.push(life({ id: 1, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 }));
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    svc.maybeGc();
    expect(store.fades).toEqual([1]);
    now += DAY; // 窗口内
    svc.maybeGc();
    expect(store.fades).toEqual([1]); // 零新增动作
    now += 25 * 3_600_000 * 24; // 超窗口
    svc.maybeGc();
    expect(store.fades).toEqual([1]); // 该条目已 faded（fadeMany 只动 active）——零动作即验证节流后仍无重复 fade
  });

  test("⑧ 软上限：append 后 count > SOFT_CAP → 主动 GC（绕节流）", async () => {
    const store = fakeStore();
    const now = 400 * DAY;
    store.entries.push(life({ id: 1, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 }));
    // 覆写 count 触发软上限面（不真插 2000 条）
    (store as { count: () => number }).count = () => STEWARD_MEMORY_SOFT_CAP + 1;
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    const outcome = await svc.appendMemoryEntry("手动记一条");
    expect(outcome.ok).toBe(true);
    expect(store.fades).toEqual([1]); // append 后主动 GC 已 fade 旧条目
  });

  test("⑨ pin/restore 委托：置顶隐含解除淡忘 + 刷 updatedAt；active restore 幂等 no-op", () => {
    const store = fakeStore();
    const now = 400 * DAY;
    store.entries.push({ ...life({ id: 1, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - DAY });
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    // active restore no-op（faded 才可恢复）
    expect(svc.restoreMemoryEntry(99)).toBe(false);
    // 置顶隐含解除淡忘 + 刷 updatedAt
    expect(svc.pinMemoryEntry(1, true)).toBe(true);
    const pinned = store.list()[0]!;
    expect(pinned.pinned).toBe(true);
    expect(pinned.fadedAt).toBe(0);
    expect(pinned.updatedAt).toBe(now);
    // 置顶条目强度恒满（永不 fade）
    expect(memoryStrength(pinned, now + 10_000 * DAY)).toBe(1);
    expect(svc.pinMemoryEntry(1, false)).toBe(true); // 取消置顶
    expect(store.list()[0]!.pinned).toBe(false);
  });

  test("⑩ GC 定时器：startGcTimer 幂等 + dispose 清理", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    svc.startGcTimer();
    svc.startGcTimer(); // 幂等（不叠加定时器）
    svc.dispose();
    svc.dispose(); // 幂等
  });
});

// ── 防双写水位闸直接单测（设置页长期记忆组批）────────────────────────
//
// 与 steward-memory-tool.test.ts ⑥⑦ 的区别：那边断言在 fakeMemory 镜像面
// （fake 自持 lastExplicitRememberAt）；此处构造**真实 StewardMemoryService**
// （受控 clock + fake 出站依赖），断言落在真实实现的水位置位/读面语义上——
// 双写场景：轮内显式 remember（steward-turn/manual）置位 → 总结器记忆点
// 经 explicitRememberedSince(spanStart) 判本轮让位；自动生产源
// （session-summary）不置位不误伤。
describe("防双写水位闸（explicitRememberedSince 真实实现直接单测）", () => {
  /** 受控时钟服务构造糖（t 可变——模拟轮内时间推进）。 */
  function svcAt(t: number): { svc: StewardMemoryService; store: ReturnType<typeof fakeStore>; t: { now: number } } {
    const clock = { now: t };
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => clock.now,
    });
    return { svc, store, t: clock };
  }

  test("① 初始态：水位 -1 → explicitRememberedSince 任意起点 false", () => {
    const { svc } = svcAt(1000);
    expect(svc.explicitRememberedSince(0)).toBe(false);
    expect(svc.explicitRememberedSince(1000)).toBe(false);
  });

  test("② 显式 remember（steward-turn）成功 → 水位置位：since ≤ 写入时刻 true / since > 写入时刻 false", async () => {
    const { svc, t } = svcAt(500);
    await svc.remember("用户偏好简洁回复", "preference", "steward-turn");
    expect(svc.explicitRememberedSince(0)).toBe(true); // 轮 spanStart（=0）以来写过
    expect(svc.explicitRememberedSince(500)).toBe(true); // 等号含入（>= 语义：本轮锚点整点写入算本轮）
    t.now = 900;
    expect(svc.explicitRememberedSince(901)).toBe(false); // 水位 500 < 901：下轮 spanStart 之后才写的才算
  });

  test("③ manual 人工新增同样置位（appendMemoryEntry → remember source=manual）", async () => {
    const { svc } = svcAt(700);
    const outcome = await svc.appendMemoryEntry("手动记一条", "preference");
    expect(outcome.ok).toBe(true);
    expect(svc.explicitRememberedSince(700)).toBe(true);
  });

  test("④ 自动生产源不置位：session-summary 记忆点入库 → 水位不动（显式写入才防双写）", async () => {
    const { svc } = svcAt(300);
    const outcome = await svc.rememberSessionMemoryPoint("总结器提炼的偏好", "preference", "habit");
    expect(outcome.updated).toBe(false); // 入库成功（新增）
    expect(svc.explicitRememberedSince(0)).toBe(false); // 自动源不置水位
  });

  test("⑤ 写失败不置位：embed 抛错 → remember 抛错 + 水位不动（总结器下锚点可补写）", async () => {
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(3, true), // embed 抛错
      embeddingConfig: fakeLookup(),
      store,
      clock: () => 800,
    });
    await expect(svc.remember("存不进去的", "fact", "steward-turn")).rejects.toThrow("端点不可达");
    expect(svc.explicitRememberedSince(0)).toBe(false);
  });

  test("⑥ 双写场景全链：轮内显式写入后同轮总结器让位，下轮恢复可写", async () => {
    const { svc, t } = svcAt(1000);
    // 第 1 轮（spanStart=1000）：显式 remember 成功 → 本轮防双写闸关
    await svc.remember("用户偏好简洁", "preference", "steward-turn");
    expect(svc.explicitRememberedSince(1000)).toBe(true); // 总结器看到 true → 本轮记忆点让位
    // 第 2 轮（spanStart=2000）：显式水位（1000）不越界 → 总结器照常产记忆点
    t.now = 2000;
    expect(svc.explicitRememberedSince(2000)).toBe(false);
    // 第 2 轮记忆点入库（session-summary 自动源）→ 不置水位（第 3 轮仍可产）
    await svc.rememberSessionMemoryPoint("第 2 轮总结器提炼", "preference", "habit");
    expect(svc.explicitRememberedSince(2000)).toBe(false);
    // 第 3 轮（spanStart=3000）：闸仍开
    t.now = 3000;
    expect(svc.explicitRememberedSince(3000)).toBe(false);
  });
});

// ── 召回资格闸配置驱动（memory.recallMinScore；STEWARD_MEMORY_RECALL_MIN_SCORE
//    退役为缺省值单一来源）──────────────────────────────────

describe("召回资格闸配置驱动（memory.recallMinScore）", () => {
  /** 可控命中 fake store：search 回放给定 hits（资格闸断言面）。 */
  function hitStore(hits: readonly StewardMemoryHit[]): StewardMemoryPort {
    return {
      append: () => [],
      search: () => hits,
      list: () => hits,
      forget: () => false,
      updateEntry: () => false,
      findProgressId: () => null,
      markRecalled: () => {},
      setPinned: () => false,
      restore: () => false,
      fadeMany: () => {},
      count: () => hits.length,
      storedDim: () => 3,
      resetVectors: () => {},
      putVector: () => {},
      close: () => {},
    };
  }

  function hit(id: number, score: number, over: Partial<StewardMemoryEntry> = {}): StewardMemoryHit {
    return {
      ...life({ id, kind: "preference", text: `条目 ${id}`, source: "steward-turn", createdAt: 1, updatedAt: 1 }),
      ...over,
      score,
    };
  }

  function gateService(kv: Record<string, string>, hits: readonly StewardMemoryHit[]): StewardMemoryService {
    return new StewardMemoryService({
      config: fakeConfig({ ...ENABLED_KV, ...kv }),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: hitStore(hits),
      clock: () => 5000,
    });
  }

  test("① 配置阈值生效于资格闸：阈值 0.5 时 score 0.4 不返回、0.6 返回（管家召回面）", async () => {
    const svc = gateService({ [MEMORY_RECALL_MIN_SCORE_KEY]: "0.5" }, [hit(1, 0.6), hit(2, 0.4)]);
    const section = await svc.recallSection("随便什么");
    expect(section).toContain("条目 1");
    expect(section).not.toContain("条目 2");
  });

  test("② 资格与排序解耦回归钉死：低于阈值条目即便强度满格（pinned）也不返回——强度救不回低相似度", async () => {
    const svc = gateService(
      { [MEMORY_RECALL_MIN_SCORE_KEY]: "0.5" },
      [hit(1, 0.49, { pinned: true }), hit(2, 0.6, { createdAt: 1, updatedAt: 1, lastRecalledAt: 1, recallCount: 8 })],
    );
    const section = await svc.recallSection("随便什么");
    expect(section).toContain("条目 2");
    expect(section).not.toContain("条目 1"); // 闸砍在裸相似度上（融合排序之前）——pinned 恒满强度也不救回
  });

  test("③ 缺省阈值 = STEWARD_MEMORY_RECALL_MIN_SCORE（未配置——常量缺省单一来源，0.30 判界等价旧行为）", async () => {
    const svc = gateService(
      {},
      [hit(1, STEWARD_MEMORY_RECALL_MIN_SCORE - 0.01), hit(2, STEWARD_MEMORY_RECALL_MIN_SCORE + 0.01)],
    );
    const section = await svc.recallSection("随便什么");
    expect(section).not.toContain("条目 1");
    expect(section).toContain("条目 2");
  });

  test("④ topK 上限语义不变：阈值放行全部候选后仍按 memory.recallTopK 截断（上限不是配额）", async () => {
    const svc = gateService(
      { [MEMORY_RECALL_MIN_SCORE_KEY]: "0", [MEMORY_RECALL_TOP_K_KEY]: "2" },
      [hit(1, 0.9), hit(2, 0.8), hit(3, 0.7)],
    );
    const section = await svc.recallSection("随便什么");
    const lines = section!.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(2);
  });

  test("⑤ memory_search 工具面同源闸（semanticRecallCore 共用）：阈值 0.5 时 0.4 不回、0.6 回", async () => {
    const svc = gateService({ [MEMORY_RECALL_MIN_SCORE_KEY]: "0.5" }, [hit(1, 0.6), hit(2, 0.4)]);
    const hits = await svc.searchMemories("随便什么");
    expect(hits.map((h) => h.id)).toEqual([1]);
  });
});

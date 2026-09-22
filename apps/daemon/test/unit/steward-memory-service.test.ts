/**
 * StewardMemoryService 管家记忆 B3 单元测试（写入去重 + 召回阈值）。
 *
 * 覆盖面（fake store + fake embedding——服务编排逻辑，存储真实性由
 * steward-memory-store.test.ts 覆盖）：
 * 1. 写入去重：remember 内语义查重 top1 ≥ DEDUP_THRESHOLD → updateEntry
 *    覆盖原条目（append 零调用），返回 { id, updated: true }；
 * 2. 非重复新增：top1 < 阈值 → append 正常路径，返回 { id, updated: false }；
 * 3. 阈值边界：score 恰等于 DEDUP_THRESHOLD → 判重（闭区间下沿）；
 * 4. 召回阈值：recallSection 过滤 score < RECALL_MIN_SCORE 的命中；
 * 5. 召回全低于阈值 → undefined（无记忆段——与零命中同语义）。
 */
import { describe, expect, test } from "bun:test";
import {
  STEWARD_MEMORY_DEDUP_THRESHOLD,
  STEWARD_MEMORY_RECALL_MIN_SCORE,
  StewardMemoryService,
} from "../../src/application/steward/StewardMemoryService";
import type { StewardMemoryEntry, StewardMemoryHit, StewardMemoryPort } from "../../src/application/ports/outbound/StewardMemoryPort";
import type { EmbeddingPort } from "../../src/application/ports/outbound/EmbeddingPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";

/** fake 存储面（语义检索回注可控——去重/阈值判定素材）。 */
function fakeStore(opts: { topScore?: number } = {}) {
  const state = {
    appended: 0,
    updated: [] as { id: number; text: string }[],
    entries: [{ id: 7, kind: "preference", text: "回复要简洁", source: "steward-turn", createdAt: 1000 }] as StewardMemoryEntry[],
  };
  const store = {
    get appended() {
      return state.appended;
    },
    get updated() {
      return state.updated;
    },
    append: () => {
      state.appended += 1;
      state.entries.push({ id: 8, kind: "fact", text: "", source: "", createdAt: 0 });
    },
    search: (): readonly StewardMemoryHit[] =>
      opts.topScore === undefined ? [] : [{ ...state.entries[0]!, score: opts.topScore }],
    list: (): readonly StewardMemoryEntry[] => state.entries,
    updateEntry: (id: number, text: string) => {
      state.updated.push({ id, text });
      return true;
    },
    forget: () => true,
    count: () => state.entries.length,
    storedDim: () => 1024,
    resetVectors: () => {},
    putVector: () => {},
    close: () => {},
  };
  return store as unknown as StewardMemoryPort & typeof state;
}

function makeService(store: ReturnType<typeof fakeStore>) {
  const embedding: EmbeddingPort = {
    endpointLabel: () => "Ollama/bge-m3",
    async embed(texts: string[]) {
      return { vectors: texts.map(() => new Float32Array([0.1, 0.2])), dim: 1024 };
    },
  };
  const config: RuntimeConfigPort = {
    get: (key: string) => (key === "steward.memory.enabled" ? "1" : key === "steward.memory.endpointId" ? "ep-1" : undefined),
    set: async () => {},
  } as unknown as RuntimeConfigPort;
  return new StewardMemoryService({
    config,
    embedding,
    embeddingConfig: { resolveRecord: (id: string) => (id === "ep-1" ? ({ id, name: "Ollama", model: "bge-m3", baseUrl: "http://x", apiKey: undefined } as never) : null) },
    store,
  });
}

describe("StewardMemoryService B3：写入去重", () => {
  test("① top1 ≥ 阈值 → updateEntry 覆盖（append 零调用），返回 updated:true", async () => {
    const store = fakeStore({ topScore: 0.95 });
    const svc = makeService(store);
    const saved = await svc.remember("回复务必简短", "preference", "steward-turn");
    expect(saved).toEqual({ id: 7, updated: true });
    expect(store.appended).toBe(0);
    expect(store.updated).toEqual([{ id: 7, text: "回复务必简短" }]);
  });

  test("② top1 < 阈值 → append 正常路径，返回 updated:false", async () => {
    const store = fakeStore({ topScore: 0.5 });
    const svc = makeService(store);
    const saved = await svc.remember("项目在 helix 仓", "fact", "steward-turn");
    expect(saved.updated).toBe(false);
    expect(store.appended).toBe(1);
    expect(store.updated).toEqual([]);
  });

  test("③ 边界：score 恰等于阈值 → 判重覆盖", async () => {
    const store = fakeStore({ topScore: STEWARD_MEMORY_DEDUP_THRESHOLD });
    const svc = makeService(store);
    const saved = await svc.remember("回复要简洁明了", "preference", "steward-turn");
    expect(saved.updated).toBe(true);
  });
});

describe("StewardMemoryService B3：召回阈值", () => {
  test("④ 低于 RECALL_MIN_SCORE 的命中被过滤，达标命中保留", async () => {
    const store = fakeStore({ topScore: 0.8 });
    const svc = makeService(store);
    // search 回注可控：topScore 即唯一命中的分数
    const section = await svc.recallSection("随便什么");
    expect(section).toBeDefined();
    expect(section).toContain("回复要简洁");
  });

  test("⑤ 全部命中低于阈值 → undefined（无记忆段）", async () => {
    const store = fakeStore({ topScore: STEWARD_MEMORY_RECALL_MIN_SCORE - 0.01 });
    const svc = makeService(store);
    const section = await svc.recallSection("随便什么");
    expect(section).toBeUndefined();
  });
});

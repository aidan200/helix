/**
 * StewardMemoryService 单测共享夹具（steward-memory-service*.test.ts 三文件共用）——
 * 纯位置迁移自 steward-memory-service.test.ts（P1 体量门拆分批，测试逻辑零改动）：
 * fake embedding / fake store / fake 配置域查询面 / 判官 helper。
 */
import type { EmbeddingPort, EmbeddingResult } from "../../../src/application/ports/outbound/EmbeddingPort";
import type { RuntimeConfigPort } from "../../../src/application/ports/outbound/RuntimeConfigPort";
import type {
  StewardMemoryAppendItem,
  StewardMemoryEntry,
  StewardMemoryHit,
  StewardMemoryPort,
} from "../../../src/application/ports/outbound/StewardMemoryPort";
import type { EmbeddingEndpointRecord } from "../../../src/application/embedding/EmbeddingConfigService";
import type { EmbeddingConfigLookup } from "../../../src/application/steward/StewardMemoryService";
import { MEMORY_ENABLED_KEY, MEMORY_ENDPOINT_ID_KEY } from "../../../src/application/memory/memoryConfig";

export const EP_ID = "ep-bge";
export const ENDPOINT_RECORD: EmbeddingEndpointRecord = {
  id: EP_ID,
  name: "Ollama 本地",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "sk-x",
  model: "bge-m3",
};

export function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
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
export function fakeLookup(record: EmbeddingEndpointRecord | null = ENDPOINT_RECORD): EmbeddingConfigLookup & { drop(): void } {
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

export function fakeEmbedding(dim = 3, fail = false): EmbeddingPort & { calls: string[][] } {
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
export function life(
  e: Pick<StewardMemoryEntry, "id" | "kind" | "text" | "source" | "createdAt" | "updatedAt"> & Partial<StewardMemoryEntry>,
): StewardMemoryEntry {
  return { lastRecalledAt: e.updatedAt, recallCount: 0, fadedAt: 0, pinned: false, ...e };
}

export function fakeStore(dim: number | null = 3): StewardMemoryPort & {
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

export const ENABLED_KV = {
  [MEMORY_ENABLED_KEY]: "1",
  [MEMORY_ENDPOINT_ID_KEY]: EP_ID,
};

// ── 文件级判官 helper（B5 两段闸段与 B4a 判官面段共用）────────────────────

export const JUDGE_RECORD_TOP: EmbeddingEndpointRecord = {
  id: "ep-jev",
  name: "Jev",
  baseUrl: "https://api.typesafe.ai/v1",
  apiKey: "sk-judge",
  model: "jev-latest",
  kind: "classifier",
};

export function fakeJudgeTop(probability = 0.8, fail = false) {
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

export function judgeLookup(): EmbeddingConfigLookup {
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

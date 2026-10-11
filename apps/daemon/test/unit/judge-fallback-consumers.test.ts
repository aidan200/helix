/**
 * 判官端点兜底层（D1 渐进收编）消费面矩阵单测——显式配置 ＞ 默认分类端点 ＞
 * 缺席降级 三档，钉在至少两个判官消费面（记忆查重精判 + barge-in 停止判定）。
 *
 * 形态陈述（D1 渐进收编）：各消费面的 judgeEndpointId 类键位**保留不退役**
 * ——显式配置优先；未配置时取全局默认分类端点（有默认 = 判官在场）；无默认
 * = 维持现状缺席降级（记忆查重回退 0.92 纯向量 / 判不出 fail-stop 归消费面）。
 * 端点解析过同一兜底层（resolveJudgeRecord 单点），不逐面各写一套。
 *
 * 断言面：
 * 1. 记忆查重（StewardMemoryService）：三档 ×（判官可用性 + getMemoryState
 *    判官引用态 + remember 两段闸是否走 judgeSame 精判）；
 * 2. barge-in 停止判定（makeIntentJudgeFace → StewardService.judgeStopIntent）：
 *    三档 ×（ready 解析 + judgeStopIntent 判定生效/判不出 degraded=off）。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { StewardMemoryPort, StewardMemoryHit, StewardMemoryEntry, StewardMemoryAppendItem } from "../../src/application/ports/outbound/StewardMemoryPort";
import {
  MEMORY_ENABLED_KEY,
  MEMORY_JUDGE_ENDPOINT_ID_KEY,
} from "../../src/application/memory/memoryConfig";
import {
  EmbeddingConfigService,
  CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY,
  EMBEDDING_DEFAULT_ENDPOINT_ID_KEY,
  EMBEDDING_ENDPOINTS_KEY,
  type EmbeddingEndpointRecord,
} from "../../src/application/embedding/EmbeddingConfigService";
import { StewardMemoryService, type EmbeddingConfigLookup } from "../../src/application/steward/StewardMemoryService";
import {
  resolveTriageJudgeRecord,
  STEWARD_TRIAGE_JUDGE_ENABLED_KEY,
  STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY,
} from "../../src/application/steward/StewardTriageJudge";
import { makeIntentJudgeFace as makeIntentFace } from "../../src/application/steward/StewardIntentJudge";
import { StewardService } from "../../src/application/steward/StewardService";
import type { AgentEnginePort } from "../../src/application/ports/outbound/AgentEnginePort";

// ── fixture 端点 ─────────────────────────────────────────────

const EXPLICIT_JUDGE: EmbeddingEndpointRecord = {
  id: "ep-j1",
  name: "Jev 直连",
  baseUrl: "https://judge.example/v1",
  model: "jev-latest",
  kind: "classifier",
  verifiedAt: 1000,
};
const DEFAULT_JUDGE: EmbeddingEndpointRecord = {
  id: "ep-j2",
  name: "pi-ai 目录判官",
  baseUrl: "",
  model: "typesafe/jev-latest",
  kind: "classifier",
  variant: "pi-ai",
  verifiedAt: 2000,
};
const VEC_ENDPOINT: EmbeddingEndpointRecord = {
  id: "ep-vec",
  name: "Ollama 本地",
  baseUrl: "http://localhost:11434/v1",
  model: "bge-m3",
  verifiedAt: 1000,
};

function memoryConfig(initial: Record<string, string> = {}) {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
    kv,
  } satisfies RuntimeConfigPort & { kv: Map<string, string> };
}

/** 以真实 EmbeddingConfigService 当 lookup（生产消费面同姿势）。 */
function lookupOf(initial: Record<string, string> = {}): {
  lookup: EmbeddingConfigLookup;
  config: ReturnType<typeof memoryConfig>;
} {
  const config = memoryConfig(initial);
  const svc = new EmbeddingConfigService({
    config,
    createProbe: () => ({
      embed: async (): Promise<EmbeddingResult> => ({ vectors: [Float32Array.from([0.1])], dim: 1 }),
      endpointLabel: () => "fake",
    }),
    createJudgeProbe: () => ({ noul: async () => 0.9, endpointLabel: () => "fake" }),
  });
  return { lookup: svc, config };
}

function seedEndpoints(config: { set(k: string, v: string): Promise<void> }, records: readonly EmbeddingEndpointRecord[]): void {
  void config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(records));
}

// ── 记忆查重消费面 fakes ─────────────────────────────────────

function fakeEmbedding(): EmbeddingPort {
  return {
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      return { vectors: texts.map(() => Float32Array.from([0.5])), dim: 1 };
    },
  };
}

/** 最小 store：search 恒回一条 0.9 候选（两段闸粗筛必出候选）。 */
type MemoryFake = StewardMemoryPort & {
  entries: StewardMemoryEntry[];
  appended: StewardMemoryAppendItem[];
  updated: { id: number; text: string }[];
};
function fakeStore(): MemoryFake {
  const entries: StewardMemoryEntry[] = [];
  const appended: StewardMemoryAppendItem[] = [];
  const updated: { id: number; text: string }[] = [];
  const impl: MemoryFake = {
    entries,
    appended,
    updated,
    append(items) {
      appended.push(...items);
      for (const item of items) {
        entries.push({
          id: entries.length + 1,
          kind: item.kind,
          text: item.text,
          source: item.source,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
          lastRecalledAt: item.createdAt,
          recallCount: 0,
          fadedAt: 0,
          pinned: false,
          ...(item.projectScope !== undefined ? { projectScope: item.projectScope } : {}),
        });
      }
    },
    search: (_q, topK): readonly StewardMemoryHit[] =>
      entries.slice(0, topK).map((e) => ({ ...e, score: 0.9 })),
    list: () => entries,
    forget: () => false,
    updateEntry(id, text) {
      updated.push({ id, text });
      return entries.some((e) => e.id === id);
    },
    findProgressId: () => null,
    markRecalled: () => {},
    setPinned: () => false,
    restore: () => false,
    fadeMany: () => {},
    count: () => entries.length,
    storedDim: () => 1,
    resetVectors: () => {},
    putVector: () => {},
    close: () => {},
  };
  return impl;
}

function fakeJudge(probability = 0.8) {
  const calls: { state: string; question: string }[] = [];
  return {
    calls,
    endpointLabel: () => "fake-judge",
    async noul(state: string, question: string): Promise<number> {
      calls.push({ state, question });
      return probability;
    },
  };
}

// ── ① 记忆查重消费面三档（记忆查重精判 E-214/B5） ─────────────

describe("判官兜底层 × 记忆查重（B5 精判）：显式 ＞ 默认 ＞ 缺席", () => {
  test("① 显式 memory.judgeEndpointId 优先（默认分类端点另设也只认显式）", async () => {
    const { lookup, config } = lookupOf({ [EMBEDDING_DEFAULT_ENDPOINT_ID_KEY]: "ep-vec" });
    seedEndpoints(config, [EXPLICIT_JUDGE, DEFAULT_JUDGE, VEC_ENDPOINT]);
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-j2");
    const judge = fakeJudge();
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: memoryConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_JUDGE_ENDPOINT_ID_KEY]: "ep-j1" }),
      embedding: fakeEmbedding(),
      embeddingConfig: lookup,
      store,
      judge,
    });
    expect(svc.judgeSedimentAvailable()).toBe(true);
    expect(svc.getMemoryState().judgeEndpoint?.id).toBe("ep-j1"); // 显式优先
    store.entries.push({
      id: 1, kind: "fact", text: "回复要简洁", source: "manual", createdAt: 0, updatedAt: 0,
      lastRecalledAt: 0, recallCount: 0, fadedAt: 0, pinned: false,
    });
    await svc.remember("回复务必简短", "preference", "steward-turn");
    expect(judge.calls.length).toBe(1); // 两段闸走 judgeSame 精判
    expect(store.updated).toEqual([{ id: 1, text: "回复务必简短" }]); // ≥0.5 同条覆盖
  });

  test("② 未配显式 → 兜底默认分类端点（有默认 = 判官在场，精判生效）", async () => {
    const { lookup, config } = lookupOf({ [EMBEDDING_DEFAULT_ENDPOINT_ID_KEY]: "ep-vec" });
    seedEndpoints(config, [EXPLICIT_JUDGE, DEFAULT_JUDGE, VEC_ENDPOINT]);
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-j2");
    const judge = fakeJudge();
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: memoryConfig({ [MEMORY_ENABLED_KEY]: "1" }), // memory.judgeEndpointId 未配
      embedding: fakeEmbedding(),
      embeddingConfig: lookup,
      store,
      judge,
    });
    expect(svc.judgeSedimentAvailable()).toBe(true); // 默认分类端点 = 判官在场
    expect(svc.getMemoryState().judgeEndpoint?.id).toBe("ep-j2"); // 兜底默认端点上屏
    store.entries.push({
      id: 1, kind: "fact", text: "回复要简洁", source: "manual", createdAt: 0, updatedAt: 0,
      lastRecalledAt: 0, recallCount: 0, fadedAt: 0, pinned: false,
    });
    await svc.remember("回复务必简短", "preference", "steward-turn");
    expect(judge.calls.length).toBe(1); // 精判走判官（不再回退纯向量）
    expect(store.updated).toEqual([{ id: 1, text: "回复务必简短" }]);
  });

  test("③ 无默认无显式 → 缺席降级维持现状（judgeSediment 不可用、remember 回退 0.92 纯向量零判官调用）", async () => {
    const { lookup, config } = lookupOf({ [EMBEDDING_DEFAULT_ENDPOINT_ID_KEY]: "ep-vec" });
    seedEndpoints(config, [EXPLICIT_JUDGE, VEC_ENDPOINT]);
    const judge = fakeJudge();
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: memoryConfig({ [MEMORY_ENABLED_KEY]: "1" }),
      embedding: fakeEmbedding(),
      embeddingConfig: lookup,
      store,
      judge,
    });
    expect(svc.judgeSedimentAvailable()).toBe(false);
    expect(svc.getMemoryState().judgeEndpoint).toBeNull();
    store.entries.push({
      id: 1, kind: "fact", text: "回复要简洁", source: "manual", createdAt: 0, updatedAt: 0,
      lastRecalledAt: 0, recallCount: 0, fadedAt: 0, pinned: false,
    });
    await svc.remember("回复务必简短", "preference", "steward-turn");
    expect(judge.calls).toHaveLength(0); // 判官缺席——回退纯向量阈值
  });

  test("③b 显式悬空不落默认（显式在场即显式语义）", () => {
    const { lookup, config } = lookupOf();
    seedEndpoints(config, [DEFAULT_JUDGE, VEC_ENDPOINT]);
    void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, "ep-j2");
    const svc = new StewardMemoryService({
      config: memoryConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_JUDGE_ENDPOINT_ID_KEY]: "ep-gone" }),
      embedding: fakeEmbedding(),
      embeddingConfig: lookup,
      store: fakeStore(),
      judge: fakeJudge(),
    });
    expect(svc.judgeSedimentAvailable()).toBe(false); // 悬空 = 未配（读面降级）
    expect(svc.getMemoryState().judgeEndpoint).toBeNull();
  });
});

// ── ② barge-in 停止判定消费面三档（E-305 judgeStopIntent） ────

function stubEngine(): AgentEnginePort {
  const fail = (): never => {
    throw new Error("judgeStopIntent 用例不应构造/驱动引擎");
  };
  return {
    start: fail,
    steer: fail,
    abort: fail,
    isStreaming: () => false,
  } as unknown as AgentEnginePort;
}

function stopServiceWith(judgeFace: ReturnType<typeof makeIntentFace>): StewardService {
  return new StewardService({
    llm: {
      modelId: "fake/none",
      complete: async () => {
        throw new Error("judgeStopIntent 用例不应调用 LLM");
      },
    },
    orchestration: { status: () => [], send: () => ({ delivered: false, detail: "n/a" }) },
    tasks: { listTasks: () => [] },
    config: memoryConfig(),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
    createEngine: () => stubEngine(),
    intentJudge: judgeFace,
    logger: { info: () => {}, warn: () => {} },
  });
}

describe("判官兜底层 × barge-in 停止判定（E-305）：显式 ＞ 默认 ＞ 缺席", () => {
  function faceWith(kv: Record<string, string>, records: readonly EmbeddingEndpointRecord[], defaultClassifierId?: string) {
    const { lookup, config } = lookupOf();
    seedEndpoints(config, records);
    if (defaultClassifierId !== undefined) void config.set(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY, defaultClassifierId);
    return {
      face: makeIntentFace({ config: memoryConfig(kv), embeddingConfig: lookup, judge: { noul: async () => 0.9 } }),
      cfg: memoryConfig(kv),
      lookup,
    };
  }

  test("① 显式 triage.judgeEndpointId 优先 → ready；judgeStopIntent 判定生效（判 stop）", async () => {
    const { face, cfg, lookup } = faceWith(
      { [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1", [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-j1" },
      [EXPLICIT_JUDGE, DEFAULT_JUDGE],
      "ep-j2",
    );
    expect(resolveTriageJudgeRecord(cfg, lookup)?.id).toBe("ep-j1"); // 显式优先于默认
    expect(face.ready()).toBe(true);
    const svc = stopServiceWith(face);
    const r = await svc.judgeStopIntent("停");
    expect(r.stop).toBe(true); // 判官在场 → 判定生效
    expect(r.degraded).toBeUndefined();
  });

  test("② 未配显式 → 兜底默认分类端点（有默认 = 判官在场）→ 判定生效", async () => {
    const { face, cfg, lookup } = faceWith(
      { [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1" },
      [EXPLICIT_JUDGE, DEFAULT_JUDGE],
      "ep-j2",
    );
    expect(resolveTriageJudgeRecord(cfg, lookup)?.id).toBe("ep-j2"); // 兜底默认端点
    expect(face.ready()).toBe(true);
    const svc = stopServiceWith(face);
    const r = await svc.judgeStopIntent("停");
    expect(r.stop).toBe(true);
    expect(r.degraded).toBeUndefined();
  });

  test("③ 无默认无显式 → 缺席降级维持现状（judgeStopIntent 判不出，fail-stop 归消费面）", async () => {
    const { face } = faceWith({ [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1" }, [EXPLICIT_JUDGE, VEC_ENDPOINT]);
    expect(face.ready()).toBe(false);
    const r = await stopServiceWith(face).judgeStopIntent("停");
    expect(r.stop).toBe(false);
    expect(r.degraded).toBe("unready"); // 现状：开关开但端点未配 = WARN 降级（语义不变）
    // 开关关 = 默认态零日志（现状 off 语义不变）
    const off = faceWith({}, [EXPLICIT_JUDGE, VEC_ENDPOINT]).face;
    expect(off.enabled()).toBe(false);
    const r2 = await stopServiceWith(off).judgeStopIntent("停");
    expect(r2.stop).toBe(false);
    expect(r2.degraded).toBe("off");
  });
});

/**
 * StewardMemoryService 单测——写入查重两段闸（B5）+ 判官面（B4a）+ 召回资格闸
 * 配置驱动（memory.recallMinScore）。纯位置迁移自 steward-memory-service.test.ts
 * （P1 体量门拆分批，测试逻辑与断言零改动）；共享夹具在
 * ./helpers/steward-memory-service-fixtures。
 */
import { describe, expect, test } from "bun:test";
import type { EmbeddingEndpointRecord } from "../../src/application/embedding/EmbeddingConfigService";
import type {
  StewardMemoryAppendItem,
  StewardMemoryEntry,
  StewardMemoryHit,
  StewardMemoryPort,
} from "../../src/application/ports/outbound/StewardMemoryPort";
import {
  StewardMemoryService,
  STEWARD_MEMORY_RECALL_MIN_SCORE,
  type EmbeddingConfigLookup,
} from "../../src/application/steward/StewardMemoryService";
import {
  MEMORY_ENABLED_KEY,
  MEMORY_JUDGE_ENDPOINT_ID_KEY,
  MEMORY_RECALL_MIN_SCORE_KEY,
  MEMORY_RECALL_TOP_K_KEY,
} from "../../src/application/memory/memoryConfig";
import {
  ENABLED_KV,
  ENDPOINT_RECORD,
  fakeConfig,
  fakeEmbedding,
  fakeJudgeTop,
  fakeLookup,
  judgeLookup,
  life,
} from "./helpers/steward-memory-service-fixtures";

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

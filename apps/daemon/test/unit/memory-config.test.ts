/**
 * 批B：长期记忆配置独立化 + 召回量配置驱动（memory.* 通用记忆配置域）。
 *
 * 断言面：
 * 1. 缺省零行为变化：未配置时 recallSection 候选池 = 24（store.search 入参）
 *    、注入条数上限 = 5（与定格常量时代等价）；
 * 2. 配置生效：KV 改写 memory.recallTopK / memory.recallPool 后按新值取数
 *    （topK=10 注入 ≤10 条；pool 生效于 store.search 入参）；
 * 3. 非法值回退：0 / 负数 / 非整数 / 非数字 / 超上界 / topK>pool 组合 →
 *    回退缺省 + 不抛错 + warn；
 * 4. 读写闭环：setMemoryConfig 写 recallTopK/recallPool → getMemoryState
 *    回显现值；steward.set_config memory 组类型校验 + 透传；
 * 5. 旧键迁移：steward.memory.* 三键 → memory.* 命名域（新域已有值不覆盖）
 *    + 清旧键 + 幂等可重跑；迁移后 getMemoryState 读面正确；
 * 6. 召回段文案含优先级声明句（知识图谱约束优先）。
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
  MEMORY_ENABLED_KEY,
  MEMORY_ENDPOINT_ID_KEY,
  MEMORY_JUDGE_ENDPOINT_ID_KEY,
  MEMORY_RECALL_TOP_K_KEY,
  MEMORY_RECALL_POOL_KEY,
  MEMORY_RECALL_TOP_K_DEFAULT,
  MEMORY_RECALL_POOL_DEFAULT,
  MEMORY_RECALL_POOL_MAX,
  LEGACY_STEWARD_MEMORY_ENABLED_KEY,
  LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY,
  LEGACY_STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY,
  migrateLegacyStewardMemoryKeys,
  resolveMemoryRecallParams,
} from "../../src/application/memory/memoryConfig";
import { StewardMemoryService, type EmbeddingConfigLookup } from "../../src/application/steward/StewardMemoryService";
import { handleStewardSetConfig } from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import type { StewardService } from "../../src/application/steward/StewardService";

// ── fakes ─────────────────────────────────────────────────────────

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

const EP_ID = "ep-bge";
const ENDPOINT_RECORD: EmbeddingEndpointRecord = {
  id: EP_ID,
  name: "Ollama 本地",
  baseUrl: "http://localhost:11434/v1",
  model: "bge-m3",
};
const JUDGE_RECORD: EmbeddingEndpointRecord = {
  id: "ep-jev",
  name: "Jev",
  baseUrl: "https://judge.example/v1",
  model: "jev-latest",
  kind: "classifier",
};

function fakeLookup(): EmbeddingConfigLookup {
  return {
    resolveRecord: (endpointId) =>
      endpointId === EP_ID ? ENDPOINT_RECORD : endpointId === JUDGE_RECORD.id ? JUDGE_RECORD : null,
  };
}

function fakeEmbedding(dim = 3): EmbeddingPort {
  return {
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      return {
        vectors: texts.map((_, i) => Float32Array.from({ length: dim }, (_v, j) => 0.1 * (i + j + 1))),
        dim,
      };
    },
  };
}

/** 记录 search 入参的 fake store（召回量配置断言面）。 */
function fakeStore(entryCount: number): StewardMemoryPort & { searched: number[]; entries: StewardMemoryEntry[] } {
  const entries: StewardMemoryEntry[] = Array.from({ length: entryCount }, (_, i) => ({
    id: i + 1,
    kind: (i % 2 === 0 ? "preference" : "fact") as "preference" | "fact",
    text: `条目 ${i + 1}`,
    source: "s",
    createdAt: i + 1,
    updatedAt: i + 1,
    lastRecalledAt: i + 1,
    recallCount: 0,
    fadedAt: 0,
    pinned: false,
  }));
  const searched: number[] = [];
  return {
    searched,
    entries,
    append: (_items: readonly StewardMemoryAppendItem[]) => {},
    search(_query: Float32Array, topK: number): readonly StewardMemoryHit[] {
      searched.push(topK);
      return entries.slice(0, topK).map((e) => ({ ...e, score: 0.9 }));
    },
    list: () => entries,
    forget: () => false,
    updateEntry: () => true,
    findProgressId: () => null,
    markRecalled: () => undefined,
    setPinned: () => false,
    restore: () => false,
    fadeMany: () => undefined,
    count: () => entries.length,
    storedDim: () => 3,
    resetVectors: () => undefined,
    putVector: () => undefined,
    close: () => undefined,
  };
}

function makeService(kv: Record<string, string>, entryCount = 7, warn: (m: string) => void = () => {}) {
  const store = fakeStore(entryCount);
  const service = new StewardMemoryService({
    config: fakeConfig({ [MEMORY_ENABLED_KEY]: "1", [MEMORY_ENDPOINT_ID_KEY]: EP_ID, ...kv }),
    embedding: fakeEmbedding(),
    embeddingConfig: fakeLookup(),
    store,
    logger: { warn },
  });
  return { service, store };
}

function countRecallLines(section: string): number {
  return section.split("\n").filter((line) => line.startsWith("- [")).length;
}

// ── 1-2/4. 召回量配置驱动 ─────────────────────────────────────────

describe("批B·召回量配置驱动（topK/pool 常量 → KV 配置）", () => {
  test("① 缺省零行为变化：未配置 → search 入参 24、注入上限 5", async () => {
    const { service, store } = makeService({});
    const section = await service.recallSection("怎么改代码风格");
    expect(store.searched).toEqual([MEMORY_RECALL_POOL_DEFAULT]); // 候选池 = 24（与现状等价）
    expect(countRecallLines(section!)).toBe(MEMORY_RECALL_TOP_K_DEFAULT); // 注入上限 = 5（与现状等价）
  });

  test("② 配置生效：KV 改写 topK/pool → 按新值取数（topK=10 注入 ≤10；pool 生效于 search 入参）", async () => {
    const { service, store } = makeService(
      { [MEMORY_RECALL_TOP_K_KEY]: "10", [MEMORY_RECALL_POOL_KEY]: "40" },
      12,
    );
    const section = await service.recallSection("怎么改代码风格");
    expect(store.searched).toEqual([40]); // pool 生效于 store.search 入参
    expect(countRecallLines(section!)).toBe(10); // topK=10 注入 10 条（库内 12 条够取）
    // 小值同样生效
    const { service: s2, store: st2 } = makeService({ [MEMORY_RECALL_TOP_K_KEY]: "2" }, 12);
    const sec2 = await s2.recallSection("x");
    expect(countRecallLines(sec2!)).toBe(2);
    expect(st2.searched).toEqual([MEMORY_RECALL_POOL_DEFAULT]); // pool 未配 = 缺省 24
  });

  test("③ 非法值静默回退缺省 + warn + 不抛错（0/负数/非整数/非数字/超上界/topK>pool）", async () => {
    for (const bad of ["0", "-3", "3.5", "abc", ""]) {
      const warns: string[] = [];
      const { service, store } = makeService({ [MEMORY_RECALL_TOP_K_KEY]: bad }, 7, (m) => warns.push(m));
      const section = await service.recallSection("x");
      expect(section).toBeDefined(); // 不抛错、不挡对话
      expect(countRecallLines(section!)).toBe(MEMORY_RECALL_TOP_K_DEFAULT);
      expect(store.searched).toEqual([MEMORY_RECALL_POOL_DEFAULT]);
      if (bad !== "") expect(warns.length).toBeGreaterThan(0); // 清空 = 未配置态不 warn
    }
    // pool 非法（超上界 200）→ 回退缺省 24
    const poolWarns: string[] = [];
    const { service: sp, store: stp } = makeService(
      { [MEMORY_RECALL_POOL_KEY]: String(MEMORY_RECALL_POOL_MAX + 1) },
      7,
      (m) => poolWarns.push(m),
    );
    expect(await sp.recallSection("x")).toBeDefined();
    expect(stp.searched).toEqual([MEMORY_RECALL_POOL_DEFAULT]);
    expect(poolWarns.length).toBeGreaterThan(0);
    // 组合非法 topK>pool → 整对回退缺省（5/24）
    const pairWarns: string[] = [];
    const { service: sq, store: stq } = makeService(
      { [MEMORY_RECALL_TOP_K_KEY]: "10", [MEMORY_RECALL_POOL_KEY]: "4" },
      7,
      (m) => pairWarns.push(m),
    );
    const secq = await sq.recallSection("x");
    expect(countRecallLines(secq!)).toBe(MEMORY_RECALL_TOP_K_DEFAULT);
    expect(stq.searched).toEqual([MEMORY_RECALL_POOL_DEFAULT]);
    expect(pairWarns.length).toBeGreaterThan(0);
  });

  test("④ 读写闭环：setMemoryConfig 写 recallTopK/recallPool → getMemoryState 回显现值", async () => {
    const { service } = makeService({});
    const before = service.getMemoryState();
    expect(before.recallTopK).toBe(MEMORY_RECALL_TOP_K_DEFAULT);
    expect(before.recallPool).toBe(MEMORY_RECALL_POOL_DEFAULT);
    const outcome = await service.setMemoryConfig({ recallTopK: 10, recallPool: 40 });
    expect(outcome.ok).toBe(true);
    const after = service.getMemoryState();
    expect(after.recallTopK).toBe(10);
    expect(after.recallPool).toBe(40);
    // 写面直出 KV（值语义由读面 resolver 统一裁决）
    const config = fakeConfig();
    const svc2 = new StewardMemoryService({
      config,
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: fakeStore(0),
    });
    await svc2.setMemoryConfig({ recallTopK: 3 });
    expect(config.kv.get(MEMORY_RECALL_TOP_K_KEY)).toBe("3");
  });
});

// ── 5. 旧键一次性迁移 ────────────────────────────────────────────

describe("批B·旧键一次性迁移（steward.memory.* → memory.* 命名域）", () => {
  test("⑤ 三键迁移 + 清旧键 + 幂等（跑两次结果一致）+ 新域已有值不覆盖", async () => {
    const config = fakeConfig({
      [LEGACY_STEWARD_MEMORY_ENABLED_KEY]: "1",
      [LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY]: EP_ID,
      [LEGACY_STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id,
    });
    expect(await migrateLegacyStewardMemoryKeys(config)).toBe(true);
    expect(config.kv.get(MEMORY_ENABLED_KEY)).toBe("1");
    expect(config.kv.get(MEMORY_ENDPOINT_ID_KEY)).toBe(EP_ID);
    expect(config.kv.get(MEMORY_JUDGE_ENDPOINT_ID_KEY)).toBe(JUDGE_RECORD.id);
    // 清旧键（空串 = 未配置态）
    expect(config.kv.get(LEGACY_STEWARD_MEMORY_ENABLED_KEY)).toBe("");
    expect(config.kv.get(LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBe("");
    expect(config.kv.get(LEGACY_STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY)).toBe("");
    // 幂等：跑两次结果一致（零动作）
    const snapshot = new Map(config.kv);
    expect(await migrateLegacyStewardMemoryKeys(config)).toBe(false);
    expect([...config.kv.entries()].sort()).toEqual([...snapshot.entries()].sort());
    // 新域已有值不覆盖（防覆盖），旧键仍清
    const conflict = fakeConfig({
      [MEMORY_ENDPOINT_ID_KEY]: "ep-new",
      [LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY]: EP_ID,
      [LEGACY_STEWARD_MEMORY_ENABLED_KEY]: "1",
    });
    expect(await migrateLegacyStewardMemoryKeys(conflict)).toBe(true); // enabled 迁了
    expect(conflict.kv.get(MEMORY_ENDPOINT_ID_KEY)).toBe("ep-new"); // 新域优先
    expect(conflict.kv.get(LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY)).toBe("");
  });

  test("⑥ 迁移后 getMemoryState/配置读面正确（enabled/endpoint/judgeEndpoint 走新域）", async () => {
    const config = fakeConfig({
      [LEGACY_STEWARD_MEMORY_ENABLED_KEY]: "1",
      [LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY]: EP_ID,
      [LEGACY_STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY]: JUDGE_RECORD.id,
    });
    await migrateLegacyStewardMemoryKeys(config);
    const service = new StewardMemoryService({
      config,
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: fakeStore(3),
    });
    const state = service.getMemoryState();
    expect(state.enabled).toBe(true);
    expect(state.available).toBe(true);
    expect(state.endpoint?.id).toBe(EP_ID);
    expect(state.judgeEndpoint?.id).toBe(JUDGE_RECORD.id);
  });
});

// ── 6. 召回段权威声明句 ──────────────────────────────────────────

describe("批B·召回段优先级声明", () => {
  test("⑦ 召回段头含权威声明：涉及代码/项目现实以知识图谱约束为准，本段只提供用户偏好与工作状态参考", async () => {
    const { service } = makeService({});
    const section = await service.recallSection("怎么改代码风格");
    expect(section).toContain("涉及代码/项目现实以知识图谱约束为准");
    expect(section).toContain("本段只提供用户偏好与工作状态参考");
    // 原参考性声明保留（既有断言面不回归）
    expect(section).toContain("以本轮指令为准");
    expect(section).toContain("## 长期记忆");
  });
});

// ── 4b. steward.set_config memory 组转发（协议写面闭环）───────────

describe("批B·steward.set_config memory 组（转发 memory.* 域）", () => {
  function setConfigCtx(payload: Record<string, unknown>): {
    errors: string[];
    patches: Record<string, unknown>[];
  } {
    const errors: string[] = [];
    const patches: Record<string, unknown>[] = [];
    const service = {
      setConfig: async (patch: Record<string, unknown>) => {
        patches.push(patch);
        return { ok: true };
      },
      getConfig: () => ({}),
    } as unknown as StewardService;
    const ctx = {
      ws: { data: { sender: { id: "conn-1" } } },
      type: "steward.set_config",
      payload,
      steward: { service, stream: { subscribeSteward: () => {}, unsubscribeSteward: () => {} } },
      commandError: (_t: string, _c: string, message: string) => {
        errors.push(message);
      },
      rawSender: () => ({ id: "conn-1" }),
      sendNow: () => {},
    } as unknown as StewardCommandContext;
    handleStewardSetConfig(ctx);
    return { errors, patches };
  }

  test("⑧ memory 组 recallTopK/recallPool 类型校验 + 逐字段透传", async () => {
    const ok = setConfigCtx({ memory: { enabled: true, recallTopK: 10, recallPool: 40 } });
    expect(ok.errors).toEqual([]);
    await Bun.sleep(0); // setConfig 异步落账
    expect(ok.patches).toEqual([{ memory: { enabled: true, recallTopK: 10, recallPool: 40 } }]);
    // 类型非法 → invalid_payload（类型闸；值语义由读面 resolver 静默回退）
    const badTopK = setConfigCtx({ memory: { recallTopK: "10" } });
    expect(badTopK.errors.length).toBe(1);
    expect(badTopK.errors[0]).toContain("recallTopK");
    expect(badTopK.patches).toEqual([]);
    const badPool = setConfigCtx({ memory: { recallPool: null } });
    expect(badPool.errors.length).toBe(1);
    expect(badPool.errors[0]).toContain("recallPool");
    // 既有槽位不受影响
    const legacy = setConfigCtx({ memory: { endpointId: "ep-1" } });
    expect(legacy.errors).toEqual([]);
    await Bun.sleep(0);
    expect(legacy.patches).toEqual([{ memory: { endpointId: "ep-1" } }]);
  });
});

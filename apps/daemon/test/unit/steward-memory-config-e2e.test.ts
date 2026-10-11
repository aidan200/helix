/**
 * 长期记忆设置组写路径端到端单测（设置页「长期记忆」组批）。
 *
 * 断言面（UI → steward.set_config 协议 → memoryConfig 生效值回显——真实
 * StewardService + 真实 StewardMemoryService 全链，仅出站依赖 fake）：
 * 1. 五键写入：payload.memory {enabled,endpointId,judgeEndpointId,recallTopK,
 *    recallPool} → memory.* KV 落值 + steward.config.result 回执 memory 组
 *    携带生效值（所见即所得）；
 * 2. 类型闸完备性：judgeEndpointId 非字符串 → invalid_payload 拒答零写入
 *    （现行闸漏该键——本批补闸的 TDD 红点）；enabled/endpointId/recallTopK/
 *    recallPool 非法类型照旧拒答；
 * 3. 值语义读面兜底回显：recallTopK 负数（类型合法、值非法）落 KV 后回执
 *    回显缺省生效值 5（写面不拒写——resolver 静默回退，E-261 哲学）；
 * 4. 组合非法整对回退：recallTopK > recallPool → 回执整对回退 5/24。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { EventEnvelope } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardMemoryService } from "../../src/application/steward/StewardMemoryService";
import type { EmbeddingConfigLookup } from "../../src/application/steward/StewardMemoryService";
import type { StewardMemoryPort } from "../../src/application/ports/outbound/StewardMemoryPort";
import { handleStewardSetConfig } from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import {
  MEMORY_ENABLED_KEY,
  MEMORY_ENDPOINT_ID_KEY,
  MEMORY_JUDGE_ENDPOINT_ID_KEY,
  MEMORY_RECALL_POOL_KEY,
  MEMORY_RECALL_TOP_K_KEY,
  MEMORY_RECALL_MIN_SCORE_KEY,
} from "../../src/application/memory/memoryConfig";

// ── fakes（steward-memory-service.test.ts / config-summary-handler.test.ts 同款收窄面）──

function noopLlm(): StewardLlmPort {
  return {
    modelId: "deepseek/deepseek-v4-flash",
    async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
      throw new Error("配置面零 LLM 调用");
    },
  };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

function fakeLookup(): EmbeddingConfigLookup {
  return {
    resolveRecord: (endpointId) =>
      endpointId === "ep-bge"
        ? { id: "ep-bge", name: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "bge-m3" }
        : null,
    resolveDefault: () => ({ baseUrl: "http://localhost:11434/v1", model: "bge-m3" }),
    resolveDefaultClassifierRecord: () => null,
  };
}

function fakeEmbedding(): EmbeddingPort {
  return {
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      return {
        vectors: texts.map((_, i) => Float32Array.from({ length: 3 }, (_v, j) => 0.1 * (i + j + 1))),
        dim: 3,
      };
    },
  };
}

function fakeStore(): StewardMemoryPort {
  return {
    append: () => {},
    search: () => [],
    list: () => [],
    forget: () => false,
    updateEntry: () => false,
    findProgressId: () => null,
    markRecalled: () => {},
    setPinned: () => false,
    restore: () => false,
    fadeMany: () => {},
    count: () => 0,
    storedDim: () => null,
    resetVectors: () => {},
    putVector: () => {},
    close: () => {},
  };
}

function makeService(config: RuntimeConfigPort): StewardService {
  return new StewardService({
    llm: noopLlm(),
    orchestration: { status: () => [], send: () => ({ delivered: false, detail: "配置面零写注入" }) },
    tasks: { listTasks: () => [] },
    config,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
    createEngine: createEngineFromPort(noopLlm()),
    memory: new StewardMemoryService({
      config,
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    }),
  });
}

function stewardCtxOf(
  service: StewardService,
  payload: Record<string, unknown>,
): { ctx: StewardCommandContext; frames: EventEnvelope[]; errors: { code: string; message: string }[] } {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type: "steward.set_config",
    payload,
    steward: {
      service,
      stream: { subscribeSteward: () => {}, unsubscribeSteward: () => {} },
    },
    commandError: (_type: string, code: string, message: string) => {
      errors.push({ code, message });
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as StewardCommandContext;
  return { ctx, frames, errors };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ── 五键写入端到端 ─────────────────────────────────────────

describe("长期记忆组写路径端到端（steward.set_config memory 组 → memory.* 生效值回显）", () => {
  test("① 四键写入：payload.memory → memory.* KV 落值 + 回执 memory 组携带生效值（批1：endpointId 退役）", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      memory: { enabled: true, judgeEndpointId: "ep-jev-x", recallTopK: 8, recallPool: 32 },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    // KV 落值（memoryConfig 键位单源）
    expect(config.kv.get(MEMORY_ENABLED_KEY)).toBe("1");
    expect(config.kv.get(MEMORY_ENDPOINT_ID_KEY)).toBeUndefined(); // 退役键零写入
    expect(config.kv.get(MEMORY_JUDGE_ENDPOINT_ID_KEY)).toBe("ep-jev-x");
    expect(config.kv.get(MEMORY_RECALL_TOP_K_KEY)).toBe("8");
    expect(config.kv.get(MEMORY_RECALL_POOL_KEY)).toBe("32");
    // 回执所见即所得（steward.config.result.memory 生效值——设置页回填数据源）
    expect(frames).toHaveLength(1);
    const frame = frames[0] as {
      type: string;
      payload: { memory: { enabled: boolean; recallTopK?: number; recallPool?: number } };
    };
    expect(frame.type).toBe("steward.config.result");
    expect(frame.payload.memory.enabled).toBe(true);
    expect(frame.payload.memory.recallTopK).toBe(8);
    expect(frame.payload.memory.recallPool).toBe(32);
  });

  test("①b memory 组 endpointId 退役兼容（批1）：旧传值静默忽略（含非法类型不拒答）+ 回执不回 endpointId", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      memory: { enabled: true, endpointId: 42 },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(0); // 静默忽略（additive 兼容，不拒答）
    expect(config.kv.get(MEMORY_ENDPOINT_ID_KEY)).toBeUndefined(); // 不落值
    expect(config.kv.get(MEMORY_ENABLED_KEY)).toBe("1"); // 其余字段照常
    const frame = frames[0] as { payload: { memory: Record<string, unknown> } };
    expect("endpoint" in frame.payload.memory).toBe(false); // 回执不再回 endpointId
    expect("endpointId" in frame.payload.memory).toBe(false);
  });

  test("② 类型闸：judgeEndpointId 非字符串 → invalid_payload 拒答零写入（闸漏键回归）", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      memory: { judgeEndpointId: 123 },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("command.invalid_payload");
    expect(errors[0]!.message).toContain("judgeEndpointId");
    expect(config.kv.get(MEMORY_JUDGE_ENDPOINT_ID_KEY)).toBeUndefined(); // 拒答零写入
    expect(frames).toHaveLength(0);
  });

  test("③ 其余三键类型闸照旧：非法类型 → invalid_payload（逐键；endpointId 不在此列——退役静默忽略）", async () => {
    for (const [payload, needle] of [
      [{ memory: { enabled: "yes" } }, "memory.enabled"],
      [{ memory: { recallTopK: "8" } }, "memory.recallTopK"],
      [{ memory: { recallPool: null } }, "memory.recallPool"],
    ] as [Record<string, unknown>, string][]) {
      const config = fakeConfig();
      const { ctx, errors } = stewardCtxOf(makeService(config), payload);
      handleStewardSetConfig(ctx);
      await settle();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("command.invalid_payload");
      expect(errors[0]!.message).toContain(needle);
      expect(config.kv.size).toBe(0);
    }
  });

  test("④ 值语义读面兜底：recallTopK 负数（类型合法值非法）落 KV → 回执回显缺省生效值 5", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      memory: { recallTopK: -3 },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(0); // 写面不拒写（值语义读面兜底——E-261）
    expect(config.kv.get(MEMORY_RECALL_TOP_K_KEY)).toBe("-3"); // 原值落库
    const frame = frames[0] as { payload: { memory: { recallTopK?: number; recallPool?: number } } };
    expect(frame.payload.memory.recallTopK).toBe(5); // 回显生效值（resolver 静默回退缺省）
    expect(frame.payload.memory.recallPool).toBe(24);
  });

  test("⑤ 组合非法整对回退：recallTopK 99 > recallPool 24 → 回执整对回显 5/24", async () => {
    const config = fakeConfig();
    const { ctx, frames } = stewardCtxOf(makeService(config), {
      memory: { recallTopK: 99 },
    });
    handleStewardSetConfig(ctx);
    await settle();
    const frame = frames[0] as { payload: { memory: { recallTopK?: number; recallPool?: number } } };
    expect(frame.payload.memory.recallTopK).toBe(5);
    expect(frame.payload.memory.recallPool).toBe(24);
  });

  test("⑥ recallMinScore additive 写入闭环：{recallMinScore:0.5} → KV 落值 + 回执生效值 0.5；非法值 1.5 落 KV 后回执回显缺省 0.3", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      memory: { recallMinScore: 0.5 },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    expect(config.kv.get(MEMORY_RECALL_MIN_SCORE_KEY)).toBe("0.5");
    const frame = frames[0] as { payload: { memory: { recallMinScore?: number } } };
    expect(frame.payload.memory.recallMinScore).toBe(0.5);
    // 值非法（>1、类型合法）→ 写面不拒写、回执回显缺省生效值（所见即所得）
    const config2 = fakeConfig();
    const second = stewardCtxOf(makeService(config2), {
      memory: { recallMinScore: 1.5 },
    });
    handleStewardSetConfig(second.ctx);
    await settle();
    expect(second.errors).toHaveLength(0);
    expect(config2.kv.get(MEMORY_RECALL_MIN_SCORE_KEY)).toBe("1.5");
    const frame2 = second.frames[0] as { payload: { memory: { recallMinScore?: number } } };
    expect(frame2.payload.memory.recallMinScore).toBe(0.3);
  });

  test("⑦ recallMinScore 类型闸：非 number → invalid_payload 拒答零写入", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      memory: { recallMinScore: "0.5" },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("command.invalid_payload");
    expect(errors[0]!.message).toContain("recallMinScore");
    expect(config.kv.get(MEMORY_RECALL_MIN_SCORE_KEY)).toBeUndefined();
    expect(frames).toHaveLength(0);
  });
});

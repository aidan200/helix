/**
 * 管家配置运行期化批单测（TDD）。
 *
 * 断言面（任务 brief 测试要求）：
 * 1. 默认层 setConfig {model}：KV 落库 + 引擎在场时 setModel 直改同步
 *    （下一问生效）；引擎未装配（无对话）= 只写 KV 不炸，下一问装配读新值。
 * 2. 默认层 setConfig {thinking}：KV 落库 + 引擎临时 override 清空
 *    （空串 = 链缺位——生效档回落新 KV；不清则旧临时档遮蔽新默认）。
 * 3. 临时层 setModel：引擎未装配 → 拒答；引擎在场 → 内存直改（currentModel
 *    观测变化）不落 KV；thinking 空串 = 清临时档。
 * 4. 读面双位：getConfig/getProfile 携 thinking/currentModel/currentThinking
 *    （无引擎 = current 同默认层、override null）。
 * 5. 默认值修正：STEWARD_DEFAULT_MODEL 在 pi-ai 目录内可解析（装配不炸）。
 */
import { describe, expect, test } from "bun:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, Models } from "@earendil-works/pi-ai";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import { StewardService } from "../../src/application/steward/StewardService";
import { STEWARD_THINKING_KEY } from "../../src/application/steward/stewardConstants";
import { STEWARD_DEFAULT_MODEL } from "../../src/adapters/driven/loop/PiStewardLlmAdapter";
import { buildStewardEngine } from "../../src/adapters/driven/steward/StewardEngineBuilder";
import { createEngineFromPort, fakeStewardModel, portScriptStreamFn } from "../helpers/steward/portScriptEngine";

// ── fakes（steward-service-a2.test.ts 同款收窄面） ──────────────

function scriptLlm(): StewardLlmPort {
  return {
    modelId: STEWARD_DEFAULT_MODEL,
    async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
      return { kind: "blocks", blocks: [{ type: "text", text: "好的" }], stopReason: "stop" };
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

function makeService(config: RuntimeConfigPort): StewardService {
  return new StewardService({
    llm: scriptLlm(),
    createEngine: createEngineFromPort(scriptLlm()),
    orchestration: {
      status: () => [],
      send: () => ({ delivered: false, detail: "测试零写注入" }),
    },
    tasks: { listTasks: () => [] },
    config,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
  });
}

/** 精确匹配目录形态（setModel("fake/other") 可解析为独立模型——共享 helper
 *  的 fakeStewardModels.getModel 恒返回同一 model，无法断言换模后 currentModel
 *  变化；本形态仅供临时层断言，其余用 makeService）。 */
function makeServiceWithExactCatalog(config: RuntimeConfigPort): StewardService {
  const exactCatalog = {
    getModel: (provider: string, id: string) =>
      provider === "fake" ? ({ ...fakeStewardModel, id } as Model<any>) : undefined,
    getModels: () => [fakeStewardModel],
    streamSimple: () => {
      throw new Error("不应走到真实流（剧本流已接 streamFnOverride）");
    },
  } as unknown as Models;
  const llm = scriptLlm();
  return new StewardService({
    llm,
    createEngine: (opts) =>
      buildStewardEngine({
        systemPrompt: opts.systemPrompt,
        model: fakeStewardModel,
        apiKeys: { fake: "key" },
        models: exactCatalog,
        tools: opts.tools,
        gatedTools: opts.gatedTools,
        persistentListener: opts.persistentListener,
        ...(opts.initialMessages.length > 0 ? { initialMessages: opts.initialMessages } : {}),
        streamFnOverride: portScriptStreamFn(llm),
      }),
    orchestration: {
      status: () => [],
      send: () => ({ delivered: false, detail: "测试零写注入" }),
    },
    tasks: { listTasks: () => [] },
    config,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
  });
}

describe("默认层：setConfig {model} 运行期接线", () => {
  test("引擎未装配：只写 KV 不炸（下一问装配自然读新值）", async () => {
    const cfg = fakeConfig({ "steward.enabled": "1" });
    const svc = makeService(cfg);
    const outcome = await svc.setConfig({ model: "deepseek/deepseek-flash" });
    expect(outcome.ok).toBe(true);
    expect(cfg.kv.get("steward.model")).toBe("deepseek/deepseek-flash");
  });

  test("引擎在场：KV 落库 + currentModel 即时跟随（setModel 直改观测面）", async () => {
    const cfg = fakeConfig({ "steward.enabled": "1" });
    const svc = makeService(cfg);
    await svc.ask("你好"); // 装配引擎（懒构造）
    expect(svc.getConfig().currentModel).toBeTruthy();
    await svc.setConfig({ model: "fake/model" });
    expect(cfg.kv.get("steward.model")).toBe("fake/model");
    // 引擎 setModel 直改——currentModel 即时变（无需弃引擎）
    expect(svc.getConfig().currentModel).toBe("fake/model");
    expect(svc.getConfig().model).toBe("fake/model");
  });
});

describe("默认层：setConfig {thinking}", () => {
  test("KV 落库（空串 = 未设）+ getConfig 双位回显", async () => {
    const cfg = fakeConfig({ "steward.enabled": "1" });
    const svc = makeService(cfg);
    await svc.setConfig({ thinking: "high" });
    expect(cfg.kv.get(STEWARD_THINKING_KEY)).toBe("high");
    expect(svc.getConfig().thinking).toBe("high");
    // 清除回默认
    await svc.setConfig({ thinking: "" });
    expect(cfg.kv.get(STEWARD_THINKING_KEY)).toBe("");
    expect(svc.getConfig().thinking).toBe("");
  });

  test("引擎在场：默认层变更清临时 override（观测面 override 归 null）", async () => {
    const cfg = fakeConfig({ "steward.enabled": "1" });
    const svc = makeService(cfg);
    await svc.ask("你好");
    // 先临时设档
    svc.setModel({ model: "fake/model", thinking: "max" });
    expect(svc.getConfig().currentThinking).toBe("max");
    // 默认层变更 → 临时档被清（回落新默认，不遮蔽）
    await svc.setConfig({ thinking: "low" });
    expect(svc.getConfig().currentThinking).toBeNull();
    expect(svc.getConfig().thinking).toBe("low");
  });
});

describe("临时层：setModel（引擎内存直改，不落 KV）", () => {
  test("引擎未装配 → 拒答（临时层无载体）", () => {
    const cfg = fakeConfig({ "steward.enabled": "1" });
    const svc = makeService(cfg);
    const outcome = svc.setModel({ model: "fake/model" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("尚未开始对话");
    // KV 不受影响
    expect(cfg.kv.get("steward.model")).toBeUndefined();
  });

  test("引擎在场：currentModel 直改 + KV 不落（默认层不动）", async () => {
    const cfg = fakeConfig({ "steward.enabled": "1" });
    const svc = makeServiceWithExactCatalog(cfg);
    await svc.ask("你好");
    const outcome = svc.setModel({ model: "fake/other", thinking: "high" });
    expect(outcome.ok).toBe(true);
    // 临时态观测：current ≠ default
    expect(svc.getConfig().currentModel).toBe("fake/other");
    expect(svc.getConfig().currentThinking).toBe("high");
    // 默认层不动（未落 KV）
    expect(cfg.kv.get("steward.model")).toBeUndefined();
    expect(cfg.kv.get(STEWARD_THINKING_KEY)).toBeUndefined();
  });

  test("thinking 空串 = 清临时档（override 归 null）", async () => {
    const cfg = fakeConfig({ "steward.enabled": "1" });
    const svc = makeServiceWithExactCatalog(cfg);
    await svc.ask("你好");
    svc.setModel({ model: "fake/model", thinking: "high" });
    expect(svc.getConfig().currentThinking).toBe("high");
    svc.setModel({ model: "fake/model", thinking: "" });
    expect(svc.getConfig().currentThinking).toBeNull();
  });
});

describe("读面双位：getProfile", () => {
  test("未设 KV：model/thinking = null；无引擎：current 同默认层", () => {
    const svc = makeService(fakeConfig({}));
    const p = svc.getProfile();
    expect(p.model).toBeNull();
    expect(p.thinking).toBeNull();
    expect(p.currentModel).toBeNull();
    expect(p.currentThinking).toBeNull();
    // JSON 序列化面字段不丢
    expect(JSON.parse(JSON.stringify(p)).thinking).toBeNull();
  });

  test("KV 已设 + 引擎在场：双位分离可见", async () => {
    const cfg = fakeConfig({ "steward.enabled": "1", "steward.model": "fake/model" });
    const svc = makeServiceWithExactCatalog(cfg);
    await svc.ask("你好");
    const p = svc.getProfile();
    expect(p.model).toBe("fake/model");
    expect(p.currentModel).toBe("fake/model"); // 未临时换模 = 同默认
    svc.setModel({ model: "fake/other" });
    expect(svc.getProfile().currentModel).toBe("fake/other");
    expect(svc.getProfile().model).toBe("fake/model"); // 默认层不动
  });
});

describe("默认值修正：STEWARD_DEFAULT_MODEL 目录可达", () => {
  test("在 pi-ai builtin 目录内（引擎装配不 fail-fast）", () => {
    const models = builtinModels();
    const slash = STEWARD_DEFAULT_MODEL.indexOf("/");
    const provider = STEWARD_DEFAULT_MODEL.slice(0, slash);
    const id = STEWARD_DEFAULT_MODEL.slice(slash + 1);
    expect(models.getModel(provider, id)).toBeTruthy();
  });
});

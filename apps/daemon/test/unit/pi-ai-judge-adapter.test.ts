/**
 * PiAiJudgeAdapter 单测（pi-ai 分类器 variant——fake Models 目录，零网络）。
 *
 * 断言面：
 * 1. noul 成功：目录解析 "provider/model-id"（classifier 型）→ classify 调用
 *    面（state 包装 text / bool 问题 instructions / apiKey 透传）→ bool
 *    probability 直接回传（与 Jev noul 同语义的校准概率）；
 * 2. key 优先级：端点记录 apiKey > provider key（auth.json）；都无 → 中文
 *    抛错指向设置页（PiStewardLlmAdapter 同款文案惯例）；
 * 3. 失败语义：stopReason error → 抛 errorMessage（classify 不 reject——
 *    pi-ai 契约，错误在结果里）；缺 answers.q / 概率越界 → 抛错定位；
 * 4. 模型形态：非 classifier 型 / 解析失败 → 抛错；
 * 5. 未配置 → 抛错降级（零 classify 调用）。
 */
import { describe, expect, test } from "bun:test";
import type { ClassifierContext, ClassifierModel, ClassifierResult, Models } from "@earendil-works/pi-ai";
import { PiAiJudgeAdapter } from "../../src/adapters/driven/embedding/PiAiJudgeAdapter";
import type { JudgeRecord } from "../../src/adapters/driven/embedding/JudgeAdapterFactory";

/** 目录条目（最小 classifier/chat 模型形态）。 */
interface FakeEntry {
  provider: string;
  id: string;
  type?: "classifier" | "chat";
}

/** 可控 fake Models（目录解析 + classify 调用记录）。 */
function fakeModels(entries: FakeEntry[], classifyImpl?: (model: unknown, context: ClassifierContext, options?: unknown) => Promise<ClassifierResult>) {
  const classifyCalls: { model: unknown; context: ClassifierContext; options?: unknown }[] = [];
  const models = {
    getModel: (provider: string, id: string) => entries.find((e) => e.provider === provider && e.id === id) as never,
    getModels: (provider?: string) =>
      (provider === undefined ? entries : entries.filter((e) => e.provider === provider)).map((e) => ({ id: e.id })) as never,
    classify: async (model: unknown, context: ClassifierContext, options?: unknown) => {
      classifyCalls.push({ model, context, options });
      if (classifyImpl === undefined) throw new Error("classify 未预设");
      return classifyImpl(model, context, options);
    },
  };
  return { models: models as unknown as Models, classifyCalls };
}

/** 预设 classify 结果（bool 概率 / error 形态）。 */
function boolResult(probability: number, model: FakeEntry): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: model.provider,
    model: model.id,
    answers: { q: { type: "bool", probability } },
    stopReason: "stop",
    timestamp: 0,
  };
}

const JEV: FakeEntry = { provider: "typesafe", id: "jev-latest", type: "classifier" };
const CHAT: FakeEntry = { provider: "deepseek", id: "deepseek-v4-flash", type: "chat" };
const CFG: JudgeRecord = { baseUrl: "pi-ai", model: "typesafe/jev-latest", variant: "pi-ai" };

describe("PiAiJudgeAdapter：noul 判定（pi-ai 分类器通道）", () => {
  test("成功：目录解析 + bool 问题 + probability 透传 + provider key 兑底", async () => {
    const fm = fakeModels([JEV, CHAT], async (model) => boolResult(0.72, JEV));
    const adapter = new PiAiJudgeAdapter({
      getModels: () => fm.models,
      getConfig: () => CFG,
      getApiKey: (provider) => (provider === "typesafe" ? "auth-json-key" : undefined),
    });
    const prob = await adapter.noul("对话片段", "是否包含新信息？");
    expect(prob).toBeCloseTo(0.72);
    // 调用面：bool 问题 + instructions 透传 + state 包装 + apiKey 兜底
    expect(fm.classifyCalls).toHaveLength(1);
    const ctx = fm.classifyCalls[0]!.context;
    expect((ctx.state as { text?: string }).text).toBe("对话片段");
    expect(ctx.questions.q).toMatchObject({ type: "bool", instructions: "是否包含新信息？" });
    expect((fm.classifyCalls[0]!.options as { apiKey?: string }).apiKey).toBe("auth-json-key");
    // 模型解析：目录 classifier 条目
    expect((fm.classifyCalls[0]!.model as ClassifierModel<"typesafe-system-one">).id).toBe("jev-latest");
  });

  test("key 优先级：端点记录 apiKey 覆盖 provider key", async () => {
    const fm = fakeModels([JEV], async () => boolResult(0.5, JEV));
    const adapter = new PiAiJudgeAdapter({
      getModels: () => fm.models,
      getConfig: () => ({ ...CFG, apiKey: "record-key" }),
      getApiKey: () => "auth-json-key",
    });
    await adapter.noul("s", "q");
    expect((fm.classifyCalls[0]!.options as { apiKey?: string }).apiKey).toBe("record-key");
  });

  test("双 key 缺失 → 中文抛错指向设置页（零 classify 调用）", async () => {
    const fm = fakeModels([JEV], async () => boolResult(0.5, JEV));
    const adapter = new PiAiJudgeAdapter({
      getModels: () => fm.models,
      getConfig: () => CFG,
      getApiKey: () => undefined,
    });
    let message = "";
    try {
      await adapter.noul("s", "q");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("API key");
    expect(message).toContain("auth.set_key");
    expect(fm.classifyCalls).toHaveLength(0);
  });

  test("classify 结果 stopReason=error → 抛 errorMessage（pi-ai 不 reject 契约）", async () => {
    const fm = fakeModels([JEV], async () => ({ ...boolResult(0, JEV), stopReason: "error", errorMessage: "HTTP 401: invalid key" }) as ClassifierResult);
    const adapter = new PiAiJudgeAdapter({
      getModels: () => fm.models,
      getConfig: () => CFG,
      getApiKey: () => "k",
    });
    let message = "";
    try {
      await adapter.noul("s", "q");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("401");
  });

  test("协议形态异常：缺 answers.q / 概率越界 → 抛错定位", async () => {
    const missing = fakeModels([JEV], async () => ({ ...boolResult(0.5, JEV), answers: {} }) as ClassifierResult);
    const a1 = new PiAiJudgeAdapter({ getModels: () => missing.models, getConfig: () => CFG, getApiKey: () => "k" });
    expect(a1.noul("s", "q")).rejects.toThrow("answers");

    const overflow = fakeModels([JEV], async () => boolResult(1.5, JEV));
    const a2 = new PiAiJudgeAdapter({ getModels: () => overflow.models, getConfig: () => CFG, getApiKey: () => "k" });
    expect(a2.noul("s", "q")).rejects.toThrow("概率");
  });

  test("模型形态：非 classifier 型 → 抛错（classify 拒收 chat 模型）", async () => {
    const fm = fakeModels([CHAT], async () => boolResult(0.5, CHAT));
    const adapter = new PiAiJudgeAdapter({
      getModels: () => fm.models,
      getConfig: () => ({ ...CFG, model: "deepseek/deepseek-v4-flash" }),
      getApiKey: () => "k",
    });
    let message = "";
    try {
      await adapter.noul("s", "q");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("分类模型");
    expect(fm.classifyCalls).toHaveLength(0);
  });

  test("模型解析失败（不在目录）→ 抛错含模型串", async () => {
    const fm = fakeModels([JEV], async () => boolResult(0.5, JEV));
    const adapter = new PiAiJudgeAdapter({
      getModels: () => fm.models,
      getConfig: () => ({ ...CFG, model: "typesafe/unknown-model" }),
      getApiKey: () => "k",
    });
    let message = "";
    try {
      await adapter.noul("s", "q");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("判官模型解析失败");
    expect(message).toContain("typesafe/unknown-model");
  });

  test("未配置 → 抛错降级（零 classify 调用）", async () => {
    const fm = fakeModels([JEV], async () => boolResult(0.5, JEV));
    const adapter = new PiAiJudgeAdapter({ getModels: () => fm.models, getConfig: () => null, getApiKey: () => "k" });
    expect(adapter.noul("s", "q")).rejects.toThrow("未配置");
    expect(fm.classifyCalls).toHaveLength(0);
  });

  test("endpointLabel：pi-ai/{model} 可读标识", () => {
    const fm = fakeModels([JEV]);
    const adapter = new PiAiJudgeAdapter({ getModels: () => fm.models, getConfig: () => CFG, getApiKey: () => "k" });
    expect(adapter.endpointLabel()).toBe("pi-ai/typesafe/jev-latest");
    const unconfigured = new PiAiJudgeAdapter({ getModels: () => fm.models, getConfig: () => null, getApiKey: () => "k" });
    expect(unconfigured.endpointLabel()).toBe("pi-ai 未配置");
  });
});

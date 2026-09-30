import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  buildCustomProvider,
  CustomProviderRegistry,
  registerCustomProviders,
} from "../../src/adapters/driven/llm/custom-providers";
import { ModelCatalog } from "../../src/adapters/driven/llm/model-catalog";
import { resolveConfigModel } from "../../src/adapters/driven/llm/model-provider";
import type { CustomProviderDef } from "../../src/application/ports/outbound/CustomProviderPort";
import {
  CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
  CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
} from "../../src/application/ports/outbound/CustomProviderPort";

/**
 * 三方平台批（U）：CustomProviderDef → pi-ai Provider 装配与目录接入——
 * ① buildCustomProvider 产物形态（id/baseUrl/模型缺省归一/openai-completions 流）；
 * ② 活注册表 register/unregister 即时反映目录读面（无需重建）；
 * ③ 装配序契约：catalog 构造后登记——刷新域（providerIdList 快照）不含
 *    自定义 provider，但目录读面动态可见；
 * ④ resolveConfigModel 全链路打通（"provider/model-id" 解析收束单点）。
 */

const VOLCENGINE_DEF: CustomProviderDef = {
  id: "volcengine-plan",
  name: "火山方舟 Agent Plan",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  models: [
    { id: "kimi-k3", contextWindow: 256_000, reasoning: true },
    { id: "deepseek-v4-flash" },
    { id: "glm-5.3", name: "GLM 5.3", maxTokens: 32_768 },
  ],
};

describe("① buildCustomProvider 产物形态", () => {
  test("模型行缺省归一（name/contextWindow/maxTokens/reasoning/cost 全 0）", () => {
    const provider = buildCustomProvider(VOLCENGINE_DEF);
    expect(provider.id).toBe("volcengine-plan");
    expect(provider.baseUrl).toBe(VOLCENGINE_DEF.baseUrl);
    const models = provider.getModels();
    expect(models.length).toBe(3);
    const [kimi, flash, glm] = models;
    expect(kimi?.id).toBe("kimi-k3");
    expect(kimi?.contextWindow).toBe(256_000);
    expect(kimi?.reasoning).toBe(true);
    expect(flash?.name).toBe("deepseek-v4-flash"); // name 缺省 = id
    expect(flash?.contextWindow).toBe(CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW);
    expect(flash?.maxTokens).toBe(CUSTOM_MODEL_DEFAULT_MAX_TOKENS);
    expect(flash?.reasoning).toBe(false);
    expect(glm?.name).toBe("GLM 5.3");
    expect(glm?.maxTokens).toBe(32_768);
    for (const m of models) {
      expect(m.api).toBe("openai-completions");
      expect(m.provider).toBe("volcengine-plan");
      expect(m.baseUrl).toBe(VOLCENGINE_DEF.baseUrl);
      expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(m.input).toEqual(["text"]);
    }
  });
});

describe("② 活注册表即时反映目录读面", () => {
  test("register 后 getModel/getModels 可解析；unregister 后移除；builtinProviderIds 不含自定义", () => {
    const models = builtinModels();
    const registry = new CustomProviderRegistry(models);
    expect(registry.builtinProviderIds().includes("volcengine-plan")).toBe(false);
    expect(registry.builtinProviderIds().includes("anthropic")).toBe(true);

    registry.register(VOLCENGINE_DEF);
    expect(models.getProvider("volcengine-plan")?.id).toBe("volcengine-plan");
    expect(models.getModel("volcengine-plan", "kimi-k3")?.id).toBe("kimi-k3");
    // upsert 语义：同 id 再 register 覆盖
    registry.register({ ...VOLCENGINE_DEF, models: [{ id: "kimi-k3" }] });
    expect(models.getModels("volcengine-plan").length).toBe(1);

    registry.unregister("volcengine-plan");
    expect(models.getProvider("volcengine-plan")).toBeUndefined();
    // 幂等：不存在再删不抛
    registry.unregister("volcengine-plan");
  });
});

describe("③ 装配序契约（catalog 构造后登记）", () => {
  test("目录读面动态可见自定义模型；刷新域快照（providerIdList）不含自定义 provider", () => {
    const models = builtinModels();
    const catalog = new ModelCatalog({ models, baseUrl: "http://catalog.invalid", fetchImpl: () => {
      throw new Error("不应触发刷新");
    } });
    // 构造后登记（buildModelStack 装配序）
    registerCustomProviders(models, [VOLCENGINE_DEF]);

    // 目录读面：hasModel / mergedModels / providerIds / modelsView / resolveModel
    expect(catalog.hasModel("volcengine-plan/kimi-k3")).toBe(true);
    expect(catalog.providerIds().includes("volcengine-plan")).toBe(true);
    const merged = catalog.mergedModels();
    expect(merged.some((m) => m.provider === "volcengine-plan" && m.id === "glm-5.3")).toBe(true);
    const view = catalog.modelsView();
    expect(view.getModel("volcengine-plan", "deepseek-v4-flash")?.contextWindow).toBe(CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW);

    // 运行期撤销即时反映
    models.deleteProvider("volcengine-plan");
    expect(catalog.hasModel("volcengine-plan/kimi-k3")).toBe(false);
  });
});

describe("④ resolveConfigModel 全链路（解析收束单点）", () => {
  test('"volcengine-plan/kimi-k3" 经合并目录解析为完整 Model 对象', () => {
    const models = builtinModels();
    const catalog = new ModelCatalog({ models });
    registerCustomProviders(models, [VOLCENGINE_DEF]);
    const resolved = resolveConfigModel("volcengine-plan/kimi-k3", catalog.modelsView());
    expect(resolved.id).toBe("kimi-k3");
    expect(resolved.provider).toBe("volcengine-plan");
    expect(resolved.baseUrl).toBe(VOLCENGINE_DEF.baseUrl);
  });
});

describe("⑤ auth resolve 凭据透传（options.apiKey 裁决点回归）", () => {
  /**
   * 回归锚点：pi-ai models.ts 的 applyAuth 把 options.apiKey 包装成
   * credential 调 provider 自身 resolve()——resolve 返回 undefined 即抛
   * "Provider is not configured"，即使 options.apiKey 已显式传入。曾因
   * 形式性 resolve（恒 undefined）导致火山方舟 verify 全挂。
   */
  const minimalCtx = { env: async () => undefined, fileExists: () => false } as never;

  test("credential.key 透传为 AuthResult；无凭据返回 undefined（诚实未配置）", async () => {
    const provider = buildCustomProvider(VOLCENGINE_DEF);
    const apiKey = provider.auth.apiKey!;
    const withKey = await apiKey.resolve({
      ctx: minimalCtx,
      credential: { type: "api_key", key: "ark-test" },
      signal: new AbortController().signal,
    });
    expect(withKey?.auth.apiKey).toBe("ark-test");
    const without = await apiKey.resolve({ ctx: minimalCtx, signal: new AbortController().signal });
    expect(without).toBeUndefined();
  });

  test("streamSimple options.apiKey 不再抛 Provider is not configured（打到 HTTP 层才失败）", async () => {
    const models = builtinModels();
    registerCustomProviders(models, [{ ...VOLCENGINE_DEF, baseUrl: "http://127.0.0.1:1" }]);
    const model = models.getModel("volcengine-plan", "kimi-k3")!;
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: 0 }] },
      { apiKey: "ark-test", maxTokens: 1, maxRetries: 0 },
    );
    let errorSeen = false;
    for await (const ev of stream) {
      if (ev.type === "error") {
        errorSeen = true;
        const msg = (ev as { error?: { errorMessage?: string } }).error?.errorMessage ?? "";
        expect(msg).not.toContain("Provider is not configured");
        break;
      }
    }
    expect(errorSeen).toBe(true); // 连接拒绝（端口 1）——auth 已过，败在 HTTP 层
  });
});

describe("⑥ API 风格选流与价格映射（三方平台批 II）", () => {
  test("api 缺省归一 openai-completions；显式 anthropic-messages → 模型 api 字段与流匹配", () => {
    // 缺省（旧 KV 无 api 字段）
    const openai = buildCustomProvider(VOLCENGINE_DEF);
    for (const m of openai.getModels()) expect(m.api).toBe("openai-completions");

    // 显式 anthropic
    const anthropic = buildCustomProvider({
      ...VOLCENGINE_DEF,
      id: "my-anthropic-gw",
      api: "anthropic-messages",
      models: [{ id: "claude-x", contextWindow: 200_000 }],
    });
    const models = anthropic.getModels();
    expect(models.length).toBe(1);
    expect(models[0]?.api).toBe("anthropic-messages");
    expect(models[0]?.provider).toBe("my-anthropic-gw");

    // 目录接入：模型字符串可解析，流按模型 api 分发
    const catalogModels = builtinModels();
    registerCustomProviders(catalogModels, [
      { ...VOLCENGINE_DEF, api: "anthropic-messages", id: "my-anthropic-gw", models: [{ id: "claude-x", contextWindow: 200_000 }] },
    ]);
    const resolved = catalogModels.getModel("my-anthropic-gw", "claude-x")!;
    expect(resolved.api).toBe("anthropic-messages");
  });

  test("价格映射 inputPrice/outputPrice → cost（缺省 0 = 未知计费）", () => {
    const provider = buildCustomProvider({
      ...VOLCENGINE_DEF,
      models: [
        { id: "kimi-k3", contextWindow: 256_000, inputPrice: 0.6, outputPrice: 2.5 },
        { id: "glm-5.3", contextWindow: 128_000 },
      ],
    });
    const [kimi, glm] = provider.getModels();
    expect(kimi?.cost).toEqual({ input: 0.6, output: 2.5, cacheRead: 0, cacheWrite: 0 });
    expect(glm?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("批 III：思考方言透传——非 auto 写 Model.compat.thinkingFormat，auto/缺省不写（交探测）", () => {
    // deepseek 方言（火山方舟）→ compat 显式声明
    const volc = buildCustomProvider({
      ...VOLCENGINE_DEF,
      thinkingFormat: "deepseek",
      models: [{ id: "kimi-k3", contextWindow: 256_000, reasoning: true }],
    });
    const volcModel = volc.getModels()[0]! as Model<"openai-completions">;
    expect(volcModel.compat?.thinkingFormat).toBe("deepseek");
    expect(volcModel.reasoning).toBe(true);

    // auto / 缺省（旧配置）→ 不写 compat 字段（pi-ai detectCompat 按 baseUrl 探测，兑底 openai）
    const autoGw = buildCustomProvider({ ...VOLCENGINE_DEF, thinkingFormat: "auto", models: [{ id: "m1", contextWindow: 128_000 }] });
    expect((autoGw.getModels()[0]! as Model<"openai-completions">).compat?.thinkingFormat).toBeUndefined();
    const legacyGw = buildCustomProvider({ ...VOLCENGINE_DEF, models: [{ id: "m2", contextWindow: 128_000 }] });
    expect((legacyGw.getModels()[0]! as Model<"openai-completions">).compat?.thinkingFormat).toBeUndefined();
  });
});

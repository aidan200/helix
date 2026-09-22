import { describe, expect, test } from "bun:test";
import {
  CustomProviderService,
  parseCustomProviders,
  CUSTOM_PROVIDERS_KEY,
} from "../../src/application/services/CustomProviderService";
import type { CustomProviderDef, CustomProviderRegistryPort } from "../../src/application/ports/outbound/CustomProviderPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { AuthStorePort } from "../../src/application/ports/outbound/AuthStorePort";
import type { DefaultModelPort } from "../../src/application/ports/outbound/DefaultModelPort";

/**
 * 三方平台批（U）：CustomProviderService——CRUD 校验 + 活目录同步 + 删除防线。
 * 测试注入 fake 三端口（config/registry/auth/defaultModel）——依赖注入面即
 * 断言面（model-provider 同款纪律）。
 */

function makeConfig(initial = ""): RuntimeConfigPort & { store: Map<string, string> } {
  const store = new Map<string, string>(initial === "" ? [] : [[CUSTOM_PROVIDERS_KEY, initial]]);
  return {
    store,
    get: (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

function makeRegistry(builtinIds: string[] = ["anthropic", "openai"]) {
  const registered = new Map<string, CustomProviderDef>();
  const registry: CustomProviderRegistryPort = {
    register: (def) => void registered.set(def.id, def),
    unregister: (id) => void registered.delete(id),
    builtinProviderIds: () => builtinIds,
  };
  return { registry, registered };
}

function makeAuth(configuredIds: string[] = [], masked: Record<string, string> = {}): AuthStorePort {
  return {
    statusOf: (providerId) =>
      configuredIds.includes(providerId)
        ? { configured: true, keyMasked: masked[providerId] ?? "····abcd" }
        : { configured: false },
    setKey: async () => ({ keyMasked: "····" }),
    deleteKey: async () => {},
    apiKeyOf: () => undefined,
    apiKeysSnapshot: () => ({}),
  };
}

function makeDefaultModel(current: string): DefaultModelPort {
  return { stored: () => current, current: () => current, set: async () => {} };
}

const VALID_INPUT = {
  id: "volcengine-plan",
  name: "火山方舟 Agent Plan",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  models: [
    { id: "kimi-k3", contextWindow: 256_000, reasoning: true },
    { id: "glm-5.3", contextWindow: 128_000 },
    { id: "deepseek-v4-flash", contextWindow: 128_000 },
    { id: "deepseek-v4-pro", contextWindow: 128_000 },
  ],
};

function makeService(opts?: {
  initialConfig?: string;
  builtinIds?: string[];
  configuredKeys?: string[];
  defaultModel?: string;
}) {
  const config = makeConfig(opts?.initialConfig ?? "");
  const { registry, registered } = makeRegistry(opts?.builtinIds ?? ["anthropic", "openai"]);
  const service = new CustomProviderService({
    config,
    registry,
    auth: makeAuth(opts?.configuredKeys ?? []),
    defaultModel: makeDefaultModel(opts?.defaultModel ?? "anthropic/claude-sonnet-4-5"),
  });
  return { service, config, registered };
}

describe("set 校验（invalid → 中文 error；valid → KV + 活注册）", () => {
  test("id 规则：非法字符/大写/超长拒绝", async () => {
    const { service } = makeService();
    for (const bad of ["", "UPPER", "has space", "_leading", "a".repeat(33), "中文"]) {
      const outcome = await service.set({ ...VALID_INPUT, id: bad });
      expect(outcome.ok).toBe(false);
    }
  });
  test("id 与内置 provider 冲突拒绝（openai）", async () => {
    const { service } = makeService();
    const outcome = await service.set({ ...VALID_INPUT, id: "openai" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("内置 provider");
  });
  test("baseUrl 非 http(s) URL 拒绝", async () => {
    const { service } = makeService();
    for (const bad of ["", "ftp://x", "not-a-url"]) {
      const outcome = await service.set({ ...VALID_INPUT, baseUrl: bad });
      expect(outcome.ok).toBe(false);
    }
  });
  test("models 空数组/重复 id/非正整数数值拒绝", async () => {
    const { service } = makeService();
    expect((await service.set({ ...VALID_INPUT, models: [] })).ok).toBe(false);
    expect(
      (await service.set({ ...VALID_INPUT, models: [{ id: "a", contextWindow: 128_000 }, { id: "a", contextWindow: 128_000 }] })).ok,
    ).toBe(false);
    expect(
      (await service.set({ ...VALID_INPUT, models: [{ id: "a", contextWindow: -1 }] })).ok,
    ).toBe(false);
    expect(
      (await service.set({ ...VALID_INPUT, models: [{ id: "a", contextWindow: 128_000, maxTokens: 1.5 }] })).ok,
    ).toBe(false);
    expect(
      (await service.set({ ...VALID_INPUT, models: [{ id: "a", contextWindow: 128_000, reasoning: "yes" as unknown as boolean }] })).ok,
    ).toBe(false);
  });
  test("valid 路径：KV 落盘 + registry.register 同步；同 id 再 set = 覆盖", async () => {
    const { service, config, registered } = makeService();
    const ok = await service.set(VALID_INPUT);
    expect(ok.ok).toBe(true);
    expect(registered.get("volcengine-plan")?.models.length).toBe(4);
    const stored = parseCustomProviders(config.get(CUSTOM_PROVIDERS_KEY));
    expect(stored.length).toBe(1);
    expect(stored[0]?.baseUrl).toBe(VALID_INPUT.baseUrl);
    // name 缺省 = id
    const ok2 = await service.set({ ...VALID_INPUT, name: undefined, models: [{ id: "only-one", contextWindow: 128_000 }] });
    expect(ok2.ok).toBe(true);
    expect(registered.get("volcengine-plan")?.models.length).toBe(1);
    expect(parseCustomProviders(config.get(CUSTOM_PROVIDERS_KEY)).length).toBe(1); // upsert 非 append
  });
});

describe("delete 防线与幂等", () => {
  test("不存在 → error；默认模型落在目标上 → error 带引导；正常删除 → KV + registry 撤销", async () => {
    const initial = JSON.stringify([{
      id: "volcengine-plan",
      name: "火山方舟",
      baseUrl: "https://ark.example/api/plan/v3",
      models: [{ id: "kimi-k3" }],
    }]);
    // 默认模型在目标 provider 上
    const blocked = makeService({ initialConfig: initial, defaultModel: "volcengine-plan/kimi-k3" });
    const rejected = await blocked.service.delete("volcengine-plan");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("model.set_default");

    // 默认模型不在 → 放行
    const allowed = makeService({ initialConfig: initial });
    const ok = await allowed.service.delete("volcengine-plan");
    expect(ok.ok).toBe(true);
    expect(allowed.registered.has("volcengine-plan")).toBe(false);
    expect(parseCustomProviders(allowed.config.get(CUSTOM_PROVIDERS_KEY)).length).toBe(0);

    // 不存在（幂等拒绝）
    const missing = await allowed.service.delete("ghost");
    expect(missing.ok).toBe(false);
  });
});

describe("listView（key 状态投影 + 模型行缺省归一）", () => {
  test("hasApiKey/keyMasked 来自 authStore；模型行 name/数值缺省归一", () => {
    const initial = JSON.stringify([{
      id: "volcengine-plan",
      name: "火山方舟",
      baseUrl: "https://ark.example/api/plan/v3",
      models: [{ id: "kimi-k3", reasoning: true }],
    }]);
    const { service } = makeService({ initialConfig: initial, configuredKeys: ["volcengine-plan"] });
    const view = service.listView();
    expect(view.length).toBe(1);
    const row = view[0]!;
    expect(row.hasApiKey).toBe(true);
    expect(row.keyMasked).toBe("····abcd");
    expect(row.models[0]!.name).toBe("kimi-k3");
    expect(row.models[0]!.contextWindow).toBe(128_000);
    expect(row.models[0]!.maxTokens).toBe(16_384);
    expect(row.models[0]!.reasoning).toBe(true);
  });
});

describe("parseCustomProviders（KV 防御解析）", () => {
  test("undefined/空串/非数组/坏行 → 过滤或空表", () => {
    expect(parseCustomProviders(undefined)).toEqual([]);
    expect(parseCustomProviders("")).toEqual([]);
    expect(parseCustomProviders("not json")).toEqual([]);
    expect(parseCustomProviders('{"a":1}')).toEqual([]);
    expect(parseCustomProviders(JSON.stringify([{ id: "", name: "x", baseUrl: "y", models: [] }]))).toEqual([]);
    const good = parseCustomProviders(JSON.stringify([{
      id: "p1", name: "P1", baseUrl: "https://x", models: [{ id: "m1" }],
    }]));
    expect(good.length).toBe(1);
    expect(good[0]?.models[0]?.id).toBe("m1");
  });
  test("批 II：api 字段宽容归一（合法枚举收下/非法与缺失 = undefined）", () => {
    const rows = parseCustomProviders(JSON.stringify([
      { id: "p1", name: "P1", baseUrl: "https://x", api: "anthropic-messages", models: [{ id: "m1" }] },
      { id: "p2", name: "P2", baseUrl: "https://x", models: [{ id: "m2" }] },
      { id: "p3", name: "P3", baseUrl: "https://x", api: "weird-style", models: [{ id: "m3" }] },
    ]));
    expect(rows[0]?.api).toBe("anthropic-messages");
    expect(rows[1]?.api).toBeUndefined();
    expect(rows[2]?.api).toBeUndefined();
  });
});

describe("批 II：api 风格 + contextWindow 必填 + 价格校验", () => {
  test("contextWindow 缺失拒绝（错误文案含必填引导）", async () => {
    const { service } = makeService();
    const outcome = await service.set({ ...VALID_INPUT, models: [{ id: "kimi-k3" }] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("必填");
  });
  test("api 非法枚举拒绝；合法 anthropic-messages 存入 + registry 同步", async () => {
    const { service, registered } = makeService();
    const bad = await service.set({ ...VALID_INPUT, api: "weird-style" as "openai-completions" });
    expect(bad.ok).toBe(false);
    const ok = await service.set({ ...VALID_INPUT, api: "anthropic-messages" });
    expect(ok.ok).toBe(true);
    expect(registered.get("volcengine-plan")?.api).toBe("anthropic-messages");
  });
  test("价格：合法小数存入；负数/NaN 拒绝", async () => {
    const { service } = makeService();
    const ok = await service.set({
      ...VALID_INPUT,
      models: [{ id: "kimi-k3", contextWindow: 256_000, inputPrice: 0.6, outputPrice: 2.5 }],
    });
    expect(ok.ok).toBe(true);
    const neg = await service.set({
      ...VALID_INPUT,
      models: [{ id: "kimi-k3", contextWindow: 256_000, inputPrice: -1 }],
    });
    expect(neg.ok).toBe(false);
    const nan = await service.set({
      ...VALID_INPUT,
      models: [{ id: "kimi-k3", contextWindow: 256_000, outputPrice: Number.NaN }],
    });
    expect(nan.ok).toBe(false);
  });
});

describe("批 II：listView 投影 api/价格（缺省归一）", () => {
  test("旧存储行（无 api/价格）→ openai-completions + 价格 0；新行显式透传", () => {
    const initial = JSON.stringify([
      { id: "old-gw", name: "旧网关", baseUrl: "https://x", models: [{ id: "m1", contextWindow: 128_000 }] },
      { id: "new-gw", name: "新网关", api: "anthropic-messages", baseUrl: "https://y", models: [{ id: "m2", contextWindow: 200_000, inputPrice: 3, outputPrice: 15 }] },
    ]);
    const { service } = makeService({ initialConfig: initial });
    const view = service.listView();
    expect(view[0]!.api).toBe("openai-completions");
    expect(view[0]!.models[0]!.inputPrice).toBe(0);
    expect(view[0]!.models[0]!.outputPrice).toBe(0);
    expect(view[1]!.api).toBe("anthropic-messages");
    expect(view[1]!.models[0]!.inputPrice).toBe(3);
    expect(view[1]!.models[0]!.outputPrice).toBe(15);
  });
});

describe("批 III：思考控制方言 thinkingFormat", () => {
  test("缺省 auto + 非法枚举拒绝 + 合法枚举透传落盘", async () => {
    const { service, config } = makeService({});
    // 缺省：不传 → 落盘行 thinkingFormat=auto（显式缺省值，非 undefined）
    const ok = await service.set({ ...VALID_INPUT });
    expect(ok.ok).toBe(true);
    const rows = JSON.parse(config.get("custom_providers")!) as Array<{ thinkingFormat?: string }>;
    expect(rows[0]!.thinkingFormat).toBe("auto");
    // 非法枚举拒绝
    const bad = await service.set({ ...VALID_INPUT, thinkingFormat: "gemini-style" as never });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("thinkingFormat");
    // 合法枚举透传
    const ok2 = await service.set({ ...VALID_INPUT, thinkingFormat: "deepseek" });
    expect(ok2.ok).toBe(true);
    const rows2 = JSON.parse(config.get("custom_providers")!) as Array<{ thinkingFormat?: string }>;
    expect(rows2[0]!.thinkingFormat).toBe("deepseek");
  });

  test("listView 投影：新行透传 + 旧行（无字段/非法值）归一 auto", () => {
    const initial = JSON.stringify([
      { id: "legacy", name: "旧库行", baseUrl: "https://x", models: [{ id: "m1", contextWindow: 128_000 }] },
      { id: "corrupt", name: "脏值行", thinkingFormat: "gemini-style", baseUrl: "https://y", models: [{ id: "m2", contextWindow: 128_000 }] },
    ]);
    const { service } = makeService({ initialConfig: initial });
    expect(service.listView().map((v) => v.thinkingFormat)).toEqual(["auto", "auto"]);
  });
});

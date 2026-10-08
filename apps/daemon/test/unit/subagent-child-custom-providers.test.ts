import { describe, expect, test } from "bun:test";
import { buildChildModels } from "../../src/adapters/driven/subagent/child/ChildMain";
import type { CustomProviderDef } from "../../src/application/ports/outbound/CustomProviderPort";

/**
 * custom provider 子进程注册批（子侧）：ChildMain.buildChildModels——
 * HELIX_CUSTOM_PROVIDERS_JSON 定格透传的自定义 provider 定义注册进子进程
 * 本地 pi-ai Models（engine 构造前，options.models 注入面）。
 *
 * 缺口背景：子进程 Models 原为零 custom provider 注册（registerCustomProviders
 * 只在 daemon 主进程 buildModelStack 调用）——自定义 provider 模型槽位的
 * SubAgent 流式首调 Models.requireProvider 抛 Unknown provider。
 *
 * 断言面：
 * - env 有值 → getModel/getProvider 命中（注册进本地 models）；
 * - env 空缺 / 坏 JSON / 形态非法 → 零注册不炸（parseCustomProviders
 *   防御解析先例：形态非法视同空表）；
 * - builtin 底座不受影响（createModelsBase 全量内置仍在）。
 */

const def: CustomProviderDef = {
  id: "cp-test",
  name: "测试平台",
  api: "openai-completions",
  baseUrl: "https://cp-test.example.com/v1",
  models: [{ id: "m1", name: "Model One", contextWindow: 128_000 }],
};

describe("ChildMain.buildChildModels（HELIX_CUSTOM_PROVIDERS_JSON → 本地 Models 注册）", () => {
  test("env 有值 → 注册进本地 models（getModel/getProvider 命中自定义 provider 模型）", () => {
    const models = buildChildModels({ HELIX_CUSTOM_PROVIDERS_JSON: JSON.stringify([def]) });
    expect(models.getProvider("cp-test")).toBeDefined();
    const hit = models.getModel("cp-test", "m1");
    expect(hit).toBeDefined();
    expect(hit!.provider).toBe("cp-test");
    expect(hit!.baseUrl).toBe("https://cp-test.example.com/v1");
  });

  test("builtin 底座不受影响（内置 provider 仍在，自定义并存）", () => {
    const models = buildChildModels({ HELIX_CUSTOM_PROVIDERS_JSON: JSON.stringify([def]) });
    expect(models.getProvider("anthropic")).toBeDefined();
  });

  test("env 空缺 → 零注册不炸", () => {
    const models = buildChildModels({});
    expect(models.getProvider("cp-test")).toBeUndefined();
    expect(models.getProvider("anthropic")).toBeDefined(); // 底座照常
  });

  test("坏 JSON → 零注册不炸（防御解析，形态非法视同空表先例）", () => {
    const models = buildChildModels({ HELIX_CUSTOM_PROVIDERS_JSON: "not json{{" });
    expect(models.getProvider("cp-test")).toBeUndefined();
  });

  test("形态非法元素（缺 id/name/baseUrl/models）→ 视同空表/剔除，不炸", () => {
    const models = buildChildModels({
      HELIX_CUSTOM_PROVIDERS_JSON: JSON.stringify([{ id: "cp-test" }, "junk", 42, null]),
    });
    expect(models.getProvider("cp-test")).toBeUndefined();
  });
});

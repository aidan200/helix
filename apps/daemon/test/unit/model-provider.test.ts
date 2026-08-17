import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildModels,
  createStreamFn,
  explicitGetApiKey,
  resolveModel,
} from "../../src/adapters/driven/pi-engine/model-provider";
import type { Model, Models } from "@earendil-works/pi-ai";

/**
 * TP-CL4-7（U）：模型接入纪律（AD-11/13）——
 * ① provider 经 `pi-ai/providers/all` 子路径（源码扫描）；
 * ② model/apiKeys 来自 config.json 后**显式传** pi-ai 工厂（spy 断言参数传递，
 *    不走 env 解析路径）；
 * ③ streamFn 工厂把 (model, context, options) 原样转交 Models.streamSimple。
 */

const providerSrc = readFileSync(
  new URL("../../src/adapters/driven/pi-engine/model-provider.ts", import.meta.url),
  "utf8",
);

describe("① provider 经 providers/all 子路径（源码纪律）", () => {
  test("model-provider 的 builtinModels import 自 @earendil-works/pi-ai/providers/all", () => {
    expect(providerSrc).toContain('from "@earendil-works/pi-ai/providers/all"');
    expect(providerSrc).not.toMatch(/from "@earendil-works\/pi-ai";\s*\nimport \{ builtinModels/);
  });
});

describe("② 显式传参（spy 断言）", () => {
  test("resolveModel 把 'provider/model-id' 显式拆解传给工厂目录 getModel", () => {
    const calls: Array<[string, string]> = [];
    const fakeModel = { id: "m-1", provider: "fake" } as unknown as Model<any>;
    const spyModels = {
      getModel: (provider: string, id: string) => {
        calls.push([provider, id]);
        return fakeModel;
      },
      getModels: () => [fakeModel],
    } as unknown as Models;

    const resolved = resolveModel(spyModels, "anthropic/claude-x");
    expect(calls).toEqual([["anthropic", "claude-x"]]);
    expect(resolved).toBe(fakeModel);
  });

  test("resolveModel 对未知模型 fail-fast（中文报错）", () => {
    const spyModels = {
      getModel: () => undefined,
      getModels: () => [{ id: "known-1" } as unknown as Model<any>],
    } as unknown as Models;
    expect(() => resolveModel(spyModels, "x/unknown")).toThrow(/不在 pi-ai 静态目录/);
  });

  test("explicitGetApiKey 返回显式 key（静态表或 auth.json getter；缺 key fail-fast）", () => {
    const getApiKey = explicitGetApiKey({ anthropic: "sk-test-123" });
    // spy：返回值即被显式放进 stream options.apiKey 的值（AD-11/13 链路）
    expect(getApiKey("anthropic")).toBe("sk-test-123");
    // T2.3（AD-2）：数据源改 auth.json——getter 形态读现值（换 key 下一请求生效）
    let table = { anthropic: "sk-live-1" };
    const liveGetApiKey = explicitGetApiKey(() => table);
    expect(liveGetApiKey("anthropic")).toBe("sk-live-1");
    table = { anthropic: "sk-live-2" };
    expect(liveGetApiKey("anthropic")).toBe("sk-live-2");
    expect(() => liveGetApiKey("openai")).toThrow(/auth\.json/);
    expect(() => getApiKey("openai")).toThrow(/auth\.json/);
  });
});

describe("③ streamFn 工厂转交", () => {
  test("createStreamFn 把 (model, context, options) 原样传给 Models.streamSimple", () => {
    const calls: unknown[][] = [];
    const fakeStream = { marker: "stream" };
    const spyModels = {
      streamSimple: (...args: unknown[]) => {
        calls.push(args);
        return fakeStream as never;
      },
    } as unknown as Models;

    const streamFn = createStreamFn(spyModels);
    const model = { id: "m" } as Model<any>;
    const ctx = { systemPrompt: "s", messages: [] } as never;
    const opts = { apiKey: "sk-explicit" } as never;
    const out = streamFn(model, ctx, opts) as unknown as { marker: string };

    expect(out.marker).toBe("stream");
    expect(calls).toEqual([[model, ctx, opts]]); // 参数原样透传（含显式 apiKey）
  });
});

describe("④ builtinModels 离线可用（静态目录）", () => {
  test("buildModels 返回非空目录且 anthropic 在列", () => {
    const models = buildModels();
    expect(models.getModels("anthropic").length).toBeGreaterThan(0);
  });
});

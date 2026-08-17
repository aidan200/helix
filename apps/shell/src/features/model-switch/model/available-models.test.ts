/**
 * P-3 模型菜单可用性过滤单测（T5.3：configured join / 当前模型兜底 /
 * auth 未到达不过滤 / 搜索在过滤后集合 / 零可用空集）。
 */
import { describe, expect, it } from "vitest";
import type { CatalogModel } from "@helix/protocol";
import type { AuthProviderEntry } from "@/entities/session/model/state";
import { filterAvailableModels, sameModel } from "./available-models";

function model(id: string): CatalogModel {
  const providerId = id.split("/")[0] ?? id;
  return {
    id,
    providerId,
    contextWindow: 200_000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    source: "builtin",
  };
}

function authOf(entries: Record<string, boolean>): Record<string, AuthProviderEntry> {
  const out: Record<string, AuthProviderEntry> = {};
  for (const [providerId, configured] of Object.entries(entries)) {
    out[providerId] = { providerId, configured, verifyStatus: "unverified" };
  }
  return out;
}

const CATALOG = [
  model("anthropic/claude-opus-4-1"),
  model("anthropic/claude-sonnet-4-5"),
  model("openai/gpt-5.2"),
  model("google/gemini-3-pro"),
  model("xai/grok-4"),
];

const ids = (list: CatalogModel[]) => list.map((m) => m.id);

describe("sameModel 双形态匹配", () => {
  it("完整 id 相等 / 短 id 尾段匹配 / 不同模型不匹配", () => {
    expect(sameModel("openai/gpt-5.2", "openai/gpt-5.2")).toBe(true);
    expect(sameModel("gpt-5.2", "openai/gpt-5.2")).toBe(true);
    expect(sameModel("gpt-5-mini", "openai/gpt-5.2")).toBe(false);
  });
});

describe("filterAvailableModels 可用性口径（T5.3）", () => {
  it("configured join：仅保留 configured provider 的模型（verifyStatus 不参与）", () => {
    const auth = authOf({ anthropic: true, openai: true, google: false, xai: false });
    // google 行即使 verifyStatus=ok 也不改变 configured=false 的判定
    auth.google = { providerId: "google", configured: false, verifyStatus: "ok", latencyMs: 120 };
    const out = filterAvailableModels({
      models: CATALOG,
      auth,
      authLoaded: true,
      currentModel: "anthropic/claude-opus-4-1",
      query: "",
    });
    expect(ids(out)).toEqual([
      "anthropic/claude-opus-4-1",
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.2",
    ]);
  });

  it("当前会话模型兜底：provider 未 configured 也保留当前项（同组其余模型不带入）", () => {
    const auth = authOf({ anthropic: true, openai: false, google: false, xai: false });
    const out = filterAvailableModels({
      models: CATALOG,
      auth,
      authLoaded: true,
      currentModel: "xai/grok-4",
      query: "",
    });
    expect(ids(out)).toEqual([
      "anthropic/claude-opus-4-1",
      "anthropic/claude-sonnet-4-5",
      "xai/grok-4",
    ]);
  });

  it("兜底双形态：welcome 短 id 也能保住目录完整 id 行", () => {
    const auth = authOf({ anthropic: false, openai: false, google: false, xai: false });
    const out = filterAvailableModels({
      models: CATALOG,
      auth,
      authLoaded: true,
      currentModel: "grok-4",
      query: "",
    });
    expect(ids(out)).toEqual(["xai/grok-4"]);
  });

  it("auth 首批未到达（authLoaded=false）：不过滤，仅搜索生效", () => {
    const out = filterAvailableModels({
      models: CATALOG,
      auth: {},
      authLoaded: false,
      currentModel: undefined,
      query: "",
    });
    expect(out).toHaveLength(CATALOG.length);
  });

  it("搜索在过滤后集合上进行：未配置 provider 的模型不被搜出", () => {
    const auth = authOf({ anthropic: true, openai: false, google: false, xai: false });
    const out = filterAvailableModels({
      models: CATALOG,
      auth,
      authLoaded: true,
      currentModel: "anthropic/claude-opus-4-1",
      query: "gemini",
    });
    expect(out).toEqual([]);
  });

  it("零可用：无 configured provider 且当前模型不在目录 → 空集（组件侧给引导空态）", () => {
    const auth = authOf({ anthropic: false, openai: false, google: false, xai: false });
    const out = filterAvailableModels({
      models: CATALOG,
      auth,
      authLoaded: true,
      currentModel: "test/not-in-catalog",
      query: "",
    });
    expect(out).toEqual([]);
  });
});

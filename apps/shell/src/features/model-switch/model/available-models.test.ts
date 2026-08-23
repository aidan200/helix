/**
 * P-3 模型菜单可用性过滤单测（T5.3：configured join / 当前模型兜底 /
 * auth 未到达不过滤 / 搜索在过滤后集合 / 零可用空集）。
 * T5.4 热修：跨厂商同名 provider 维度（sameModel / resolveCatalogMatch /
 * 兜底仅保留目标 provider 当前项 / 短 id 歧义宁可不标）。
 */
import { describe, expect, it } from "vitest";
import type { CatalogModel } from "@helix/protocol";
import type { AuthProviderEntry } from "@/entities/session/model/state";
import { filterAvailableModels, resolveCatalogMatch, sameModel } from "./available-models";

function model(id: string): CatalogModel {
  const providerId = id.split("/")[0] ?? id;
  return {
    id,
    providerId,
    contextWindow: 200_000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    source: "builtin",
    reasoning: true, // v0.11 additive（thinking 批② 能力位）
    thinkingLevels: ["low", "medium", "high"],
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

describe("sameModel provider 维度（T5.4 热修）", () => {
  it("跨厂商同名：短 id 相等但两侧 provider 均可确定且不等 → 不匹配", () => {
    expect(sameModel("anthropic/claude-haiku-4-5", "xai/claude-haiku-4-5")).toBe(false);
    expect(sameModel("xai/claude-haiku-4-5", "anthropic/claude-haiku-4-5")).toBe(false);
  });

  it("同 provider 完整 id 命中 / 短 id 单侧未知兼容保留（不牺牲 provider 区分度）", () => {
    expect(sameModel("anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5")).toBe(true);
    // 单侧 provider 不可确定（legacy 短 id）：仅短 id 命中，目录侧消歧归 resolveCatalogMatch
    expect(sameModel("claude-haiku-4-5", "anthropic/claude-haiku-4-5")).toBe(true);
    expect(sameModel("anthropic/claude-haiku-4-5", "claude-haiku-4-5")).toBe(true);
  });
});

describe("resolveCatalogMatch 目录解析（T5.4）", () => {
  const DUP = [
    model("anthropic/claude-haiku-4-5"),
    model("xai/claude-haiku-4-5"),
    model("xai/grok-4"),
  ];

  it("完整 id：跨厂商同名仅命中目标 provider 项", () => {
    expect(resolveCatalogMatch("xai/claude-haiku-4-5", DUP)?.id).toBe("xai/claude-haiku-4-5");
    expect(resolveCatalogMatch("anthropic/claude-haiku-4-5", DUP)?.id).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("短 id 唯一命中：welcome 短 id 兼容命中目标 provider 项", () => {
    expect(resolveCatalogMatch("grok-4", DUP)?.id).toBe("xai/grok-4");
  });

  it("短 id 跨厂商歧义：宁可不标也不错标 → undefined", () => {
    expect(resolveCatalogMatch("claude-haiku-4-5", DUP)).toBeUndefined();
  });

  it("undefined / 空串 / 零命中 → undefined", () => {
    expect(resolveCatalogMatch(undefined, DUP)).toBeUndefined();
    expect(resolveCatalogMatch("", DUP)).toBeUndefined();
    expect(resolveCatalogMatch("other/nope", DUP)).toBeUndefined();
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

  it("兜底 provider 维度（T5.4）：current 未 configured 时仅保留该 provider 当前项，不带出其他厂商同名项", () => {
    const catalog = [model("anthropic/claude-haiku-4-5"), model("xai/claude-haiku-4-5")];
    const auth = authOf({ anthropic: false, xai: false });
    const out = filterAvailableModels({
      models: catalog,
      auth,
      authLoaded: true,
      currentModel: "xai/claude-haiku-4-5",
      query: "",
    });
    expect(ids(out)).toEqual(["xai/claude-haiku-4-5"]);
  });

  it("兜底短 id 歧义（T5.4）：current 短 id 跨厂商同名 → 不带出任何同名项（宁可不标也不错标）", () => {
    const catalog = [model("anthropic/claude-haiku-4-5"), model("xai/claude-haiku-4-5")];
    const auth = authOf({ anthropic: false, xai: false });
    const out = filterAvailableModels({
      models: catalog,
      auth,
      authLoaded: true,
      currentModel: "claude-haiku-4-5",
      query: "",
    });
    expect(out).toEqual([]);
  });
});

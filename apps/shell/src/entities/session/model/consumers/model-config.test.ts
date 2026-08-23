/**
 * model-config 消费者单测（T3.3；契约 C §1/§2.2 真消费）。
 *
 * 覆盖：9 类结果帧消费语义（目录/默认/凭据）+ verify 四态互斥 + in-flight
 * 归属锁定与 stale 丢弃 + UI action（started 族串行化约束）。
 * 帧构造对齐契约 payload 形状（TS 类型即守护，AG-13）。
 */
import { describe, expect, it } from "vitest";
import { SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import {
  applyModelConfigAction,
  applyModelConfigEvent,
} from "./model-config";
import { createInitialTopologyState } from "../state";
import type { ModelConfigState, TopologyState } from "../state";
import type { CatalogModel } from "@helix/protocol";

/** 目录构造（契约 CatalogModel 字段；避免跨层 import e2e 模块）。 */
function model(id: string, source: "builtin" | "overlay" = "builtin"): CatalogModel {
  const [providerId, ...rest] = id.split("/");
  return {
    id,
    providerId: rest.length > 0 ? providerId! : id,
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    source,
    reasoning: true, // v0.11 additive（thinking 批② 能力位）
    thinkingLevels: ["low", "medium", "high"],
  };
}

/** 模型配置面上的帧消费快捷（活跃 store 不动，测试面简洁）。 */
function onConfig(mc: ModelConfigState, type: string, payload: unknown, sessionId = SYSTEM_SESSION_ID): ModelConfigState {
  return applyModelConfigEvent({ ...createInitialTopologyState(), modelConfig: mc }, frame(type, payload, sessionId)).modelConfig;
}

function frame(type: string, payload: unknown, sessionId: string = SYSTEM_SESSION_ID): EventEnvelope {
  return { v: 0, sessionId, channel: "model", type, payload } as unknown as EventEnvelope;
}

function authListFrame(
  providers: { providerId: string; configured: boolean; keyMasked?: string; verifyStatus?: "ok" | "fail" | "unverified" }[],
): EventEnvelope {
  return frame("auth.list.result", { providers });
}

describe("model-config 帧消费（目录/默认）", () => {
  it("model.catalog.result → 目录快照（models/refreshedAt/source；degraded 空）", () => {
    const topo = applyModelConfigEvent(createInitialTopologyState(), frame("model.catalog.result", {
      models: [model("anthropic/claude-sonnet-4-5")],
      refreshedAt: 1_000,
      source: "remote",
    }));
    expect(topo.modelConfig.catalog?.models).toHaveLength(1);
    expect(topo.modelConfig.catalog?.refreshedAt).toBe(1_000);
    expect(topo.modelConfig.catalog?.source).toBe("remote");
    expect(topo.modelConfig.catalog?.degraded).toEqual([]);
  });

  it("model.catalog_refresh.result → 目录更新 + degraded 降级 + catalogRefreshing 清位", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/catalog-refresh-started" });
    expect(mc.catalogRefreshing).toBe(true);
    mc = onConfig(mc, "model.catalog_refresh.result", {
      models: [model("anthropic/claude-sonnet-4-5", "overlay")],
      refreshedAt: 9_999,
      source: "remote",
      degraded: ["google"],
    });
    expect(mc.catalogRefreshing).toBe(false);
    expect(mc.catalog?.degraded).toEqual(["google"]);
    expect(mc.catalog?.refreshedAt).toBe(9_999);
  });

  it("model.get_default.result / model.get.result → defaultModel 面（会话 model 不写——双源防护）", () => {
    let topo = applyModelConfigEvent(createInitialTopologyState(), frame("model.get_default.result", { model: "anthropic/claude-sonnet-4-5" }));
    expect(topo.modelConfig.defaultModel).toBe("anthropic/claude-sonnet-4-5");
    // model.get.result 信封 sessionId=目标会话（非 SYSTEM）；defaultModel 面照常更新
    topo = applyModelConfigEvent(topo, frame("model.get.result", { model: "x", isDefault: false, defaultModel: "openai/gpt-5.2" }, "sess-a"));
    expect(topo.modelConfig.defaultModel).toBe("openai/gpt-5.2");
    expect(topo.active.model).toBe(""); // 活跃 store model 由快照/model.changed 驱动
  });

  it("model.set_default.result → 仅清 setDefaultInflight（乐观值已由 started 写入）", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/set-default-started", model: "openai/gpt-5.2" });
    expect(mc.defaultModel).toBe("openai/gpt-5.2");
    expect(mc.setDefaultInflight).toBe("openai/gpt-5.2");
    const after = applyModelConfigEvent({ ...createInitialTopologyState(), modelConfig: mc }, frame("model.set_default.result", { previous: "anthropic/claude-sonnet-4-5" }));
    expect(after.modelConfig.setDefaultInflight).toBeNull();
    expect(after.modelConfig.defaultModel).toBe("openai/gpt-5.2");
  });
});

describe("model-config auth 族（凭据增量 + verify 四态）", () => {
  it("auth.list.result → 凭据行整体替换（daemon 三态映射四态初值）", () => {
    const topo = applyModelConfigEvent(createInitialTopologyState(), authListFrame([
      { providerId: "anthropic", configured: true, keyMasked: "····7f3a", verifyStatus: "ok" },
      { providerId: "xai", configured: false },
    ]));
    expect(topo.modelConfig.auth["anthropic"]).toMatchObject({ configured: true, keyMasked: "····7f3a", verifyStatus: "ok" });
    expect(topo.modelConfig.auth["xai"]).toMatchObject({ configured: false, verifyStatus: "unverified" });
  });

  it("auth.list 替换保留在途 verifying（帧驱动权威不覆盖 in-flight 态）", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/verify-started", providerId: "anthropic" });
    const after = applyModelConfigEvent({ ...createInitialTopologyState(), modelConfig: mc }, authListFrame([
      { providerId: "anthropic", configured: true, keyMasked: "····7f3a" },
    ]));
    expect(after.modelConfig.auth["anthropic"]!.verifyStatus).toBe("verifying");
  });

  it("verify：started 先清旧态置 verifying；ok 结果带延迟写入归属 provider", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/verify-started", providerId: "google" });
    expect(mc.verifyInflight).toBe("google");
    expect(mc.auth["google"]!.verifyStatus).toBe("verifying");
    const after = applyModelConfigEvent({ ...createInitialTopologyState(), modelConfig: mc }, frame("auth.verify.result", { status: "ok", latencyMs: 142 }));
    expect(after.modelConfig.auth["google"]).toMatchObject({ verifyStatus: "ok", latencyMs: 142 });
    expect(after.modelConfig.verifyInflight).toBeNull();
  });

  it("verify fail 结果带原因；重测（ok → started）先清旧态（四态互斥）", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/verify-started", providerId: "google" });
    let topo = { ...createInitialTopologyState(), modelConfig: mc };
    topo = applyModelConfigEvent(topo, frame("auth.verify.result", { status: "ok", latencyMs: 90 }));
    expect(topo.modelConfig.auth["google"]!.verifyStatus).toBe("ok");
    // 重测：清 ok → verifying
    let mc2 = applyModelConfigAction(topo.modelConfig, { type: "model/verify-started", providerId: "google" });
    expect(mc2.auth["google"]!.verifyStatus).toBe("verifying");
    expect(mc2.auth["google"]!.latencyMs).toBeUndefined();
    const fail = applyModelConfigEvent({ ...createInitialTopologyState(), modelConfig: mc2 }, frame("auth.verify.result", { status: "fail", reason: "401 · key 无效" }));
    expect(fail.modelConfig.auth["google"]).toMatchObject({ verifyStatus: "fail", failReason: "401 · key 无效" });
  });

  it("verify/set_key/delete_key stale 帧（无 in-flight）原样丢弃", () => {
    const topo = createInitialTopologyState();
    expect(applyModelConfigEvent(topo, frame("auth.verify.result", { status: "ok", latencyMs: 10 }))).toBe(topo);
    expect(applyModelConfigEvent(topo, frame("auth.set_key.result", { keyMasked: "····0000" }))).toBe(topo);
    expect(applyModelConfigEvent(topo, frame("auth.delete_key.result", {}))).toBe(topo);
  });

  it("auth.set_key.result → 脱敏更新 + 连通态重置未验证", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/set-key-started", providerId: "anthropic" });
    mc = applyModelConfigAction(mc, { type: "model/verify-started", providerId: "google" });
    let topo = { ...createInitialTopologyState(), modelConfig: mc };
    topo = applyModelConfigEvent(topo, frame("auth.verify.result", { status: "ok", latencyMs: 30 }));
    topo = applyModelConfigEvent(topo, authListFrame([{ providerId: "anthropic", configured: true, keyMasked: "····7f3a", verifyStatus: "ok" }]));
    const after = applyModelConfigEvent(topo, frame("auth.set_key.result", { keyMasked: "····c21e" }));
    expect(after.modelConfig.auth["anthropic"]).toMatchObject({ configured: true, keyMasked: "····c21e", verifyStatus: "unverified" });
    expect(after.modelConfig.setKeyInflight).toBeNull();
  });

  it("auth.delete_key.result → 转未配置 + 徽标重置未验证", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/delete-key-started", providerId: "anthropic" });
    let topo = applyModelConfigEvent({ ...createInitialTopologyState(), modelConfig: mc }, authListFrame([{ providerId: "anthropic", configured: true, keyMasked: "····7f3a", verifyStatus: "ok" }]));
    const after = applyModelConfigEvent(topo, frame("auth.delete_key.result", {}));
    expect(after.modelConfig.auth["anthropic"]).toMatchObject({ configured: false, verifyStatus: "unverified" });
    expect(after.modelConfig.auth["anthropic"]!.keyMasked).toBeUndefined();
  });
});

describe("model-config action 串行化约束（结果帧无 providerId 回携）", () => {
  it("verify in-flight 期间其他 provider started 被忽略；同 provider 重测允许", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/verify-started", providerId: "google" });
    const blocked = applyModelConfigAction(mc, { type: "model/verify-started", providerId: "openai" });
    expect(blocked).toBe(mc); // 串行化：并发归属不可判定
    const retry = applyModelConfigAction(mc, { type: "model/verify-started", providerId: "google" });
    expect(retry.verifyInflight).toBe("google");
  });

  it("set_key / delete_key in-flight 期间重复 started 被忽略", () => {
    let mc = createInitialTopologyState().modelConfig;
    mc = applyModelConfigAction(mc, { type: "model/set-key-started", providerId: "a" });
    expect(applyModelConfigAction(mc, { type: "model/set-key-started", providerId: "b" })).toBe(mc);
    mc = applyModelConfigAction(mc, { type: "model/delete-key-started", providerId: "a" });
    expect(applyModelConfigAction(mc, { type: "model/delete-key-started", providerId: "b" })).toBe(mc);
  });
});

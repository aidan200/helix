/**
 * 任务总结子功能配置面单测（语音播报摘要独立槽位批；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. StewardService.getConfig：summary 组现态（缺省 {enabled:false, model:null}
 *    ——无默认模型，未配置 = null 非 undefined，JSON 序列化面钉死）；
 * 2. StewardService.setConfig：enabled 布尔写 KV "1"/"0"；model 写专用槽位
 *    （与管家对话模型槽位 steward.model 分立）；格式非法回 error 判别不落
 *    KV；**空串 = 清空槽位回未配置态**（与管家对话 model 忽略空串不同——
 *    摘要面无默认模型，清空是真实业务态）；
 * 3. handler 层（TR-159 帧级纪律）：handleStewardSetConfig summary 组
 *    逐字段解构透传——类型非法 commandError；写成功回执
 *    steward.config.result 帧 payload.summary 字段非 undefined（真透传证明，
 *    不接受「类型加了 = 通了」）。
 */
import { describe, expect, test } from "bun:test";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EventEnvelope } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import {
  handleStewardGetConfig,
  handleStewardSetConfig,
} from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

// ── fakes（steward-profile.test.ts 同款收窄面） ──────────────

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

function makeService(config: RuntimeConfigPort): StewardService {
  return new StewardService({
    llm: noopLlm(),
    orchestration: {
      status: () => [],
      send: () => ({ delivered: false, detail: "配置面零写注入" }),
    },
    tasks: { listTasks: () => [] },
    config,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
  });
}

/** handler ctx（steward-profile.test.ts 同构：frames/errors 收集面；type 参数化——get/set 两命令共用）。 */
function ctxOf(
  service: StewardService,
  payload: Record<string, unknown>,
  type: string = "steward.set_config",
): { ctx: StewardCommandContext; frames: EventEnvelope[]; errors: string[] } {
  const frames: EventEnvelope[] = [];
  const errors: string[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type,
    payload,
    steward: {
      service,
      stream: {
        subscribeSteward: () => {},
        unsubscribeSteward: () => {},
      },
    },
    commandError: (_type: string, _code: string, message: string) => {
      errors.push(message);
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as StewardCommandContext;
  return { ctx, frames, errors };
}

describe("StewardService：任务总结配置组（summary）", () => {
  test("getConfig 缺省：summary = {enabled:false, model:null}（无默认模型——未配置 null 非 undefined）", () => {
    const svc = makeService(fakeConfig({ "steward.enabled": "1", "steward.model": "zai/glm-5.3" }));
    const cfg = svc.getConfig();
    expect(cfg.summary).toEqual({ enabled: false, model: null });
    // JSON 序列化面字段不丢（null 钉死，非 undefined 挥发——帧 payload 构造源）
    expect(JSON.parse(JSON.stringify(cfg)).summary).toEqual({ enabled: false, model: null });
  });

  test("getConfig 已配置：summary 开关与专用槽位各读各的（与管家对话模型分立）", () => {
    const svc = makeService(
      fakeConfig({
        "steward.enabled": "1",
        "steward.model": "zai/glm-5.3",
        "steward.summary.enabled": "1",
        "steward.summary.model": "deepseek/deepseek-v4-flash",
      }),
    );
    const cfg = svc.getConfig();
    expect(cfg.model).toBe("zai/glm-5.3"); // 管家对话模型
    expect(cfg.summary).toEqual({ enabled: true, model: "deepseek/deepseek-v4-flash" }); // 摘要专用
  });

  test("setConfig：开/关写 KV；模型写专用槽位（steward.model 不受影响）", async () => {
    const config = fakeConfig({ "steward.model": "zai/glm-5.3" });
    const svc = makeService(config);
    const on = await svc.setConfig({ summary: { enabled: true, model: "deepseek/deepseek-v4-flash" } });
    expect(on).toEqual({ ok: true });
    expect(config.kv.get("steward.summary.enabled")).toBe("1");
    expect(config.kv.get("steward.summary.model")).toBe("deepseek/deepseek-v4-flash");
    expect(config.kv.get("steward.model")).toBe("zai/glm-5.3"); // 对话槽位不被覆盖
    const off = await svc.setConfig({ summary: { enabled: false } });
    expect(off).toEqual({ ok: true });
    expect(config.kv.get("steward.summary.enabled")).toBe("0");
  });

  test("setConfig：模型格式非法 → error 判别不落 KV", async () => {
    const config = fakeConfig({});
    const svc = makeService(config);
    const bad = await svc.setConfig({ summary: { model: "不是模型格式" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("格式非法");
    expect(config.kv.has("steward.summary.model")).toBe(false);
  });

  test("setConfig：模型空串 = 清空槽位回未配置态（与管家对话 model 忽略空串不同）", async () => {
    const config = fakeConfig({ "steward.summary.model": "deepseek/deepseek-v4-flash" });
    const svc = makeService(config);
    const ok = await svc.setConfig({ summary: { model: "" } });
    expect(ok).toEqual({ ok: true });
    expect(svc.getConfig().summary.model).toBeNull();
  });
});

describe("handleStewardSetConfig：summary 组透传（TR-159 帧级纪律）", () => {
  test("帧级断言：set_config {summary:{enabled,model}} → config.result 帧 payload.summary 真透传", async () => {
    const config = fakeConfig({});
    const svc = makeService(config);
    const { ctx, frames, errors } = ctxOf(svc, { summary: { enabled: true, model: "deepseek/deepseek-v4-flash" } });
    handleStewardSetConfig(ctx);
    // setConfig 异步——等微任务队列清空
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(0);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.type).toBe("steward.config.result");
    const payload = frame.payload as { summary?: { enabled?: boolean; model?: string | null } };
    // TR-159：不接受「类型加了 = 通了」——帧 payload 字段非 undefined 值正确
    expect(payload.summary).not.toBeUndefined();
    expect(payload.summary!.enabled).toBe(true);
    expect(payload.summary!.model).toBe("deepseek/deepseek-v4-flash");
  });

  test("帧级断言：get_config → config.result 帧 payload.summary 缺省态（enabled:false/model:null）", () => {
    const svc = makeService(fakeConfig({}));
    const { ctx, frames } = ctxOf(svc, {}, "steward.get_config");
    handleStewardGetConfig(ctx);
    expect(frames).toHaveLength(1);
    const payload = frames[0]!.payload as { summary?: { enabled?: boolean; model?: string | null } };
    expect(payload.summary).not.toBeUndefined();
    expect(payload.summary!.enabled).toBe(false);
    expect(payload.summary!.model).toBeNull();
  });

  test("类型校验：summary 非 object / enabled 非 boolean / model 非 string → commandError", async () => {
    for (const [payload, hint] of [
      [{ summary: "on" }, "summary 应为 object"],
      [{ summary: { enabled: "yes" } }, "enabled 应为 boolean"],
      [{ summary: { model: 42 } }, "model 应为 string"],
    ] as const) {
      const svc = makeService(fakeConfig({}));
      const { ctx, errors, frames } = ctxOf(svc, payload as unknown as Record<string, unknown>);
      handleStewardSetConfig(ctx);
      await new Promise((r) => setTimeout(r, 0));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(hint);
      expect(frames).toHaveLength(0); // 拒绝面不回 config.result
    }
  });
});

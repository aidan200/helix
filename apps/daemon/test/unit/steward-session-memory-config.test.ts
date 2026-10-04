/**
 * sessionMemory 配置面单测（会话内容级感知 M1：progress 批配置域）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. getConfig：sessionMemory 组现态（缺省 {enabled:false, everyTurns:3,
 *    model:null}——everyTurns 默认 3 对齐 topic 锚点；model null 归一）；
 * 2. setConfig：enabled 布尔写 KV；everyTurns 正整数校验（非法回 error 不落
 *    KV，合法范围 1-20）；model 格式校验同 summary（provider/model-id；空串
 *    = 清空槽位回未配置态——无默认纪律）；
 * 3. handler 层透传：handleStewardSetConfig sessionMemory 组逐字段解构——
 *    类型非法 commandError；写成功回执 steward.config.result 帧 payload
 *    .sessionMemory 字段非 undefined（真透传证明）。
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
import { handleStewardSetConfig } from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

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

function makeService(kv: Record<string, string> = {}) {
  const config = fakeConfig(kv);
  const svc = new StewardService({ llm: noopLlm(), config } as unknown as ConstructorParameters<typeof StewardService>[0]);
  return { svc, config };
}

describe("sessionMemory 配置面", () => {
  test("① getConfig 缺省态：{enabled:false, everyTurns:3, model:null}", () => {
    const { svc } = makeService();
    expect(svc.getConfig().sessionMemory).toEqual({ enabled: false, everyTurns: 3, model: null });
  });

  test("② getConfig 已配态：KV 三键读取 + everyTurns 非法回落 3 + model 空串归一 null", () => {
    const { svc } = makeService({
      "steward.sessionmemory.enabled": "1",
      "steward.sessionmemory.everyturns": "5",
      "steward.sessionmemory.model": "deepseek/summary-flash",
    });
    expect(svc.getConfig().sessionMemory).toEqual({ enabled: true, everyTurns: 5, model: "deepseek/summary-flash" });
    const { svc: svc2 } = makeService({
      "steward.sessionmemory.everyturns": "abc",
      "steward.sessionmemory.model": "  ",
    });
    expect(svc2.getConfig().sessionMemory).toEqual({ enabled: false, everyTurns: 3, model: null });
  });

  test("③ setConfig：三字段全写 + 空串清空 model 回 null", async () => {
    const { svc, config } = makeService();
    const ok = await svc.setConfig({ sessionMemory: { enabled: true, everyTurns: 6, model: "deepseek/summary-flash" } });
    expect(ok).toEqual({ ok: true });
    expect(config.kv.get("steward.sessionmemory.enabled")).toBe("1");
    expect(config.kv.get("steward.sessionmemory.everyturns")).toBe("6");
    expect(config.kv.get("steward.sessionmemory.model")).toBe("deepseek/summary-flash");
    const ok2 = await svc.setConfig({ sessionMemory: { model: "" } });
    expect(ok2).toEqual({ ok: true });
    expect(svc.getConfig().sessionMemory.model).toBeNull();
  });

  test("④ setConfig 校验：everyTurns 非正整数/超 20 回 error 不落 KV；model 格式非法回 error", async () => {
    const { svc, config } = makeService();
    const bad1 = await svc.setConfig({ sessionMemory: { everyTurns: 0 } });
    expect(bad1).toMatchObject({ ok: false });
    const bad2 = await svc.setConfig({ sessionMemory: { everyTurns: 21 } });
    expect(bad2).toMatchObject({ ok: false });
    const bad3 = await svc.setConfig({ sessionMemory: { everyTurns: 2.5 } });
    expect(bad3).toMatchObject({ ok: false });
    const bad4 = await svc.setConfig({ sessionMemory: { model: "no-slash" } });
    expect(bad4).toMatchObject({ ok: false });
    expect(config.kv.get("steward.sessionmemory.everyturns")).toBeUndefined();
    expect(config.kv.get("steward.sessionmemory.model")).toBeUndefined();
  });

  test("⑤ handler 透传：sessionMemory 组逐字段解构（类型非法 commandError；成功回执带 sessionMemory）", async () => {
    const { svc } = makeService();
    const sent: { type: string; payload: unknown }[] = [];
    const errors: string[] = [];
    const mkCtx = (payload: Record<string, unknown>): StewardCommandContext =>
      ({
        ws: { data: { sender: { id: "conn-1" } } },
        type: "steward.set_config",
        payload,
        steward: { service: svc, stream: { subscribeSteward: () => {}, unsubscribeSteward: () => {} } },
        commandError: (_t: string, _c: string, message: string) => {
          errors.push(message);
        },
        rawSender: () => ({ id: "conn-1" }),
        sendNow: (_s: unknown, frame: { type: string; payload: unknown }) => {
          sent.push(frame);
        },
      }) as unknown as StewardCommandContext;
    handleStewardSetConfig(mkCtx({ sessionMemory: { enabled: true, everyTurns: 4, model: "deepseek/summary-flash" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(0);
    const frame = sent.find((e) => e.type === "steward.config.result") as
      | { payload: { sessionMemory?: { enabled: boolean; everyTurns: number; model: string | null } } }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame!.payload.sessionMemory).toEqual({ enabled: true, everyTurns: 4, model: "deepseek/summary-flash" });
    // 类型非法：everyTurns 字符串 → commandError 判别
    handleStewardSetConfig(mkCtx({ sessionMemory: { everyTurns: "four" as unknown as number } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
  });
});

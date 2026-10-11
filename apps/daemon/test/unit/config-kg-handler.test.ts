/**
 * kg 查重阈值协议面单测（批2 WP-C「知识库」配置组；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. config.get_kg 读面回执生效值（KV 缺省 → 0.80/0.92；非法 KV → 读面
 *    兜底值回显——所见即所得）；
 * 2. config.set_kg 部分更新合并写（携带项写入未携带项保留）+ 回执生效值；
 * 3. 类型闸（非有限数 → invalid_payload，零写入）+ 至少携带一项；
 * 4. warn > dup 颠倒写入 → 回执整对回退缺省（读面裁决，写面不前置值校验
 *    ——memoryConfig 哲学）；
 * 5. 未装配（kgConfig 缺席）→ command.unimplemented。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EventEnvelope } from "@helix/protocol";
import type { WsCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import { handleConfigGetKg, handleConfigSetKg } from "../../src/adapters/driving/ws-server/handlers/config";
import { KgConfigStore } from "../../src/adapters/driven/sqlite-session/KgConfigStore";
import {
  KG_SEMANTIC_MINSCORE_DEFAULT,
  KG_SEMANTIC_MINSCORE_KEY,
  KG_SEMANTIC_TOPK_DEFAULT,
  KG_SEMANTIC_TOPK_KEY,
  KG_SIMILARITY_DUP_DEFAULT,
  KG_SIMILARITY_DUP_KEY,
  KG_SIMILARITY_WARN_DEFAULT,
  KG_SIMILARITY_WARN_KEY,
} from "../../src/application/services/kg/kgConfig";

/** 配置组回执同形载荷（查重阈值对 + 语义召回对——四字段同构回显）。 */
type KgResultPayload = { similarityWarn: number; similarityDup: number; semanticTopK: number; semanticMinScore: number };

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

/** config handler ctx（config-summary-handler.test.ts 同构：kgConfig 真体 + 收集面）。 */
function configCtxOf(
  config: RuntimeConfigPort | null,
  payload: Record<string, unknown>,
  type: string,
): { ctx: WsCommandContext; frames: EventEnvelope[]; errors: { code: string; message: string }[] } {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type,
    payload,
    ...(config !== null ? { kgConfig: new KgConfigStore(config) } : {}),
    commandError: (_type: string, code: string, message: string) => {
      errors.push({ code, message });
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as WsCommandContext;
  return { ctx, frames, errors };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("config.get_kg（kg.* 查重阈值读面）", () => {
  test("① 回执生效值：KV 缺省 → 0.80/0.92", () => {
    const { ctx, frames, errors } = configCtxOf(fakeConfig(), {}, "config.get_kg");
    handleConfigGetKg(ctx);
    expect(errors).toHaveLength(0);
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { type: string; payload: KgResultPayload };
    expect(frame.type).toBe("config.get_kg.result");
    expect(frame.payload).toEqual({
      similarityWarn: KG_SIMILARITY_WARN_DEFAULT,
      similarityDup: KG_SIMILARITY_DUP_DEFAULT,
      semanticTopK: KG_SEMANTIC_TOPK_DEFAULT,
      semanticMinScore: KG_SEMANTIC_MINSCORE_DEFAULT,
    });
  });

  test("② 非法 KV → 读面兜底生效值回显（所见即所得；语义对同款）", () => {
    const config = fakeConfig({
      [KG_SIMILARITY_WARN_KEY]: "2",
      [KG_SIMILARITY_DUP_KEY]: "x",
      [KG_SEMANTIC_TOPK_KEY]: "2.5",
      [KG_SEMANTIC_MINSCORE_KEY]: "9",
    });
    const { ctx, frames } = configCtxOf(config, {}, "config.get_kg");
    handleConfigGetKg(ctx);
    const frame = frames[0] as { payload: KgResultPayload };
    expect(frame.payload).toEqual({
      similarityWarn: KG_SIMILARITY_WARN_DEFAULT,
      similarityDup: KG_SIMILARITY_DUP_DEFAULT,
      semanticTopK: KG_SEMANTIC_TOPK_DEFAULT,
      semanticMinScore: KG_SEMANTIC_MINSCORE_DEFAULT,
    });
  });

  test("③ 未装配 → command.unimplemented", () => {
    const { ctx, frames, errors } = configCtxOf(null, {}, "config.get_kg");
    handleConfigGetKg(ctx);
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("command.unimplemented");
  });
});

describe("config.set_kg（kg.* 查重阈值写面）", () => {
  test("① 部分更新合并写 + 回执生效值（携带项写入未携带项保留；四字段同构）", async () => {
    const config = fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "0.75", [KG_SEMANTIC_TOPK_KEY]: "8" });
    const { ctx, frames, errors } = configCtxOf(config, { similarityDup: 0.95, semanticMinScore: 0.4 }, "config.set_kg");
    handleConfigSetKg(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    expect(config.kv.get(KG_SIMILARITY_DUP_KEY)).toBe("0.95");
    expect(config.kv.get(KG_SIMILARITY_WARN_KEY)).toBe("0.75"); // 未携带项保留
    expect(config.kv.get(KG_SEMANTIC_MINSCORE_KEY)).toBe("0.4");
    expect(config.kv.get(KG_SEMANTIC_TOPK_KEY)).toBe("8"); // 未携带项保留
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { type: string; payload: KgResultPayload };
    expect(frame.type).toBe("config.set_kg.result");
    expect(frame.payload).toEqual({ similarityWarn: 0.75, similarityDup: 0.95, semanticTopK: 8, semanticMinScore: 0.4 });
  });

  test("② 类型闸：非有限数 / 空载荷 → invalid_payload 零写入（语义字段同款）", async () => {
    for (const payload of [
      {},
      { similarityWarn: "0.8" },
      { similarityDup: Number.NaN },
      { similarityWarn: Number.POSITIVE_INFINITY },
      { similarityDup: null },
      { semanticTopK: "5" },
      { semanticMinScore: Number.NaN },
      { semanticTopK: Number.POSITIVE_INFINITY },
      { semanticMinScore: null },
    ]) {
      const config = fakeConfig();
      const { ctx, errors } = configCtxOf(config, payload, "config.set_kg");
      handleConfigSetKg(ctx);
      await settle();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("command.invalid_payload");
      expect(config.kv.size).toBe(0);
    }
  });

  test("③ warn > dup 颠倒写入 → 回执整对回退缺省（读面裁决，写面照存）", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = configCtxOf(config, { similarityWarn: 0.95, similarityDup: 0.9 }, "config.set_kg");
    handleConfigSetKg(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    // 写面不做前置值校验（memoryConfig 哲学）——原值落 KV
    expect(config.kv.get(KG_SIMILARITY_WARN_KEY)).toBe("0.95");
    expect(config.kv.get(KG_SIMILARITY_DUP_KEY)).toBe("0.9");
    const frame = frames[0] as { payload: KgResultPayload };
    // 回执 = 生效值（整对回退缺省——所见即所得）
    expect(frame.payload).toEqual({
      similarityWarn: KG_SIMILARITY_WARN_DEFAULT,
      similarityDup: KG_SIMILARITY_DUP_DEFAULT,
      semanticTopK: KG_SEMANTIC_TOPK_DEFAULT,
      semanticMinScore: KG_SEMANTIC_MINSCORE_DEFAULT,
    });
  });

  test("⑤ 语义召回字段写面：KV 落盘 + 回执生效值（非法值写面照存、读面裁决回显）", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = configCtxOf(config, { semanticTopK: 3, semanticMinScore: 0.5 }, "config.set_kg");
    handleConfigSetKg(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    expect(config.kv.get(KG_SEMANTIC_TOPK_KEY)).toBe("3");
    expect(config.kv.get(KG_SEMANTIC_MINSCORE_KEY)).toBe("0.5");
    const frame = frames[0] as { payload: KgResultPayload };
    expect(frame.payload).toEqual({
      similarityWarn: KG_SIMILARITY_WARN_DEFAULT,
      similarityDup: KG_SIMILARITY_DUP_DEFAULT,
      semanticTopK: 3,
      semanticMinScore: 0.5,
    });
  });

  test("④ 未装配 → command.unimplemented", async () => {
    const { ctx, frames, errors } = configCtxOf(null, { similarityWarn: 0.8 }, "config.set_kg");
    handleConfigSetKg(ctx);
    await settle();
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("command.unimplemented");
  });
});

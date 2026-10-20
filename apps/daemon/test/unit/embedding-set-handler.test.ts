import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@helix/protocol";
import { handleEmbeddingSet } from "../../src/adapters/driving/ws-server/handlers/embedding";
import type { EmbeddingCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * embedding.set 载荷校验序（低危批）：
 * - variant 类型闸必须**先于**「baseUrl 按 variant 条件必填」判定——否则
 *   variant 非 string（如数字）时会先报「payload.baseUrl 应为非空 string」，
 *   错误归因指向 baseUrl 而非真正的错处；
 * - variant 通过类型闸后必为非空串，落库载荷不再需要 `variant !== ""` 死条件。
 */

function embeddingCtx(payload: Record<string, unknown>) {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const setCalls: Record<string, unknown>[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type: "embedding.set",
    payload,
    embedding: {
      service: {
        listView: () => [],
        resolveDefaultRecord: () => null,
        set: async (input: Record<string, unknown>) => {
          setCalls.push(input);
          return { ok: true };
        },
      },
    },
    commandError: (_type: string, code: string, message: string) => {
      errors.push({ code, message });
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as EmbeddingCommandContext;
  return { ctx, frames, errors, setCalls };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("handleEmbeddingSet（校验序）", () => {
  test("① variant 非 string → 报 payload.variant（不再误报 baseUrl 缺失）", () => {
    const { ctx, errors } = embeddingCtx({ name: "e", model: "m", variant: 5 });
    handleEmbeddingSet(ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("payload.variant");
    expect(errors[0]!.message).not.toContain("baseUrl");
  });

  test("② variant 空串 → 同一处报 payload.variant", () => {
    const { ctx, errors } = embeddingCtx({ name: "e", model: "m", variant: "" });
    handleEmbeddingSet(ctx);
    expect(errors[0]?.message).toContain("payload.variant");
  });

  test("③ variant = pi-ai → baseUrl 免填，variant 原样进 set 载荷", async () => {
    const { ctx, errors, setCalls } = embeddingCtx({ name: "e", model: "m", variant: "pi-ai" });
    handleEmbeddingSet(ctx);
    await settle();
    expect(errors).toEqual([]);
    expect(setCalls[0]).toEqual({ name: "e", model: "m", variant: "pi-ai" });
  });

  test("④ 缺 baseUrl 且非 pi-ai → baseUrl 必填报错（条件必填语义保留）", () => {
    const { ctx, errors } = embeddingCtx({ name: "e", model: "m" });
    handleEmbeddingSet(ctx);
    expect(errors[0]?.message).toContain("payload.baseUrl");
  });
});

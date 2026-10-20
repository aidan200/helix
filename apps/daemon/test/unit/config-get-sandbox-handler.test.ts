import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@helix/protocol";
import { handleConfigGetSandbox } from "../../src/adapters/driving/ws-server/handlers/config";
import type { WsCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * config.get_sandbox 读面（低危批）：回执三字段必须来自**同一次** current()
 * 快照——读面按调用时刻现拍，分三次取值在非原子读面下会让一个回执里的
 * enabled/extraRoots/autoApprove 属于不同时刻（自相矛盾的回执）。
 */

function sandboxCtx(reads: { count: number }) {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type: "config.get_sandbox",
    payload: {},
    sandboxConfig: {
      current: () => {
        reads.count += 1;
        // 每次取值都不同：若实现分三次读，回执会混装不同快照
        return { enabled: reads.count === 1, extraRoots: [`/r${reads.count}`], autoApprove: reads.count === 1 };
      },
    },
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

describe("config.get_sandbox（读面单快照）", () => {
  test("① 三字段同源于一次 current()（读面只被取值一次）", () => {
    const reads = { count: 0 };
    const { ctx, frames, errors } = sandboxCtx(reads);
    handleConfigGetSandbox(ctx);
    expect(errors).toEqual([]);
    expect(reads.count).toBe(1);
    const payload = (frames[0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toEqual({ enabled: true, extraRoots: ["/r1"], autoApprove: true });
  });

  test("② 未装配 sandboxConfig → command.unimplemented（零帧）", () => {
    const { ctx, frames, errors } = sandboxCtx({ count: 0 });
    (ctx as unknown as { sandboxConfig: undefined }).sandboxConfig = undefined;
    handleConfigGetSandbox(ctx);
    expect(frames).toEqual([]);
    expect(errors[0]?.code).toBe("command.unimplemented");
  });
});

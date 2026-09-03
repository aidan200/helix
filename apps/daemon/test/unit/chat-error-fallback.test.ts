import { describe, expect, test } from "bun:test";
import { handleChatSend, handleChatSteer } from "../../src/adapters/driving/ws-server/handlers/chat";
import type { ChatCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * H5 单元：chat.send/chat.steer 的 catch 兜底分支（非 invalid_payload 的
 * 意外异常）也回 connection.error 透传 message——客户端零感知的静默失败
 * 修复（daemon.internal 码，连接保持；console.warn 保留服务端可观测）。
 */

interface ErrorCall {
  readonly type: string;
  readonly code: string;
  readonly message: string;
}

function makeCtx(over: {
  readonly payload?: Record<string, unknown>;
  readonly envelope?: { sessionId?: unknown };
  readonly sendMessage?: (text: string, sid?: string, images?: unknown) => Promise<unknown>;
  readonly steer?: (text: string, sid?: string, instanceId?: string) => Promise<unknown>;
  readonly startDraftSession?: (...args: unknown[]) => Promise<{ sessionId: string }>;
  readonly errors: ErrorCall[];
}): ChatCommandContext {
  return {
    ws: { data: { sender: { send: () => undefined } } },
    type: "chat.send",
    payload: { text: "hi", ...over.payload },
    envelope: over.envelope ?? { sessionId: "s-1" },
    chat: {
      sendMessage: over.sendMessage ?? (() => Promise.resolve({})),
      steer: over.steer ?? (() => Promise.resolve({})),
    },
    directory: {
      startDraftSession: over.startDraftSession ?? (() => Promise.resolve({ sessionId: "s-new" })),
      getSessionView: async () => ({
        session: { sessionId: "s-new", createdAt: "2026-08-24T00:00:00.000Z", entries: [], turns: [], pendingSteer: [] },
        toolCalls: [],
      }),
    },
    events: { subscribeSession: () => undefined },
    sessionStamp: () => ({ model: "test/model", agentState: "idle" }),
    snapshotFrame: () => ({ v: "0.11", type: "session.snapshot", payload: {} }),
    commandError: (type: string, code: string, message: string) => {
      over.errors.push({ type, code, message });
    },
    sendNow: () => undefined,
  } as unknown as ChatCommandContext;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("H5：chat 族 catch 兜底回执 connection.error（不再静默 console.warn）", () => {
  test("chat.send 既有会话链意外异常 → daemon.internal 回执透传 message", async () => {
    const errors: ErrorCall[] = [];
    handleChatSend(
      makeCtx({
        errors,
        sendMessage: () => Promise.reject(new Error("引擎连接断裂")),
      }),
    );
    await flush();
    expect(errors).toEqual([{ type: "chat.send", code: "daemon.internal", message: "引擎连接断裂" }]);
  });

  test("chat.send 草稿建会话链意外异常 → daemon.internal 回执透传 message", async () => {
    const errors: ErrorCall[] = [];
    const ctx = makeCtx({
      errors,
      payload: { draft: true },
      envelope: {},
      startDraftSession: () => Promise.reject(new Error("目录服务崩溃")),
    });
    handleChatSend(ctx);
    await flush();
    expect(errors).toEqual([{ type: "chat.send", code: "daemon.internal", message: "目录服务崩溃" }]);
  });

  test("chat.steer 意外异常 → daemon.internal 回执透传 message", async () => {
    const errors: ErrorCall[] = [];
    handleChatSteer(
      makeCtx({
        errors,
        steer: () => Promise.reject(new Error("实例总线超时")),
      }),
    );
    await flush();
    expect(errors).toEqual([{ type: "chat.send", code: "daemon.internal", message: "实例总线超时" }]);
  });

  test("invalid_payload 仍走原码（回归：不吞既有回执语义）", async () => {
    const errors: ErrorCall[] = [];
    const err = Object.assign(new Error("图片数量超限"), { code: "command.invalid_payload" });
    handleChatSend(makeCtx({ errors, sendMessage: () => Promise.reject(err) }));
    await flush();
    expect(errors).toEqual([{ type: "chat.send", code: "command.invalid_payload", message: "图片数量超限" }]);
  });
});

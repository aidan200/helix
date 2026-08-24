import { describe, expect, test } from "bun:test";
import { handleChatSend } from "../../src/adapters/driving/ws-server/handlers/chat";
import type { ChatCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * P1 T3 单元：chat.send 草稿链 mode 透传（handler 面，最小 ctx 桩——
 * error-code-judgement.test.ts 同款形态）。
 *
 * - 草稿分支：payload.mode（string 非空）→ startDraftSession 第 4 参透传；
 *   缺省/空串/非 string → undefined；
 * - 非草稿链忽略：信封带 sessionId 的 chat.send 即使 payload 有 mode 也不
 *   消费（协议注释声明——无第二条写路径，防锁定语义旁路）；
 * - draft 标记与显式 sessionId 同现以 sessionId 为准（既有规则回归 + mode
 *   一并忽略）。
 */

interface Recorded {
  readonly draftCalls: unknown[][];
  readonly sends: unknown[][];
}

function makeCtx(payload: Record<string, unknown>, envelope: { sessionId?: unknown }, rec: Recorded): ChatCommandContext {
  return {
    ws: { data: { sender: { send: () => undefined } } },
    type: "chat.send",
    payload: { text: "hi", ...payload },
    envelope,
    chat: {
      sendMessage: (...args: unknown[]) => {
        rec.sends.push(args);
        return Promise.resolve({ mode: "turn", turnId: "t1", entryId: "e1" });
      },
    },
    directory: {
      startDraftSession: (...args: unknown[]) => {
        rec.draftCalls.push(args);
        return Promise.resolve({ sessionId: "s-new" });
      },
      getSessionView: async () => {
        return {
          session: { sessionId: "s-new", createdAt: "2026-08-24T00:00:00.000Z", entries: [], turns: [], pendingSteer: [] },
          toolCalls: [],
        };
      },
    },
    events: { subscribeSession: () => undefined },
    sessionStamp: () => ({ model: "test/model", agentState: "idle" }),
    snapshotFrame: (view: unknown, model: string, agentState: unknown) => ({
      v: "0.11",
      sessionId: (view as { session: { sessionId: string } }).session.sessionId,
      channel: "session",
      type: "session.snapshot",
      payload: { snapshot: { sessionId: "s-new", model, agentState, revision: 0, entries: [], tail: [] } },
    }),
    commandError: () => undefined,
    sendNow: () => undefined,
  } as unknown as ChatCommandContext;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("P1 T3 ② chat.send draft 链 mode 透传（handler → startDraftSession）", () => {
  test("draft:true + mode 非空字符串 → startDraftSession(text, model, images, mode) 第 4 参透传", async () => {
    const rec: Recorded = { draftCalls: [], sends: [] };
    handleChatSend(makeCtx({ draft: true, mode: "weird-mode", model: "test/m" }, {}, rec));
    await flush();
    expect(rec.draftCalls).toHaveLength(1);
    expect(rec.draftCalls[0]).toEqual(["hi", "test/m", undefined, "weird-mode"]);
    expect(rec.sends).toEqual([]);
  });

  test("mode 缺省/空串/非 string → 透传 undefined（缺省 default 语义归消费侧解析）", async () => {
    for (const mode of [undefined, "", 123, { id: "default" }]) {
      const rec: Recorded = { draftCalls: [], sends: [] };
      handleChatSend(makeCtx({ draft: true, ...(mode === undefined ? {} : { mode }) }, {}, rec));
      await flush();
      expect(rec.draftCalls[0]![3]).toBeUndefined();
    }
  });
});

describe("P1 T3 ⑥ 非草稿链 mode 忽略（无第二条写路径）", () => {
  test("信封 sessionId + payload.mode → 只走 sendMessage 路由，startDraftSession 零调用", async () => {
    const rec: Recorded = { draftCalls: [], sends: [] };
    handleChatSend(makeCtx({ mode: "whatever" }, { sessionId: "s1" }, rec));
    await flush();
    expect(rec.sends).toEqual([["hi", "s1", undefined]]);
    expect(rec.draftCalls).toEqual([]);
  });

  test("draft:true 与显式 sessionId 同现 → sessionId 为准（mode 一并忽略）", async () => {
    const rec: Recorded = { draftCalls: [], sends: [] };
    handleChatSend(makeCtx({ draft: true, mode: "whatever" }, { sessionId: "s1" }, rec));
    await flush();
    expect(rec.sends).toEqual([["hi", "s1", undefined]]);
    expect(rec.draftCalls).toEqual([]);
  });
});

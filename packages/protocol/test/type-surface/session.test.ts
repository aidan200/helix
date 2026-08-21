/**
 * session 族：subscribe tier 两形态 + unsubscribe 空载荷不动（CL-2）与 session 通道分族类型面、session 域负向编译守护。
 */
import { describe, expect, test } from "bun:test";
import type {
  EmptyPayload,
  EventEnvelope,
  SessionListChangedEvent,
  SessionLoadHistoryCommand,
  SessionSubscribeCommand,
  SessionSubscribePayload,
  SessionUnsubscribeCommand,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { subscribeMonitor, subscribeTierDefault, unsubscribeUnchanged } from "./samples/v03";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
type _SessionFamily = Expect<
  Equal<
    TypeOfChannel<"session">,
    "session.snapshot" | "session.list_changed" | "session.list.result" | "session.loadHistory.result"
  >
>;

// CL-2 subscribe payload 换 SessionSubscribePayload（tier 二值可选；缺省 full）
type _SubscribeTierDomain = Expect<
  Equal<SessionSubscribePayload["tier"], "full" | "monitor" | undefined>
>;

type _SubscribePayloadSwapped = Expect<
  Equal<SessionSubscribeCommand["payload"], SessionSubscribePayload>
>;

type _UnsubscribePayloadKeptEmpty = Expect<
  Equal<SessionUnsubscribeCommand["payload"], EmptyPayload>
>;

// ── 负向断言（编译期守护指令；运行时字面量回读见对应 test） ──
// 负向断言（v0.2）：channel 字面量与事件类型不符（session.list_changed 归 session 族）
// @ts-expect-error channel 必须是 "session"
const badChannel: SessionListChangedEvent = { v: "0.7", sessionId: "s", channel: "chat", type: "session.list_changed", payload: { kind: "created" } };

// 负向断言（v0.2）：session.loadHistory 缺游标
// @ts-expect-error beforeEntryId 必填
const badLoadHistory: SessionLoadHistoryCommand = { v: "0.7", sessionId: "s", type: "session.loadHistory", payload: {} };

describe("session：subscribe tier 档位（源 TP-v0.3-①）", () => {
  test("CL-2 tier：monitor / 缺省 full 两形态；unsubscribe payload 保持空不动", () => {
    expect(subscribeMonitor.payload.tier).toBe("monitor");
    expect(subscribeTierDefault.payload.tier).toBeUndefined(); // 缺省 = full（既有语义不变）
    expect(unsubscribeUnchanged.payload).toEqual({}); // EmptyPayload 不动
    expect(unsubscribeUnchanged.sessionId).toBe("sess-1"); // 信封路由位不变
  });

});

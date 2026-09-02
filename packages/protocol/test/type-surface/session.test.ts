/**
 * session 族：subscribe tier 两形态 + unsubscribe 空载荷不动（CL-2）与 session 通道分族类型面、session 域负向编译守护。
 */
import { describe, expect, test } from "bun:test";
import type {
  EmptyPayload,
  EventEnvelope,
  SessionListChangedEvent,
  SessionLoadHistoryCommand,
  SessionPlanChangedEvent,
  SessionSnapshotEvent,
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
    | "session.snapshot"
    | "session.list_changed"
    | "session.list.result"
    | "session.loadHistory.result"
    | "session.plan.changed"
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
const badChannel: SessionListChangedEvent = { v: "0.11", sessionId: "s", channel: "chat", type: "session.list_changed", payload: { kind: "created" } };

// 负向断言（v0.2）：session.loadHistory 缺游标
// @ts-expect-error beforeEntryId 必填
const badLoadHistory: SessionLoadHistoryCommand = { v: "0.11", sessionId: "s", type: "session.loadHistory", payload: {} };

describe("session：subscribe tier 档位（源 TP-v0.3-①）", () => {
  test("CL-2 tier：monitor / 缺省 full 两形态；unsubscribe payload 保持空不动", () => {
    expect(subscribeMonitor.payload.tier).toBe("monitor");
    expect(subscribeTierDefault.payload.tier).toBeUndefined(); // 缺省 = full（既有语义不变）
    expect(unsubscribeUnchanged.payload).toEqual({}); // EmptyPayload 不动
    expect(unsubscribeUnchanged.sessionId).toBe("sess-1"); // 信封路由位不变
  });

});

// ── 主会话工作台账（main-session plan 批）：session.plan.changed 事件 + 快照 plan/ledger 字段形状 ──

describe("session.plan.changed：主会话工作台账广播（wire 形状）", () => {
  test("载荷形状：sessionId + plan 行集（或 null）+ ledger 计数摘要（或 null，与 plan 同源同 null）", () => {
    const frame: SessionPlanChangedEvent = {
      v: "0.11",
      sessionId: "sess-plan-1",
      channel: "session",
      type: "session.plan.changed",
      payload: {
        sessionId: "sess-plan-1",
        plan: [
          { seq: 1, content: "拉通链路", status: "done", note: null },
          { seq: 2, content: "落地实现", status: "in_progress", note: "进行中注记" },
        ],
        ledger: { total: 2, done: 1, inProgress: 1 },
      },
    };
    expect(frame.type).toBe("session.plan.changed");
    expect(frame.channel).toBe("session");
    expect(frame.payload.plan?.[1]).toEqual({
      seq: 2,
      content: "落地实现",
      status: "in_progress",
      note: "进行中注记",
    });
    // ledger 形状锚定（与 task 域批次 DTO 同源——TaskBatchLedgerDto 复用）
    expect(frame.payload.ledger).toEqual({ total: 2, done: 1, inProgress: 1 });
  });

  test("无台账形态：plan/ledger 双 null（不是空数组——null = 无台账语义）", () => {
    const frame = {
      v: "0.11",
      sessionId: "sess-plan-2",
      channel: "session",
      type: "session.plan.changed",
      payload: { sessionId: "sess-plan-2", plan: null, ledger: null },
    } as const;
    const narrowed: SessionPlanChangedEvent = frame;
    expect(narrowed.payload.plan).toBeNull();
    expect(narrowed.payload.ledger).toBeNull();
  });
});

describe("session.snapshot：主会话 plan 字段（快照恢复种子，additive）", () => {
  test("携带形态：plan 行集 + ledger 计数摘要；无台账 = 双 null", () => {
    const withPlan: SessionSnapshotEvent = {
      v: "0.11",
      sessionId: "sess-plan-1",
      channel: "session",
      type: "session.snapshot",
      payload: {
        snapshot: {
          sessionId: "sess-plan-1",
          model: "m",
          agentState: "idle",
          revision: 0,
          entries: [],
          plan: [{ seq: 1, content: "条目一", status: "pending", note: null }],
          ledger: { total: 1, done: 0, inProgress: 0 },
        },
      },
    };
    expect(withPlan.payload.snapshot.plan).toEqual([
      { seq: 1, content: "条目一", status: "pending", note: null },
    ]);
    expect(withPlan.payload.snapshot.ledger).toEqual({ total: 1, done: 0, inProgress: 0 });

    const noPlan: SessionSnapshotEvent = {
      v: "0.11",
      sessionId: "sess-plan-2",
      channel: "session",
      type: "session.snapshot",
      payload: {
        snapshot: {
          sessionId: "sess-plan-2",
          model: "m",
          agentState: "idle",
          revision: 0,
          entries: [],
          plan: null,
          ledger: null,
        },
      },
    };
    expect(noPlan.payload.snapshot.plan).toBeNull();
    expect(noPlan.payload.snapshot.ledger).toBeNull();
  });
});

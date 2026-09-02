/**
 * plan 消费者 + 快照恢复种子（main-session plan 批）：
 *
 * - session.plan.changed → state.plan/ledger 全量帧整体替换（幂等——重复帧
 *   同态；双 null = 无台账如实落，观察面条隐藏判据）；
 * - session.snapshot 携带 plan/ledger → 恢复种子（重连/切换不丢台账）；
 *   缺省（旧 daemon 未携带）→ 保留现值（thinking 切片同判兼容）；
 *   携带 plan:null → 清场（无台账权威）。
 */
import { describe, expect, it } from "vitest";
import type { EventEnvelope, SessionPlanChangedPayload, WorkItemDto } from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionState,
} from "../session-reducer";

const onEvent = (s: SessionState, event: EventEnvelope): SessionState =>
  sessionReducer(s, { type: "event", event });

const ROWS: WorkItemDto[] = [
  { seq: 1, content: "拉通链路", status: "done", note: "产物见 x" },
  { seq: 2, content: "写失败测试", status: "in_progress", note: null },
  { seq: 3, content: "落地实现", status: "pending", note: null },
];

function planChanged(payload: SessionPlanChangedPayload): EventEnvelope {
  return { v: 0, sessionId: payload.sessionId, channel: "session", type: "session.plan.changed", payload };
}

/** 最小合法快照载荷（plan/ledger 按需覆盖）。 */
function snapshot(extra: Record<string, unknown>): EventEnvelope {
  return {
    v: 0,
    type: "session.snapshot",
    payload: {
      sessionId: "s1",
      snapshot: {
        sessionId: "s1",
        model: "m",
        agentState: "idle",
        entries: [],
        instances: [],
        ...extra,
      },
    },
  } as unknown as EventEnvelope;
}

describe("session.plan.changed → state（main-session plan 批增量面）", () => {
  it("全量帧落 store：plan 行 + ledger 计数摘要（前端零拼装直录）", () => {
    const s = onEvent(
      createInitialSessionState(),
      planChanged({
        sessionId: "s1",
        plan: ROWS,
        ledger: { total: 3, done: 1, inProgress: 1 },
      }),
    );
    expect(s.plan).toEqual(ROWS);
    expect(s.ledger).toEqual({ total: 3, done: 1, inProgress: 1 });
  });

  it("全量帧幂等：重复帧同态；推进帧整体替换（非合并）", () => {
    const first = onEvent(
      createInitialSessionState(),
      planChanged({ sessionId: "s1", plan: ROWS, ledger: { total: 3, done: 1, inProgress: 1 } }),
    );
    const again = onEvent(
      first,
      planChanged({ sessionId: "s1", plan: ROWS, ledger: { total: 3, done: 1, inProgress: 1 } }),
    );
    expect(again.plan).toEqual(ROWS);
    const advanced = onEvent(
      again,
      planChanged({
        sessionId: "s1",
        plan: ROWS.map((r) => (r.seq === 2 ? { ...r, status: "done" as const } : r)),
        ledger: { total: 3, done: 2, inProgress: 0 },
      }),
    );
    expect(advanced.ledger).toEqual({ total: 3, done: 2, inProgress: 0 });
    expect(advanced.plan?.[1]?.status).toBe("done");
  });

  it("双 null 帧 = 无台账如实落（观察面隐藏判据；重建清场同帧形状）", () => {
    const withPlan = onEvent(
      createInitialSessionState(),
      planChanged({ sessionId: "s1", plan: ROWS, ledger: { total: 3, done: 1, inProgress: 1 } }),
    );
    const cleared = onEvent(withPlan, planChanged({ sessionId: "s1", plan: null, ledger: null }));
    expect(cleared.plan).toBeNull();
    expect(cleared.ledger).toBeNull();
  });
});

describe("session.snapshot plan/ledger 恢复种子（additive）", () => {
  it("快照携带 plan/ledger → 恢复种子落 store（重连不丢台账）", () => {
    const s = onEvent(
      createInitialSessionState(),
      snapshot({ plan: ROWS, ledger: { total: 3, done: 1, inProgress: 1 } }),
    );
    expect(s.plan).toEqual(ROWS);
    expect(s.ledger).toEqual({ total: 3, done: 1, inProgress: 1 });
  });

  it("快照缺省 plan 字段（旧 daemon）→ 保留现值（不清场不虚构）", () => {
    const withPlan = onEvent(
      createInitialSessionState(),
      planChanged({ sessionId: "s1", plan: ROWS, ledger: { total: 3, done: 1, inProgress: 1 } }),
    );
    const s = onEvent(withPlan, snapshot({}));
    expect(s.plan).toEqual(ROWS);
    expect(s.ledger).toEqual({ total: 3, done: 1, inProgress: 1 });
  });

  it("快照携带 plan:null → 清场（无台账权威；快照为落盘终态）", () => {
    const withPlan = onEvent(
      createInitialSessionState(),
      planChanged({ sessionId: "s1", plan: ROWS, ledger: { total: 3, done: 1, inProgress: 1 } }),
    );
    const s = onEvent(withPlan, snapshot({ plan: null, ledger: null }));
    expect(s.plan).toBeNull();
    expect(s.ledger).toBeNull();
  });
});

/**
 * plan 消费者 + 快照恢复种子（main-session plan 批 + SubAgent 抽屉 plan 面）：
 *
 * - session.plan.changed → state.plan/ledger 全量帧整体替换（幂等——重复帧
 *   同态；双 null = 无台账如实落，观察面条隐藏判据）；
 * - session.plan.changed payload.instanceId 携带 → SubAgent 实例台账分片
 *   instancePlans[instanceId] 整存/整删（缺省 = 主会话台账既有口径零变化）；
 * - session.snapshot 携带 plan/ledger → 恢复种子（重连/切换不丢台账）；
 *   缺省（旧 daemon 未携带）→ 保留现值（thinking 切片同判兼容）；
 *   携带 plan:null → 清场（无台账权威）；instances[].plan → 实例分片种子
 *   重建（未列实例/无 plan 实例随快照清理）。
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

describe("session.plan.changed instanceId 路由（SubAgent 抽屉 plan 面）", () => {
  const SA_ROWS: WorkItemDto[] = [
    { seq: 1, content: "探查现状", status: "done", note: null },
    { seq: 2, content: "落地改动", status: "in_progress", note: null },
  ];
  const SA_LEDGER = { total: 2, done: 1, inProgress: 1 };

  it("携带 instanceId → 实例分片整存；主会话 plan/ledger 零干扰", () => {
    const base = onEvent(
      createInitialSessionState(),
      planChanged({ sessionId: "s1", plan: ROWS, ledger: { total: 3, done: 1, inProgress: 1 } }),
    );
    const s = onEvent(
      base,
      planChanged({ sessionId: "s1", instanceId: "agent-3", plan: SA_ROWS, ledger: SA_LEDGER }),
    );
    expect(s.instancePlans["agent-3"]).toEqual({ plan: SA_ROWS, ledger: SA_LEDGER });
    expect(s.plan).toEqual(ROWS); // 主会话台账不受实例帧影响
  });

  it("多实例分片互不干扰；推进帧整体替换（非合并）", () => {
    const a = onEvent(
      createInitialSessionState(),
      planChanged({ sessionId: "s1", instanceId: "agent-1", plan: SA_ROWS, ledger: SA_LEDGER }),
    );
    const ab = onEvent(
      a,
      planChanged({
        sessionId: "s1",
        instanceId: "agent-2",
        plan: [{ seq: 1, content: "独立台账", status: "pending", note: null }],
        ledger: { total: 1, done: 0, inProgress: 0 },
      }),
    );
    expect(Object.keys(ab.instancePlans).sort()).toEqual(["agent-1", "agent-2"]);
    const advanced = onEvent(
      ab,
      planChanged({
        sessionId: "s1",
        instanceId: "agent-1",
        plan: SA_ROWS.map((r) => (r.seq === 2 ? { ...r, status: "done" as const } : r)),
        ledger: { total: 2, done: 2, inProgress: 0 },
      }),
    );
    expect(advanced.instancePlans["agent-1"]?.ledger).toEqual({ total: 2, done: 2, inProgress: 0 });
    expect(advanced.instancePlans["agent-2"]?.plan).toHaveLength(1); // 未动实例分片不变
  });

  it("实例帧双 null = 分片整删（无键幂等无操作）；主会话双 null 不受实例键影响", () => {
    const withSlice = onEvent(
      createInitialSessionState(),
      planChanged({ sessionId: "s1", instanceId: "agent-3", plan: SA_ROWS, ledger: SA_LEDGER }),
    );
    const cleared = onEvent(
      withSlice,
      planChanged({ sessionId: "s1", instanceId: "agent-3", plan: null, ledger: null }),
    );
    expect(cleared.instancePlans["agent-3"]).toBeUndefined();
    // 无键双 null → 幂等无操作（引用不变）
    const again = onEvent(
      cleared,
      planChanged({ sessionId: "s1", instanceId: "agent-3", plan: null, ledger: null }),
    );
    expect(again).toBe(cleared);
  });
});

describe("session.snapshot instances[].plan 实例分片种子（SubAgent 抽屉 plan 面）", () => {
  it("快照 instances 携带 plan/ledger → 实例分片种子重建", () => {
    const s = onEvent(
      createInitialSessionState(),
      snapshot({
        instances: [
          {
            instanceId: "agent-main",
            kind: "main",
            profileKind: "main-session",
            state: "idle",
            createdAt: "t",
          },
          {
            instanceId: "agent-3",
            kind: "subagent",
            profileKind: "subagent-worker",
            state: "running",
            createdAt: "t",
            plan: [{ seq: 1, content: "恢复项", status: "done", note: "种子" }],
            ledger: { total: 1, done: 1, inProgress: 0 },
          },
        ],
      }),
    );
    expect(s.instancePlans["agent-3"]).toEqual({
      plan: [{ seq: 1, content: "恢复项", status: "done", note: "种子" }],
      ledger: { total: 1, done: 1, inProgress: 0 },
    });
    expect(s.instancePlans["agent-main"]).toBeUndefined(); // 主实例不走分片
  });

  it("快照未列实例/无 plan 实例 → 分片随快照清理（实例消亡不留残片）", () => {
    const withSlice = onEvent(
      createInitialSessionState(),
      planChanged({
        sessionId: "s1",
        instanceId: "agent-gone",
        plan: [{ seq: 1, content: "旧分片", status: "done", note: null }],
        ledger: { total: 1, done: 1, inProgress: 0 },
      }),
    );
    const s = onEvent(withSlice, snapshot({}));
    expect(s.instancePlans).toEqual({}); // 快照无实例清单 → 全量清理
  });
});

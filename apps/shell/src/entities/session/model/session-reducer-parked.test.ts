/**
 * park/resume 卡片投影（code-review 低危：事件路 no-op 与快照路不同源）。
 *
 * 背景：agent.parked 曾显式 no-op（卡片保持 running），而快照重建直取
 * DTO state（可为 parked）——同一实例「事件期显示执行中、重连快照后变挂起」，
 * 且挂起实例按「非终态」被计进 selectActiveRunState 的 subagent_running 徽标
 *（挂着不干活却把侧栏钉在运行中；SessionStats 实例 chip 的 parked 走 idle 点）。
 *
 * 钉法：①parked 帧落卡片挂起位并停段计时（非终态：不清 closure）；②快照路
 * 同置该位（两路同源）；③resumed 摘位；④挂起实例不计入 subagent_running。
 */
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import type { SessionAction, SessionState } from "./state";
import { createInitialTopologyState, selectActiveRunState, topologyReducer } from "./topology";

const ev = (event: EventEnvelope): SessionAction => ({ type: "event", event });

const welcome = (): EventEnvelope =>
  ({
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "sess-1", model: "claude-sonnet-4-5", agentState: "idle" },
  }) as EventEnvelope;

const spawned = (agentId = "agent-1"): EventEnvelope =>
  ({
    v: 0,
    sessionId: "sess-1",
    type: "agent.spawned",
    payload: { agentId, task: "干活", profileKind: "subagent-worker", anchorEntryId: null },
  }) as EventEnvelope;

const started = (agentId = "agent-1"): EventEnvelope =>
  ({
    v: 0,
    sessionId: "sess-1",
    type: "agent.started",
    payload: { agentId, startedAtMs: 1_000, elapsedMs: 0 },
  }) as EventEnvelope;

const parked = (agentId = "agent-1"): EventEnvelope =>
  ({
    v: 0,
    sessionId: "sess-1",
    type: "agent.parked",
    payload: { agentId, parkedAt: "2026-10-20T10:00:00+08:00" },
  }) as EventEnvelope;

const resumed = (agentId = "agent-1"): EventEnvelope =>
  ({
    v: 0,
    sessionId: "sess-1",
    type: "agent.resumed",
    payload: { agentId, startedAtMs: 5_000, elapsedMs: 2_000 },
  }) as EventEnvelope;

/** 走拓扑根 reducer（产线同径：信封 sessionId 路由到活跃 store）。 */
function run(...events: EventEnvelope[]): SessionState {
  return events.map(ev).reduce(topologyReducer, createInitialTopologyState()).active;
}

const card = (s: SessionState) => s.instances[0]!;

describe("agent.parked 卡片投影（事件路 / 快照路同源）", () => {
  it("parked 帧 → 卡片挂起位 + 停段计时（state 保持非终态，closure 不清）", () => {
    const s = run(welcome(), spawned(), started(), parked());
    expect(card(s).parked).toBe(true);
    expect(card(s).state).toBe("running"); // 非终态：不触发收口链
    expect(card(s).startedAtMs).toBeUndefined();
    expect(card(s).closure).toBeUndefined();
  });

  it("挂起实例不计入 subagent_running 徽标（挂着不干活）；resumed 摘位后恢复计数", () => {
    const s = run(welcome(), spawned(), started());
    expect(selectActiveRunState(s)).toBe("subagent_running");
    const p = run(welcome(), spawned(), started(), parked());
    expect(selectActiveRunState(p)).not.toBe("subagent_running");
    const r = run(welcome(), spawned(), started(), parked(), resumed());
    expect(card(r).parked).toBe(false);
    expect(card(r).startedAtMs).toBe(5_000);
    expect(selectActiveRunState(r)).toBe("subagent_running");
  });

  it("终态吸收：已 failed 的卡片收到 parked 不变（F1.9）", () => {
    const failed: EventEnvelope = {
      v: 0,
      sessionId: "sess-1",
      type: "agent.failed",
      payload: { agentId: "agent-1", error: "boom" },
    } as EventEnvelope;
    const s = run(welcome(), spawned(), started(), failed, parked());
    expect(card(s).parked).toBeUndefined();
    expect(card(s).state).toBe("failed");
  });

  it("快照路同源：DTO state=parked → 卡片 running + 挂起位（重连后徽标口径不变）", () => {
    const s = topologyReducer(
      createInitialTopologyState(),
      ev({
        v: 0,
        type: "session.snapshot",
        payload: {
          snapshot: {
            sessionId: "s1",
            model: "claude-sonnet-4-5",
            agentState: "idle",
            revision: 1,
            entries: [],
            instances: [
              {
                instanceId: "agent-1",
                kind: "subagent",
                state: "parked",
                task: "干活",
                profileKind: "subagent-worker",
                anchorEntryId: null,
              },
            ],
          },
        },
      } as unknown as EventEnvelope),
    ).active;
    expect(card(s).parked).toBe(true);
    expect(card(s).state).toBe("running");
    expect(selectActiveRunState(s)).not.toBe("subagent_running");
  });
});

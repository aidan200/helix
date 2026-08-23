/**
 * thinking 切片消费者单测（thinking 批①③，iter-20260823-6ps5 T2.1）：
 * - thinking.changed 广播 → 活跃 store thinking 切片（override/effective 双位）；
 * - 快照 thinking 读面（additive，缺省保留现值——旧快照/wire 未映射兼容）；
 * - ui/set-draft-thinking 草稿暂存（draft-model 先例：仅草稿态生效，
 *   override + effective 乐观镜像即时反映；真实会话原样防御）。
 * 纯函数纪律（AG-14）：真 reducer 回放造态。
 */
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "../session-reducer";

const ev = (event: EventEnvelope): SessionAction => ({ type: "event", event });

function play(events: SessionAction[], base?: SessionState): SessionState {
  return events.reduce(sessionReducer, base ?? createInitialSessionState());
}

/** 最小快照载荷（thinking 位由用例按需携带/省略）。 */
function snapshotEvent(thinking?: { override: string | null; effective: string | null }): EventEnvelope {
  return {
    v: 0,
    type: "session.snapshot",
    payload: {
      snapshot: {
        sessionId: "s1",
        model: "anthropic/claude-opus-4.1",
        agentState: "idle",
        revision: 0,
        entries: [],
        ...(thinking !== undefined ? { thinking } : {}),
      },
    },
  } as unknown as EventEnvelope;
}

describe("thinking 切片（entities/session；thinking 批①③）", () => {
  it("thinking.changed 广播 → 切片双位更新（override + effective）", () => {
    const s = play([
      ev({
        v: 0,
        type: "thinking.changed",
        sessionId: "s1",
        payload: { override: "xhigh", effective: "high" },
      }),
    ]);
    expect(s.thinking).toEqual({ override: "xhigh", effective: "high" });
  });

  it("thinking.changed 无覆盖（override null）→ 切片 override null", () => {
    const s = play([
      ev({
        v: 0,
        type: "thinking.changed",
        sessionId: "s1",
        payload: { override: null, effective: "medium" },
      }),
    ]);
    expect(s.thinking).toEqual({ override: null, effective: "medium" });
  });

  it("快照携带 thinking → 切片初始化（F1.5 快照侧：UI 与引擎一致）", () => {
    const s = play([ev(snapshotEvent({ override: "high", effective: "high" }))]);
    expect(s.thinking).toEqual({ override: "high", effective: "high" });
  });

  it("快照未携带 thinking（additive 缺省）→ 保留现值（旧快照兼容）", () => {
    const base = play([
      ev({
        v: 0,
        type: "thinking.changed",
        sessionId: "s1",
        payload: { override: "low", effective: "low" },
      }),
    ]);
    const s = play([ev(snapshotEvent())], base);
    expect(s.thinking).toEqual({ override: "low", effective: "low" });
  });

  it("ui/set-draft-thinking：草稿态本地暂存（override + effective 乐观镜像，徽标即时反映）", () => {
    const draft: SessionState = { ...createInitialSessionState(), conn: "connected", view: "ready" };
    const s = sessionReducer(draft, { type: "ui/set-draft-thinking", level: "high" });
    expect(s.thinking).toEqual({ override: "high", effective: "high" });
  });

  it("ui/set-draft-thinking：真实会话原样（防御——真实会话走 thinking.set 帧语义）", () => {
    const real: SessionState = { ...createInitialSessionState(), conn: "connected", view: "ready", sessionId: "s1" };
    const s = sessionReducer(real, { type: "ui/set-draft-thinking", level: "high" });
    expect(s).toBe(real);
  });
});

/**
 * conn 消费者 daemonFreshness 承接（stale-indicator 批）：
 * - welcome 携带 daemonFreshness → 落连接态字段 state.daemonFreshness
 *  （三分支同承接：草稿 / 本地活跃保留 / 首连采纳）；
 * - 缺省（旧 daemon / 打包态）→ null（按新鲜处理）；
 * - 连接级事实：session 切换 / 新建草稿重建活跃 store 时保留（同一 WS
 *   不重握手——welcome 不会再到）。
 */
import { describe, expect, it } from "vitest";
import type { ConnectionWelcomePayload, EventEnvelope } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "../session-reducer";
import { topologyReducer, createInitialTopologyState } from "../topology";

function welcome(payload: ConnectionWelcomePayload): EventEnvelope {
  return { v: 0, type: "connection.welcome", payload };
}

const onEvent = (s: SessionState, event: EventEnvelope): SessionState =>
  sessionReducer(s, { type: "event", event });

const FRESH = { startedAt: 1_760_000_000_000, stale: false };
const STALE = { startedAt: 1_760_000_000_000, stale: true };

describe("connection.welcome daemonFreshness 承接（stale-indicator 批）", () => {
  it("首连采纳分支：携带 stale:true → state.daemonFreshness 原样落连接态", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "m/x", agentState: "idle", daemonFreshness: STALE }),
    );
    expect(s.conn).toBe("connected");
    expect(s.daemonFreshness).toEqual({ startedAt: 1_760_000_000_000, stale: true });
  });

  it("草稿分支（draft:true）：daemonFreshness 同承接", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "daemon-mem-draft", model: "m/x", agentState: "idle", draft: true, daemonFreshness: FRESH }),
    );
    expect(s.sessionId).toBeNull();
    expect(s.daemonFreshness).toEqual({ startedAt: 1_760_000_000_000, stale: false });
  });

  it("本地活跃保留分支（sessionId 非 null）：不采纳会话面字段，daemonFreshness 照承接（连接级事实）", () => {
    let s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "m/a", agentState: "idle" }),
    );
    expect(s.daemonFreshness).toBeNull(); // 缺省（旧 daemon）→ null
    s = onEvent(
      s,
      welcome({ sessionId: "daemon-current", model: "m/b", agentState: "idle", daemonFreshness: STALE }),
    );
    expect(s.sessionId).toBe("s1"); // 视图不被劫持
    expect(s.daemonFreshness).toEqual(STALE); // 连接面字段照常承接
  });

  it("缺省字段（旧 daemon / 打包态）→ null（按新鲜处理，行为不变）", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "m/x", agentState: "idle" }),
    );
    expect(s.daemonFreshness).toBeNull();
  });

  it("重连 welcome 刷新现值：stale → fresh 覆盖（重启 daemon 后重连即消警）", () => {
    let s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "m/x", agentState: "idle", daemonFreshness: STALE }),
    );
    s = onEvent(
      s,
      welcome({ sessionId: "s1", model: "m/x", agentState: "idle", daemonFreshness: FRESH }),
    );
    expect(s.daemonFreshness).toEqual(FRESH);
  });
});

describe("连接级保留：切换会话 / 新建草稿不丢 daemonFreshness", () => {
  it("session/switch-started 重建活跃 store 后保留", () => {
    let topo = createInitialTopologyState();
    topo = topologyReducer(topo, {
      type: "event",
      event: welcome({ sessionId: "s1", model: "m/x", agentState: "idle", daemonFreshness: STALE }),
    });
    expect(topo.active.daemonFreshness).toEqual(STALE);
    topo = topologyReducer(topo, { type: "session/switch-started", sessionId: "s2" });
    expect(topo.active.daemonFreshness).toEqual(STALE); // 同一 WS 连接级事实
  });

  it("session/new-draft 草稿态重建后保留", () => {
    let topo = createInitialTopologyState();
    topo = topologyReducer(topo, {
      type: "event",
      event: welcome({ sessionId: "s1", model: "m/x", agentState: "idle", daemonFreshness: STALE }),
    });
    topo = topologyReducer(topo, { type: "session/new-draft" });
    expect(topo.active.sessionId).toBeNull();
    expect(topo.active.daemonFreshness).toEqual(STALE);
  });
});

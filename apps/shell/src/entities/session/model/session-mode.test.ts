/**
 * P1 会话模式（T4 前端）——session store mode 字段生命周期测试。
 *
 * 设计语义（mode-framework-p1-plan D3/D4）：
 * - 草稿模式 = 纯前端状态（切换零 daemon 交互）：ui/set-draft-mode 唯一
 *   写入口，仅草稿态（sessionId===null）生效；切换同时丢弃本地 draft
 *   model/thinking 暂存（会话将是新的，用户重选）；
 * - 建会话后锁定：快照 mode 收权（snap.mode ?? DEFAULT_MODE_ID）、welcome
 *   （已建会话）回带；此后无任何写路径（ui/set-draft-mode 真实会话原样）；
 * - new draft 重置 default（freshDraftActive 经 createInitialSessionState）；
 * - 切换会话（freshLoadingActive）重置 default，快照到达重新收权。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MODE_ID } from "@helix/protocol";
import type { ConnectionWelcomePayload, EventEnvelope, SessionSnapshotDto } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "./session-reducer";
import { topologyReducer } from "./topology";
import { createInitialTopologyState } from "./state";

const onEvent = (s: SessionState, event: EventEnvelope): SessionState =>
  sessionReducer(s, { type: "event", event });

function welcome(payload: ConnectionWelcomePayload): EventEnvelope {
  return { v: 0, type: "connection.welcome", payload };
}

function snapshotOf(over: Partial<SessionSnapshotDto>): EventEnvelope {
  return {
    v: 0,
    type: "session.snapshot",
    payload: {
      snapshot: {
        sessionId: "s1",
        model: "m/x",
        agentState: "idle",
        revision: 0,
        entries: [],
        ...over,
      },
    },
  };
}

/** 草稿态活跃 store（sessionId===null + view ready）。 */
function draftState(over: Partial<SessionState> = {}): SessionState {
  return { ...createInitialSessionState(), sessionId: null, view: "ready", ...over };
}

describe("初始态 mode（P1 T4）", () => {
  it("初始 = DEFAULT_MODE_ID", () => {
    expect(createInitialSessionState().mode).toBe(DEFAULT_MODE_ID);
    expect(createInitialSessionState().mode).toBe("default");
  });
});

describe("ui/set-draft-mode（草稿态唯一写入口）", () => {
  it("草稿态：置 mode + 丢弃本地 draft model/thinking 暂存", () => {
    const before = draftState({
      mode: "default",
      model: "openai/gpt-5",
      thinking: { override: "high", effective: "high" },
    });
    const s = sessionReducer(before, { type: "ui/set-draft-mode", mode: "default" });
    expect(s.mode).toBe("default");
    expect(s.model).toBe(""); // 切换丢弃：会话将是新的，用户重选
    expect(s.thinking).toEqual({ override: null, effective: null });
  });

  it("草稿态：同值切换同样丢弃暂存（幂等语义以丢弃为准）", () => {
    const before = draftState({ model: "openai/gpt-5" });
    const s = sessionReducer(before, { type: "ui/set-draft-mode", mode: DEFAULT_MODE_ID });
    expect(s.model).toBe("");
    expect(s.thinking).toEqual({ override: null, effective: null });
  });

  it("草稿文本与附件不丢弃（只丢弃 model/thinking 暂存）", () => {
    const before = draftState({
      draft: "半截输入",
      attachments: ["data:image/png;base64,AAAA"],
      model: "openai/gpt-5",
    });
    const s = sessionReducer(before, { type: "ui/set-draft-mode", mode: DEFAULT_MODE_ID });
    expect(s.draft).toBe("半截输入");
    expect(s.attachments).toEqual(["data:image/png;base64,AAAA"]);
  });

  it("已建会话：原样（锁定 = 无第二条写路径，防御）", () => {
    const before = { ...createInitialSessionState(), sessionId: "s1", mode: "default" };
    const s = sessionReducer(before, { type: "ui/set-draft-mode", mode: "staged" });
    expect(s).toBe(before); // 引用不变（零动作）
    expect(s.mode).toBe("default");
  });
});

describe("快照 mode 收权（建会话定格回带）", () => {
  it("snap 携带 mode → state.mode 收权（草稿转正链）", () => {
    const s = onEvent(
      draftState({ mode: "staged", model: "openai/gpt-5" }),
      snapshotOf({ mode: "staged" }),
    );
    expect(s.sessionId).toBe("s1");
    expect(s.mode).toBe("staged"); // 快照权威收权
  });

  it("snap 未携带 mode → 按 default 兜底（旧 daemon 兼容）", () => {
    const s = onEvent(draftState({ mode: "staged" }), snapshotOf({}));
    expect(s.mode).toBe("default");
  });

  it("切换会话重建：mode 先归 default，快照重新收权", () => {
    let s = onEvent(draftState(), snapshotOf({ mode: "staged" }));
    s = topologyReducer(
      { ...createInitialTopologyState(), active: s },
      { type: "session/switch-started", sessionId: "s2" },
    ).active;
    expect(s.mode).toBe("default"); // freshLoadingActive 重置
    s = onEvent(s, snapshotOf({ mode: "staged" }));
    expect(s.mode).toBe("staged");
  });
});

describe("welcome mode 回带（已建会话）", () => {
  it("非草稿 welcome 携带 mode → 落 store", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "m/x", agentState: "idle", mode: "staged" }),
    );
    expect(s.sessionId).toBe("s1");
    expect(s.mode).toBe("staged");
  });

  it("非草稿 welcome 未携带 → default 兜底（旧 daemon 兼容）", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "m/x", agentState: "idle" }),
    );
    expect(s.mode).toBe("default");
  });

  it("草稿 welcome（draft:true）不带 mode → 本地所选保持（重连不丢草稿选择）", () => {
    const before = draftState({ mode: "staged" });
    const s = onEvent(
      before,
      welcome({ sessionId: "daemon-mem-draft", model: "m/x", agentState: "idle", draft: true }),
    );
    expect(s.sessionId).toBeNull();
    expect(s.mode).toBe("staged");
  });
});

describe("session/new-draft 重置 default", () => {
  it("已建会话 → 新草稿：mode 归 default（草稿暂存 model/thinking 一并清零）", () => {
    let s = onEvent(draftState(), snapshotOf({ mode: "staged" }));
    s = topologyReducer({ ...createInitialTopologyState(), active: s }, { type: "session/new-draft" }).active;
    expect(s.sessionId).toBeNull();
    expect(s.mode).toBe("default");
    expect(s.model).toBe("");
    expect(s.thinking).toEqual({ override: null, effective: null });
  });
});

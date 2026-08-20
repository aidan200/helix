/**
 * conn 消费者 welcome draft 标记承接 + 草稿模型本地暂存（T3；bug1 前端半面 + bug4）。
 *
 * - welcome payload.draft===true → connected（hasConnected/toastPending 逻辑保持）
 *   + sessionId 保持 null（草稿态：不激活 daemon 零条目内存草稿——无标题幻影
 *   会话闭环）+ view="ready" + model=payload.model（daemon 全局默认——草稿徽标
 *   数据源）；
 * - draft 缺省/false → 现状回归（sessionId/model/agentState 落 store）；
 * - 草稿态断连重连：welcome draft:true 不把草稿顶回 daemon 当前会话（既有裂缝
 *   覆盖）；真实会话路径行为维持现状（不在本任务扩大）；
 * - ui/set-draft-model：仅 sessionId===null（草稿态）生效置 state.model，真实
 *   会话原样（防御；model.set 帧语义不变）。
 */
import { describe, expect, it } from "vitest";
import type { ConnectionWelcomePayload, EventEnvelope } from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionState,
} from "../session-reducer";

function welcome(payload: ConnectionWelcomePayload): EventEnvelope {
  return { v: 0, type: "connection.welcome", payload };
}

const onEvent = (s: SessionState, event: EventEnvelope): SessionState =>
  sessionReducer(s, { type: "event", event });

describe("connection.welcome draft 标记承接（T3）", () => {
  it("draft:true → connected + sessionId 保持 null + view ready + model 落 store", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({
        sessionId: "daemon-mem-draft",
        model: "anthropic/claude-sonnet-4-5",
        agentState: "idle",
        draft: true,
      }),
    );
    expect(s.conn).toBe("connected");
    expect(s.hasConnected).toBe(true);
    expect(s.sessionId).toBeNull(); // 草稿态：不激活 daemon 内存草稿（无标题幻影闭环）
    expect(s.view).toBe("ready");
    expect(s.model).toBe("anthropic/claude-sonnet-4-5"); // 草稿徽标数据源（daemon 全局默认）
  });

  it("draft 缺省 → 现状回归（sessionId/model/agentState 落 store，view ready）", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "anthropic/claude-sonnet-4-5", agentState: "idle" }),
    );
    expect(s.conn).toBe("connected");
    expect(s.sessionId).toBe("s1");
    expect(s.model).toBe("anthropic/claude-sonnet-4-5");
    expect(s.agentState).toBe("idle");
    expect(s.view).toBe("ready");
  });

  it("draft:false → 现状逻辑（真实会话激活）", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "s1", model: "m/x", agentState: "running", draft: false }),
    );
    expect(s.sessionId).toBe("s1");
    expect(s.model).toBe("m/x");
    expect(s.agentState).toBe("running");
  });

  it("草稿态断连重连 welcome draft:true → 仍草稿（sessionId 保持 null，不顶回 daemon 当前会话）", () => {
    let s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "daemon-mem-draft", model: "m/a", agentState: "idle", draft: true }),
    );
    s = sessionReducer(s, { type: "conn/disconnected" });
    s = onEvent(
      s,
      welcome({ sessionId: "daemon-mem-draft", model: "m/a", agentState: "idle", draft: true }),
    );
    expect(s.conn).toBe("connected");
    expect(s.sessionId).toBeNull();
    expect(s.view).toBe("ready");
    expect(s.model).toBe("m/a");
  });
});

describe("ui/set-draft-model（T3：草稿模型本地暂存）", () => {
  it("sessionId===null（草稿态）→ 置 state.model", () => {
    const before = { ...createInitialSessionState(), sessionId: null, view: "ready" as const };
    const s = sessionReducer(before, { type: "ui/set-draft-model", model: "openai/gpt-5" });
    expect(s.model).toBe("openai/gpt-5");
    expect(s.sessionId).toBeNull();
  });

  it("sessionId 非 null（真实会话）→ 原样（防御）", () => {
    const before = {
      ...createInitialSessionState(),
      sessionId: "s1",
      model: "anthropic/claude-sonnet-4-5",
    };
    const s = sessionReducer(before, { type: "ui/set-draft-model", model: "openai/gpt-5" });
    expect(s).toBe(before); // 引用不变（零动作）
  });
});

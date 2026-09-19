/**
 * conn 消费者 welcome draft 标记承接 + 草稿模型本地暂存（T3；bug1 前端半面 + bug4）。
 *
 * - welcome payload.draft===true → connected（hasConnected/toastPending 逻辑保持）
 *   + sessionId 保持 null（草稿态：不激活 daemon 零条目内存草稿——无标题幻影
 *   会话闭环）+ view="ready" + model=payload.model（daemon 全局默认——草稿徽标
 *   数据源）；
 * - draft 缺省/false → 现状回归（sessionId/model/agentState 落 store）；
 * - 草稿态断连重连：welcome draft:true 不把草稿顶回 daemon 当前会话（既有裂缝
 *   覆盖）；
 * - 本地活跃会话优先（症状B修复方案1）：重连 welcome 非 draft 且本地已有
 *   活跃会话（sessionId 非 null = 用户打开的会话，非草稿新建态）时，welcome
 *   的会话面字段（sessionId/model/mode/agentState）描述的是 daemon 当前会话
 *   （全局最近活跃投影），与用户视图可能错位——保持本地视图不采纳，对账由
 *   replay 的 subscribe(活跃会话) 回推快照权威重建（与 ledger.learnAttached
 *   「已有活跃位不覆盖——用户当前选择优先」对称）；无本地活跃（首连/草稿/
 *   冷启动）照旧采纳；
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

describe("connection.welcome 本地活跃会话优先（症状B修复方案1：重连视图劫持防线）", () => {
  /** 已连接 + 活跃会话 A 定格基线（快照到达后的稳定态；session-mode.test.ts 构造形态）。 */
  function activeOnA(over: Partial<SessionState> = {}): SessionState {
    return {
      ...createInitialSessionState(),
      conn: "connected",
      hasConnected: true,
      view: "ready",
      sessionId: "sess-a",
      model: "m/a",
      mode: "staged",
      agentState: "idle",
      entries: [{ kind: "message", id: "e1", role: "user", content: "问一句", ts: 1 }],
      ...over,
    };
  }

  it("本地活跃会话 A + 重连 welcome 带 B（A≠B）→ 视图保持 A：会话面字段不被 daemon 当前会话顶替，连接面字段照常", () => {
    // 断连（投影与草稿不清空——SM 规则 4/5）后重连，daemon 恢复的最新活跃是 B
    let s = sessionReducer(activeOnA(), { type: "conn/disconnected" });
    s = onEvent(s, welcome({ sessionId: "sess-b", model: "m/b", agentState: "running", mode: "other" }));
    expect(s.conn).toBe("connected"); // 连接面照常更新
    expect(s.hasConnected).toBe(true);
    expect(s.toastPending).toBe("restore"); // 重连恢复 toast（快照条数填满——对账路径）
    expect(s.sessionId).toBe("sess-a"); // 视图保持 A：welcome 不无条件采纳
    expect(s.model).toBe("m/a"); // 会话面字段全保本地（B 的投影不串台）
    expect(s.mode).toBe("staged");
    expect(s.agentState).toBe("idle");
    expect(s.view).toBe("ready"); // 快照两阶段不被 welcome 越权改写（保持现值）
    expect(s.entries).toEqual([
      { kind: "message", id: "e1", role: "user", content: "问一句", ts: 1 },
    ]); // 投影随活跃位保留（对账由 replay 回推快照整体替换）
  });

  it("切换在途（view=loading）重连 welcome 带 B ≠ 目标 → 保持目标 + loading 不被 welcome 越权解除（快照到达才 ready）", () => {
    const switching = activeOnA({ view: "loading", sessionId: "sess-c", model: "", mode: "default" });
    const s = onEvent(
      switching,
      welcome({ sessionId: "sess-b", model: "m/b", agentState: "idle" }),
    );
    expect(s.sessionId).toBe("sess-c"); // 切换目标保持
    expect(s.view).toBe("loading"); // 两阶段协议：仅 session.snapshot 解除 loading
  });

  it("本地无活跃（首连/冷启动）→ 照旧采纳（行为不变）", () => {
    const s = onEvent(
      createInitialSessionState(),
      welcome({ sessionId: "sess-b", model: "m/b", agentState: "running", mode: "staged" }),
    );
    expect(s.conn).toBe("connected");
    expect(s.sessionId).toBe("sess-b"); // 采纳 daemon 当前会话
    expect(s.model).toBe("m/b");
    expect(s.agentState).toBe("running");
    expect(s.mode).toBe("staged");
    expect(s.view).toBe("ready");
  });

  it("草稿态（sessionId=null）重连 welcome 非 draft → 照旧采纳（方案1 范围：草稿态不在保护面，行为不变）", () => {
    const draft = { ...createInitialSessionState(), hasConnected: true, view: "ready" as const };
    const s = onEvent(
      sessionReducer(draft, { type: "conn/disconnected" }),
      welcome({ sessionId: "sess-b", model: "m/b", agentState: "idle" }),
    );
    expect(s.sessionId).toBe("sess-b"); // 既有行为：非 draft welcome 采纳
    expect(s.view).toBe("ready");
  });

  it("手动重试后重连（pendingManualRetry）+ 本地活跃 A → 保持 A + toast 走 retry 文案", () => {
    const s = onEvent(
      sessionReducer({ ...activeOnA(), pendingManualRetry: true }, { type: "conn/manual-retry" }),
      welcome({ sessionId: "sess-b", model: "m/b", agentState: "idle" }),
    );
    expect(s.sessionId).toBe("sess-a"); // 手动重试同属重连：防线同等生效
    expect(s.pendingManualRetry).toBe(false);
    expect(s.toastPending).toBe("retry");
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

/**
 * store 拓扑单测（AD-3 §3.4 前端形态：活跃完整 store + 后台轻量 store；
 * 切换两阶段 P-1s 状态模型 + AD-1 向上分页；T3.1）。
 *
 * 机械判据（brief 决策消解）：
 * ① 「轻量 store」= 后台会话 state 对象不含 entries/channelStreams 字段
 *    （类型级断言 + 运行时断言）；未读计数随该会话事件 +1；
 * ② 「切换两阶段互斥」= loading 期间 success 内容不渲染（entries 清空 +
 *    view=loading + 输入禁用）；快照到达即转 ready + 输入恢复；
 * ③ 「向上分页」= hasMore 门控（false 不再发命令——loading 不置位）；
 *    历史前插不重复；hasMore=false 后禁用；
 * ④ nextChannelSeq per-store 单调：切换重建从快照重算，旧 store seq 不带入。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EntryDto, EventEnvelope, SessionMeta } from "@helix/protocol";
import {
  createInitialTopologyState,
  topologyReducer,
  selectCanLoadEarlier,
  type BackgroundSessionState,
  type TopologyState,
} from "./topology";
import { selectCanSend } from "./session-reducer";
import type { SessionAction } from "./state";

const A = "sess-a";
const B = "sess-b";

// ── 帧构造（v0.2 信封章印）─────────────────────────────────

const ev = (event: EventEnvelope, ts = 0): SessionAction => ({ type: "event", event, ts });

function welcome(sessionId: string): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "notification",
    type: "connection.welcome",
    payload: { sessionId, model: "anthropic/claude-sonnet-4-5", agentState: "idle" },
  };
}

function snapshotFrame(sessionId: string, entries: EntryDto[], tail: { totalEntries?: number; tailStartCursor?: string | null } = {}): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    sessionId,
    channel: "session",
    type: "session.snapshot",
    payload: {
      snapshot: {
        sessionId,
        model: "anthropic/claude-sonnet-4-5",
        agentState: "idle",
        revision: entries.length,
        entries,
        ...(tail.totalEntries !== undefined ? { totalEntries: tail.totalEntries } : {}),
        ...(tail.tailStartCursor !== undefined ? { tailStartCursor: tail.tailStartCursor } : {}),
      },
    },
  };
}

function listResult(metas: SessionMeta[]): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "session",
    type: "session.list.result",
    payload: { sessions: metas },
  };
}

const msg = (id: string, role: "user" | "assistant", content: string, ts: number) => ({
  kind: "message" as const,
  id,
  role,
  content,
  ts,
});

const META_A: SessionMeta = { sessionId: A, title: "活跃会话标题", lastActivityAt: 900, runState: "idle", loaded: true };
const META_B: SessionMeta = { sessionId: B, title: "后台会话标题", lastActivityAt: 500, runState: "streaming", loaded: false };

/** 已连接 + 清单就绪的基线拓扑。 */
function base(): TopologyState {
  const actions: SessionAction[] = [
    ev(welcome(A)),
    ev(snapshotFrame(A, [msg("e2", "user", "二", 2), msg("e1", "assistant", "一", 1)])),
    ev(listResult([META_A, META_B])),
  ];
  return actions.reduce(topologyReducer, createInitialTopologyState());
}

// ── ① 轻量 store 类型级判据 ─────────────────────────────────

describe("后台轻量 store（AD-3 机械判据：不含 entries/channelStreams）", () => {
  it("类型级：BackgroundSessionState 键集恰为轻量六字段（无 entries/channelStreams）", () => {
    expectTypeOf<keyof BackgroundSessionState>().toEqualTypeOf<
      "sessionId" | "title" | "runState" | "lastActivityAt" | "unread" | "seen"
    >();
  });

  it("运行时：切换后旧活跃会话转轻量——对象不含 entries 键；标题取自清单", () => {
    const topo = base();
    const next = topologyReducer(topo, { type: "session/switch-started", sessionId: B });
    const bg = next.background[A]!;
    expect(bg.title).toBe(META_A.title);
    expect(bg.runState).toBe("idle");
    expect(JSON.stringify(bg)).not.toContain("entries");
    expect(JSON.stringify(bg)).not.toContain("channelStreams");
  });

  it("降级填充已见游标（seen）：装载窗口 entry id + 流式 messageId + 进行中轮次 turnId（Set 承载，M35）", () => {
    let topo = base(); // 活跃 A：entries [e2, e1]
    topo = topologyReducer(topo, ev({
      v: PROTOCOL_VERSION,
      sessionId: A,
      channel: "chat",
      type: "chat.turn.started",
      payload: { turnId: "t7" },
    }));
    topo = topologyReducer(topo, ev({
      v: PROTOCOL_VERSION,
      sessionId: A,
      channel: "chat",
      type: "chat.stream.delta",
      payload: { messageId: "m-stream", delta: "流式中" },
    }));
    const next = topologyReducer(topo, { type: "session/switch-started", sessionId: B });
    const bg = next.background[A]!;
    expect(bg.seen.turnId).toBe("t7");
    expect(bg.seen.entryIds).toBeInstanceOf(Set);
    expect([...bg.seen.entryIds].sort()).toEqual(["e1", "e2", "m-stream"]);
  });
});

// ── ② 切换两阶段（P-1s 状态模型）───────────────────────────

describe("切换两阶段互斥（loading → success）", () => {
  it("switch-started：旧活跃转轻量 + 目标重建 loading（entries 清空、sessionId 指向目标、连接态保留）", () => {
    const topo = base();
    expect(topo.active.view).toBe("ready");
    const next = topologyReducer(topo, { type: "session/switch-started", sessionId: B });
    // 旧活跃转后台轻量
    expect(next.background[A]).toBeDefined();
    expect(next.background[B]).toBeUndefined(); // 目标会话轻量态移除（转活跃）
    // 目标 = 全新 loading store：success 内容不渲染（互斥）
    expect(next.active.view).toBe("loading");
    expect(next.active.sessionId).toBe(B);
    expect(next.active.entries).toEqual([]);
    expect(next.active.streaming).toBeNull();
    // 连接态保留（同一 WS 连接切换不断线）
    expect(next.active.conn).toBe("connected");
    expect(next.active.hasConnected).toBe(true);
    // 输入禁用（loading 期间）
    expect(selectCanSend(next.active)).toBe(false);
  });

  it("快照到达即转 ready：输入恢复；重复切换到同会话前 loading 期间 entries 保持清空", () => {
    const switched = topologyReducer(base(), { type: "session/switch-started", sessionId: B });
    const ready = topologyReducer(switched, ev(snapshotFrame(B, [msg("b1", "user", "B 会话尾窗首条", 1)])));
    expect(ready.active.view).toBe("ready");
    expect(ready.active.entries.map((e) => e.id)).toEqual(["b1"]);
    expect(selectCanSend(ready.active)).toBe(true);
  });

  it("切换回原会话：目标会话轻量态转活跃，未读清零后从零计数", () => {
    let topo = base();
    // 后台 B 收两帧白名单内新内容（seen 空游标，保守全计）→ 未读 2
    topo = topologyReducer(topo, ev({
      v: PROTOCOL_VERSION, sessionId: B, channel: "chat", type: "chat.message.completed",
      payload: { entry: msg("b1", "assistant", "后台完成一", 1) },
    }));
    topo = topologyReducer(topo, ev({
      v: PROTOCOL_VERSION, sessionId: B, channel: "chat", type: "chat.message.completed",
      payload: { entry: msg("b2", "assistant", "后台完成二", 2) },
    }));
    expect(topo.background[B]!.unread).toBe(2);
    // 切到 B：轻量态移除（未读随之消解）
    const next = topologyReducer(topo, { type: "session/switch-started", sessionId: B });
    expect(next.background[B]).toBeUndefined();
  });
});

// ── ③ 向上分页（AD-1）──────────────────────────────────────

describe("loadHistory 向上分页门控", () => {
  it("尾窗快照带 tailStartCursor → hasMore 置位；ui/load-earlier 置 loading", () => {
    const setup: SessionAction[] = [
      ev(welcome(A)),
      ev(snapshotFrame(A, [msg("e3", "user", "三", 3)], { totalEntries: 5, tailStartCursor: "e3" })),
    ];
    let topo = setup.reduce(topologyReducer, createInitialTopologyState());
    // T3.2：total = 快照 totalEntries（胶囊分母）；paged = 曾有更早历史（胶囊可见）
    expect(topo.active.history).toEqual({ hasMore: true, nextCursor: "e3", loading: false, total: 5, paged: true });
    expect(selectCanLoadEarlier(topo.active)).toBe(true);
    topo = topologyReducer(topo, { type: "ui/load-earlier" });
    expect(topo.active.history.loading).toBe(true);
    // loading 中重复触发：不再置位（门控）
    const again = topologyReducer(topo, { type: "ui/load-earlier" });
    expect(again).toBe(topo);
  });

  it("result 到达：历史前插不重复 + 翻页位更新；hasMore=false 后禁用（load-earlier no-op）", () => {
    const setup: SessionAction[] = [
      ev(welcome(A)),
      ev(snapshotFrame(A, [msg("e3", "user", "三", 3), msg("e2", "assistant", "二", 2)], { totalEntries: 3, tailStartCursor: "e2" })),
      { type: "ui/load-earlier" },
    ];
    let topo = setup.reduce(topologyReducer, createInitialTopologyState());
    topo = topologyReducer(topo, ev({
      v: PROTOCOL_VERSION, sessionId: A, channel: "session", type: "session.loadHistory.result",
      payload: { entries: [msg("e1", "user", "一", 1), msg("e2", "assistant", "二", 2)], hasMore: false, nextCursor: null },
    }));
    // 前插升序 + e2 去重
    expect(topo.active.entries.map((e) => e.id)).toEqual(["e1", "e3", "e2"]);
    expect(topo.active.history).toEqual({ hasMore: false, nextCursor: null, loading: false, total: 3, paged: true });
    expect(selectCanLoadEarlier(topo.active)).toBe(false);
    // 禁用后 load-earlier 不再置 loading（不再发命令的数据面）
    expect(topologyReducer(topo, { type: "ui/load-earlier" })).toBe(topo);
  });

  it("无尾窗字段的旧快照（v0/v0.1 兼容）→ hasMore=false（全量已含）", () => {
    const topo = [ev(welcome(A)), ev(snapshotFrame(A, [msg("e1", "user", "一", 1)]))].reduce(topologyReducer, createInitialTopologyState());
    expect(topo.active.history.hasMore).toBe(false);
  });
});

// ── ⑤ 新建草稿（F(1.2).1；T3.2）─────────────────────

describe("新建草稿（session/new-draft）", () => {
  it("活跃会话转后台轻量照常执行 + 活跃 store 置草稿态（sessionId=null + view=ready + 输入可用）", () => {
    const topo = base();
    const next = topologyReducer(topo, { type: "session/new-draft" });
    // 旧活跃转后台轻量（标题/运行态取清单元数据）
    expect(next.background[A]).toBeDefined();
    expect(next.background[A]!.title).toBe(META_A.title);
    // 草稿态：无会话上下文、就绪可发（空态直接可见，无快照在途）
    expect(next.active.sessionId).toBeNull();
    expect(next.active.view).toBe("ready");
    expect(next.active.entries).toEqual([]);
    expect(selectCanSend(next.active)).toBe(true);
    // 连接态保留（同一 WS）
    expect(next.active.conn).toBe("connected");
    // 清单不动（草稿不入 session.list——前端零权威）
    expect(next.list).toEqual(topo.list);
  });

  it("已在草稿：原样（引用相等，无动作）；草稿建会话后再次新建 → 新会话转后台", () => {
    const draft = topologyReducer(base(), { type: "session/new-draft" });
    expect(topologyReducer(draft, { type: "session/new-draft" })).toBe(draft);
    // 草稿 → 首条消息建会话（list_changed created + 快照转活跃）→ 再新建：新会话转后台
    const created: SessionMeta = { sessionId: "sess-new", title: "新会话标题", lastActivityAt: 999, runState: "streaming", loaded: true };
    const withNew = topologyReducer(draft, ev(listResult([created, META_A, META_B])));
    const active = topologyReducer(withNew, ev(snapshotFrame("sess-new", [msg("n1", "user", "首条", 1)])));
    expect(active.active.sessionId).toBe("sess-new");
    const again = topologyReducer(active, { type: "session/new-draft" });
    expect(again.background["sess-new"]).toBeDefined();
    expect(again.active.sessionId).toBeNull();
  });

  it("首连前（sessionId=null）新建：无轻量态可转，原样引用保持", () => {
    const initial = createInitialTopologyState();
    expect(topologyReducer(initial, { type: "session/new-draft" })).toBe(initial);
  });
});

// ── ④ nextChannelSeq per-store 单调 ────────────────────────

describe("nextChannelSeq per-store 单调（切换重建从快照重算）", () => {
  it("活跃 store 内全局单调；切换重建后 seq 从新快照重算（旧 store 值不带入）", () => {
    // SubAgent channel 快照重建（channels 字段）→ seq 从 1 起算
    const withChannels: EventEnvelope = {
      v: PROTOCOL_VERSION,
      sessionId: A,
      channel: "session",
      type: "session.snapshot",
      payload: {
        snapshot: {
          sessionId: A,
          model: "anthropic/claude-sonnet-4-5",
          agentState: "idle",
          revision: 2,
          entries: [msg("e1", "user", "主线", 1)],
          instances: [{
            instanceId: "agent-1",
            kind: "subagent",
            profileKind: "subagent-worker",
            state: "done",
            createdAt: "2026-08-16T00:00:00.000Z",
            channels: {
              messages: [{ kind: "message", id: "sa-m1", role: "assistant", content: "实例消息", ts: 1, instanceId: "agent-1" }],
              thinking: [{ kind: "thinking", id: "sa-t1", instanceId: "agent-1", text: "实例思考", durationMs: 10, createdAt: "2026-08-16T00:00:01.000Z" }],
            },
          }],
        },
      },
    };
    const topo = [ev(welcome(A)), ev(withChannels)].reduce(topologyReducer, createInitialTopologyState());
    const items = topo.active.instanceChannels["agent-1"]!;
    expect(items.length).toBeGreaterThanOrEqual(4); // spawned + modelResolved + msg + thinking + closure?
    const seqs = items.map((i) => i.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // 单调递增
    expect(topo.active.nextChannelSeq).toBe(Math.max(...seqs) + 1);

    // 切换到 B 再切回 A：重建后 seq 重算（不沿用上次的最大值漂移）
    const roundTrip: SessionAction[] = [
      { type: "session/switch-started", sessionId: B },
      ev(snapshotFrame(B, [msg("b1", "user", "B", 1)])),
      { type: "session/switch-started", sessionId: A },
      ev(withChannels),
    ];
    const round = roundTrip.reduce(topologyReducer, topo);
    const rebuilt = round.active.instanceChannels["agent-1"]!;
    expect(rebuilt.map((i) => i.seq)).toEqual(seqs); // 确定性重算（同快照同 seq）
  });
});

// ── 组合面：ui/conn action 透传活跃 store ──────────────────

describe("topologyReducer 组合面", () => {
  it("ui/set-draft 等既有 action 透传活跃完整 store", () => {
    const topo = base();
    const next = topologyReducer(topo, { type: "ui/set-draft", text: "草稿" });
    expect(next.active.draft).toBe("草稿");
    expect(next.background).toEqual(topo.background);
  });

  it("conn/* action 透传（切换期间断线 → 活跃 loading store 连接态翻转）", () => {
    const switched = topologyReducer(base(), { type: "session/switch-started", sessionId: B });
    const disconnected = topologyReducer(switched, { type: "conn/disconnected" });
    expect(disconnected.active.conn).toBe("disconnected");
    expect(disconnected.active.view).toBe("loading");
  });
});

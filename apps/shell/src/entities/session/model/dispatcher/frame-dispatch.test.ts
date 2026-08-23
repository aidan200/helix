/**
 * dispatcher 帧路由单测（AD-3 前端形态；v0.2 统一信封接线，T3.1）。
 *
 * 机械判据（brief 决策消解）：
 * ① 帧解析信封 sessionId/channel/type → 按 sessionId 路由：
 *    活跃会话帧 → 完整 store；后台会话帧 → 轻量 store；系统帧
 *    （SYSTEM_SESSION_ID / 缺省 v0·v0.1 兼容）→ 活跃 store 系统面；
 * ② 后台帧只驱动轻量 store（徽标/未读计数），不写活跃 store；
 * ③ 四占位 type 接真消费：list.result → 清单数据；list_changed → 轻量
 *    清单更新；loadHistory.result → 历史前插；model.changed → 会话 model 态；
 * ④ 未知会话帧不误写任何 store（多会话隔离）。
 * 纯函数纪律：无 React / 无 IO / 无 Date.now。
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EventEnvelope, SessionMeta } from "@helix/protocol";
import { dispatchFrame } from "./frame";
import { route } from "./index";
import { createInitialTopologyState, type TopologyState } from "../state";
import { sessionReducer } from "../session-reducer";
import { topologyReducer } from "../topology";

// ── 帧构造（v0.2 信封章印；daemon 下发侧同构）──────────────

const A = "sess-active";
const B = "sess-bg";

function frame(type: string, payload: unknown, opts: { sessionId?: string; channel?: string; instanceId?: string } = {}): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
    ...(opts.channel !== undefined ? { channel: opts.channel as EventEnvelope["channel"] } : {}),
    type,
    payload,
  } as EventEnvelope;
}

/** 活跃会话已连接且已就绪的拓扑基线（welcome + snapshot 重建后）。 */
function connectedTopology(entries: unknown[] = []): TopologyState {
  let topo = createInitialTopologyState();
  const apply = (e: EventEnvelope) => {
    topo = dispatchFrame(topo, e, 0);
  };
  apply(frame("connection.welcome", { sessionId: A, model: "anthropic/claude-sonnet-4-5", agentState: "idle" }, { sessionId: SYSTEM_SESSION_ID, channel: "notification" }));
  apply(frame("session.snapshot", { snapshot: { sessionId: A, model: "anthropic/claude-sonnet-4-5", agentState: "idle", revision: entries.length, entries } }, { sessionId: A, channel: "session" }));
  return topo;
}

/** 带后台会话 B 的拓扑基线（session.list.result 播种轻量 store）。 */
function topologyWithBackground(): TopologyState {
  let topo = connectedTopology();
  const meta: SessionMeta = { sessionId: B, title: "后台会话", lastActivityAt: 500, runState: "idle", loaded: true };
  return dispatchFrame(topo, frame("session.list.result", { sessions: [
    { sessionId: A, title: "活跃会话", lastActivityAt: 900, runState: "idle", loaded: true },
    meta,
  ] }, { sessionId: SYSTEM_SESSION_ID, channel: "session" }));
}

describe("dispatcher 帧路由（v0.2 信封 sessionId）", () => {
  it("活跃会话帧 → 完整 store 消费（chat.stream.delta 进 streaming）", () => {
    const topo = connectedTopology();
    const next = dispatchFrame(topo, frame("chat.stream.delta", { messageId: "m1", delta: "Hel" }, { sessionId: A, channel: "chat" }), 0);
    expect(next.active.streaming).toEqual({ messageId: "m1", text: "Hel" });
    // 后台/清单面不受影响
    expect(next.background).toEqual(topo.background);
  });

  it("系统帧（SYSTEM_SESSION_ID）→ 活跃 store 系统面（connection.*）", () => {
    const topo = createInitialTopologyState();
    const next = dispatchFrame(topo, frame("connection.welcome", { sessionId: A, model: "m/x", agentState: "idle" }, { sessionId: SYSTEM_SESSION_ID, channel: "notification" }), 0);
    expect(next.active.conn).toBe("connected");
    expect(next.active.sessionId).toBe(A);
  });

  it("缺省信封 sessionId（v0/v0.1 兼容帧）→ 活跃 store 消费", () => {
    const topo = connectedTopology();
    const next = dispatchFrame(topo, frame("chat.stream.delta", { messageId: "m1", delta: "旧帧" }), 0);
    expect(next.active.streaming).toEqual({ messageId: "m1", text: "旧帧" });
  });

  it("后台会话帧 → 轻量 store 消费：unread +1、runState 徽标更新、活跃 store 不动", () => {
    const topo = topologyWithBackground();
    const before = topo.active;
    const next = dispatchFrame(topo, frame("chat.stream.delta", { messageId: "b1", delta: "后台流式" }, { sessionId: B, channel: "chat" }), 0);
    expect(next.background[B]!.unread).toBe(1);
    expect(next.background[B]!.runState).toBe("streaming");
    // 不渲染 entries：活跃完整 store 引用不变（未被误写）
    expect(next.active).toBe(before);
  });

  it("后台编排帧 → runState=subagent_running；model.changed 非内容事件不计未读", () => {
    const topo = topologyWithBackground();
    const spawned = dispatchFrame(topo, frame("agent.spawned", { agentId: "ag-1", task: "后台任务", profileKind: "subagent-worker" }, { sessionId: B, channel: "agent" }), 0);
    expect(spawned.background[B]!.runState).toBe("subagent_running");
    expect(spawned.background[B]!.unread).toBe(1);
    const model = dispatchFrame(spawned, frame("model.changed", { sessionId: B, model: "openai/gpt-5.2", previous: "anthropic/claude-sonnet-4-5", effective: "next-turn" }, { sessionId: B, channel: "model" }), 0);
    expect(model.background[B]!.unread).toBe(1); // 换模非内容事件
    // thinking.changed（thinking 批①）同判：会话参数变更非内容事件，不计未读
    const thinking = dispatchFrame(model, frame("thinking.changed", { override: "high", effective: "high" }, { sessionId: B, channel: "thinking" }), 0);
    expect(thinking.background[B]!.unread).toBe(1);
  });

  it("未知会话帧（既非活跃也非后台）→ 状态原样（多会话隔离）", () => {
    const topo = topologyWithBackground();
    const next = dispatchFrame(topo, frame("chat.stream.delta", { messageId: "x", delta: "陌生会话" }, { sessionId: "sess-unknown", channel: "chat" }), 0);
    expect(next).toBe(topo);
  });

  it("agent.config 族三 type（v0.6 系统级）→ 拓扑级前置路由：changed 接真消费（revision 递增），两结果帧直通不写活跃 store（M6 T4）", () => {
    const topo = connectedTopology();
    const activeBefore = topo.active;
    // ① changed 广播 → agentConfig.revision +1（智能体页失效重拉信号）
    const next = dispatchFrame(topo, frame("agent.config.changed", { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false }, { sessionId: SYSTEM_SESSION_ID, channel: "agent" }), 0);
    expect(next).not.toBe(topo);
    expect(next.agentConfig.revision).toBe(topo.agentConfig.revision + 1);
    expect(next.active).toBe(activeBefore); // 活跃会话 store 不被配置广播误写
    // ② 两点对点结果帧 → 拓扑原引用（真消费归页面查询链，registry no-op 已注销）
    expect(dispatchFrame(topo, frame("agent.config.list.result", { profiles: [] }, { sessionId: SYSTEM_SESSION_ID, channel: "agent" }), 0)).toBe(topo);
    expect(dispatchFrame(topo, frame("agent.config.set_enabled.result", { status: "applied" }, { sessionId: SYSTEM_SESSION_ID, channel: "agent" }), 0)).toBe(topo);
    // ③ 结果帧不前置路由时会落入 route() → undefined → 原样返回（多会话隔离不受影响）
    expect(route("agent.config.list.result")).toBeUndefined();
  });

  it("web 族三 type（v0.7 系统级）→ 拓扑级前置路由：result/changed 写 topology.webStatus，stop.result 直通不写态（T4）", () => {
    const topo = connectedTopology();
    const activeBefore = topo.active;
    const statusPayload = {
      state: "connected",
      browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
      tabCount: 1,
      tabs: [{ tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "Example", lastAccessed: 1724000000000 }],
    };
    // ① 启动查询回执 → webStatus 写入（IconRail 联网钮数据源）
    const queried = dispatchFrame(topo, frame("web.status.result", statusPayload, { sessionId: SYSTEM_SESSION_ID, channel: "web" }), 0);
    expect(queried).not.toBe(topo);
    expect(queried.webStatus).toEqual(statusPayload);
    expect(queried.active).toBe(activeBefore); // 活跃会话 store 不被误写
    // ② 广播 → webStatus 覆盖写（idle 回退形态）
    const idled = dispatchFrame(queried, frame("web.status.changed", { state: "idle", tabCount: 0, tabs: [] }, { sessionId: SYSTEM_SESSION_ID, channel: "web" }), 0);
    expect(idled.webStatus).toEqual({ state: "idle", tabCount: 0, tabs: [] });
    // ③ stop 回执 → 拓扑原引用（状态回流经广播）
    expect(dispatchFrame(queried, frame("web.stop.result", { status: "applied" }, { sessionId: SYSTEM_SESSION_ID, channel: "web" }), 0)).toBe(queried);
    expect(route("web.status.result")).toBeUndefined();
  });

  it("session.list.result → 会话清单数据面 + 后台轻量 store 播种（活跃会话不播种）", () => {
    const topo = connectedTopology();
    const next = dispatchFrame(topo, frame("session.list.result", { sessions: [
      { sessionId: A, title: "活跃", lastActivityAt: 900, runState: "idle", loaded: true },
      { sessionId: B, title: "后台", lastActivityAt: 500, runState: "streaming", loaded: false },
    ] }, { sessionId: SYSTEM_SESSION_ID, channel: "session" }), 0);
    expect(next.list.map((m) => m.sessionId)).toEqual([A, B]);
    expect(next.background[B]).toMatchObject({ sessionId: B, title: "后台", runState: "streaming", unread: 0 });
    expect(next.background[A]).toBeUndefined();
  });

  it("session.list_changed{state_changed} → 清单与轻量 store 同步更新", () => {
    const topo = topologyWithBackground();
    const next = dispatchFrame(topo, frame("session.list_changed", {
      kind: "state_changed",
      sessionId: B,
      session: { sessionId: B, title: "后台会话", lastActivityAt: 700, runState: "subagent_running", loaded: true },
    }, { sessionId: SYSTEM_SESSION_ID, channel: "session" }), 0);
    expect(next.background[B]).toMatchObject({ runState: "subagent_running", lastActivityAt: 700 });
    expect(next.list.find((m) => m.sessionId === B)!.runState).toBe("subagent_running");
  });

  it("session.list_changed{created} → 清单新增 + 轻量播种；{deleted} → 双面移除", () => {
    const topo = topologyWithBackground();
    const created = dispatchFrame(topo, frame("session.list_changed", {
      kind: "created",
      sessionId: "sess-new",
      session: { sessionId: "sess-new", title: "新会话标题恰好二十个字符哦哦哦", lastActivityAt: 800, runState: "idle", loaded: true },
    }, { sessionId: SYSTEM_SESSION_ID, channel: "session" }), 0);
    expect(created.list.some((m) => m.sessionId === "sess-new")).toBe(true);
    expect(created.background["sess-new"]).toMatchObject({ title: "新会话标题恰好二十个字符哦哦哦", unread: 0 });

    const deleted = dispatchFrame(created, frame("session.list_changed", { kind: "deleted", sessionId: B }, { sessionId: SYSTEM_SESSION_ID, channel: "session" }), 0);
    expect(deleted.background[B]).toBeUndefined();
    expect(deleted.list.some((m) => m.sessionId === B)).toBe(false);
  });

  it("model.changed（活跃会话）→ 活跃 store model 态更新", () => {
    const topo = connectedTopology();
    expect(topo.active.model).toBe("anthropic/claude-sonnet-4-5");
    const next = dispatchFrame(topo, frame("model.changed", { sessionId: A, model: "openai/gpt-5.2", previous: "anthropic/claude-sonnet-4-5", effective: "next-turn" }, { sessionId: A, channel: "model" }), 0);
    expect(next.active.model).toBe("openai/gpt-5.2");
  });

  it("session.loadHistory.result（活跃）→ 历史前插 + 去重 + 翻页位更新", () => {
    const tail = [
      { kind: "message", id: "e3", role: "assistant", content: "三", ts: 3 },
      { kind: "message", id: "e2", role: "user", content: "二", ts: 2 },
    ];
    const topo = connectedTopology(tail);
    const next = dispatchFrame(topo, frame("session.loadHistory.result", {
      // e3 已在尾窗内（重复下发）→ 去重；e1 前插
      entries: [
        { kind: "message", id: "e1", role: "assistant", content: "一", ts: 1 },
        { kind: "message", id: "e3", role: "assistant", content: "三", ts: 3 },
      ],
      hasMore: false,
      nextCursor: null,
    }, { sessionId: A, channel: "session" }), 0);
    expect(next.active.entries.map((e) => e.id)).toEqual(["e1", "e3", "e2"]);
    // T3.2：total 沿自快照（未携带 = null）；paged 置位（分页胶囊可见性）
    expect(next.active.history).toEqual({ hasMore: false, nextCursor: null, loading: false, total: null, paged: true });
  });

  it("session.snapshot 到达 → background 同名会话清理（草稿建会话链：list_changed 先到）", () => {
    let topo = topologyWithBackground();
    // 草稿链：list_changed{created, sess-draft} 先播种轻量 store
    topo = dispatchFrame(topo, frame("session.list_changed", {
      kind: "created",
      sessionId: "sess-draft",
      session: { sessionId: "sess-draft", title: "草稿新会话", lastActivityAt: 1_000, runState: "idle", loaded: true },
    }, { sessionId: SYSTEM_SESSION_ID, channel: "session" }), 0);
    expect(topo.background["sess-draft"]).toBeDefined();
    // 快照随后到达（连接订阅切换至新会话）→ 新会话转活跃，轻量残留清理
    const next = dispatchFrame(topo, frame("session.snapshot", { snapshot: { sessionId: "sess-draft", model: "anthropic/claude-sonnet-4-5", agentState: "idle", revision: 0, entries: [] } }, { sessionId: "sess-draft", channel: "session" }), 0);
    expect(next.active.sessionId).toBe("sess-draft");
    expect(next.active.view).toBe("ready");
    expect(next.background["sess-draft"]).toBeUndefined();
  });

  it("未注册 type 帧（系统路向）→ 状态原样（原 applyEvent default 语义）", () => {
    const topo = topologyWithBackground();
    const next = dispatchFrame(topo, frame("nonexistent.type", {}, { sessionId: A, channel: "chat" }), 0);
    expect(next).toBe(topo);
  });
});

describe("dispatcher 与既有 reducer 组合面", () => {
  it("同一帧经 dispatchFrame 与 sessionReducer 直投，活跃 store 结果等价（兼容帧路径）", () => {
    const legacy = frame("chat.stream.delta", { messageId: "m1", delta: "兼容" });
    const viaDispatcher = dispatchFrame(createInitialTopologyState(), legacy, 0);
    const viaReducer = sessionReducer(createInitialTopologyState().active, { type: "event", event: legacy, ts: 0 });
    expect(viaDispatcher.active.streaming).toEqual(viaReducer.streaming);
  });
});

describe("草稿态帧路由（bug3 流式串台修复：后台路由不依赖 activeId 非空）", () => {
  /** 草稿态拓扑：A 流式中用户新建草稿（A 转后台轻量已播种，active.sessionId=null）。 */
  function draftTopology(): TopologyState {
    const topo = topologyReducer(topologyWithBackground(), { type: "session/new-draft" });
    expect(topo.active.sessionId).toBeNull();
    expect(topo.background[A]).toBeDefined();
    return topo;
  }

  it("a. 草稿态收到后台已播种会话的 chat.stream.delta → 后台轻量消费，活跃草稿 store 零改动", () => {
    const topo = draftTopology();
    const before = topo.active;
    const next = dispatchFrame(topo, frame("chat.stream.delta", { messageId: "m1", delta: "旧会话流式" }, { sessionId: A, channel: "chat" }), 0);
    expect(next.background[A]!.unread).toBe(1);
    expect(next.background[A]!.runState).toBe("streaming");
    // 串台修复：旧会话流式帧不写入活跃草稿 store（引用不变 + streaming 仍 null）
    expect(next.active).toBe(before);
    expect(next.active.streaming).toBeNull();
  });

  it("b. 草稿态收到未知会话帧 → 原样丢弃（多会话隔离语义不变）", () => {
    const topo = draftTopology();
    const next = dispatchFrame(topo, frame("chat.stream.delta", { messageId: "x", delta: "陌生会话" }, { sessionId: "sess-unknown", channel: "chat" }), 0);
    expect(next).toBe(topo);
  });

  it("c. 草稿态收到 model.get.result（信封 sid=目标会话）→ modelConfig 面正常消费（防回归：配置族前置）", () => {
    const topo = draftTopology();
    const next = dispatchFrame(topo, frame("model.get.result", { defaultModel: "openai/gpt-5.2" }, { sessionId: A, channel: "model" }), 0);
    expect(next.modelConfig.defaultModel).toBe("openai/gpt-5.2");
    // 拓扑级消费：活跃草稿 store 与后台轻量态均不被误写（配置族不入后台未读）
    expect(next.active).toBe(topo.active);
    expect(next.background[A]!.unread).toBe(0);
  });
});

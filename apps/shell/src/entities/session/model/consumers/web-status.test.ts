/**
 * web-status 拓扑级消费者单测（T4 联网状态图标；契约 v0.7 web 族）。
 *
 * 拓扑级消费（操作 TopologyState，与 agent-config 同构）：CDP 连接状态是
 * daemon 级全局数据（信封 sessionId = SYSTEM_SESSION_ID，订阅无关全连接），
 * 不入活跃会话 store，经 dispatcher/frame.ts 前置门路由。
 *
 * 三 type 分工（T7 v0.9 +1：四 type）：
 * - web.status.result（app 启动查询回执）/ web.status.changed（四时机广播）
 *   → 真消费：payload 写入 topology.webStatus（IconRail 联网钮数据源）；
 * - web.stop.result（停止写面回执）/ web.start.result（启动写面回执，v0.9
 *   T7 显式启动通路）→ 拓扑原引用直通（状态回流经 web.status.changed
 *   广播，回执帧零写态——applied/skipped 语义无 UI 消费面）。
 */
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import { createInitialTopologyState } from "../state";
import { applyWebEvent, isWebEventType, WEB_EVENT_TYPES } from "../consumers/web-status";

function frame(type: string, payload: unknown): EventEnvelope {
  return {
    v: "0.10",
    sessionId: "__system__",
    channel: "web",
    type,
    payload,
  } as EventEnvelope;
}

const CONNECTED = {
  state: "connected",
  browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
  tabCount: 1,
  tabs: [
    { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "Example", lastAccessed: 1724000000000 },
  ],
} as const;

describe("isWebEventType（web 族前置门）", () => {
  it("四 type 命中（v0.9 +web.start.result）；族外 type 不命中", () => {
    expect(WEB_EVENT_TYPES).toEqual(["web.status.changed", "web.status.result", "web.stop.result", "web.start.result"]);
    for (const t of WEB_EVENT_TYPES) expect(isWebEventType(t)).toBe(true);
    expect(isWebEventType("agent.config.changed")).toBe(false);
    expect(isWebEventType("model.changed")).toBe(false);
  });
});

describe("applyWebEvent（拓扑级真消费）", () => {
  it("web.status.result（启动查询回执）→ topology.webStatus 写入", () => {
    const topo = createInitialTopologyState();
    expect(topo.webStatus).toBeNull(); // 初值 null = 未收到任何状态帧（灰态）
    const next = applyWebEvent(topo, frame("web.status.result", CONNECTED));
    expect(next).not.toBe(topo);
    expect(next.webStatus).toEqual(CONNECTED);
    expect(next.active).toBe(topo.active); // 活跃会话 store 不被误写
  });

  it("web.status.changed（广播）→ topology.webStatus 覆盖写（含 error 态）", () => {
    const topo = createInitialTopologyState();
    const connected = applyWebEvent(topo, frame("web.status.changed", CONNECTED));
    expect(connected.webStatus).toEqual(CONNECTED);
    const errored = applyWebEvent(connected, frame("web.status.changed", { state: "error", tabCount: 0, error: "CDP WebSocket 断开", tabs: [] }));
    expect(errored.webStatus).toEqual({ state: "error", tabCount: 0, error: "CDP WebSocket 断开", tabs: [] });
    const idle = applyWebEvent(errored, frame("web.status.changed", { state: "idle", tabCount: 0, tabs: [] }));
    expect(idle.webStatus).toEqual({ state: "idle", tabCount: 0, tabs: [] });
  });

  it("web.stop.result（停止回执）→ 拓扑原引用直通（状态回流经广播，回执零写态）", () => {
    const topo = applyWebEvent(createInitialTopologyState(), frame("web.status.result", CONNECTED));
    expect(applyWebEvent(topo, frame("web.stop.result", { status: "applied" }))).toBe(topo);
  });

  it("web.start.result（启动回执，v0.9）→ 拓扑原引用直通（applied/skipped 均零写态）", () => {
    const topo = applyWebEvent(createInitialTopologyState(), frame("web.status.result", CONNECTED));
    expect(applyWebEvent(topo, frame("web.start.result", { status: "applied" }))).toBe(topo);
    expect(applyWebEvent(topo, frame("web.start.result", { status: "skipped", reason: "未发现开启远程调试的浏览器" }))).toBe(topo);
  });
});

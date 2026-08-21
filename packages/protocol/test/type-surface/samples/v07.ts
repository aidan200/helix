import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  CommandEnvelope,
  EventEnvelope,
  WebStatusChangedEvent,
  WebStatusCommand,
  WebStatusResultEvent,
  WebStopCommand,
  WebStopResultEvent,
} from "../../../src/index";

/**
 * v0.7 样例帧（web 族：2 命令 / 2 点对点结果帧 + 1 广播；T4 联网状态图标
 * 契约——daemon BrowserPort 单例 CDP 连接状态读面 + 手动停止写面 +
 * onStatusChange 广播）。构造即类型检查（payload 字面量对位窄化）。
 */
// ── 命令样例 ──

/** web.status：状态查询（无参全局命令；回执 = web.status.result 点对点） */
export const webStatusQuery: WebStatusCommand = {
  v: PROTOCOL_VERSION,
  type: "web.status",
  payload: {},
};

/** web.stop：手动停止（无参全局命令；回执 = web.stop.result 点对点 +
 * 状态回 idle 经 web.status.changed 广播） */
export const webStop: WebStopCommand = {
  v: PROTOCOL_VERSION,
  type: "web.stop",
  payload: {},
};

// ── 事件样例 ──

/** web.status.result：connected 态回执（含 browser 标识 + tabs 清单） */
export const webStatusResultConnected: WebStatusResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "web",
  type: "web.status.result",
  payload: {
    state: "connected",
    browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
    tabCount: 2,
    tabs: [
      { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "Example", lastAccessed: 1724000000000 },
      { tabId: "tab-2", ownerId: "agent-1", url: "https://example.com/docs", title: "Docs", lastAccessed: 1724000060000 },
    ],
  },
};

/** web.status.result：idle 态回执（未连接——browser/error 缺席，tabs 空） */
export const webStatusResultIdle: WebStatusResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "web",
  type: "web.status.result",
  payload: { state: "idle", tabCount: 0, tabs: [] },
};

/** web.stop.result：applied 回执（点对点） */
export const webStopResultApplied: WebStopResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "web",
  type: "web.stop.result",
  payload: { status: "applied" },
};

/** web.status.changed：error 态广播（信封 sessionId = SYSTEM_SESSION_ID 全连接） */
export const webStatusChangedError: WebStatusChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "web",
  type: "web.status.changed",
  payload: { state: "error", tabCount: 0, error: "CDP WebSocket 断开", tabs: [] },
};

/** web.status.changed：connected 态广播（含 tabs——popover 实时清单数据源） */
export const webStatusChangedConnected: WebStatusChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "web",
  type: "web.status.changed",
  payload: {
    state: "connected",
    browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
    tabCount: 1,
    tabs: [
      { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "Example", lastAccessed: 1724000000000 },
    ],
  },
};

export const v07Commands: CommandEnvelope[] = [webStatusQuery, webStop];
export const v07Events: EventEnvelope[] = [
  webStatusResultConnected,
  webStatusResultIdle,
  webStopResultApplied,
  webStatusChangedError,
  webStatusChangedConnected,
];

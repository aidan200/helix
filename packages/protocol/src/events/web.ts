/**
 * web 族事件（v0.7，T4 联网状态图标；契约 = PROTOCOL.md §16.8）。
 *
 * 域形状与 daemon BrowserPort 的 BrowserStatus / TabInfo 对齐（DTO 映射归
 * daemon driving 层 handlers/web.ts；本包零 CDP 符号——id/label/port/tab
 * 全是业务概念）。
 *
 * 三帧分工（v0.9 +1：四帧）：
 * - web.status.result：web.status 查询的点对点回执（TR-AD-21 模式，仅发
 *   发起连接；信封 sessionId = SYSTEM_SESSION_ID——全局命令会话无关）；
 * - web.stop.result：web.stop 写面回执（点对点；停止后的状态回流经
 *   web.status.changed 广播，不在本帧重复）；
 * - web.status.changed：状态变更广播（连接成功/断开/tab 增减/error 四时机，
 *   daemon BrowserPort.onStatusChange 事件源；SYSTEM_SESSION_ID 全连接下发，
 *   与 agent.config.changed 同构；payload 含 tabs——popover 清单实时数据源）；
 * - web.start.result（v0.9，T7 CDP 显式启动通路）：web.start 写面回执
 *  （点对点；applied/skipped 两判别；状态回流同走 changed 广播）。
 */
import type { EventFrame } from "../envelope";

/** CDP 连接状态四态（BrowserConnectionState 同形）。 */
export type WebConnectionState = "idle" | "connecting" | "connected" | "error";

/** 已连接浏览器标识（发现自 DevToolsActivePort + TCP 探活）。 */
export interface WebBrowserDto {
  id: string;
  label: string;
  port: number;
}

/** 受管 tab 行（owner 维度观测面；TabInfo 同形）。 */
export interface WebTabDto {
  tabId: string;
  ownerId: string;
  url: string;
  title: string;
  /** 最近一次操作的 epoch 毫秒（前端闲置时长展示输入）。 */
  lastAccessed: number;
}

/**
 * web.status.result / web.status.changed 共用状态块：state + browser
 * （connected 时携带；idle/error 缺席）+ tabCount（受管 tab 数）+ error
 * （state="error" 时携带）+ tabs（受管 tab 清单快照；广播同形状含 tabs，
 * popover 实时清单数据源）。
 */
export interface WebStatusPayload {
  state: WebConnectionState;
  /** 已建立连接时携带；idle/error（缓存已清）时缺席。 */
  browser?: WebBrowserDto;
  /** daemon 受管 tab 数（managedTabs 口径，非浏览器全部 tab）。 */
  tabCount: number;
  /** state="error" 时的最近错误说明。 */
  error?: string;
  /** 受管 tab 清单（只读快照；未连接 = 空数组）。 */
  tabs: WebTabDto[];
}

/** web.stop.result：停止写面回执（幂等——未连接时 stop 安全 no-op 仍 applied）。 */
export interface WebStopResultPayload {
  status: "applied";
}

/**
 * web.start.result payload（v0.9）：启动写面回执两判别——applied = 建连
 * 成功/已连接幂等（BrowserPort.connect() 幂等语义直通）；skipped = 未发现
 * 可用浏览器，reason 含引导用户开 remote debugging 的说明（daemon
 * browser-discovery 错误文案同源）。
 */
export type WebStartResultPayload =
  | { status: "applied" }
  | { status: "skipped"; reason: string };

// ── v0.7 新增信封（channel 挂 web 新族）──

/** web.status.result：状态查询回执（点对点；信封 sessionId = SYSTEM_SESSION_ID）。 */
export interface WebStatusResultEvent extends EventFrame<WebStatusPayload> {
  channel?: "web";
  type: "web.status.result";
}
/** web.stop.result：停止写面回执（点对点；全局命令）。 */
export interface WebStopResultEvent extends EventFrame<WebStopResultPayload> {
  channel?: "web";
  type: "web.stop.result";
}
/** web.status.changed：状态变更广播（daemon 级全局；信封 sessionId = SYSTEM_SESSION_ID）。 */
export interface WebStatusChangedEvent extends EventFrame<WebStatusPayload> {
  channel?: "web";
  type: "web.status.changed";
}
/** web.start.result：显式启动写面回执（v0.9；点对点；全局命令）。 */
export interface WebStartResultEvent extends EventFrame<WebStartResultPayload> {
  channel?: "web";
  type: "web.start.result";
}

import type {
  BrowserPort,
  BrowserStatus,
  BrowserStatusListener,
  ClickAtResult,
  ClickResult,
  ScrollDirection,
  ScrollResult,
  SetFilesResult,
  ScreenshotFormat,
  ScreenshotResult,
  TabInfo,
} from "../../../../application/ports/outbound/BrowserPort";
import type { ChildOutboundLine, ToolResponseLine } from "../transport/wire";
import { RemoteToolBridge } from "./remote-tool-bridge";

/**
 * RemoteBrowserPort —— BrowserPort 进程外实现（H-3 方案 A 转发通道，子进程侧）。
 *
 * 子进程零 CDP 知识、零连接状态：12 个 browser 工具可达方法（白名单，H-3
 * 裁决 4）序列化为 tool-req 行上 wire，daemon 侧 ScopedBrowserProxy 归属校验后
 * 转发全局唯一 CdpConnectionManager 单例执行，tool-res 回执按 reqId 关联 settle。
 *
 * 管理面 4 方法（connect/onStatusChange/stop/reclaimOwner）**不上 wire**——
 * 有意收窄：共享连接归 daemon 生命周期（lazy connect 由 daemon 侧首发调用拉起，
 * 子进程首发操作即触发）；stop/reclaimOwner 会越 owner 边界（波及他人 tab /
 * 全局连接），归属校验兜不住，子进程侧本地安全 noop。
 *
 * 失败语义：转发超时 / daemon 侧抛错（ok:false）→ 拒绝（中文文案，同
 * CoreToolExecutor 工具错误先例 → 工具 isError）；子进程退出 rejectAll 清场。
 */

/** 转发缺省超时（可注入——测试小值；daemon 侧 CDP 操作自身有独立超时）。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class RemoteBrowserPort implements BrowserPort {
  /** 转发机制单点（pending/reqId/超时/清场与 RemoteAskPort 同源）。 */
  private readonly bridge: RemoteToolBridge;

  constructor(
    instanceId: string,
    writeLine: (line: ChildOutboundLine) => void,
    timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
  ) {
    this.bridge = new RemoteToolBridge({
      instanceId,
      writeLine,
      timeoutMs,
      firstReqId: 0,
      timeoutMessage: (method) => `browser 转发超时（${method}，${timeoutMs}ms 无 daemon 回执）`,
    });
  }

  /** ChildMain stdin 路由馈入：reqId 关联 settle。未知/迟到 reqId 静默忽略。 */
  handleResponse(line: ToolResponseLine): void {
    this.bridge.handleResponse(line);
  }

  /** 子进程退出清场：全部在飞请求以 reason 拒绝（定时器同清）。 */
  rejectAll(reason: string): void {
    this.bridge.rejectAll(reason);
  }

  /** 转发单点（机制在 RemoteToolBridge：reqId 递增 → pending 登记 → 上 wire → 等回执）。 */
  private call<T>(method: string, args: readonly unknown[]): Promise<T> {
    return this.bridge.call<T>(method, args);
  }

  // ── 转发面（12 白名单方法；尾缺省参裁 undefined——JSON null 不越线） ──

  openTab(url: string, ownerId: string): Promise<{ tabId: string }> {
    return this.call("openTab", [url, ownerId]);
  }
  navigateTab(tabId: string, url: string): Promise<void> {
    return this.call("navigateTab", [tabId, url]);
  }
  backTab(tabId: string): Promise<void> {
    return this.call("backTab", [tabId]);
  }
  evalInTab(tabId: string, expression: string): Promise<unknown> {
    return this.call("evalInTab", [tabId, expression]);
  }
  clickInTab(tabId: string, selector: string): Promise<ClickResult> {
    return this.call("clickInTab", [tabId, selector]);
  }
  clickAtInTab(tabId: string, selector: string): Promise<ClickAtResult> {
    return this.call("clickAtInTab", [tabId, selector]);
  }
  setFilesInTab(tabId: string, selector: string, files: readonly string[]): Promise<SetFilesResult> {
    return this.call("setFilesInTab", [tabId, selector, files]);
  }
  scrollTab(tabId: string, y?: number, direction?: ScrollDirection): Promise<ScrollResult> {
    // H9：定长占位（y ?? null / direction ?? null）——杜绝稀疏数组让 direction 落 y 位
    return this.call("scrollTab", [tabId, y ?? null, direction ?? null]);
  }
  screenshotTab(tabId: string, file?: string, format?: ScreenshotFormat): Promise<ScreenshotResult> {
    // H9：定长占位（file ?? null / format ?? null），同上
    return this.call("screenshotTab", [tabId, file ?? null, format ?? null]);
  }
  closeTab(tabId: string): Promise<void> {
    return this.call("closeTab", [tabId]);
  }
  getStatus(): Promise<BrowserStatus> {
    return this.call("getStatus", []);
  }
  listTabs(): Promise<readonly TabInfo[]> {
    return this.call("listTabs", []);
  }

  // ── 管理面（不上 wire——共享连接/他人 tab 不归子进程管；本地安全 noop） ──

  /** noop：连接归 daemon 生命周期；lazy connect 由 daemon 侧首发 tab 操作拉起。 */
  connect(): Promise<void> {
    return Promise.resolve();
  }
  /** noop 退订：状态广播是 daemon→WS 面，子进程无消费场景。 */
  onStatusChange(_listener: BrowserStatusListener): () => void {
    return () => undefined;
  }
  /** noop：stop 波及全局共享连接（他人 tab 同断），不归单个子进程裁决。 */
  stop(): Promise<void> {
    return Promise.resolve();
  }
  /** noop：owner 回收由 daemon 侧终态钩子统一执行（onInstanceTerminal → reclaimOwner）。 */
  reclaimOwner(_ownerId: string): Promise<void> {
    return Promise.resolve();
  }
}

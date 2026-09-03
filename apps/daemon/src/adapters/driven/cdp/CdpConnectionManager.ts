/**
 * CdpConnectionManager —— BrowserPort 的 CDP 实现（CDP 地基；
 * 移植自 web-access/scripts/cdp-proxy.mjs，HTTP proxy 形态 → 进程内 manager）。
 *
 * 【v2 决策】CDP 连接内嵌 daemon 进程：无独立 proxy 进程、无 HTTP 监听
 * 端口、无新增依赖（bun 原生 globalThis.WebSocket）。连接生命周期 =
 * daemon 生命周期——组合根单例 + shutdown 链挂 stop()。
 *
 * 【关键机制（移植蓝本对照）】
 * - 浏览器发现：browser-discovery.ts（DevToolsActivePort + TCP 探活，
 *   不触发授权弹窗）；多浏览器从简取第一个 + 状态带 label（偏好持久化
 *   config.env 机制后续任务再做）。
 * - 连接：ws://127.0.0.1:{port}{wsPath||'/devtools/browser'}；命令 id 配对
 *   + 超时（缺省 30s）；Target.attachedToTarget 事件维护 targetId→sessionId。
 * - 防竞态 openTab：createTarget(about:blank, background) → attach → 显式
 *   Page.navigate → waitForLoad（轮询 readyState，acceptInteractive +
 *   requireNonBlank）——避免慢页面在真正加载前被 about:blank 的
 *   readyState=complete 误判。
 * - 反风控端口拦截：每 session Fetch.enable 拦截 127.0.0.1/localhost:
 *   {debugPort}/* → requestPaused → failRequest(ConnectionRefused)，
 *   防网站探测 DevTools 开着。
 * - 断线重连：ws close → 清 sessions/tabs/发现缓存 + 在飞命令立即拒绝 →
 *   状态回 idle；下次调用 lazy 重连。不杀浏览器、不抛致命错。
 * - idle sweep：TabRegistry 周期扫描，闲置超期 closeTarget + 出册。
 *
 * 【可测性】wsFactory/fsReader/tcpProber/fileWriter/now/各超时参数全部
 * 注入化——integration 测试 fake WS 剧本驱动，不依赖真浏览器。
 */
import { writeFile } from "node:fs/promises";
import type {
  BrowserPort,
  BrowserStatus,
  BrowserStatusListener,
  BrowserConnectionState,
  ClickAtResult,
  ClickResult,
  ScreenshotFormat,
  ScreenshotResult,
  ScrollDirection,
  ScrollResult,
  SetFilesResult,
  TabInfo,
} from "../../../application/ports/outbound/BrowserPort";
import {
  detectBrowsers,
  type DiscoveredBrowser,
  type FsReader,
  type TcpProber,
} from "./browser-discovery";
import { TabRegistry } from "./TabRegistry";

/** 浏览器兼容 WS 面（bun 原生 globalThis.WebSocket / 测试 fake 共用）。 */
export interface CdpWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
}

const WS_OPEN = 1;
const READY_CHECK_EXPR = "JSON.stringify({ ready: document.readyState, url: location.href })";

export interface CdpConnectionManagerDeps {
  /** OS 用户主目录（AG-07：组合根经 infrastructure/paths.ts 取；本模块不直接展开主目录）。 */
  readonly homeDir: string;
  /** 平台（缺省 process.platform；测试注入）。 */
  readonly platform?: string;
  /** win32 LOCALAPPDATA 覆盖（缺省回退 <homeDir>/AppData/Local——AG-08 禁读环境变量）。 */
  readonly localAppData?: string;
  /** 文件读取接缝（发现逻辑；缺省 node:fs）。 */
  readonly fsReader?: FsReader;
  /** TCP 探活接缝（缺省 node:net）。 */
  readonly tcpProber?: TcpProber;
  /** WS 工厂（缺省 bun 原生 WebSocket；测试 fake 剧本驱动）。 */
  readonly wsFactory?: (url: string) => CdpWebSocket;
  /** 截图落盘接缝（缺省 node:fs/promises writeFile）。 */
  readonly fileWriter?: (filePath: string, data: Buffer) => Promise<void>;
  /** 时钟（idle 判定/waitForLoad deadline；缺省 Date.now）。 */
  readonly now?: () => number;
  /** CDP 命令超时 ms（缺省 30s）。 */
  readonly commandTimeoutMs?: number;
  /** waitForLoad 超时 ms（缺省 15s）。 */
  readonly loadTimeoutMs?: number;
  /** waitForLoad readyState 轮询间隔 ms（缺省 500）。 */
  readonly loadPollMs?: number;
  /** scroll 后懒加载触发窗口 ms（缺省 800）。 */
  readonly scrollSettleMs?: number;
  /** idle sweep 扫描间隔 ms（缺省 60s）。 */
  readonly sweepIntervalMs?: number;
  /** tab 闲置阈值 ms（缺省 15min）。 */
  readonly idleTimeoutMs?: number;
}

interface PendingCommand {
  readonly resolve: (msg: any) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CdpConnectionManager implements BrowserPort {
  private state: BrowserConnectionState = "idle";
  private error: string | undefined;
  private browser: DiscoveredBrowser | undefined;
  private ws: CdpWebSocket | undefined;
  private connectingPromise: Promise<void> | undefined;
  private cmdId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly sessions = new Map<string, string>(); // targetId → sessionId
  private readonly portGuardedSessions = new Set<string>();
  private readonly registry: TabRegistry;
  private readonly listeners = new Set<BrowserStatusListener>();

  private readonly platform: string;
  private readonly wsFactory: (url: string) => CdpWebSocket;
  private readonly fileWriter: (filePath: string, data: Buffer) => Promise<void>;
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly loadPollMs: number;
  private readonly scrollSettleMs: number;

  constructor(private readonly deps: CdpConnectionManagerDeps) {
    this.platform = deps.platform ?? process.platform;
    this.wsFactory = deps.wsFactory ?? ((url) => new globalThis.WebSocket(url) as unknown as CdpWebSocket);
    this.fileWriter = deps.fileWriter ?? ((p, data) => writeFile(p, data).then(() => undefined));
    this.now = deps.now ?? Date.now;
    this.commandTimeoutMs = deps.commandTimeoutMs ?? 30_000;
    this.loadTimeoutMs = deps.loadTimeoutMs ?? 15_000;
    this.loadPollMs = deps.loadPollMs ?? 500;
    this.scrollSettleMs = deps.scrollSettleMs ?? 800;
    this.registry = new TabRegistry({
      now: this.now,
      sweepIntervalMs: deps.sweepIntervalMs,
      idleTimeoutMs: deps.idleTimeoutMs,
    });
  }

  // ── 连接与状态 ──────────────────────────────────────────────

  /** lazy 连接（幂等：已连接 no-op；并发复用进行中的连接）。 */
  connect(): Promise<void> {
    if (this.isOpen()) return Promise.resolve();
    if (!this.connectingPromise) {
      this.connectingPromise = this.doConnect().finally(() => {
        this.connectingPromise = undefined;
      });
    }
    return this.connectingPromise;
  }

  /** H-3：公开读面 async 化（RemoteBrowserPort 进程外实现可行）；内部同步快照保留（notifyStatus 广播链零 await）。 */
  getStatus(): Promise<BrowserStatus> {
    return Promise.resolve(this.statusSnapshot());
  }

  /** 状态快照同步组装（内部面：notifyStatus 广播 + getStatus 薄包同源）。 */
  private statusSnapshot(): BrowserStatus {
    return {
      state: this.state,
      browser:
        this.browser !== undefined
          ? { id: this.browser.id, label: this.browser.label, port: this.browser.port }
          : undefined,
      tabCount: this.registry.list().length,
      error: this.error,
    };
  }

  onStatusChange(listener: BrowserStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 手动停止：关全部 managed tabs → 断 WS → 回 idle。幂等；未连接安全 no-op。 */
  async stop(): Promise<void> {
    this.registry.stopSweep();
    if (this.ws !== undefined) {
      for (const id of this.registry.list().map((t) => t.tabId)) {
        try {
          await this.sendCDP("Target.closeTarget", { targetId: id });
        } catch {
          /* tab 可能已关 */
        }
        this.sessions.delete(id);
        this.registry.remove(id);
      }
      this.ws.close(); // handleClose 统一收尾：清缓存/拒绝 pending/状态回 idle
    } else {
      this.registry.clear();
      if (this.state !== "idle") this.setState("idle");
    }
  }

  // ── tab 操作 ────────────────────────────────────────────────

  /** 开后台 tab（防竞态：about:blank → attach → 显式导航 → waitForLoad）。 */
  async openTab(url: string, ownerId: string): Promise<{ tabId: string }> {
    await this.connect();
    const resp = await this.sendCDP("Target.createTarget", { url: "about:blank", background: true });
    const tabId: string = resp.result.targetId;
    this.registry.add(tabId, ownerId);
    this.notifyStatus(); // tab 增

    if (url !== "about:blank") {
      try {
        const sid = await this.ensureSession(tabId);
        await this.sendCDP("Page.navigate", { url }, sid);
        await this.waitForLoad(sid, { requireNonBlank: true, acceptInteractive: true });
        this.registry.update(tabId, { url });
      } catch {
        /* 导航/等待非致命：tab 已开，调用方可 evalInTab 探态 */
      }
    }
    return { tabId };
  }

  async navigateTab(tabId: string, url: string): Promise<void> {
    await this.connect();
    const sid = await this.ensureSession(tabId);
    await this.sendCDP("Page.navigate", { url }, sid);
    await this.waitForLoad(sid);
    this.registry.update(tabId, { url });
    this.registry.touch(tabId);
  }

  /** 后退（history.back + waitForLoad；移植源 /back 同语义）。 */
  async backTab(tabId: string): Promise<void> {
    await this.connect();
    const sid = await this.ensureSession(tabId);
    await this.sendCDP("Runtime.evaluate", { expression: "history.back()" }, sid);
    await this.waitForLoad(sid);
    this.registry.touch(tabId);
  }

  async evalInTab(tabId: string, expression: string): Promise<unknown> {
    await this.connect();
    const sid = await this.ensureSession(tabId);
    const resp = await this.sendCDP(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sid,
    );
    this.registry.touch(tabId);
    if (resp.result?.exceptionDetails) {
      throw new Error(resp.result.exceptionDetails.text ?? "页面内执行异常");
    }
    return resp.result?.result?.value;
  }

  /** JS 层点击（简单快速）；未命中元素 { clicked: false }。 */
  async clickInTab(tabId: string, selector: string): Promise<ClickResult> {
    await this.connect();
    const sid = await this.ensureSession(tabId);
    const selectorJson = JSON.stringify(selector);
    const js = `(() => {
      const el = document.querySelector(${selectorJson});
      if (!el) return { error: '未找到元素: ' + ${selectorJson} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
    })()`;
    const resp = await this.sendCDP("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true }, sid);
    this.registry.touch(tabId);
    const val = resp.result?.result?.value;
    if (!val || val.error) return { clicked: false };
    return val as ClickResult;
  }

  /** 真实鼠标事件点击（算用户手势：文件对话框/反自动化场景）。 */
  async clickAtInTab(tabId: string, selector: string): Promise<ClickAtResult> {
    await this.connect();
    const sid = await this.ensureSession(tabId);
    const selectorJson = JSON.stringify(selector);
    const js = `(() => {
      const el = document.querySelector(${selectorJson});
      if (!el) return { error: '未找到元素: ' + ${selectorJson} };
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
    })()`;
    const coordResp = await this.sendCDP("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true }, sid);
    const coord = coordResp.result?.result?.value;
    if (!coord || coord.error) {
      this.registry.touch(tabId);
      return { clicked: false };
    }
    await this.sendCDP(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: coord.x, y: coord.y, button: "left", clickCount: 1 },
      sid,
    );
    await this.sendCDP(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: coord.x, y: coord.y, button: "left", clickCount: 1 },
      sid,
    );
    this.registry.touch(tabId);
    return { clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text };
  }

  /** 给 file input 设置本地文件（绕过文件对话框）。 */
  async setFilesInTab(tabId: string, selector: string, files: readonly string[]): Promise<SetFilesResult> {
    await this.connect();
    const sid = await this.ensureSession(tabId);
    await this.sendCDP("DOM.enable", {}, sid);
    const doc = await this.sendCDP("DOM.getDocument", {}, sid);
    const node = await this.sendCDP("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector }, sid);
    if (!node.result?.nodeId) {
      throw new Error(`未找到元素: ${selector}`);
    }
    await this.sendCDP("DOM.setFileInputFiles", { nodeId: node.result.nodeId, files: [...files] }, sid);
    this.registry.touch(tabId);
    return { success: true, count: files.length };
  }

  async scrollTab(tabId: string, y = 3000, direction: ScrollDirection = "down"): Promise<ScrollResult> {
    await this.connect();
    const sid = await this.ensureSession(tabId);
    let js: string;
    if (direction === "top") {
      js = 'window.scrollTo(0, 0); "scrolled to top"';
    } else if (direction === "bottom") {
      js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
    } else if (direction === "up") {
      js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
    } else {
      js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
    }
    const resp = await this.sendCDP("Runtime.evaluate", { expression: js, returnByValue: true }, sid);
    this.registry.touch(tabId);
    if (this.scrollSettleMs > 0) await this.sleep(this.scrollSettleMs); // 懒加载触发窗口
    return { value: (resp.result?.result?.value as string | undefined) ?? "" };
  }

  /** 截图：必须给 file 落盘（LLM 后续用 read 工具读图；base64 不进 content）。 */
  async screenshotTab(tabId: string, file?: string, format: ScreenshotFormat = "png"): Promise<ScreenshotResult> {
    if (file === undefined) {
      throw new Error("screenshotTab 必须提供 file 保存路径（截图落盘后由 read 工具读图，不返回 base64）");
    }
    await this.connect();
    const sid = await this.ensureSession(tabId);
    const resp = await this.sendCDP(
      "Page.captureScreenshot",
      { format, quality: format === "jpeg" ? 80 : undefined },
      sid,
    );
    this.registry.touch(tabId);
    const data: string = resp.result.data;
    await this.fileWriter(file, Buffer.from(data, "base64"));
    return { saved: file };
  }

  /** 关 tab（未连接只清本地注册，不触发 lazy connect）。 */
  async closeTab(tabId: string): Promise<void> {
    if (this.isOpen()) {
      try {
        await this.sendCDP("Target.closeTarget", { targetId: tabId });
      } catch {
        /* tab 可能已关 */
      }
    }
    this.sessions.delete(tabId);
    if (this.registry.remove(tabId)) this.notifyStatus(); // tab 减
  }

  listTabs(): Promise<readonly TabInfo[]> {
    return Promise.resolve(this.registry.list());
  }

  /** owner 回收：agent 终态批量关其 tabs（未连接 = 本地出册 no-op）。 */
  async reclaimOwner(ownerId: string): Promise<void> {
    for (const tabId of this.registry.idsByOwner(ownerId)) {
      await this.closeTab(tabId);
    }
  }

  // ── 内部：连接 ──────────────────────────────────────────────

  private isOpen(): boolean {
    return this.ws !== undefined && this.ws.readyState === WS_OPEN;
  }

  private async doConnect(): Promise<void> {
    this.setState("connecting");
    if (this.browser === undefined) {
      const detected = await detectBrowsers({
        platform: this.platform,
        homeDir: this.deps.homeDir,
        localAppData: this.deps.localAppData,
        fsReader: this.deps.fsReader,
        tcpProber: this.deps.tcpProber,
      });
      if (detected.length === 0) {
        const msg =
          "未发现开启远程调试的浏览器（Chrome/Chrome Canary/Chromium/Edge）。" +
          "请在浏览器地址栏访问 chrome://inspect#remote-debugging 并勾选 " +
          '"Allow remote debugging for this browser instance" 后重试。';
        this.setState("error", msg);
        throw new Error(msg);
      }
      // 从简：多个开了调试的浏览器取第一个（偏好持久化机制后续任务）
      this.browser = detected[0]!;
    }
    const { port, wsPath } = this.browser;
    const url = `ws://127.0.0.1:${port}${wsPath ?? "/devtools/browser"}`;
    try {
      await this.openSocket(url);
    } catch (err) {
      this.ws = undefined;
      this.browser = undefined; // 清发现缓存：下次重试重新发现
      this.setState("error", (err as Error).message);
      throw err;
    }
    this.setState("connected");
    this.registry.startSweep((ids) => void this.closeIdleTargets(ids));
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.wsFactory(url);
      this.ws = ws;
      const onOpen = (): void => {
        ws.removeEventListener?.("error", onHandshakeError);
        resolve();
      };
      const onHandshakeError = (e: any): void => {
        reject(new Error(e?.message ?? e?.error?.message ?? "WebSocket 连接失败"));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onHandshakeError);
      ws.addEventListener("close", () => this.handleClose());
      ws.addEventListener("message", (evt: any) => this.handleMessage(evt));
    });
  }

  /** 断线收尾：清 sessions/tabs/发现缓存 + 在飞命令立即拒绝 + 状态回 idle。 */
  private handleClose(): void {
    const hadConnection = this.ws !== undefined;
    this.ws = undefined;
    this.browser = undefined;
    this.sessions.clear();
    this.portGuardedSessions.clear();
    this.registry.stopSweep();
    this.registry.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP 连接已断开"));
    }
    this.pending.clear();
    if (hadConnection || this.state !== "idle") this.setState("idle");
  }

  private handleMessage(evt: any): void {
    const data = typeof evt === "string" ? evt : evt?.data;
    if (typeof data !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // targetId → sessionId 映射维护（flatten attach 事件通道）
    if (msg.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = msg.params;
      this.sessions.set(targetInfo.targetId, sessionId);
      this.registry.update(targetInfo.targetId, { url: targetInfo.url, title: targetInfo.title });
    }
    // 反风控：页面对调试端口的探测请求一律 ConnectionRefused
    if (msg.method === "Fetch.requestPaused") {
      const { requestId } = msg.params;
      void this.sendCDP("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }, msg.sessionId).catch(
        () => undefined,
      );
    }
    // 命令 id 配对
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p !== undefined) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        // M20：{id,error} 响应统一 reject——navigateTab/evalInTab 等不查
        // resp.error 的调用方不再把 CDP 失败静默当成功
        if (msg.error !== undefined) {
          p.reject(new Error(`CDP 错误（${(msg.error as { message?: string }).message ?? JSON.stringify(msg.error)}）`));
        } else {
          p.resolve(msg);
        }
      }
    }
  }

  private sendCDP(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new Error("WebSocket 未连接"));
        return;
      }
      const id = ++this.cmdId;
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId !== undefined) msg.sessionId = sessionId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  /** attach + 反风控端口拦截（每 session 恰一次）。 */
  private async ensureSession(targetId: string): Promise<string> {
    const existing = this.sessions.get(targetId);
    if (existing !== undefined) return existing;
    const resp = await this.sendCDP("Target.attachToTarget", { targetId, flatten: true });
    const sid: string | undefined = resp.result?.sessionId;
    if (sid === undefined) {
      throw new Error("attach 失败: " + JSON.stringify(resp.error));
    }
    this.sessions.set(targetId, sid);
    await this.enablePortGuard(sid);
    return sid;
  }

  /** 拦截页面对调试端口的探测（反风控）；Fetch 域启用失败不影响主流程。 */
  private async enablePortGuard(sessionId: string): Promise<void> {
    if (this.browser === undefined || this.portGuardedSessions.has(sessionId)) return;
    try {
      await this.sendCDP(
        "Fetch.enable",
        {
          patterns: [
            { urlPattern: `http://127.0.0.1:${this.browser.port}/*`, requestStage: "Request" },
            { urlPattern: `http://localhost:${this.browser.port}/*`, requestStage: "Request" },
          ],
        },
        sessionId,
      );
      this.portGuardedSessions.add(sessionId);
    } catch {
      /* Fetch 域启用失败不影响主流程 */
    }
  }

  /** idle sweep 执行面：到期 tab closeTarget + 出册 + tab 减帧。 */
  private async closeIdleTargets(tabIds: string[]): Promise<void> {
    let closed = 0;
    for (const tabId of tabIds) {
      try {
        await this.sendCDP("Target.closeTarget", { targetId: tabId });
      } catch {
        /* tab 可能已关 */
      }
      this.sessions.delete(tabId);
      if (this.registry.remove(tabId)) closed++;
    }
    if (closed > 0) this.notifyStatus();
  }

  /** 等待页面加载（readyState 轮询；超时静默返回——与移植源同语义）。 */
  private async waitForLoad(
    sessionId: string,
    { requireNonBlank = false, acceptInteractive = false }: { requireNonBlank?: boolean; acceptInteractive?: boolean } = {},
  ): Promise<void> {
    await this.sendCDP("Page.enable", {}, sessionId);
    const deadline = this.now() + this.loadTimeoutMs;
    while (this.now() < deadline) {
      try {
        const resp = await this.sendCDP("Runtime.evaluate", { expression: READY_CHECK_EXPR, returnByValue: true }, sessionId);
        const value = resp.result?.result?.value;
        const state = typeof value === "string" ? JSON.parse(value) : null;
        const ready = state?.ready === "complete" || (acceptInteractive && state?.ready === "interactive");
        if (ready && (!requireNonBlank || state.url !== "about:blank")) return;
      } catch {
        /* 轮询单次失败忽略 */
      }
      await this.sleep(this.loadPollMs);
    }
  }

  // ── 内部：状态 ──────────────────────────────────────────────

  private setState(state: BrowserConnectionState, error?: string): void {
    this.state = state;
    this.error = error;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    const status = this.statusSnapshot();
    for (const listener of this.listeners) listener(status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/**
 * 浏览器连接出口端口（outbound，TR-AD-1/2；T2 CDP 地基）。
 *
 * 域形状接口：零 CDP/pi 符号——方法面只有 tab/owner/selector 等业务概念，
 * CDP 协议细节（sessionId/targetId/Fetch 域/Input 域）全部收敛在 driven
 * 实现（adapters/driven/cdp/CdpConnectionManager），T3 工具层零 CDP 知识
 * 纯薄转投，T4 状态协议直接消费 onStatusChange 事件源。
 *
 * 生命周期语义（v2 决策）：CDP 连接内嵌 daemon 进程，无独立 proxy、无
 * HTTP 中间层；连接生命周期 = daemon 生命周期。连接是 lazy 的——首次
 * 调用任一 tab 操作才触发浏览器发现 + WS 建立；断线后状态回 idle，
 * 下次调用自动重连（调用侧无需感知）。
 */
export type BrowserConnectionState = "idle" | "connecting" | "connected" | "error";

/** 已连接浏览器标识（发现自 DevToolsActivePort + TCP 探活）。 */
export interface ConnectedBrowserInfo {
  readonly id: string;
  readonly label: string;
  readonly port: number;
}

export interface BrowserStatus {
  readonly state: BrowserConnectionState;
  /** 已建立连接时携带；idle/error（缓存已清）时缺席。 */
  readonly browser?: ConnectedBrowserInfo;
  /** daemon 受管 tab 数（managedTabs 口径，非浏览器全部 tab）。 */
  readonly tabCount: number;
  /** state="error" 时的最近错误说明。 */
  readonly error?: string;
}

export type BrowserStatusListener = (status: BrowserStatus) => void;

/** 受管 tab 值形状（owner 维度回收/观测的公共面）。 */
export interface TabInfo {
  readonly tabId: string;
  readonly ownerId: string;
  readonly url: string;
  readonly title: string;
  /** 最近一次操作的 epoch 毫秒（idle sweep 判定输入）。 */
  readonly lastAccessed: number;
}

/** clickInTab 结果（JS 层点击；未命中元素 clicked=false）。 */
export interface ClickResult {
  readonly clicked: boolean;
  readonly tag?: string;
  readonly text?: string;
}

/** clickAtInTab 结果（真实鼠标事件，算用户手势；附点击坐标）。 */
export interface ClickAtResult extends ClickResult {
  readonly x?: number;
  readonly y?: number;
}

export type ScrollDirection = "down" | "up" | "top" | "bottom";

export type ScreenshotFormat = "png" | "jpeg" | "webp";

export interface ScreenshotResult {
  readonly format: ScreenshotFormat;
  /** base64 图像数据（未指定 file 时携带）。 */
  readonly data?: string;
  /** 落盘路径（指定 file 时携带）。 */
  readonly file?: string;
}

export interface BrowserPort {
  // ── 连接与状态 ──
  /** lazy 连接：发现浏览器（DevToolsActivePort + TCP 探活）→ 建 WS。幂等——已连接 no-op，并发调用复用同一进行中的连接。 */
  connect(): Promise<void>;
  /** 当前状态快照（读面）。 */
  getStatus(): BrowserStatus;
  /**
   * 状态订阅（T4 广播的事件源）：连接成功/断开/tab 增减/error 四时机触发；
   * 返回退订函数。
   */
  onStatusChange(listener: BrowserStatusListener): () => void;
  /** 手动停止：关全部 managed tabs → 断 WS → 回 idle（daemon 退出清理/用户 web.stop/测试用）。幂等；未连接时安全 no-op。 */
  stop(): Promise<void>;

  // ── tab 操作（owner 维度必带 ownerId 注册；以下操作触发 lazy connect） ──
  /** 开后台 tab（防竞态：先 about:blank + attach，再显式导航 + 等待加载）。 */
  openTab(url: string, ownerId: string): Promise<{ tabId: string }>;
  /** 导航（自动等待加载完成）。 */
  navigateTab(tabId: string, url: string): Promise<void>;
  /** 执行 JS 表达式（returnByValue + awaitPromise）；页面内异常抛错。 */
  evalInTab(tabId: string, expression: string): Promise<unknown>;
  /** JS 层点击（简单快速）；元素未命中返回 { clicked: false }。 */
  clickInTab(tabId: string, selector: string): Promise<ClickResult>;
  /** 真实鼠标事件点击（算用户手势：可触发文件对话框、绕过反自动化检测）。 */
  clickAtInTab(tabId: string, selector: string): Promise<ClickAtResult>;
  /** 给 file input 设置本地文件（绕过文件对话框）；元素未命中抛错。 */
  setFilesInTab(tabId: string, selector: string, files: readonly string[]): Promise<void>;
  /** 滚动页面（默认向下 3000px，滚后留懒加载触发窗口）。 */
  scrollTab(tabId: string, y?: number, direction?: ScrollDirection): Promise<void>;
  /** 截图：file 缺省返回 base64，指定则落盘。 */
  screenshotTab(tabId: string, file?: string, format?: ScreenshotFormat): Promise<ScreenshotResult>;
  /** 关 tab（未连接时只清本地注册，不触发 lazy connect）。 */
  closeTab(tabId: string): Promise<void>;
  /** 受管 tab 清单（只读快照；不触发 lazy connect）。 */
  listTabs(): readonly TabInfo[];
  /** owner 回收：agent 终态时批量关闭其全部 tabs（组合根挂调度器终态钩子；idle sweep 兜底）。 */
  reclaimOwner(ownerId: string): Promise<void>;
}

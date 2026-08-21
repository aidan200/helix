import type {
  BrowserPort,
  BrowserStatus,
  ClickAtResult,
  ClickResult,
  ScrollDirection,
  ScrollResult,
  SetFilesResult,
  ScreenshotFormat,
  ScreenshotResult,
  TabInfo,
} from "../../src/application/ports/outbound/BrowserPort";
import { writeFileSync } from "node:fs";

/**
 * FakeBrowserPort —— BrowserPort 的记录型假实现（test/mocks，与生产 adapter
 * 同接口不同实现，不进 src/；T3 动态族工具测试与「MainSessionProfile 全集
 * 装配」场景的注册桩共用）。
 *
 * - 记录全部调用（方法名 + 参数快照）供转投断言；
 * - failWith 可编程抛错（port 抛错 → isError 错误通路）；
 * - status/tabs 可配置（browser action=status 合并返回面断言）；
 * - screenshotTab 缺 file 抛错（与 CdpConnectionManager 同契约——file 必填
 *   由 port 层裁决）。
 */
export interface BrowserPortCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export class FakeBrowserPort implements BrowserPort {
  readonly calls: BrowserPortCall[] = [];
  /** 预设：方法名 → 抛出的错误（错误通路测试）。 */
  readonly failWith = new Map<string, Error>();
  status: BrowserStatus = { state: "idle", tabCount: 0 };
  tabs: readonly TabInfo[] = [];
  /**
   * T9：screenshotTab 落盘仿真预设——设置后每次截图把该字节写盘（镜像真
   * port 落盘契约）；未设置时只记录调用不写盘（既有测试语义不变，工具侧
   * 读不到文件 → images 缺省不炸分支的被测面）。可传函数按 format 变化
   * （png 首次大图 / jpeg 重截小图剧本）。
   */
  screenshotBytes: Uint8Array | ((format: ScreenshotFormat) => Uint8Array) | null = null;

  private record<T>(method: string, args: readonly unknown[], result: T): T {
    this.calls.push({ method, args });
    const failure = this.failWith.get(method);
    if (failure !== undefined) throw failure;
    return result;
  }

  /** 最近一次指定方法调用（断言辅助）。 */
  lastCall(method: string): BrowserPortCall | undefined {
    return [...this.calls].reverse().find((c) => c.method === method);
  }

  async connect(): Promise<void> {
    this.record("connect", [], undefined);
  }
  getStatus(): BrowserStatus {
    return this.record("getStatus", [], this.status);
  }
  onStatusChange(): () => void {
    return () => undefined;
  }
  async stop(): Promise<void> {
    this.record("stop", [], undefined);
  }
  async openTab(url: string, ownerId: string): Promise<{ tabId: string }> {
    return this.record("openTab", [url, ownerId], { tabId: "tab-new" });
  }
  async navigateTab(tabId: string, url: string): Promise<void> {
    this.record("navigateTab", [tabId, url], undefined);
  }
  async backTab(tabId: string): Promise<void> {
    this.record("backTab", [tabId], undefined);
  }
  async evalInTab(tabId: string, expression: string): Promise<unknown> {
    return this.record("evalInTab", [tabId, expression], { rows: 3 });
  }
  async clickInTab(tabId: string, selector: string): Promise<ClickResult> {
    return this.record("clickInTab", [tabId, selector], { clicked: true, tag: "button", text: "提交" });
  }
  async clickAtInTab(tabId: string, selector: string): Promise<ClickAtResult> {
    return this.record("clickAtInTab", [tabId, selector], { clicked: true, tag: "input", x: 10, y: 20 });
  }
  async setFilesInTab(tabId: string, selector: string, files: readonly string[]): Promise<SetFilesResult> {
    return this.record("setFilesInTab", [tabId, selector, files], { success: true, count: files.length });
  }
  async scrollTab(tabId: string, y?: number, direction?: ScrollDirection): Promise<ScrollResult> {
    return this.record("scrollTab", [tabId, y, direction], { value: `scrolled ${direction ?? "down"} ${y ?? 3000}px` });
  }
  async screenshotTab(tabId: string, file?: string, format?: ScreenshotFormat): Promise<ScreenshotResult> {
    if (file === undefined) {
      this.calls.push({ method: "screenshotTab", args: [tabId, file] });
      throw new Error("screenshotTab 必须提供 file 落盘路径（截图供 read 工具读图）");
    }
    const result = this.record("screenshotTab", [tabId, file, format], { saved: file });
    // T9：落盘仿真（预设字节写入目标路径——镜像真 port 落盘契约）
    if (this.screenshotBytes !== null && file !== undefined) {
      const bytes =
        typeof this.screenshotBytes === "function"
          ? this.screenshotBytes(format ?? "png")
          : this.screenshotBytes;
      writeFileSync(file, bytes);
    }
    return result;
  }
  async closeTab(tabId: string): Promise<void> {
    this.record("closeTab", [tabId], undefined);
  }
  listTabs(): readonly TabInfo[] {
    return this.record("listTabs", [], this.tabs);
  }
  async reclaimOwner(ownerId: string): Promise<void> {
    this.record("reclaimOwner", [ownerId], undefined);
  }
}

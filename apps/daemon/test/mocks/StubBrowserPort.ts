import type {
  BrowserPort,
  BrowserStatus,
  BrowserStatusListener,
  ClickAtResult,
  ClickResult,
  ScreenshotResult,
  ScrollResult,
  SetFilesResult,
  TabInfo,
} from "../../src/application/ports/outbound/BrowserPort";

/**
 * StubBrowserPort（T4，契约 v0.7）：spy 系集成测试的 BrowserPort 最小桩——
 * WsServerAdapterDeps.browser 必填位填充（spy 不触发 web 族命令链，方法
 * 全部抛错防误用；onStatusChange 返回 no-op 退订）。真行为面见
 * test/integration/web-ws.test.ts 的 FakeBrowser（drive 模拟状态变更）。
 */
export class StubBrowserPort implements BrowserPort {
  getStatus(): BrowserStatus {
    return { state: "idle", tabCount: 0 };
  }
  listTabs(): readonly TabInfo[] {
    return [];
  }
  onStatusChange(_listener: BrowserStatusListener): () => void {
    return () => {};
  }
  async stop(): Promise<void> {}
  async connect(): Promise<void> {
    throw new Error("spy 不装配浏览器链");
  }
  async openTab(): Promise<{ tabId: string }> {
    throw new Error("spy 不装配浏览器链");
  }
  async navigateTab(): Promise<void> {
    throw new Error("spy 不装配浏览器链");
  }
  async backTab(): Promise<void> {
    throw new Error("spy 不装配浏览器链");
  }
  async evalInTab(): Promise<unknown> {
    throw new Error("spy 不装配浏览器链");
  }
  async clickInTab(): Promise<ClickResult> {
    throw new Error("spy 不装配浏览器链");
  }
  async clickAtInTab(): Promise<ClickAtResult> {
    throw new Error("spy 不装配浏览器链");
  }
  async setFilesInTab(): Promise<SetFilesResult> {
    throw new Error("spy 不装配浏览器链");
  }
  async scrollTab(): Promise<ScrollResult> {
    throw new Error("spy 不装配浏览器链");
  }
  async screenshotTab(): Promise<ScreenshotResult> {
    throw new Error("spy 不装配浏览器链");
  }
  async closeTab(): Promise<void> {
    throw new Error("spy 不装配浏览器链");
  }
  async reclaimOwner(): Promise<void> {
    throw new Error("spy 不装配浏览器链");
  }
}

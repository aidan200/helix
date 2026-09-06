import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
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
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * code-review M5：system.shutdown 可重入防护（buildDrivingAdapters memo 化）。
 * main.ts SIGTERM handler 与 parent-watchdog onOrphan 共用同一 gracefulExit——
 * SIGTERM 重复送达或 watchdog+SIGTERM 竞态会使 shutdown 并发重入；memo 化后
 * 二次调用直接返回首次结果，sealAll/dispose/stop/writeQueue.close 序列恰好
 * 执行一次（browserPort.stop 调用计数 = 序列执行次数的探针）。
 */

/** fake BrowserPort（零 CDP 触网；stop() 计数作 shutdown 序列执行次数探针）。 */
class FakeBrowser implements BrowserPort {
  stopCalls = 0;
  private readonly listeners = new Set<BrowserStatusListener>();

  async connect(): Promise<void> {}
  async getStatus(): Promise<BrowserStatus> {
    return { state: "idle", tabCount: 0 };
  }
  async listTabs(): Promise<readonly TabInfo[]> {
    return [];
  }
  onStatusChange(listener: BrowserStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  // ── 以下方法本测试不触达（抛错防误用）──
  async openTab(): Promise<{ tabId: string }> {
    throw new Error("not implemented");
  }
  async navigateTab(): Promise<void> {
    throw new Error("not implemented");
  }
  async backTab(): Promise<void> {
    throw new Error("not implemented");
  }
  async evalInTab(): Promise<unknown> {
    throw new Error("not implemented");
  }
  async clickInTab(): Promise<ClickResult> {
    throw new Error("not implemented");
  }
  async clickAtInTab(): Promise<ClickAtResult> {
    throw new Error("not implemented");
  }
  async setFilesInTab(): Promise<SetFilesResult> {
    throw new Error("not implemented");
  }
  async scrollTab(): Promise<ScrollResult> {
    throw new Error("not implemented");
  }
  async screenshotTab(): Promise<ScreenshotResult> {
    throw new Error("not implemented");
  }
  async closeTab(): Promise<void> {
    throw new Error("not implemented");
  }
  async reclaimOwner(): Promise<void> {
    throw new Error("not implemented");
  }
}

describe("system.shutdown 可重入防护（code-review M5）", () => {
  test("并发重入 + 串行迟到调用均返回首次结果：shutdown 序列恰好执行一次", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-shutdown-reentrant-"));
    try {
      const browser = new FakeBrowser();
      const daemon = await createTestDaemon({
        home,
        skipLock: true,
        skipConfig: true,
        port: 0,
        engine: new FakeAgentEngine(),
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
        browser,
      });
      // SIGTERM 重复送达 / watchdog+SIGTERM 竞态形态：并发重入
      await Promise.all([daemon.shutdown(), daemon.shutdown(), daemon.shutdown()]);
      expect(browser.stopCalls).toBe(1); // 序列恰好执行一次（未 memo 化时为 3）
      // 串行迟到调用同样返回首次结果（不再执行序列）
      await daemon.shutdown();
      expect(browser.stopCalls).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

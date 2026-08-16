/**
 * MockController —— spec 侧驱动剧本回放的门面（mock mode on）。
 *
 * 每个 fixture 注入后：app 的 HelixWsClient 在 fake transport 上真实跑
 * （握手 hello / 退避重连 / gave-up 全真），spec 只控制网络事件时序。
 *
 * T4.4 起控制面 window.__helixMock 由应用侧 fake 模块注册（标准注入点，
 * 非首帧前 addInitScript）——首个控制面调用前 awaitReady() 兼容启动竞态。
 */
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { EventEnvelope } from "../../packages/protocol/src/index";
import { snapshot, welcome, type ClientFrame } from "./protocol";

interface HelixMockGlobal {
  open(): Promise<void>;
  emit(frame: EventEnvelope): Promise<void>;
  emitAll(frames: EventEnvelope[]): Promise<void>;
  netClose(code?: number): Promise<void>;
  failHandshake(): Promise<void>;
  clientFrames(): Promise<(ClientFrame | null)[]>;
  activeCount(): Promise<number>;
}

export class MockController {
  constructor(private readonly page: Page) {}

  // ── 网络事件驱动 ──────────────────────────────────────────

  // ── 控制面就绪（T4.4：应用侧注册，非 addInitScript 前置）──

  /** 等待应用侧 fake 模块挂载（window.__helixMock 就绪；app 启动竞态兼容）。 */
  async awaitReady(): Promise<void> {
    await expect
      .poll(() => this.page.evaluate(() => Boolean(window.__helixMock)), { timeout: 10_000 })
      .toBe(true);
  }

  /** 触发 transport open → 生产客户端立即发送 hello 首帧。 */
  async open(): Promise<void> {
    await this.awaitReady();
    return this.page.evaluate(() => window.__helixMock!.open());
  }

  async emit(frame: EventEnvelope): Promise<void> {
    await this.awaitReady();
    return this.page.evaluate((f) => window.__helixMock!.emit(f), frame);
  }

  async emitAll(frames: EventEnvelope[]): Promise<void> {
    await this.awaitReady();
    return this.page.evaluate((fs) => window.__helixMock!.emitAll(fs), frames);
  }

  /** 已建立连接的意外断开（code 1006）。 */
  async netClose(code = 1006): Promise<void> {
    await this.awaitReady();
    return this.page.evaluate((c) => window.__helixMock!.netClose(c), code);
  }

  /** 握手期失败（onerror + close，无 welcome）。 */
  async failHandshake(): Promise<void> {
    await this.awaitReady();
    return this.page.evaluate(() => window.__helixMock!.failHandshake());
  }

  // ── C→S 帧观测 ────────────────────────────────────────────

  async clientFrames(): Promise<ClientFrame[]> {
    // 控制面未就绪（app 启动竞态）返回空——waitForCommand 的 poll 继续
    const frames = await this.page.evaluate(() =>
      window.__helixMock ? window.__helixMock.clientFrames() : [],
    );
    return frames.filter((f): f is ClientFrame => f !== null);
  }

  /** 等待某命令帧到达（poll，避免 evaluate promise 挂死）。 */
  async waitForCommand(type: string, timeout = 5000): Promise<ClientFrame> {
    let found: ClientFrame | undefined;
    await expect
      .poll(
        async () => {
          const frames = await this.clientFrames();
          found = frames.find((f) => f.type === type);
          return Boolean(found);
        },
        { timeout },
      )
      .toBe(true);
    return found!;
  }

  // ── 会话级剧本 ────────────────────────────────────────────

  app(): Locator {
    return this.page.locator(".app");
  }

  /** 等待连接态（data-conn 门控）。 */
  async waitForConn(
    state: "connecting" | "connected" | "disconnected" | "error",
    timeout = 10_000,
  ): Promise<void> {
    await expect
      .poll(() => this.app().getAttribute("data-conn"), { timeout })
      .toBe(state);
  }

  /** 标准建连剧本：open → hello → welcome → snapshot → connected。 */
  async connect(
    frames: EventEnvelope[] = [],
    opts: { model?: string; agentState?: "idle" | "running"; snapshotEntries?: [] } = {},
  ): Promise<void> {
    await this.open();
    await this.waitForCommand("hello");
    await this.emitAll([
      welcome({ model: opts.model, agentState: opts.agentState }),
      snapshot([], { model: opts.model, agentState: opts.agentState }),
      ...frames,
    ]);
    await this.waitForConn("connected");
  }

  /** 用户发送（真实键盘路径：fill + Enter）——返回本次产生的新帧（非历史帧）。 */
  async sendUserMessage(
    text: string,
    expectCmd: "chat.send" | "chat.steer" = "chat.send",
  ): Promise<ClientFrame> {
    const before = (await this.clientFrames()).filter((f) => f.type === expectCmd).length;
    const input = this.page.locator("#msg-input");
    await input.fill(text);
    await input.press("Enter");
    let found: ClientFrame | undefined;
    await expect
      .poll(
        async () => {
          const frames = (await this.clientFrames()).filter((f) => f.type === expectCmd);
          found = frames.length > before ? frames[frames.length - 1] : undefined;
          return Boolean(found);
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    return found!;
  }
}

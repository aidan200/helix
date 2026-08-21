import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import type {
  BrowserPort,
  BrowserStatus,
  BrowserStatusListener,
  ClickAtResult,
  ClickResult,
  ScreenshotFormat,
  ScreenshotResult,
  ScrollDirection,
  ScrollResult,
  SetFilesResult,
  TabInfo,
} from "../../src/application/ports/outbound/BrowserPort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID, type FrameVersion } from "@helix/protocol";

/**
 * T4 web 族命令全链集成（契约 v0.7；真组合根 + FakeAgentEngine + 真 SQLite
 * + loopback WS；BrowserPort 经 options.browser 注入 fake——零 CDP 触网）：
 * - ① web.status（idle / connected 两态）→ web.status.result 点对点回执
 *   （DTO 块 = getStatus + listTabs 组装；browser/tabs 字段映射）；
 * - ② web.stop → fake stop() 执行 + web.stop.result applied 回执 +
 *   状态回 idle 经 web.status.changed 广播回流（onStatusChange 事件源）；
 * - ③ 组合根接线：onStatusChange（连接成功/tab 增减/error 时机模拟）→
 *   web.status.changed 全连接广播（含 tabs 清单，SYSTEM_SESSION_ID）；
 * - ⑥ web.start（v0.9 T7 显式启动通路）→ fake connect() 执行 +
 *   web.start.result applied 回执（已连接幂等同 applied）+ 状态回流经
 *   web.status.changed 广播（单一事件源，handler 不重复发）；
 * - ⑦ connect() 抛错（未发现可用浏览器）→ skipped + reason 含 remote
 *   debugging 引导说明的回执。
 */

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  /** afterIndex 之后的指定 type 首帧（区分同型帧新旧）。 */
  async expectAfter(type: string, afterIndex: number, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.slice(afterIndex).some((f) => f.type === type), timeoutMs, `等待新帧 ${type}`);
    return this.frames.slice(afterIndex).find((f) => f.type === type)!;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

/** hello 握手（同 agent-config-ws 先例）。 */
async function helloHandshake(client: TestClient, token: string): Promise<void> {
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  await client.expect("connection.welcome");
  client.send({ v: 0, type: "session.subscribe", payload: {} });
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-web-ws-it-"));
}

/** fake BrowserPort（零 CDP 触网；drive() 模拟状态变更四时机通知订阅者）。 */
class FakeBrowser implements BrowserPort {
  private status: BrowserStatus = { state: "idle", tabCount: 0 };
  private tabs: readonly TabInfo[] = [];
  private readonly listeners = new Set<BrowserStatusListener>();
  stopCalls = 0;
  connectCalls = 0;
  /** 置位后 connect() 抛此错（模拟未发现可用浏览器）。 */
  connectError: Error | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
    // 建连成功（幂等——已连接时 real port no-op，fake 以 drive 模拟状态通知）
    this.drive({ state: "connected", browser: { id: "chrome-9222", label: "Chrome", port: 9222 }, tabCount: 0 });
  }

  getStatus(): BrowserStatus {
    return this.status;
  }
  listTabs(): readonly TabInfo[] {
    return this.tabs;
  }
  onStatusChange(listener: BrowserStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.drive({ state: "idle", tabCount: 0 });
  }
  /** 测试驱动：设置状态 + tabs 并通知订阅者（模拟 CDP 状态变更时机）。 */
  drive(status: BrowserStatus, tabs: readonly TabInfo[] = []): void {
    this.status = status;
    this.tabs = tabs;
    for (const l of this.listeners) l(this.status);
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

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createDaemon>>;
  browser: FakeBrowser;
  token: string;
  url: string;
  dispose: () => Promise<void>;
}

/** 组合根装配（随机端口；fake BrowserPort 经 options.browser 注入）。 */
async function makeRig(): Promise<Rig> {
  const home = tmpHome();
  const engine = new FakeAgentEngine({});
  const browser = new FakeBrowser();
  const daemon = await createDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    browser,
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return {
    home,
    daemon,
    browser,
    token,
    url: `ws://127.0.0.1:${daemon.ws.port}`,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const CONNECTED: BrowserStatus = {
  state: "connected",
  browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
  tabCount: 2,
};
const TABS: readonly TabInfo[] = [
  { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "Example", lastAccessed: 1724000000000 },
  { tabId: "tab-2", ownerId: "agent-1", url: "https://example.com/docs", title: "Docs", lastAccessed: 1724000060000 },
];

describe("web.status（v0.7 全局命令；点对点结果帧）", () => {
  test("① idle 态：state=idle / tabCount=0 / tabs 空 / browser·error 缺席", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: PROTOCOL_VERSION, type: "web.status", payload: {} });
      const result = await client.expect("web.status.result");
      expect(result.v).toBe(PROTOCOL_VERSION);
      expect(result.channel).toBe("web");
      expect(result.sessionId).toBe(SYSTEM_SESSION_ID); // 全局命令：会话无关
      expect(result.payload).toEqual({ state: "idle", tabCount: 0, tabs: [] });
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("② connected 态：browser 标识 + tabs 清单 DTO 映射（getStatus + listTabs 组装）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");
      rig.browser.drive(CONNECTED, TABS);
      await client.expect("web.status.changed"); // drive 触发广播（接线断言见③）

      client.send({ v: PROTOCOL_VERSION, type: "web.status", payload: {} });
      const result = await client.expect("web.status.result");
      expect(result.payload).toEqual({
        state: "connected",
        browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
        tabCount: 2,
        tabs: [
          { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "Example", lastAccessed: 1724000000000 },
          { tabId: "tab-2", ownerId: "agent-1", url: "https://example.com/docs", title: "Docs", lastAccessed: 1724000060000 },
        ],
      });
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("web.stop（v0.7 全局命令；停止写面）", () => {
  test("③ stop 执行 + applied 回执 + 状态回 idle 经 web.status.changed 广播回流", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");
      rig.browser.drive(CONNECTED, TABS);
      await client.expect("web.status.changed"); // 先等 connected 广播到账（界碑防串帧）
      const at = client.frames.length;

      client.send({ v: PROTOCOL_VERSION, type: "web.stop", payload: {} });
      const result = await client.expectAfter("web.stop.result", at);
      expect(result.channel).toBe("web");
      expect(result.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(result.payload).toEqual({ status: "applied" });
      expect(rig.browser.stopCalls).toBe(1); // fake stop() 真实执行
      // 状态回流：stop() → onStatusChange → 组合根接线广播（handler 不重复广播）
      const changed = await client.expectAfter("web.status.changed", at);
      expect(changed.channel).toBe("web");
      expect(changed.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(changed.payload).toEqual({ state: "idle", tabCount: 0, tabs: [] });
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("web.start（v0.9 全局命令；显式启动写面，T7）", () => {
  test("⑥ connect() 执行 + applied 回执（幂等）+ 状态回 connected 经 web.status.changed 广播回流", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");
      const at = client.frames.length;

      client.send({ v: PROTOCOL_VERSION, type: "web.start", payload: {} });
      const result = await client.expectAfter("web.start.result", at);
      expect(result.v).toBe(PROTOCOL_VERSION);
      expect(result.channel).toBe("web");
      expect(result.sessionId).toBe(SYSTEM_SESSION_ID); // 全局命令：会话无关
      expect(result.payload).toEqual({ status: "applied" });
      expect(rig.browser.connectCalls).toBe(1); // fake connect() 真实执行
      // 状态回流：connect() → onStatusChange → 组合根接线广播（handler 不重复广播）
      const changed = await client.expectAfter("web.status.changed", at);
      expect(changed.channel).toBe("web");
      expect(changed.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(changed.payload).toEqual({
        state: "connected",
        browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
        tabCount: 0,
        tabs: [],
      });

      // 幂等：已连接再 start 仍 applied（connect() no-op 语义归 port，回执面幂等）
      const at2 = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "web.start", payload: {} });
      const again = await client.expectAfter("web.start.result", at2);
      expect(again.payload).toEqual({ status: "applied" });
      expect(rig.browser.connectCalls).toBe(2);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑦ connect() 抛错（未发现可用浏览器）→ skipped + reason 含 remote debugging 引导说明", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");
      rig.browser.connectError = new Error(
        "未发现开启远程调试的浏览器（Chrome/Edge）。请以 --remote-debugging-port=9222 启动后重试",
      );
      const at = client.frames.length;

      client.send({ v: PROTOCOL_VERSION, type: "web.start", payload: {} });
      const result = await client.expectAfter("web.start.result", at);
      expect(result.channel).toBe("web");
      expect(result.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(result.payload.status).toBe("skipped");
      expect(String(result.payload.reason)).toContain("未发现开启远程调试的浏览器");
      expect(String(result.payload.reason)).toContain("remote-debugging-port"); // 引导用户开 remote debugging
      expect(rig.browser.connectCalls).toBe(1);
      // 建连失败无状态变更：不产生 web.status.changed 广播（fake 未 drive）
      expect(client.frames.slice(at).some((f) => f.type === "web.status.changed")).toBe(false);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("组合根接线：onStatusChange → web.status.changed 广播", () => {
  test("④ 状态变更（connected/error 两时机）全连接下发，payload 含 tabs 清单", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      rig.browser.drive(CONNECTED, TABS);
      const connected = await client.expect("web.status.changed");
      expect(connected.v).toBe(PROTOCOL_VERSION);
      expect(connected.channel).toBe("web");
      expect(connected.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(connected.payload).toEqual({
        state: "connected",
        browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
        tabCount: 2,
        tabs: TABS.map((t) => ({ ...t })),
      });

      const at = client.frames.length;
      rig.browser.drive({ state: "error", tabCount: 0, error: "CDP WebSocket 断开" });
      const errored = await client.expectAfter("web.status.changed", at);
      expect(errored.payload).toEqual({ state: "error", tabCount: 0, error: "CDP WebSocket 断开", tabs: [] });
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑤ shutdown 退订：daemon 关闭后 drive 不再触发广播（退订生效不炸）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    await client.open();
    await helloHandshake(client, rig.token);
    await client.expect("session.snapshot");
    await client.close();
    await rig.dispose(); // shutdown 内退订 + stop（不再广播）
    // 关闭后 fake drive：零订阅者通知（退订生效；抛错即失败）
    rig.browser.drive(CONNECTED, TABS);
    expect(rig.browser.stopCalls).toBe(1); // shutdown 挂 stop() 一次
  });
});

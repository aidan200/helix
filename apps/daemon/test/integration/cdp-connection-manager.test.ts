import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CdpConnectionManager } from "../../src/adapters/driven/cdp/CdpConnectionManager";
import type { CdpWebSocket } from "../../src/adapters/driven/cdp/CdpConnectionManager";
import type { BrowserStatus, TabInfo } from "../../src/application/ports/outbound/BrowserPort";

/**
 * T2 CdpConnectionManager integration（fake WS 剧本驱动，不依赖真浏览器）：
 * 连接/attach/eval/openTab 防竞态/反风控拦截/命令超时/断线重连/stop 清理/
 * 状态订阅四时机/owner 回收/idle sweep。
 *
 * FakeWebSocket 剧本：respond(msg) 返回 CDP 响应体（{id 由 fake 自动配对}），
 * 返回 null/undefined = 不应答（超时剧本）；receive() 主动推事件帧
 * （attachedToTarget/requestPaused/server 主动 close）。
 */

// ── FakeWebSocket ──────────────────────────────────────────────

type Respond = (msg: { id: number; method: string; params: any; sessionId?: string }, ws: FakeWebSocket) => object | null | undefined;

class FakeWebSocket implements CdpWebSocket {
  readyState = 0;
  readonly sent: { id?: number; method?: string; params?: any; sessionId?: string }[] = [];
  private readonly listeners = new Map<string, Array<(e: any) => void>>();

  constructor(
    readonly url: string,
    private readonly respond?: Respond,
  ) {}

  addEventListener(type: string, fn: (e: any) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: (e: any) => void): void {
    const arr = this.listeners.get(type) ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  send(raw: string): void {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    const body = this.respond?.(msg, this);
    if (body !== null && body !== undefined) {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: msg.id, ...body }) }));
    }
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  // ── 剧本驱动面 ──
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  fail(message: string): void {
    this.emit("error", { message });
  }
  receive(msg: object): void {
    this.emit("message", { data: JSON.stringify(msg) });
  }
  private emit(type: string, evt: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
}

// ── 剧本工具 ───────────────────────────────────────────────────

const CHROME_PORT_FILE = path.join("/fake-home", "Library/Application Support/Google/Chrome/DevToolsActivePort");

let tabSeq = 0;

/** readyState 轮询应答：complete + 非 blank（openTab waitForLoad 一次过）。 */
function evaluateValue(expression: string): unknown {
  if (expression.includes("readyState")) {
    return JSON.stringify({ ready: "complete", url: "https://example.com/" });
  }
  return undefined;
}

/** 默认全绿剧本（可用 overrides 按 method 覆盖）。 */
function defaultRespond(overrides: Partial<Record<string, (msg: any) => object | null>> = {}): Respond {
  return (msg) => {
    const override = overrides[msg.method];
    if (override) return override(msg);
    switch (msg.method) {
      case "Target.createTarget":
        return { result: { targetId: `tab-${++tabSeq}` } };
      case "Target.attachToTarget":
        return { result: { sessionId: `sess-${msg.params.targetId}` } };
      case "Target.closeTarget":
        return { result: { success: true } };
      case "Runtime.evaluate":
        return { result: { result: { value: evaluateValue(msg.params.expression) } } };
      case "Page.captureScreenshot":
        return { result: { data: Buffer.from("fake-png-bytes").toString("base64") } };
      case "DOM.getDocument":
        return { result: { root: { nodeId: 1 } } };
      case "DOM.querySelector":
        return { result: { nodeId: 42 } };
      default:
        return { result: {} };
    }
  };
}

interface Harness {
  manager: CdpConnectionManager;
  sockets: FakeWebSocket[];
  statuses: BrowserStatus[];
  clock: { now: () => number; advance: (ms: number) => void };
  fileWrites: { path: string; data: Buffer }[];
}

function createHarness(opts: {
  respond?: Respond;
  fsFiles?: Record<string, string> | null;
  commandTimeoutMs?: number;
  sweepIntervalMs?: number;
  autoOpen?: boolean;
}): Harness {
  const sockets: FakeWebSocket[] = [];
  const statuses: BrowserStatus[] = [];
  const fileWrites: { path: string; data: Buffer }[] = [];
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const autoOpen = opts.autoOpen ?? true;

  const manager = new CdpConnectionManager({
    platform: "darwin",
    homeDir: "/fake-home",
    fsReader:
      opts.fsFiles === null
        ? () => null
        : (() => {
            const files = opts.fsFiles ?? { [CHROME_PORT_FILE]: "9222\n/devtools/browser/fake-ws-path" };
            return (p: string) => files[p] ?? null;
          })(),
    tcpProber: async () => true,
    wsFactory: (url) => {
      const ws = new FakeWebSocket(url, opts.respond ?? defaultRespond());
      sockets.push(ws);
      if (autoOpen) queueMicrotask(() => ws.open());
      return ws;
    },
    now: clock.now,
    commandTimeoutMs: opts.commandTimeoutMs ?? 5_000,
    loadPollMs: 1,
    loadTimeoutMs: 1_000,
    scrollSettleMs: 0,
    sweepIntervalMs: opts.sweepIntervalMs,
    idleTimeoutMs: 15 * 60_000,
    fileWriter: async (p, data) => {
      fileWrites.push({ path: p, data });
    },
  });
  manager.onStatusChange((s) => statuses.push(s));
  return { manager, sockets, statuses, clock, fileWrites };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 测试 ───────────────────────────────────────────────────────

describe("CdpConnectionManager 连接与状态", () => {
  test("lazy connect：发现 → ws://127.0.0.1:9222/devtools/browser/fake-ws-path；状态 connecting→connected", async () => {
    const h = createHarness({});
    await h.manager.connect();

    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.url).toBe("ws://127.0.0.1:9222/devtools/browser/fake-ws-path");

    const status = (await h.manager.getStatus());
    expect(status.state).toBe("connected");
    expect(status.browser).toEqual({ id: "chrome", label: "Chrome", port: 9222 });
    expect(status.tabCount).toBe(0);
    expect(status.error).toBeUndefined();

    // 订阅面：connecting → connected 两帧
    expect(h.statuses.map((s) => s.state)).toEqual(["connecting", "connected"]);
    await h.manager.stop();
  });

  test("connect 幂等：已连接时 no-op（不重复建 WS）；并发 connect 复用同一 Promise", async () => {
    const h = createHarness({});
    await Promise.all([h.manager.connect(), h.manager.connect()]);
    await h.manager.connect();
    expect(h.sockets).toHaveLength(1);
    await h.manager.stop();
  });

  test("无浏览器开调试 → connect 拒绝 + 状态 error（订阅面收到 error 帧）", async () => {
    const h = createHarness({ fsFiles: null });
    await expect(h.manager.connect()).rejects.toThrow(/远程调试/);
    const status = (await h.manager.getStatus());
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/远程调试/);
    expect(h.statuses.map((s) => s.state)).toEqual(["connecting", "error"]);
  });

  test("命令配对超时：不应答的命令在 commandTimeoutMs 后拒绝", async () => {
    const h = createHarness({
      respond: defaultRespond({ "Target.createTarget": () => null }),
      commandTimeoutMs: 30,
    });
    await expect(h.manager.openTab("https://example.com", "agent-1")).rejects.toThrow(/超时/);
    await h.manager.stop();
  });

  test("退订函数：unsubscribe 后不再收到状态帧", async () => {
    const h = createHarness({});
    const extra: BrowserStatus[] = [];
    const unsub = h.manager.onStatusChange((s) => extra.push(s));
    unsub();
    await h.manager.connect();
    expect(extra).toEqual([]);
    await h.manager.stop();
  });
});

describe("CdpConnectionManager tab 操作", () => {
  test("openTab 防竞态序列：createTarget(about:blank,background) → attach → Fetch.enable → Page.navigate → waitForLoad", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("https://example.com", "agent-1");

    const methods = h.sockets[0]!.sent.map((m) => m.method);
    const createIdx = methods.indexOf("Target.createTarget");
    const attachIdx = methods.indexOf("Target.attachToTarget");
    const fetchIdx = methods.indexOf("Fetch.enable");
    const navigateIdx = methods.indexOf("Page.navigate");
    const evalIdx = methods.indexOf("Runtime.evaluate");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeGreaterThan(createIdx);
    expect(fetchIdx).toBeGreaterThan(attachIdx);
    expect(navigateIdx).toBeGreaterThan(attachIdx);
    expect(evalIdx).toBeGreaterThan(navigateIdx); // waitForLoad 轮询

    // 防竞态关键断言：createTarget 用 about:blank 而非目标 URL
    const create = h.sockets[0]!.sent[createIdx]!;
    expect(create.params).toEqual({ url: "about:blank", background: true });
    // 显式导航带目标 URL，且经 session
    const nav = h.sockets[0]!.sent[navigateIdx]!;
    expect(nav.params).toEqual({ url: "https://example.com" });
    expect(nav.sessionId).toBe(`sess-${tabId}`);

    // 反风控：Fetch.enable 拦截调试端口两模式
    const guard = h.sockets[0]!.sent[fetchIdx]!;
    expect(guard.params.patterns).toEqual([
      { urlPattern: "http://127.0.0.1:9222/*", requestStage: "Request" },
      { urlPattern: "http://localhost:9222/*", requestStage: "Request" },
    ]);

    // tab 注册 + 状态订阅（tab 增减帧）
    expect((await h.manager.listTabs()).map((t: TabInfo) => t.tabId)).toEqual([tabId]);
    expect((await h.manager.getStatus()).tabCount).toBe(1);
    expect(h.statuses.map((s) => s.state)).toEqual(["connecting", "connected", "connected"]);
    expect(h.statuses[2]!.tabCount).toBe(1);
    await h.manager.stop();
  });

  test("openTab(about:blank) 不导航不等待", async () => {
    const h = createHarness({});
    await h.manager.openTab("about:blank", "agent-1");
    const methods = h.sockets[0]!.sent.map((m) => m.method);
    expect(methods).not.toContain("Page.navigate");
    await h.manager.stop();
  });

  test("evalInTab：returnByValue+awaitPromise 取值；异常详情抛错", async () => {
    const h = createHarness({
      respond: defaultRespond({
        "Runtime.evaluate": (msg) => {
          if (msg.params.expression === "boom()") {
            return { result: { exceptionDetails: { text: "ReferenceError: boom is not defined" } } };
          }
          if (msg.params.expression === "1+1") return { result: { result: { value: 2 } } };
          return { result: { result: { value: evaluateValue(msg.params.expression) } } };
        },
      }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");

    expect(await h.manager.evalInTab(tabId, "1+1")).toBe(2);
    const evalMsg = h.sockets[0]!.sent.find((m) => m.params?.expression === "1+1")!;
    expect(evalMsg.params.returnByValue).toBe(true);
    expect(evalMsg.params.awaitPromise).toBe(true);
    expect(evalMsg.sessionId).toBe(`sess-${tabId}`);

    await expect(h.manager.evalInTab(tabId, "boom()")).rejects.toThrow(/boom is not defined/);
    await h.manager.stop();
  });

  test("backTab：history.back() eval + waitForLoad", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    await h.manager.backTab(tabId);
    const sent = h.sockets[0]!.sent;
    const backIdx = sent.findIndex((m) => m.params?.expression === "history.back()");
    expect(backIdx).toBeGreaterThanOrEqual(0);
    expect(sent[backIdx]!.sessionId).toBe(`sess-${tabId}`);
    // waitForLoad 轮询跟随其后
    expect(sent.findIndex((m, i) => i > backIdx && m.params?.expression?.includes("readyState"))).toBeGreaterThan(backIdx);
    await h.manager.stop();
  });

  test("navigateTab：Page.navigate + waitForLoad + touch", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    h.clock.advance(60_000);
    await h.manager.navigateTab(tabId, "https://example.com/next");
    const nav = h.sockets[0]!.sent.filter((m) => m.method === "Page.navigate").at(-1)!;
    expect(nav.params).toEqual({ url: "https://example.com/next" });
    expect((await h.manager.listTabs())[0]!.lastAccessed).toBe(1_060_000);
    await h.manager.stop();
  });

  test("Target.attachedToTarget 事件：session 映射建立 + registry url/title 回写", async () => {
    const h = createHarness({});
    await h.manager.connect();
    // 浏览器侧 attach 事件（如别路 attach）→ registry 里受管 tab 的 url/title 更新
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    h.sockets[0]!.receive({
      method: "Target.attachedToTarget",
      params: { sessionId: "sess-x", targetInfo: { targetId: tabId, url: "https://evt.example", title: "事件标题" } },
    });
    const tab = (await h.manager.listTabs())[0]!;
    expect(tab.url).toBe("https://evt.example");
    expect(tab.title).toBe("事件标题");
    await h.manager.stop();
  });

  test("反风控：Fetch.requestPaused 事件 → Fetch.failRequest(ConnectionRefused) 同 session 回发", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    const before = h.sockets[0]!.sent.length;
    h.sockets[0]!.receive({
      method: "Fetch.requestPaused",
      sessionId: `sess-${tabId}`,
      params: { requestId: "req-1", request: { url: "http://127.0.0.1:9222/json/version" } },
    });
    await sleep(5); // failRequest 经 queueMicrotask 应答链
    const newSent = h.sockets[0]!.sent.slice(before);
    const fail = newSent.find((m) => m.method === "Fetch.failRequest")!;
    expect(fail.params).toEqual({ requestId: "req-1", errorReason: "ConnectionRefused" });
    expect(fail.sessionId).toBe(`sess-${tabId}`);
    await h.manager.stop();
  });

  test("closeTab：closeTarget + 出册 + tab 减帧", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    const statusesBefore = h.statuses.length;
    await h.manager.closeTab(tabId);

    const close = h.sockets[0]!.sent.find((m) => m.method === "Target.closeTarget")!;
    expect(close.params).toEqual({ targetId: tabId });
    expect((await h.manager.listTabs())).toEqual([]);
    expect((await h.manager.getStatus()).tabCount).toBe(0);
    expect(h.statuses.length).toBe(statusesBefore + 1);
    expect(h.statuses.at(-1)!.tabCount).toBe(0);
    await h.manager.stop();
  });

  test("listTabs 返回只读快照（TabInfo 五字段）", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-7");
    const tabs = (await h.manager.listTabs());
    expect(tabs).toEqual([
      { tabId, ownerId: "agent-7", url: "about:blank", title: "", lastAccessed: 1_000_000 },
    ]);
    await h.manager.stop();
  });
});

describe("CdpConnectionManager 交互方法（T2b）", () => {
  test("clickInTab：JS 点击返回 {clicked,tag,text}；未命中元素 clicked=false", async () => {
    const h = createHarness({
      respond: defaultRespond({
        "Runtime.evaluate": (msg) => {
          const expr: string = msg.params.expression;
          if (expr.includes("el.click()")) {
            if (expr.includes("#ok")) return { result: { result: { value: { clicked: true, tag: "BUTTON", text: "提交" } } } };
            return { result: { result: { value: { error: "未找到元素: #missing" } } } };
          }
          return { result: { result: { value: evaluateValue(expr) } } };
        },
      }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    expect(await h.manager.clickInTab(tabId, "#ok")).toEqual({ clicked: true, tag: "BUTTON", text: "提交" });
    expect(await h.manager.clickInTab(tabId, "#missing")).toEqual({ clicked: false });
    await h.manager.stop();
  });

  test("clickAtInTab：坐标 eval → Input.dispatchMouseEvent pressed+released 同坐标", async () => {
    const h = createHarness({
      respond: defaultRespond({
        "Runtime.evaluate": (msg) => {
          const expr: string = msg.params.expression;
          if (expr.includes("getBoundingClientRect")) {
            return { result: { result: { value: { x: 100, y: 200, tag: "INPUT", text: "" } } } };
          }
          return { result: { result: { value: evaluateValue(expr) } } };
        },
      }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    const result = await h.manager.clickAtInTab(tabId, "input[type=file]");
    expect(result).toEqual({ clicked: true, x: 100, y: 200, tag: "INPUT", text: "" });

    const mouse = h.sockets[0]!.sent.filter((m) => m.method === "Input.dispatchMouseEvent");
    expect(mouse.map((m) => [m.params.type, m.params.x, m.params.y, m.params.button, m.params.clickCount])).toEqual([
      ["mousePressed", 100, 200, "left", 1],
      ["mouseReleased", 100, 200, "left", 1],
    ]);
    expect(mouse[0]!.sessionId).toBe(`sess-${tabId}`);
    await h.manager.stop();
  });

  test("clickAtInTab：元素未命中 → clicked=false 且不发鼠标事件", async () => {
    const h = createHarness({
      respond: defaultRespond({
        "Runtime.evaluate": (msg) => {
          const expr: string = msg.params.expression;
          if (expr.includes("getBoundingClientRect")) {
            return { result: { result: { value: { error: "未找到元素" } } } };
          }
          return { result: { result: { value: evaluateValue(expr) } } };
        },
      }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    expect(await h.manager.clickAtInTab(tabId, "#none")).toEqual({ clicked: false });
    expect(h.sockets[0]!.sent.filter((m) => m.method === "Input.dispatchMouseEvent")).toEqual([]);
    await h.manager.stop();
  });

  test("setFilesInTab：DOM.enable→getDocument→querySelector→setFileInputFiles 序列，返回 {success,count}", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    const result = await h.manager.setFilesInTab(tabId, "input[type=file]", ["/tmp/a.png", "/tmp/b.png"]);
    expect(result).toEqual({ success: true, count: 2 });

    const methods = h.sockets[0]!.sent.map((m) => m.method);
    const seq = ["DOM.enable", "DOM.getDocument", "DOM.querySelector", "DOM.setFileInputFiles"];
    let last = -1;
    for (const m of seq) {
      const idx = methods.indexOf(m, last + 1);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
    const setFiles = h.sockets[0]!.sent[last]!;
    expect(setFiles.params).toEqual({ nodeId: 42, files: ["/tmp/a.png", "/tmp/b.png"] });
    expect(setFiles.sessionId).toBe(`sess-${tabId}`);
    await h.manager.stop();
  });

  test("setFilesInTab：选择器未命中（nodeId=0）→ 抛错", async () => {
    const h = createHarness({
      respond: defaultRespond({ "DOM.querySelector": () => ({ result: { nodeId: 0 } }) }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    await expect(h.manager.setFilesInTab(tabId, "#nope", ["/tmp/a.png"])).rejects.toThrow(/未找到元素/);
    await h.manager.stop();
  });

  test("scrollTab：默认向下滚 y=3000；方向参数映射 up/top/bottom；返回 eval 值 {value}", async () => {
    const h = createHarness({
      respond: defaultRespond({
        "Runtime.evaluate": (msg) => {
          const expr: string = msg.params.expression;
          if (expr.includes("readyState")) return { result: { result: { value: evaluateValue(expr) } } };
          if (expr.includes("scroll")) return { result: { result: { value: "scroll-ack" } } };
          return { result: { result: { value: undefined } } };
        },
      }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    expect(await h.manager.scrollTab(tabId)).toEqual({ value: "scroll-ack" });
    await h.manager.scrollTab(tabId, 500, "up");
    await h.manager.scrollTab(tabId, undefined, "top");
    await h.manager.scrollTab(tabId, undefined, "bottom");

    const exprs = h.sockets[0]!.sent
      .filter((m) => m.method === "Runtime.evaluate" && typeof m.params?.expression === "string" && m.params.expression.includes("scroll"))
      .map((m) => m.params.expression as string);
    expect(exprs[0]).toContain("scrollBy(0, 3000)");
    expect(exprs[1]).toContain("scrollBy(0, -500)");
    expect(exprs[2]).toContain("scrollTo(0, 0)");
    expect(exprs[3]).toContain("scrollTo(0, document.body.scrollHeight)");
    await h.manager.stop();
  });

  test("screenshotTab：指定 file 落盘返回 {saved}；jpeg 带 quality=80", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    const png = await h.manager.screenshotTab(tabId, "/tmp/shot.png");
    expect(png).toEqual({ saved: "/tmp/shot.png" });
    expect(h.fileWrites).toHaveLength(1);
    expect(h.fileWrites[0]!.path).toBe("/tmp/shot.png");
    expect(h.fileWrites[0]!.data.toString()).toBe("fake-png-bytes");

    await h.manager.screenshotTab(tabId, "/tmp/shot.jpg", "jpeg");
    const jpegMsg = h.sockets[0]!.sent.filter((m) => m.method === "Page.captureScreenshot").at(-1)!;
    expect(jpegMsg.params).toEqual({ format: "jpeg", quality: 80 });
    expect(jpegMsg.sessionId).toBe(`sess-${tabId}`);
    await h.manager.stop();
  });

  test("screenshotTab：无 file → 抛错（必须传保存路径），且不触发 lazy connect", async () => {
    const h = createHarness({});
    await expect(h.manager.screenshotTab("ghost")).rejects.toThrow(/file/);
    expect(h.sockets).toHaveLength(0);
    expect((await h.manager.getStatus()).state).toBe("idle");
  });
});

describe("CdpConnectionManager 生命周期", () => {
  test("断线重连：server close → 状态回 idle + 清 tab/发现缓存；下次操作 lazy 重连", async () => {
    const h = createHarness({});
    await h.manager.openTab("about:blank", "agent-1");
    expect((await h.manager.getStatus()).tabCount).toBe(1);

    h.sockets[0]!.close(); // 模拟浏览器侧断开
    expect((await h.manager.getStatus()).state).toBe("idle");
    expect((await h.manager.getStatus()).browser).toBeUndefined();
    expect((await h.manager.listTabs())).toEqual([]);
    expect(h.statuses.at(-1)!.state).toBe("idle");

    // lazy 重连：新建 WS（发现缓存已清 → 重新发现）
    await h.manager.openTab("about:blank", "agent-1");
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]!.url).toBe("ws://127.0.0.1:9222/devtools/browser/fake-ws-path");
    expect((await h.manager.getStatus()).state).toBe("connected");
    await h.manager.stop();
  });

  test("断线时在飞命令被拒绝（不悬挂 30s）", async () => {
    const h = createHarness({
      respond: defaultRespond({ "Runtime.evaluate": () => null }),
      commandTimeoutMs: 60_000,
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    const p = h.manager.evalInTab(tabId, "1+1");
    // 等命令真正发出（attach/enable 微任务链走完）再断线，否则 close 先于 send
    let guard = 0;
    while (!h.sockets[0]!.sent.some((m) => m.params?.expression === "1+1")) {
      await sleep(1);
      if (++guard > 3000) throw new Error("evaluate 未发出（测试剧本故障）");
    }
    h.sockets[0]!.close();
    await expect(p).rejects.toThrow(/断开|未连接/);
  });

  test("stop()：关全部 managed tabs → 断 WS → 回 idle（sweep 停止）", async () => {
    const h = createHarness({});
    await h.manager.openTab("about:blank", "agent-1");
    await h.manager.openTab("about:blank", "agent-2");
    await h.manager.stop();

    const closes = h.sockets[0]!.sent.filter((m) => m.method === "Target.closeTarget");
    expect(closes).toHaveLength(2);
    expect(h.sockets[0]!.readyState).toBe(3);
    expect((await h.manager.listTabs())).toEqual([]);
    expect((await h.manager.getStatus()).state).toBe("idle");
    expect((await h.manager.getStatus()).tabCount).toBe(0);

    // stop 幂等：二次调用不崩
    await h.manager.stop();
  });

  test("未连接时 stop() 为安全 no-op", async () => {
    const h = createHarness({});
    await h.manager.stop();
    expect((await h.manager.getStatus()).state).toBe("idle");
    expect(h.sockets).toHaveLength(0);
  });

  test("reclaimOwner：只回收该 owner 的 tabs，其他 owner 不受影响", async () => {
    const h = createHarness({});
    const t1 = await h.manager.openTab("about:blank", "agent-1");
    const t2 = await h.manager.openTab("about:blank", "agent-2");
    const t3 = await h.manager.openTab("about:blank", "agent-1");

    await h.manager.reclaimOwner("agent-1");
    expect((await h.manager.listTabs()).map((t) => t.tabId)).toEqual([t2.tabId]);

    const closed = h.sockets[0]!.sent
      .filter((m) => m.method === "Target.closeTarget")
      .map((m) => m.params.targetId);
    expect(closed.sort()).toEqual([t1.tabId, t3.tabId].sort());
    await h.manager.stop();
  });

  test("未连接时 reclaimOwner/closeTab/listTabs 不触发 lazy connect", async () => {
    const h = createHarness({});
    await h.manager.reclaimOwner("agent-1");
    await h.manager.closeTab("ghost");
    expect((await h.manager.listTabs())).toEqual([]);
    expect(h.sockets).toHaveLength(0);
    expect((await h.manager.getStatus()).state).toBe("idle");
  });

  test("idle sweep：闲置超期 tab 被自动 closeTarget + 出册", async () => {
    const h = createHarness({ sweepIntervalMs: 5 });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    h.clock.advance(16 * 60_000); // 闲置 16min > 15min 阈值

    await sleep(50); // sweep interval 5ms 真实计时器跑若干轮
    const closes = h.sockets[0]!.sent.filter((m) => m.method === "Target.closeTarget");
    expect(closes.map((m) => m.params.targetId)).toContain(tabId);
    expect((await h.manager.listTabs())).toEqual([]);
    await h.manager.stop();
  });
});

describe("M20：{id,error} CDP 响应统一 reject（不查 error 的调用方不再静默当成功）", () => {
  test("navigateTab 遇 error 响应 → reject 透传 CDP 错误", async () => {
    const h = createHarness({
      respond: defaultRespond({
        "Page.navigate": () => ({ error: { code: -32602, message: "Cannot navigate to invalid URL" } }),
      }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    await expect(h.manager.navigateTab(tabId, "chrome://bad")).rejects.toThrow(/Cannot navigate to invalid URL/);
    await h.manager.stop();
  });

  test("evalInTab 遇 error 响应 → reject 透传 CDP 错误", async () => {
    const h = createHarness({
      respond: defaultRespond({
        "Runtime.evaluate": () => ({ error: { code: -32000, message: "Session closed" } }),
      }),
    });
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    await expect(h.manager.evalInTab(tabId, "1+1")).rejects.toThrow(/Session closed/);
    await h.manager.stop();
  });

  test("正常 result 响应仍 resolve（回归）", async () => {
    const h = createHarness({});
    const { tabId } = await h.manager.openTab("about:blank", "agent-1");
    await h.manager.navigateTab(tabId, "https://example.com/");
    await h.manager.stop();
  });
});

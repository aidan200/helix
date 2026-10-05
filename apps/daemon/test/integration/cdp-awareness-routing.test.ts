/**
 * M1 browser adapter 感知集成（fake WS 剧本驱动，不依赖真浏览器）：
 * 事件路由（CDP 事件帧不再丢弃）→ 观察者回传归属（executionContextId →
 * targetId 防串扰）→ SurfaceRegistry 归一（surfaceId=browser:<targetId>）→
 * StewardPerceptionService ring buffer（第三源）；FocusState 前台 tab。
 *
 * 红绿证据链（brief 测试要求 3）：
 * 1. 感知开关 on：Target.setAutoAttach + 观察者注入（Runtime.addBinding /
 *    Page.addScriptToEvaluateOnNewDocument）→ bindingCalled/frameNavigated →
 *    SurfaceEvent 入 ring（kind/origin 正确）；
 * 2. bindingCalled→targetId 归属防串扰（executionContextId 映射优先于
 *    sessionId 直查）；
 * 3. 感知开关 off：零注入（无 setAutoAttach/无 addBinding/无脚本）零上报
 *    （ring 恒空）。
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CdpConnectionManager, type CdpWebSocket } from "../../src/adapters/driven/cdp/CdpConnectionManager";
import { BrowserSurfaceAdapter } from "../../src/adapters/driven/cdp/BrowserSurfaceAdapter";
import { OBSERVER_BINDING_NAME } from "../../src/adapters/driven/cdp/browser-observer";
import { SurfaceRegistry } from "../../src/application/surface/SurfaceRegistry";
import { StewardPerceptionService } from "../../src/application/steward/StewardPerceptionService";

// ── FakeWebSocket（最小剧本面——cdp-connection-manager.test 同族） ──

class FakeWebSocket implements CdpWebSocket {
  readyState = 0;
  readonly sent: { id?: number; method?: string; params?: any; sessionId?: string }[] = [];
  private readonly listeners = new Map<string, Array<(e: any) => void>>();
  private tabSeq = 0;

  constructor(readonly url: string) {}

  addEventListener(type: string, fn: (e: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: any) => void): void {
    const arr = (this.listeners.get(type) ?? []).filter((f) => f !== fn);
    this.listeners.set(type, arr);
  }
  send(raw: string): void {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    // 默认全绿应答（fake 自动配对 id）；waitForLoad 就绪探测直答 complete
    let result: any = {};
    if (msg.method === "Target.createTarget") {
      result = { targetId: `tab-${++this.tabSeq}` };
    } else if (msg.method === "Target.attachToTarget") {
      result = { sessionId: `sess-${msg.params.targetId}` };
    } else if (msg.method === "Runtime.evaluate" && String(msg.params?.expression ?? "").includes("readyState")) {
      result = { result: { value: JSON.stringify({ ready: "complete", url: "https://example.com/" }) } };
    }
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: msg.id, result }) }));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  receive(msg: object): void {
    this.emit("message", { data: JSON.stringify(msg) });
  }
  private emit(type: string, evt: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
}

const CHROME_PORT_FILE = path.join("/fake-home", "Library/Application Support/Google/Chrome/DevToolsActivePort");

interface Rig {
  manager: CdpConnectionManager;
  adapter: BrowserSurfaceAdapter;
  registry: SurfaceRegistry;
  perception: StewardPerceptionService;
  sockets: FakeWebSocket[];
  setEnabled: (on: boolean) => void;
}

function makeRig(opts: { enabled?: boolean } = {}): Rig {
  const sockets: FakeWebSocket[] = [];
  let enabled = opts.enabled ?? true;
  const registry = new SurfaceRegistry({ sendAction: () => undefined });
  const perception = new StewardPerceptionService({
    feedGate: { hasStewardSubscribers: () => true },
    clock: () => 1_700_000_000_000,
  });
  // 组合根同款接线：Registry 观察者 → 感知 ring（表面族第三源）
  registry.addObserver((e) => perception.onSurfaceEvent(e));
  const adapter = new BrowserSurfaceAdapter({ registry, awarenessOn: () => enabled });
  const manager = new CdpConnectionManager({
    platform: "darwin",
    homeDir: "/fake-home",
    fsReader: (p: string) => (p === CHROME_PORT_FILE ? "9222\n/devtools/browser/fake-ws-path" : null),
    tcpProber: async () => true,
    wsFactory: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      queueMicrotask(() => ws.open());
      return ws;
    },
    commandTimeoutMs: 5_000,
    loadPollMs: 1,
    loadTimeoutMs: 1_000,
    scrollSettleMs: 0,
  });
  manager.setAwarenessSink(adapter);
  return { manager, adapter, registry, perception, sockets, setEnabled: (on) => (enabled = on) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const observerPayload = (obj: object): string => JSON.stringify(obj);

describe("CDP 事件路由 → SurfaceRegistry → 感知 ring（开关 on）", () => {
  test("连接即自动接管（Target.setAutoAttach）；会话即注入观察者（addBinding + 脚本）", async () => {
    const rig = makeRig();
    await rig.manager.connect();
    const ws = rig.sockets[0]!;
    expect(ws.sent.some((m) => m.method === "Target.setAutoAttach" && m.params?.autoAttach === true)).toBe(true);

    await rig.manager.openTab("https://example.com/", "agent-1");
    const methods = ws.sent.map((m) => m.method);
    expect(methods).toContain("Runtime.addBinding");
    expect(methods).toContain("Page.addScriptToEvaluateOnNewDocument");
    const binding = ws.sent.find((m) => m.method === "Runtime.addBinding");
    expect(binding?.params?.name).toBe(OBSERVER_BINDING_NAME);
    const script = ws.sent.find((m) => m.method === "Page.addScriptToEvaluateOnNewDocument");
    expect(String(script?.params?.source ?? "")).toContain(OBSERVER_BINDING_NAME);
    await rig.manager.stop();
  });

  test("全链：观察者回传 → SurfaceEvent(kind/origin 正确) → ring；FocusState 前台 tab", async () => {
    const rig = makeRig();
    await rig.manager.connect();
    const ws = rig.sockets[0]!;
    const { tabId } = await rig.manager.openTab("https://example.com/", "agent-1");
    const sessionId = `sess-${tabId}`;

    // executionContext 归属登记（Runtime 上下文生命周期）
    ws.receive({
      method: "Runtime.executionContextCreated",
      params: { context: { id: 11, auxData: { frameId: "F1", isDefault: true } } },
      sessionId,
    });
    // 观察者回传：focus（hasFocus 上报）→ activated/user
    ws.receive({
      method: "Runtime.bindingCalled",
      params: { name: OBSERVER_BINDING_NAME, executionContextId: 11, payload: observerPayload({ t: "focus", trusted: true, url: "https://example.com/" }) },
      sessionId,
    });
    // 观察者回传：click → user_click/user
    ws.receive({
      method: "Runtime.bindingCalled",
      params: { name: OBSERVER_BINDING_NAME, executionContextId: 11, payload: observerPayload({ t: "click", trusted: true, tag: "button" }) },
      sessionId,
    });
    // CDP 协议事件：frameNavigated（主框架）→ navigated/system
    ws.receive({
      method: "Page.frameNavigated",
      params: { frame: { url: "https://example.com/next", loaderId: "L1" } },
      sessionId,
    });
    await sleep(5);

    const ring = rig.perception.ringSnapshot();
    expect(ring.map((r) => r.kind)).toEqual(["surface.event", "surface.event", "surface.event"]);
    expect(ring.map((r) => r.sessionId)).toEqual([`browser:${tabId}`, `browser:${tabId}`, `browser:${tabId}`]);
    expect(ring[0]!.text).toContain("activated");
    expect(ring[1]!.text).toContain("user_click");
    expect(ring[2]!.text).toContain("navigated");
    // FocusState 反映当前前台 tab
    expect(rig.adapter.focusedTarget()).toBe(tabId);
    await rig.manager.stop();
  });

  test("归属防串扰：executionContextId 映射优先——A 会话帧携带 B 的上下文 id 归 B", async () => {
    const rig = makeRig();
    await rig.manager.connect();
    const ws = rig.sockets[0]!;
    const { tabId: t1 } = await rig.manager.openTab("https://a.test/", "agent-1");
    const { tabId: t2 } = await rig.manager.openTab("https://b.test/", "agent-1");
    ws.receive({ method: "Runtime.executionContextCreated", params: { context: { id: 11 } }, sessionId: `sess-${t1}` });
    ws.receive({ method: "Runtime.executionContextCreated", params: { context: { id: 22 } }, sessionId: `sess-${t2}` });

    // 交付在 t1 的 session 上、executionContextId 指向 t2 → 归 t2（上下文归属优先）
    ws.receive({
      method: "Runtime.bindingCalled",
      params: { name: OBSERVER_BINDING_NAME, executionContextId: 22, payload: observerPayload({ t: "focus", trusted: true, url: "b" }) },
      sessionId: `sess-${t1}`,
    });
    // 未知 executionContextId → 回落 sessionId 归属
    ws.receive({
      method: "Runtime.bindingCalled",
      params: { name: OBSERVER_BINDING_NAME, executionContextId: 999, payload: observerPayload({ t: "focus", trusted: true, url: "a" }) },
      sessionId: `sess-${t1}`,
    });
    await sleep(5);

    const ring = rig.perception.ringSnapshot();
    expect(ring.map((r) => r.sessionId)).toEqual([`browser:${t2}`, `browser:${t1}`]);
    expect(rig.adapter.focusedTarget()).toBe(t1); // 最后 focus 归 t1
    await rig.manager.stop();
  });

  test("事件帧不再丢弃：任意 CDP 事件均路由到感知 sink（含未知 method）", async () => {
    const routed: string[] = [];
    const rig = makeRig();
    rig.manager.setAwarenessSink({
      isEnabled: () => true,
      onCdpEvent: (method) => routed.push(method),
    });
    await rig.manager.connect();
    const ws = rig.sockets[0]!;
    ws.receive({ method: "Target.targetCreated", params: { targetInfo: { targetId: "tx" } } });
    ws.receive({ method: "Network.dataReceived", params: {}, sessionId: "sess-x" });
    ws.receive({ method: "Page.frameNavigated", params: { frame: { url: "u" } }, sessionId: "sess-x" });
    await sleep(5);
    expect(routed).toEqual(["Target.targetCreated", "Network.dataReceived", "Page.frameNavigated"]);
    await rig.manager.stop();
  });
});

describe("感知开关 off：零注入零上报（D1）", () => {
  test("off：无 setAutoAttach、无 addBinding、无观察者脚本；bindingCalled 事件不上管道", async () => {
    const rig = makeRig({ enabled: false });
    await rig.manager.connect();
    const ws = rig.sockets[0]!;
    expect(ws.sent.some((m) => m.method === "Target.setAutoAttach")).toBe(false);

    const { tabId } = await rig.manager.openTab("https://example.com/", "agent-1");
    const methods = ws.sent.map((m) => m.method);
    expect(methods).not.toContain("Runtime.addBinding");
    expect(methods).not.toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(methods).not.toContain("Target.setAutoAttach");

    // 即便观察者帧到达（陈旧注入/竞态），开关 off 也零上报
    ws.receive({
      method: "Runtime.bindingCalled",
      params: { name: OBSERVER_BINDING_NAME, executionContextId: 11, payload: observerPayload({ t: "focus", trusted: true, url: "u" }) },
      sessionId: `sess-${tabId}`,
    });
    ws.receive({ method: "Page.frameNavigated", params: { frame: { url: "u" } }, sessionId: `sess-${tabId}` });
    await sleep(5);

    expect(rig.perception.ringSnapshot()).toHaveLength(0);
    expect(rig.adapter.focusedTarget()).toBeUndefined();
    await rig.manager.stop();
  });
});

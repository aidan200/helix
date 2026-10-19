/**
 * 评审 F2 #28：enablePortGuard 只挂 ensureSession 显式 attach 路径——
 * Target.attachedToTarget（auto-attach）只挂 ensureObserver，端口守卫缺席；
 * 且 ensureSession 撞既有会话直接 return，感知开关开时全部新 tab 的反风控
 * 端口拦截落空（网站可经 http://127.0.0.1:{debugPort}/ 探测 DevTools）。
 * 另：attachedToTarget 的 sessions.set 会覆盖既有映射（手工 attach 会话成孤儿）。
 *
 * 本文件用 fake WS + fake 发现接缝（fsReader/tcpProber）驱动真实 CDP 消息处理链。
 */
import { describe, expect, test } from "bun:test";

import { CdpConnectionManager, type CdpWebSocket } from "../../src/adapters/driven/cdp/CdpConnectionManager";

interface SentFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** fake CDP WS：send 收帧 + 对带 id 的命令自动回 {result:{}}（微任务）。 */
class FakeWs implements CdpWebSocket {
  readyState = 1;
  readonly sent: SentFrame[] = [];
  private readonly listeners = new Map<string, Set<(evt: unknown) => void>>();

  private openFired = false;

  send(data: string): void {
    const frame = JSON.parse(data) as SentFrame;
    this.sent.push(frame);
    if (frame.id !== undefined) {
      queueMicrotask(() => this.fire("message", { data: JSON.stringify({ id: frame.id, result: {} }) }));
    }
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
    // 握手 open 在监听挂上后的下一微任务投递（openSocket 的 resolve 前置；
    // 构造期投递会早于 manager 注册监听）
    if (type === "open" && !this.openFired) {
      this.openFired = true;
      queueMicrotask(() => this.fire("open", {}));
    }
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string, evt: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(evt);
  }

  /** 投递一条 CDP 事件帧（无 id → 走事件路由面）。 */
  event(method: string, params: unknown, sessionId?: string): void {
    this.fire("message", { data: JSON.stringify({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) }) });
  }

  methods(): string[] {
    return this.sent.map((f) => f.method ?? "");
  }

  callsOf(method: string): SentFrame[] {
    return this.sent.filter((f) => f.method === method);
  }
}

function rig(): { manager: CdpConnectionManager; ws: FakeWs } {
  const ws = new FakeWs();
  const manager = new CdpConnectionManager({
    homeDir: "/Users/fake",
    platform: "linux", // 平台矩阵最小面（linux = chrome/chromium/edge 三行）
    fsReader: (p) => (p.endsWith("google-chrome/DevToolsActivePort") ? "9222\n/devtools/browser/abc\n" : null),
    tcpProber: async () => true,
    wsFactory: () => ws,
    commandTimeoutMs: 1_000,
  });
  manager.setAwarenessSink({
    isEnabled: () => true,
    onCdpEvent: () => {
      // 事件 sink 不在本文件断言范围
    },
  });
  return { manager, ws };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("CdpConnectionManager 端口守卫覆盖（评审 F2 #28）", () => {
  test("auto-attach 的新 tab 同样挂 Fetch 端口守卫（不只显式 attach 路径）", async () => {
    const { manager, ws } = rig();
    await manager.connect();
    expect(ws.callsOf("Fetch.enable").length).toBe(0); // 连接期无 session

    ws.event("Target.attachedToTarget", {
      sessionId: "s-auto",
      targetInfo: { targetId: "t-auto", url: "https://example.com/", title: "新 tab" },
      waitingForDebugger: false,
    });
    await tick();

    const guards = ws.callsOf("Fetch.enable").filter((f) => f.sessionId === "s-auto");
    expect(guards.length).toBe(1);
    // 端口守卫模式确实覆盖调试端口（反 DevTools 探测）
    const patterns = guards[0]!.params!["patterns"] as { urlPattern: string }[];
    expect(patterns.map((p) => p.urlPattern)).toEqual([
      "http://127.0.0.1:9222/*",
      "http://localhost:9222/*",
    ]);
    // 观察者注入仍在（原行为不回归）
    expect(ws.callsOf("Runtime.addBinding").some((f) => f.sessionId === "s-auto")).toBe(true);
    await manager.stop();
  });

  test("同 target 的第二个 attach 不覆盖既有映射，新会话被解绑（旧会话不成孤儿）", async () => {
    const { manager, ws } = rig();
    await manager.connect();

    ws.event("Target.attachedToTarget", {
      sessionId: "s-first",
      targetInfo: { targetId: "t-dup", url: "https://example.com/", title: "dup" },
      waitingForDebugger: false,
    });
    await tick();
    ws.event("Target.attachedToTarget", {
      sessionId: "s-second",
      targetInfo: { targetId: "t-dup", url: "https://example.com/", title: "dup" },
      waitingForDebugger: false,
    });
    await tick();

    // 孤儿会话必须解绑（否则同 target 两套 session，旧映射被覆盖后无人回收）
    const detached = ws.callsOf("Target.detachFromTarget");
    expect(detached.length).toBe(1);
    expect(detached[0]!.params).toMatchObject({ sessionId: "s-second" });

    // 命令面仍走既有映射（s-first）：不因覆盖而切到无人注入的会话
    const evaluated = manager.evalInTab("t-dup", "1+1");
    await tick();
    const frames = ws.callsOf("Runtime.evaluate").filter((f) => f.params?.["expression"] === "1+1");
    expect(frames.length).toBe(1);
    expect(frames[0]!.sessionId).toBe("s-first");
    await evaluated.catch(() => undefined);
    await manager.stop();
  });
});

/**
 * shared/api WS 客户端测试：transport 注入点（M3 mock 挂点）+ 握手时序 +
 * 重连退避状态机（fake transport + fake timers）。
 *
 * 契约来源：PROTOCOL.md §2/§8/§9 —— hello 首帧带 token；welcome 后转发事件；
 * 断线自动重连（指数退避），耗尽 → gave-up（error 态），手动 retry 立即重连。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import { HelixWsClient, type Transport, type TransportFactory, type TransportHandlers } from "./helix-ws";

interface FakeTransport extends Transport {
  url: string;
  sent: string[];
  /** close() 被调用过（修复批④：welcome 超时主动断开的观测面）。 */
  closed: boolean;
  open(): void;
  receive(frame: EventEnvelope): void;
  netClose(): void;
}

function fakeTransportFactory(created: FakeTransport[]): TransportFactory {
  return (url, handlers: TransportHandlers): Transport => {
    const t: FakeTransport = {
      url,
      sent: [],
      closed: false,
      connect: () => {},
      send(data: string) {
        t.sent.push(data);
      },
      close: () => {
        t.closed = true;
      },
      open() {
        handlers.onOpen();
      },
      receive(frame: EventEnvelope) {
        handlers.onMessage(JSON.stringify(frame));
      },
      netClose() {
        handlers.onClose({ code: 1006 });
      },
    };
    created.push(t);
    return t;
  };
}

function welcome(): EventEnvelope {
  return {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "m", agentState: "idle" },
  };
}

describe("HelixWsClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const transports: FakeTransport[] = [];
    const conn: { kind: string; attempt?: number; message?: string; attempts?: number }[] = [];
    const frames: EventEnvelope[] = [];
    const client = new HelixWsClient({
      port: 7333,
      getToken: async () => "dev-token",
      transportFactory: fakeTransportFactory(transports),
      backoff: { baseMs: 100, maxMs: 1_000, maxAttempts: 3 },
    });
    client.onConn((c) => conn.push(c));
    client.onFrame((f) => frames.push(f));
    client.start();
    await vi.advanceTimersByTimeAsync(0); // token fetch microtask
    return { client, transports, conn, frames };
  }

  it("start → connecting(1) → open 后发送 hello 首帧（token + protocolVersion 0.12）", async () => {
    const { transports } = await setup();
    expect(transports).toHaveLength(1);
    expect(transports[0]!.url).toBe("ws://127.0.0.1:7333");
    transports[0]!.open();
    expect(transports[0]!.sent).toHaveLength(1);
    expect(JSON.parse(transports[0]!.sent[0]!)).toEqual({
      v: "0.14",
      type: "hello",
      payload: { token: "dev-token", protocolVersion: "0.14" },
    });
  });

  it("welcome 后事件帧原样转发（供 reducer 投影）", async () => {
    const { transports, frames, conn } = await setup();
    transports[0]!.open();
    transports[0]!.receive(welcome());
    transports[0]!.receive({ v: 0, type: "agent.state.changed", payload: { state: "running" } });
    expect(frames.map((f) => f.type)).toEqual(["connection.welcome", "agent.state.changed"]);
    expect(conn.some((c) => c.kind === "connecting")).toBe(true);
  });

  it("send() 在握手完成前返回 false，welcome 后可发命令", async () => {
    const { client, transports } = await setup();
    transports[0]!.open();
    expect(client.send({ v: 0, type: "chat.send", payload: { text: "hi" } })).toBe(false);
    transports[0]!.receive(welcome()); // 握手通过
    expect(client.send({ v: 0, type: "chat.send", payload: { text: "hi" } })).toBe(true);
    expect(transports[0]!.sent.some((s) => s.includes("chat.send"))).toBe(true);
  });

  it("断线（已连接过）→ disconnected → 退避后 connecting(2) → 重连成功", async () => {
    const { client, transports, conn } = await setup();
    transports[0]!.open();
    transports[0]!.receive(welcome());
    transports[0]!.netClose();

    expect(conn.map((c) => c.kind)).toEqual(["connecting", "disconnected"]);
    // 退避 baseMs=100 内不再重试
    await vi.advanceTimersByTimeAsync(50);
    expect(transports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(transports).toHaveLength(2);
    expect(conn.at(-1)).toEqual({ kind: "connecting", attempt: 1 });

    transports[1]!.open();
    transports[1]!.receive(welcome());
    expect(client.isConnected()).toBe(true);
  });

  it("连续失败按指数退避（100→200→400ms），3 次耗尽 → gave-up；手动 retry 立即重连", async () => {
    const { client, transports, conn } = await setup();
    // attempt 1：token 拿到但连接失败（open 之前 close）
    transports[0]!.netClose();
    await vi.advanceTimersByTimeAsync(100);
    expect(transports).toHaveLength(2);
    // attempt 2 失败
    transports[1]!.netClose();
    await vi.advanceTimersByTimeAsync(200);
    expect(transports).toHaveLength(3);
    // attempt 3 失败 → 耗尽
    transports[2]!.netClose();
    await vi.advanceTimersByTimeAsync(400);
    expect(transports).toHaveLength(3); // 不再新建
    const gaveUp = conn.find((c) => c.kind === "gave-up");
    expect(gaveUp).toMatchObject({ kind: "gave-up", attempts: 3 });

    // 手动重试 → 立即 schedule（advanceTimersByTimeAsync(0) 即建连）
    client.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(transports).toHaveLength(4);
    expect(conn.at(-1)).toEqual({ kind: "connecting", attempt: 1 });
  });

  it("握手拒绝帧（connection.error + close）记录错误信息并进入退避", async () => {
    const { transports, conn } = await setup();
    transports[0]!.open();
    transports[0]!.receive({
      v: 0,
      type: "connection.error",
      payload: { code: "auth.invalid_token", message: "token mismatch" },
    });
    transports[0]!.netClose();
    await vi.advanceTimersByTimeAsync(100);
    expect(transports).toHaveLength(2);
    expect(conn.some((c) => c.kind === "gave-up")).toBe(false);
  });

  it("握手期异常 close（无 error 帧）→ close code 记入错误信息（gave-up message 可见）", async () => {
    const { transports, conn } = await setup();
    transports[0]!.netClose(); // attempt 1 失败（code 1006，无 error 帧可依赖）
    await vi.advanceTimersByTimeAsync(100);
    transports[1]!.netClose(); // attempt 2
    await vi.advanceTimersByTimeAsync(200);
    transports[2]!.netClose(); // attempt 3 → 耗尽 gave-up
    await vi.advanceTimersByTimeAsync(400);
    const gaveUp = conn.find((c) => c.kind === "gave-up");
    expect(gaveUp).toMatchObject({ kind: "gave-up", attempts: 3 });
    expect(gaveUp?.message).toBe("ws closed (code 1006)");
  });

  it("error 帧先行的 close 不被 close code 覆盖根因 message（展示面优先根因）", async () => {
    const { transports, conn } = await setup();
    for (let i = 0; i < 2; i++) {
      transports[i]!.open();
      transports[i]!.receive({
        v: 0,
        type: "connection.error",
        payload: { code: "auth.invalid_token", message: "token mismatch" },
      });
      transports[i]!.netClose();
      await vi.advanceTimersByTimeAsync(i === 0 ? 100 : 200);
    }
    transports[2]!.netClose(); // attempt 3 无 error 帧——根因已记，保留不覆盖
    await vi.advanceTimersByTimeAsync(400);
    const gaveUp = conn.find((c) => c.kind === "gave-up");
    expect(gaveUp?.message).toBe("token mismatch");
  });

  it("stop() 后不再重连（用户主动关闭语义）", async () => {
    const { client, transports } = await setup();
    transports[0]!.open();
    transports[0]!.receive(welcome());
    client.stop();
    transports[0]!.netClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transports).toHaveLength(1);
  });

  it("F5 批 #4：stop() 期间在途 token fetch 失败不挂重连 timer（generation 守卫）", async () => {
    const transports: FakeTransport[] = [];
    const conn: { kind: string }[] = [];
    let rejectToken!: (e: Error) => void;
    const client = new HelixWsClient({
      port: 7333,
      getToken: () => new Promise<string>((_res, rej) => { rejectToken = rej; }),
      transportFactory: fakeTransportFactory(transports),
      backoff: { baseMs: 100, maxMs: 1_000, maxAttempts: 3 },
    });
    client.onConn((c) => conn.push(c));
    client.start(); // attempt 1 进入在途 token fetch
    client.stop(); // generation 递增——在途 fetch 天折
    rejectToken(new Error("boom")); // 失败在 stop 之后到达
    await vi.advanceTimersByTimeAsync(10_000); // 退避窗口全部流逝
    // 旧缺陷：catch 内无 generation 守卫 → handleFailure 挂重连 timer → 无视显式
    // 停止再次 connecting；修复后零重连零 gave-up（仅首次 connecting）
    expect(transports).toHaveLength(0);
    expect(conn.map((c) => c.kind)).toEqual(["connecting"]);
  });
});

// ── 修复批④（管家建会话死锁链）：前端握手超时——connecting 态永不冻结 ──

describe("HelixWsClient 握手超时（修复批④）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 固定握手超时的 setup（缺省 500ms；welcome 永不到达的用例直接不 receive）。 */
  async function setupTimeout(opts: { handshakeTimeoutMs?: number; getToken?: (port: number, signal?: AbortSignal) => Promise<string> } = {}) {
    const transports: FakeTransport[] = [];
    const conn: { kind: string; attempt?: number; message?: string; attempts?: number }[] = [];
    const client = new HelixWsClient({
      port: 7333,
      getToken: opts.getToken ?? (async () => "dev-token"),
      transportFactory: fakeTransportFactory(transports),
      backoff: { baseMs: 100, maxMs: 1_000, maxAttempts: 3 },
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 500,
    });
    client.onConn((c) => conn.push(c));
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    return { client, transports, conn };
  }

  it("welcome 永不到达 → 超时计一次失败（transport 主动断开）→ 退避重试 → 耗尽 gave-up（message 含 handshake timeout）", async () => {
    const { transports, conn } = await setupTimeout();
    // attempt 1：open 后发送 hello，daemon 永不回 welcome（死锁连接现场）
    transports[0]!.open();
    await vi.advanceTimersByTimeAsync(500); // 握手超时窗到
    expect(transports[0]!.closed).toBe(true); // 超时主动断开（不再冻结在 connecting）
    await vi.advanceTimersByTimeAsync(100); // 退避后 attempt 2
    transports[1]!.open();
    await vi.advanceTimersByTimeAsync(500);
    expect(transports[1]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(200); // 退避后 attempt 3
    transports[2]!.open();
    await vi.advanceTimersByTimeAsync(500 + 400); // 超时 + 末次退避 → 耗尽
    const gaveUp = conn.find((c) => c.kind === "gave-up");
    expect(gaveUp).toMatchObject({ kind: "gave-up", attempts: 3 });
    expect(gaveUp?.message).toContain("handshake timeout");
  });

  it("welcome 及时到达 → 超时窗过后零副作用（连接存活、可发命令、无失败计数）", async () => {
    const { client, transports, conn } = await setupTimeout();
    transports[0]!.open();
    transports[0]!.receive(welcome());
    await vi.advanceTimersByTimeAsync(2_000); // 远超超时窗
    expect(client.isConnected()).toBe(true);
    expect(transports[0]!.closed).toBe(false); // 未被误断
    expect(conn.filter((c) => c.kind === "disconnected" || c.kind === "gave-up")).toHaveLength(0);
    expect(client.send({ v: 0, type: "chat.send", payload: { text: "hi" } } as never)).toBe(true);
  });

  it("token fetch 阶段也纳入超时（AbortController）：挂起的 getToken 超时后 abort + 计失败 + 重试继续", async () => {
    let lastSignal: AbortSignal | undefined;
    let calls = 0;
    const { transports, conn } = await setupTimeout({
      getToken: (_port, signal) => {
        lastSignal = signal;
        calls += 1;
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("dev-token"); // 首次挂起（daemon 死锁现场），后续立即返回
      },
    });
    await vi.advanceTimersByTimeAsync(500); // token 阶段超时
    expect(lastSignal?.aborted).toBe(true); // AbortController 触发
    await vi.advanceTimersByTimeAsync(100); // 退避 → attempt 2（token 立即返回）
    expect(transports).toHaveLength(1); // 第二次尝试已建 transport
    transports[0]!.open();
    transports[0]!.receive(welcome());
    await vi.advanceTimersByTimeAsync(100);
    expect(conn.filter((c) => c.kind === "gave-up")).toHaveLength(0); // 未被超时误杀后续尝试
  });

  it("stop() 清握手计时器：超时窗过后零事件（用户主动关闭）", async () => {
    const { client, transports, conn } = await setupTimeout();
    transports[0]!.open();
    client.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transports[0]!.closed).toBe(true); // stop 关闭（用户语义，非超时）
    expect(conn.filter((c) => c.kind === "disconnected" || c.kind === "gave-up")).toHaveLength(0);
  });
});

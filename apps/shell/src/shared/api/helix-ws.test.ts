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
  open(): void;
  receive(frame: EventEnvelope): void;
  netClose(): void;
}

function fakeTransportFactory(created: FakeTransport[]): TransportFactory {
  return (url, handlers: TransportHandlers): Transport => {
    const t: FakeTransport = {
      url,
      sent: [],
      connect: () => {},
      send(data: string) {
        t.sent.push(data);
      },
      close: () => {},
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

  it("start → connecting(1) → open 后发送 hello 首帧（token + protocolVersion 0.5）", async () => {
    const { transports } = await setup();
    expect(transports).toHaveLength(1);
    expect(transports[0]!.url).toBe("ws://127.0.0.1:7333");
    transports[0]!.open();
    expect(transports[0]!.sent).toHaveLength(1);
    expect(JSON.parse(transports[0]!.sent[0]!)).toEqual({
      v: "0.8",
      type: "hello",
      payload: { token: "dev-token", protocolVersion: "0.8" },
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

  it("stop() 后不再重连（用户主动关闭语义）", async () => {
    const { client, transports } = await setup();
    transports[0]!.open();
    transports[0]!.receive(welcome());
    client.stop();
    transports[0]!.netClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transports).toHaveLength(1);
  });
});

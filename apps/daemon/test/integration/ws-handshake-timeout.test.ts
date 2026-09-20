import { describe, expect, test } from "bun:test";
import type { SendOutcome, SessionChatPort } from "../../src/application/ports/inbound/ChatPort";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";
import type { SessionDirectoryPort } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { SystemPort } from "../../src/application/ports/inbound/SystemPort";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { PROTOCOL_VERSION, type EventEnvelope } from "@helix/protocol";

/**
 * 修复批 ③⑤（daemon 握手超时自清 + 连接生命周期诊断日志）：
 * ③ 连接建立后 N 秒未收到合法 hello → connection.error{auth.timeout}
 *    + close（E-54 契约 additive 扩展：先发帧再 close，与三分支拒绝同处置）；
 *    超时定时器在握手完成/连接关闭时清理，无泄漏。
 * ⑤ 连接级一行式 INFO 日志：ws open（remote）/ hello accepted / hello
 *    rejected（code）/ handshake timeout / close——死锁连接有轨迹可查。
 *
 * 事故面（2026-09-20）：TCP ESTABLISHED 但 daemon 零帧不应答的死锁连接
 * （lsof 双方 ESTABLISHED、浏览器侧 socket open、8 分钟零帧零 close）
 * ——daemon 对新连接正常，对死锁连接永不清理。
 */

function fakeView(): SessionStateView {
  return {
    session: {
      sessionId: "spy-s1",
      createdAt: "2026-09-20T00:00:00.000Z",
      entries: [
        { id: "e1", role: "user", text: "历史消息", turnId: null, isSteer: false, instanceId: "main", createdAt: "2026-09-20T00:00:01.000Z" },
      ],
      turns: [],
      pendingSteer: [],
    },
    toolCalls: [],
  };
}

interface SpyRig {
  readonly adapter: WsServerAdapter;
  readonly logs: string[];
  stop(): void;
}

function makeRig(handshakeTimeoutMs: number): SpyRig {
  const logs: string[] = [];
  const chat: SessionChatPort = {
    sendMessage: async (): Promise<SendOutcome> => ({ mode: "turn", turnId: "t1", entryId: "e1" }),
    steer: async () => ({ entryId: "e2" }),
    abort: () => {},
  };
  const directory: SessionDirectoryPort = {
    listSessions: async () => [],
    sessionExists: async () => true,
    resolveTarget: async (id?: string) => id ?? "spy-s1",
    getSessionView: async () => fakeView(),
    startDraftSession: async () => { throw new Error("spy 不装配草稿链"); },
    deleteSession: async () => { throw new Error("spy 不装配删除链"); },
    currentSessionId: () => "spy-s1",
  };
  const system: SystemPort = {
    getStatus: () => ({
      running: true,
      locked: true,
      home: "/tmp/spy-home",
      sessionId: "spy-s1",
      agentState: "idle",
      model: "spy/model",
    }),
    shutdown: async () => {},
  };
  const adapter = new WsServerAdapter({
    chat,
    directory,
    system,
    orchestration: {
      spawn: () => ({ status: "rejected", error: "spy 不装配调度" }),
      send: () => ({ delivered: false, detail: "spy" }),
      status: () => [],
      kill: () => ({ killed: false, error: "spy 不装配调度" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "测试桩不挂起" }),
      resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
    },
    model: {
      setModel: async () => { throw new Error("spy 不装配模型链"); },
      setThinking: async () => { throw new Error("spy 不装配模型链"); },
      getModel: async () => { throw new Error("spy 不装配模型链"); },
      catalog: async () => { throw new Error("spy 不装配模型链"); },
      catalogRefresh: async () => { throw new Error("spy 不装配模型链"); },
      setThinkingDefault: async () => ({ previous: null }),
      setDefault: async () => { throw new Error("spy 不装配模型链"); },
      getDefault: () => ({ model: "spy/model", thinkingDefault: null }),
      authList: async () => [],
      authSetKey: async () => { throw new Error("spy 不装配模型链"); },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail", reason: "spy" }),
    },
    resource: {
      list: async () => { throw new Error("spy 不装配资源配置链"); },
      getEffectiveSkills: async () => [],
      setEnabled: async () => { throw new Error("spy 不装配资源配置链"); },
      setModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
      clearModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
      setThinkingSlot: async () => { throw new Error("spy 不装配资源配置链"); },
      modelSlot: () => undefined,
      thinkingSlot: () => undefined,
      clearThinkingSlot: async () => { throw new Error("spy 不装配资源配置链"); },
    },
    hasModel: () => false,
    kgWriterPinnedTools: ["kg-update"],
    basePrompts: {},
    browser: new StubBrowserPort(),
    events: new EventStream(),
    token: "spy-token",
    port: 0,
    // 修复批③⑤注入口：短超时 + 连接日志 spy
    handshakeTimeoutMs,
    connLog: { info: (m) => logs.push(m) },
  });
  return { adapter, logs, stop: () => adapter.stop() };
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("修复③ daemon 握手超时（死锁连接自清）", () => {
  test("连接后不发 hello → auth.timeout error 帧 + close；日志一行式留痕", async () => {
    const rig = makeRig(60);
    try {
      const frames: EventEnvelope[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${rig.adapter.port}`);
      ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
      await new Promise<void>((r) => (ws.onopen = () => r()));

      // 不发 hello：超时窗口后收到 auth.timeout 拒绝帧
      await until(() => frames.some((f) => f.type === "connection.error"), 3000, "auth.timeout 拒绝帧");
      const err = frames.find((f) => f.type === "connection.error")!;
      expect((err.payload as { code: string }).code).toBe("auth.timeout");
      // 先发帧再 close（E-54 拒绝路径同处置）
      await until(() => ws.readyState === WebSocket.CLOSED, 3000, "超时连接关闭");

      // ⑤ 日志轨迹：open + handshake timeout + close（连接级一行式）
      await until(() => rig.logs.some((l) => l.includes("handshake timeout")), 1000, "timeout 日志");
      expect(rig.logs.some((l) => l.includes("ws open"))).toBe(true);
      expect(rig.logs.some((l) => l.includes("ws close"))).toBe(true);
    } finally {
      rig.stop();
    }
  }, 8000);

  test("及时合法 hello → welcome 正常到达；超时定时器清除（超时窗口过后连接仍存活）", async () => {
    const rig = makeRig(150);
    try {
      const frames: EventEnvelope[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${rig.adapter.port}`);
      ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "spy-token", protocolVersion: PROTOCOL_VERSION } }));
      await until(() => frames.some((f) => f.type === "connection.welcome"), 3000, "welcome");
      // 超时窗口过后（定时器已清）连接不被误杀
      await new Promise((r) => setTimeout(r, 300));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(rig.logs.some((l) => l.includes("hello accepted"))).toBe(true);
      expect(rig.logs.some((l) => l.includes("handshake timeout"))).toBe(false);
      ws.close();
    } finally {
      rig.stop();
    }
  }, 8000);

  test("坏 token 拒绝 → hello rejected(code) 日志；拒绝路径不触发超时误报", async () => {
    const rig = makeRig(200);
    try {
      const frames: EventEnvelope[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${rig.adapter.port}`);
      ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "wrong", protocolVersion: PROTOCOL_VERSION } }));
      await until(() => frames.some((f) => f.type === "connection.error"), 3000, "拒绝帧");
      const err = frames.find((f) => f.type === "connection.error")!;
      expect((err.payload as { code: string }).code).toBe("auth.invalid_token");
      await until(() => rig.logs.some((l) => l.includes("hello rejected") && l.includes("auth.invalid_token")), 1000, "rejected 日志");
      // 定时器随连接关闭清理（窗口过后零 timeout 日志）
      await new Promise((r) => setTimeout(r, 300));
      expect(rig.logs.some((l) => l.includes("handshake timeout"))).toBe(false);
    } finally {
      rig.stop();
    }
  }, 8000);
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";
import type { SessionDirectoryPort } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { SessionChatPort, SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SystemPort } from "../../src/application/ports/inbound/SystemPort";
import type { ModelPort } from "../../src/application/ports/inbound/ModelPort";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";

/**
 * T5.1 热修回归（RCA debug/session-switch-state-overwrite-root-cause.md）：
 * 多会话切换状态串台——快照盖章数据源错配。
 *
 * ① 全链（真组合根 + 按会话引擎工厂）：A 流式中 subscribe 热会话 B（idle）
 *    → 快照 agentState/model 必须 = B 自身值（修复前：经 system.getStatus()
 *    拿到最近活跃会话 A 的 streaming/model-a——必红）；
 * ② spy（确定性竞态）：draft 建会话快照组装前注册表 current 已被后台 A
 *    事件拉回（getStatus=A 投影）→ 快照仍须盖 B 自身章（subscribe 同法）。
 */

type Frame = {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
};

/** 收集帧的 loopback WS 测试客户端（与 ws-server.test.ts 同形态）。 */
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

  async waitFor(pred: (f: Frame) => boolean, what: string, timeoutMs = 5000): Promise<Frame> {
    await until(() => this.frames.some(pred), timeoutMs, `等待帧（${what}；已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find(pred)!;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("T5.1：多会话切换快照盖章 = 目标会话自身状态（串台热修）", () => {
  test("全链：A 流式中 subscribe 热会话 B（idle）→ 快照盖 B 的 agentState/model", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t51-it-"));
    // 按会话独立引擎（T2.2 工厂形态）：A=model-a 慢速长流；B=model-b 快速短回
    const engines: FakeAgentEngine[] = [];
    const daemon = await createTestDaemon({
      home,
      engine: () => {
        const first = engines.length === 0;
        const e = new FakeAgentEngine({ initialModel: first ? "test/model-a" : "test/model-b" });
        engines.push(e);
        return e;
      },
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    const token = readFileSync(path.join(home, "dev-token"), "utf8");
    const client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
      const welcome = await client.waitFor((f) => f.type === "connection.welcome", "welcome");
      const sessionA = welcome.payload.sessionId as string;
      // T4：零条目草稿握手不 attach 不推快照——显式订阅当前会话 A（v0 兼容面）
      if (welcome.payload.draft === true) {
        client.send({ v: 0, type: "session.subscribe", payload: {} });
      }
      await client.waitFor((f) => f.type === "session.snapshot", "A 初始快照");

      // A 进入长流式（≈3s 窗口：80 分片 × 40ms）
      engines[0]!.queueReplies([{ text: `甲流式长回复${"占位".repeat(150)}`, chunkDelayMs: 40 }]);
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId: sessionA, payload: { text: "甲消息" } });
      await client.waitFor(
        (f) => f.type === "agent.state.changed" && f.sessionId === sessionA && f.payload.state === "running",
        "A 进入流式",
      );

      // draft 建会话 B（快速回复；draft 快照应盖 B 自身章——model 面确定性断言）
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "乙消息" } });
      const draftSnap = await client.waitFor(
        (f) => f.type === "session.snapshot" && f.sessionId !== sessionA,
        "draft B 快照",
      );
      const sessionB = draftSnap.sessionId!;
      const draftSnapshot = draftSnap.payload.snapshot as { sessionId: string; model: string; agentState: string };
      expect(draftSnapshot.sessionId).toBe(sessionB);
      expect(draftSnapshot.model).toBe("test/model-b"); // B 自身模型（竞态窗口关闭）

      // B 快速轮收口回 idle；A 仍在流式（每次事件 touch(A)，current 恒为 A）
      await client.waitFor(
        (f) => f.type === "agent.state.changed" && f.sessionId === sessionB && f.payload.state === "idle",
        "B 收口回 idle",
      );
      expect(engines[0]!.isStreaming()).toBe(true); // 前置护栏：A 必须仍在流式

      // 主修面：subscribe 热会话 B → 快照章 = B 自身（idle + model-b）
      const baseline = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", sessionId: sessionB, payload: {} });
      await until(
        () => client.frames.slice(baseline).some((f) => f.type === "session.snapshot" && f.sessionId === sessionB),
        5000,
        "subscribe B 重推快照",
      );
      const snap = client.frames.slice(baseline).find((f) => f.type === "session.snapshot" && f.sessionId === sessionB)!;
      const snapshot = snap.payload.snapshot as { sessionId: string; model: string; agentState: string };
      expect(snapshot.sessionId).toBe(sessionB);
      expect(snapshot.agentState).toBe("idle"); // B 自身状态（修复前 = A 的 streaming）
      expect(snapshot.model).toBe("test/model-b"); // B 自身模型（修复前 = A 的 model-a）
    } finally {
      await client.close();
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("spy 确定性竞态：current 被后台 A 拉回时，draft/subscribe 快照仍盖 B 自身章", async () => {
    // 竞态窗口机械复现：startDraftSession 注册 B（touch→current=B）后、快照
    // 组装前 A 后台流式事件 touch(A) → getStatus() = A 投影。spy 直接以
    // getStatus 返 A 态定格该窗口（真链路时序见上一用例）。
    const viewOf = (sessionId: string, agentState: SessionStateView["agentState"], model: string): SessionStateView => ({
      session: {
        sessionId,
        createdAt: "2026-08-17T00:00:00.000Z",
        entries: [],
        turns: [],
        pendingSteer: [],
      },
      toolCalls: [],
      agentState,
      model,
    });
    const viewA = viewOf("A", "running", "test/model-a");
    const viewB = viewOf("B", "idle", "test/model-b");

    const chat: SessionChatPort = {
      sendMessage: async (): Promise<SendOutcome> => ({ mode: "turn", turnId: "t1", entryId: "e1" }),
      steer: async () => ({ entryId: "e2" }),
      abort: () => {},
    };
    const directory: SessionDirectoryPort = {
      listSessions: async () => [],
      sessionExists: async (id) => id === "A" || id === "B",
      resolveTarget: async (id) => id ?? "A",
      getSessionView: async (id) => (id === "B" ? viewB : viewA),
      startDraftSession: async () => ({ sessionId: "B" }),
      deleteSession: async () => {},
      currentSessionId: () => "A", // 竞态定格：A 后台流式事件已把 current 拉回 A
    };
    const system: SystemPort = {
      getStatus: () => ({
        running: true,
        locked: true,
        home: "/tmp/spy-home",
        sessionId: "A",
        agentState: "running", // A 投影（修复前的错误盖章源）
        model: "test/model-a",
      }),
      shutdown: async () => {},
    };
    const model: ModelPort = {
      setModel: async () => { throw new Error("spy"); },
      setThinking: async () => { throw new Error("spy"); },
      getModel: async () => { throw new Error("spy"); },
      catalog: async () => { throw new Error("spy"); },
      catalogRefresh: async () => { throw new Error("spy"); },
      setDefault: async () => { throw new Error("spy"); },
      getDefault: () => ({ model: "test/default" }),
      authList: async () => [],
      authSetKey: async () => { throw new Error("spy"); },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail", reason: "spy" }),
    };
    const adapter = new WsServerAdapter({
      chat,
      directory,
      system,
      orchestration: {
        spawn: () => ({ status: "rejected", error: "spy" }),
        send: () => ({ delivered: false, detail: "spy" }),
        status: () => [],
        kill: () => ({ killed: false, error: "spy" }),
        inspect: () => null,
      },
      model,
      resource: {
        // M6 T3（契约 v0.6）：agent.config 族 spy 回口——不触发真实配置链
        list: async () => { throw new Error("spy 不装配资源配置链"); },
        setEnabled: async () => { throw new Error("spy 不装配资源配置链"); },
        setModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
        clearModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
        setThinkingSlot: async () => { throw new Error("spy 不装配资源配置链"); },
        clearThinkingSlot: async () => { throw new Error("spy 不装配资源配置链"); },
      },
      hasModel: () => false,
      browser: new StubBrowserPort(), // T4（契约 v0.7）：web 族 spy 回口——不触发真实浏览器链
      events: new EventStream(),
      token: "spy-token",
      port: 0,
    });
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "spy-token", protocolVersion: PROTOCOL_VERSION } });
      await client.waitFor((f) => f.type === "connection.welcome", "welcome");
      await client.waitFor((f) => f.type === "session.snapshot", "握手快照");

      // draft 建会话快照：getStatus 已返 A 投影（竞态窗口）→ 仍须盖 B 章
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "乙消息" } });
      const draftSnap = await client.waitFor(
        (f) => f.type === "session.snapshot" && f.sessionId === "B",
        "draft B 快照",
      );
      const draftSnapshot = draftSnap.payload.snapshot as { model: string; agentState: string };
      expect(draftSnapshot.agentState).toBe("idle"); // B 自身章（修复前 = A 的 running）
      expect(draftSnapshot.model).toBe("test/model-b"); // B 自身模型（修复前 = A 的 model-a）

      // subscribe 热会话 B 同法
      const baseline = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", sessionId: "B", payload: {} });
      await until(
        () => client.frames.slice(baseline).some((f) => f.type === "session.snapshot" && f.sessionId === "B"),
        3000,
        "subscribe B 重推快照",
      );
      const snap = client.frames.slice(baseline).find((f) => f.type === "session.snapshot" && f.sessionId === "B")!;
      const snapshot = snap.payload.snapshot as { model: string; agentState: string };
      expect(snapshot.agentState).toBe("idle");
      expect(snapshot.model).toBe("test/model-b");
    } finally {
      await client.close();
      adapter.stop();
    }
  });
});

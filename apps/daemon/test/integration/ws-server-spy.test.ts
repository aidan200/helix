import { describe, expect, test } from "bun:test";
import type { ChatPort, SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SessionStateView, SessionStreamEvent } from "../../src/application/ports/inbound/SessionPort";
import type { SessionDirectoryPort } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { SystemPort } from "../../src/application/ports/inbound/SystemPort";
import type { ModelPort } from "../../src/application/ports/inbound/ModelPort";
import { ModelNotFoundError, ProviderNotFoundError } from "../../src/application/services/ModelService";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { EventStream, MONITOR_TIER_EVENT_TYPES } from "../../src/adapters/driving/ws-server/EventStream";
import { PROTOCOL_VERSION, type EventEnvelope } from "@helix/protocol";

/** TP-CL2-3 白名单机械定义（契约 v0.3 §2.2）：monitor 档唯一放行集。 */
const MONITOR_WHITELIST = ["chat.turn.started", "chat.turn.completed", "chat.message.completed"] as const;

/**
 * TP-CL6-3（I 半）：编排在 service——ws-server driving 只转发不决策。
 * spy inbound port 记录调用；loopback 客户端驱动命令帧；
 * 断言 adapter 把命令原样送达对应 port（无业务分支、无吞改）。
 * （A 半：import 白名单扫描见 arch-guard.test.ts AG-12/AG-13。）
 */

function fakeView(): SessionStateView {
  return {
    session: {
      sessionId: "spy-s1",
      createdAt: "2026-08-15T00:00:00.000Z",
      entries: [
        { id: "e1", role: "user", text: "历史消息", turnId: null, isSteer: false, instanceId: "main", createdAt: "2026-08-15T00:00:01.000Z" },
      ],
      turns: [],
      pendingSteer: [],
    },
    toolCalls: [],
  };
}

describe("TP-CL6-3：ws-server 只转发不决策（spy）", () => {
  test("命令帧 → 对应 inbound port 原样转发；事件帧经 EventStream 下发", async () => {
    const calls: string[] = [];
    const chat: ChatPort = {
      sendMessage: async (text: string): Promise<SendOutcome> => {
        calls.push(`chat.send:${text}`);
        return { mode: "turn", turnId: "t1", entryId: "e1" };
      },
      steer: async (text: string) => {
        calls.push(`chat.steer:${text}`);
        return { entryId: "e2" };
      },
      abort: () => {
        calls.push("chat.abort");
      },
    };
    let snapshotCalls = 0;
    // T2.2：WsServerAdapter 取数面改接 SessionDirectoryPort（原 SessionPort
    // 直取形态废弃）；spy 记录调用，快照取数返回固定视图
    const directory: SessionDirectoryPort = {
      listSessions: async () => [],
      sessionExists: async (id: string) => id === "spy-s1",
      resolveTarget: async (id?: string) => id ?? "spy-s1",
      getSessionView: async () => {
        snapshotCalls++;
        return fakeView();
      },
      startDraftSession: async () => {
        throw new Error("spy 不装配草稿链");
      },
      deleteSession: async () => {
        throw new Error("spy 不装配删除链");
      },
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

    const eventStream = new EventStream();
    const adapter = new WsServerAdapter({
      chat,
      directory,
      system,
      orchestration: {
        // T2.3：命令路由只转发不决策——spy 用 no-op 编排口验证帧推送
        spawn: () => ({ status: "rejected", error: "spy 不装配调度" }),
        send: () => ({ delivered: false, detail: "spy" }),
        status: () => [],
        kill: () => ({ killed: false, error: "spy 不装配调度" }),
      },
      model: {
        // T2.3（AD-2）：spy 不触发真实模型链——全部 no-op/抛错回执
        setModel: async () => { throw new Error("spy 不装配模型链"); },
        getModel: async () => { throw new Error("spy 不装配模型链"); },
        catalog: async () => { throw new Error("spy 不装配模型链"); },
        catalogRefresh: async () => { throw new Error("spy 不装配模型链"); },
        setDefault: async () => { throw new Error("spy 不装配模型链"); },
        getDefault: () => ({ model: "spy/model" }),
        authList: async () => [],
        authSetKey: async () => { throw new Error("spy 不装配模型链"); },
        authDeleteKey: async () => {},
        authVerify: async () => ({ status: "fail", reason: "spy" }),
      },
      resource: {
        // M6 T3（契约 v0.6）：agent.config 族 spy 回口——不触发真实配置链
        list: async () => { throw new Error("spy 不装配资源配置链"); },
        setEnabled: async () => { throw new Error("spy 不装配资源配置链"); },
        setModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
        clearModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
      },
      hasModel: () => false,
      browser: new StubBrowserPort(), // T4（契约 v0.7）：web 族 spy 回口——不触发真实浏览器链
      events: eventStream,
      token: "spy-token",
      port: 0,
    });
    try {
      expect(adapter.hostname).toBe("127.0.0.1");
      expect(adapter.port).toBeGreaterThan(0);

      const frames: EventEnvelope[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${adapter.port}`);
      ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
      const opened = new Promise<void>((r) => (ws.onopen = () => r()));
      await opened;

      // 握手
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "spy-token", protocolVersion: PROTOCOL_VERSION } }));
      await until(() => frames.some((f) => f.type === "connection.welcome"));
      // welcome 后快照（取自 SessionPort）
      await until(() => frames.some((f) => f.type === "session.snapshot"));
      expect(snapshotCalls).toBe(1);
      const snap = frames.find((f) => f.type === "session.snapshot")!;
      expect((snap.payload as { snapshot: { sessionId: string } }).snapshot.sessionId).toBe("spy-s1");

      // 五个命令逐一转发（payload 原样、不吞不改）
      ws.send(JSON.stringify({ v: 0, type: "chat.send", payload: { text: "原文一" } }));
      ws.send(JSON.stringify({ v: 0, type: "chat.steer", payload: { text: "原文二" } }));
      ws.send(JSON.stringify({ v: 0, type: "chat.abort", payload: {} }));
      ws.send(JSON.stringify({ v: 0, type: "session.subscribe", payload: {} }));
      await until(() => snapshotCalls === 2); // subscribe 重推快照（经 SessionDirectoryPort 取数）
      ws.send(JSON.stringify({ v: 0, type: "session.unsubscribe", payload: {} }));
      await new Promise((r) => setTimeout(r, 100));

      expect(calls).toEqual(["chat.send:原文一", "chat.steer:原文二", "chat.abort"]);

      // unsubscribe 后事件停推（通路语义）：退订后发布不产生新帧
      const before = frames.length;
      eventStream.publish({
        type: "agent.state.changed",
        sessionId: "spy-s1",
        payload: { state: "running" },
        occurredAt: "2026-08-15T00:00:10.000Z",
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(frames.length).toBe(before);

      // 重新 subscribe 恢复推送：steer.queued 帧（adapter 只投影转发）
      ws.send(JSON.stringify({ v: 0, type: "session.subscribe", payload: {} }));
      await new Promise((r) => setTimeout(r, 50));
      eventStream.publish({
        type: "steer.queued",
        sessionId: "spy-s1",
        payload: { entryId: "e9", text: "注入" },
        occurredAt: "2026-08-15T00:00:09.000Z",
      });
      await until(() => frames.some((f) => f.type === "steer.queued"));
      const queued = frames.find((f) => f.type === "steer.queued")!;
      expect(queued.payload).toEqual({ entryId: "e9" });

      ws.close();
    } finally {
      adapter.stop();
    }
  }, 8000);
  test("model/auth 命令结果帧（T2.3-result-frames 微批）：sendNow 点对点直发 + 新错误码映射", async () => {
    const modelCalls: string[] = [];
    const catalogView = {
      id: "moonshotai/kimi-k2",
      providerId: "moonshotai",
      contextWindow: 131_072,
      cost: { input: 4, output: 16, cacheRead: 1, cacheWrite: 8 },
      source: "builtin" as const,
    };
    const model: ModelPort = {
      setModel: async (_sessionId, modelId) => {
        modelCalls.push(`set:${modelId}`);
        throw new ModelNotFoundError(modelId); // 错误码映射面（model.set ack 仍为广播，不属结果帧）
      },
      getModel: async (sessionId) => {
        modelCalls.push(`get:${sessionId}`);
        return { model: "moonshotai/kimi-k2", isDefault: false, defaultModel: "anthropic/claude-sonnet-4-5" };
      },
      catalog: async () => {
        throw new Error("拉取失败：ENOTFOUND pi.dev"); // 错误码映射面（成功帧在真容器测试覆盖）
      },
      catalogRefresh: async () => {
        modelCalls.push("catalogRefresh");
        return { models: [catalogView], refreshedAt: 1_760_000_100_000, source: "builtin", degraded: ["moonshotai: 拉取失败：ENOTFOUND"] };
      },
      setDefault: async (modelId) => {
        modelCalls.push(`setDefault:${modelId}`);
        return { previous: "anthropic/claude-sonnet-4-5" };
      },
      getDefault: () => {
        modelCalls.push("getDefault");
        return { model: "anthropic/claude-sonnet-4-5" };
      },
      authList: async () => [{ providerId: "moonshotai", configured: true, keyMasked: "····7f3a" }],
      authSetKey: async (providerId, apiKey) => {
        modelCalls.push(`authSetKey:${providerId}:${apiKey}`);
        if (providerId === "no-such-provider") throw new ProviderNotFoundError(providerId);
        return { keyMasked: "····7f3a" };
      },
      authDeleteKey: async (providerId) => {
        modelCalls.push(`authDeleteKey:${providerId}`);
      },
      authVerify: async (providerId) => {
        modelCalls.push(`authVerify:${providerId}`);
        return { status: "ok" as const, latencyMs: 120 };
      },
    };
    const chat: ChatPort = {
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
      getStatus: () => ({ running: true, locked: true, home: "/tmp/spy-home", sessionId: "spy-s1", agentState: "idle", model: "spy/model" }),
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
      },
      model,
      resource: {
        // M6 T3（契约 v0.6）：agent.config 族 spy 回口——不触发真实配置链
        list: async () => { throw new Error("spy 不装配资源配置链"); },
        setEnabled: async () => { throw new Error("spy 不装配资源配置链"); },
        setModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
        clearModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
      },
      hasModel: () => false,
      browser: new StubBrowserPort(), // T4（契约 v0.7）：web 族 spy 回口——不触发真实浏览器链
      events: new EventStream(),
      token: "spy-token",
      port: 0,
    });
    try {
      const frames: EventEnvelope[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${adapter.port}`);
      ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "spy-token", protocolVersion: PROTOCOL_VERSION } }));
      await until(() => frames.some((f) => f.type === "session.snapshot"));

      // 8 类结果帧点对点直发（model.catalog.result 成功面在真容器测试覆盖）
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "model.get", payload: {} }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "model.catalog_refresh", payload: {} }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "model.set_default", payload: { model: "moonshotai/kimi-k2" } }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "model.get_default", payload: {} }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth.list", payload: {} }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "anthropic", apiKey: "sk-spy-1" } }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth.delete_key", payload: { providerId: "anthropic" } }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth.verify", payload: { providerId: "anthropic" } }));
      await until(() => frames.filter((f) => f.type.endsWith(".result")).length === 8);
      const resultOf = (type: string) => frames.find((f) => f.type === type)!;

      const modelGet = resultOf("model.get.result");
      expect(modelGet.sessionId).toBe("spy-s1"); // per-session 命令：目标会话 id（loadHistory 同构）
      expect(modelGet.channel).toBe("model");
      expect(modelGet.payload).toEqual({ model: "moonshotai/kimi-k2", isDefault: false, defaultModel: "anthropic/claude-sonnet-4-5" });

      const refresh = resultOf("model.catalog_refresh.result");
      expect(refresh.sessionId).toBe("__system__"); // 全局命令：会话无关（session.list 同构）
      expect(refresh.payload).toEqual({ models: [catalogView], refreshedAt: 1_760_000_100_000, source: "builtin", degraded: ["moonshotai: 拉取失败：ENOTFOUND"] }); // 降级说明字段

      expect(resultOf("model.set_default.result").payload).toEqual({ previous: "anthropic/claude-sonnet-4-5" });
      expect(resultOf("model.get_default.result").payload).toEqual({ model: "anthropic/claude-sonnet-4-5" });
      expect(resultOf("auth.list.result").payload).toEqual({ providers: [{ providerId: "moonshotai", configured: true, keyMasked: "····7f3a" }] });
      expect(resultOf("auth.set_key.result").payload).toEqual({ keyMasked: "····7f3a" });
      expect(resultOf("auth.delete_key.result").payload).toEqual({});
      expect(resultOf("auth.verify.result").payload).toEqual({ status: "ok", latencyMs: 120 });
      // spy 原则：payload 原样送达 port（不吞不改）
      expect(modelCalls).toContain("authSetKey:anthropic:sk-spy-1");
      expect(modelCalls).toContain("setDefault:moonshotai/kimi-k2");

      // 新错误码映射（微批）：model_not_found / provider_not_found / catalog_unreachable
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "model.set", payload: { model: "bogus/x" } }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "no-such-provider", apiKey: "k" } }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "model.catalog", payload: {} }));
      await until(() => frames.filter((f) => f.type === "connection.error").length === 3);
      const codes = frames.filter((f) => f.type === "connection.error").map((f) => (f.payload as { code: string }).code);
      expect(codes).toContain("model_not_found");
      expect(codes).toContain("provider_not_found");
      expect(codes).toContain("catalog_unreachable");

      ws.close();
    } finally {
      adapter.stop();
    }
  }, 8000);
});

// ── TP-CL2-2/3/4/5：monitor 档订阅（T2.2，契约 v0.3 §2；AD-2/Q-2a/Q-2b） ──

/** spy 装配：WsServerAdapter + 真 EventStream（事件面走真分发，命令面 spy no-op）。 */
function makeTierRig(): { adapter: WsServerAdapter; events: EventStream } {
  const chat: ChatPort = {
    sendMessage: async (): Promise<SendOutcome> => ({ mode: "turn", turnId: "t1", entryId: "e1" }),
    steer: async () => ({ entryId: "e2" }),
    abort: () => {},
  };
  const directory: SessionDirectoryPort = {
    listSessions: async () => [],
    sessionExists: async (id: string) => id === "spy-s1" || id === "spy-s2",
    resolveTarget: async (id?: string) => id ?? "spy-s1",
    getSessionView: async () => fakeView(),
    startDraftSession: async () => { throw new Error("spy 不装配草稿链"); },
    deleteSession: async () => { throw new Error("spy 不装配删除链"); },
    currentSessionId: () => "spy-s1",
  };
  const system: SystemPort = {
    getStatus: () => ({ running: true, locked: true, home: "/tmp/spy-home", sessionId: "spy-s1", agentState: "idle", model: "spy/model" }),
    shutdown: async () => {},
  };
  const events = new EventStream();
  const adapter = new WsServerAdapter({
    chat,
    directory,
    system,
    orchestration: {
      spawn: () => ({ status: "rejected", error: "spy 不装配调度" }),
      send: () => ({ delivered: false, detail: "spy" }),
      status: () => [],
      kill: () => ({ killed: false, error: "spy 不装配调度" }),
    },
    model: {
      setModel: async () => { throw new Error("spy 不装配模型链"); },
      getModel: async () => { throw new Error("spy 不装配模型链"); },
      catalog: async () => { throw new Error("spy 不装配模型链"); },
      catalogRefresh: async () => { throw new Error("spy 不装配模型链"); },
      setDefault: async () => { throw new Error("spy 不装配模型链"); },
      getDefault: () => ({ model: "spy/model" }),
      authList: async () => [],
      authSetKey: async () => { throw new Error("spy 不装配模型链"); },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail", reason: "spy" }),
    },
    resource: {
      // M6 T3（契约 v0.6）：agent.config 族 spy 回口——不触发真实配置链
      list: async () => { throw new Error("spy 不装配资源配置链"); },
      setEnabled: async () => { throw new Error("spy 不装配资源配置链"); },
      setModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
      clearModelSlot: async () => { throw new Error("spy 不装配资源配置链"); },
    },
    hasModel: () => false,
      browser: new StubBrowserPort(), // T4（契约 v0.7）：web 族 spy 回口——不触发真实浏览器链
    events,
    token: "spy-token",
    port: 0,
  });
  return { adapter, events };
}

/** loopback 客户端：握手并等首个快照（握手自动 attach 当前会话 full）。 */
async function connectTierClient(port: number): Promise<{ frames: EventEnvelope[]; send: (o: unknown) => void; close: () => void }> {
  const frames: EventEnvelope[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "spy-token", protocolVersion: PROTOCOL_VERSION } }));
  await until(() => frames.some((f) => f.type === "session.snapshot"));
  return { frames, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() };
}

/** 会话事件电池：白名单 3 类型 + 代表性非白名单类型（逐类型断言样本）。 */
const BATTERY_NON_WHITELIST = [
  "agent.state.changed",
  "tool.call.started",
  "tool.call.result",
  "steer.queued",
  "steer.drained",
  "usage.recorded",
  "chat.stream.delta",
  "thinking.stream.delta",
] as const;

function publishBattery(events: EventStream, sessionId: string): void {
  const at = (s: number) => `2026-08-15T00:00:${String(s).padStart(2, "0")}.000Z`;
  // 白名单 3 类型
  events.publish({ type: "turn.started", sessionId, payload: { turnId: "t1" }, occurredAt: at(1) });
  events.publish({ type: "message.completed", sessionId, payload: { entryId: "e1", role: "assistant", text: "完成", isSteer: false }, occurredAt: at(2) });
  events.publish({ type: "turn.completed", sessionId, payload: { reason: "done" }, occurredAt: at(3) });
  // 非白名单（session 订阅面其余事件）
  events.publish({ type: "agent.state.changed", sessionId, payload: { state: "running" }, occurredAt: at(4) });
  events.publish({ type: "tool.call.started", sessionId, payload: { toolCallId: "tc1", toolName: "bash", args: {} }, occurredAt: at(5) });
  events.publish({ type: "tool.call.result", sessionId, payload: { toolCallId: "tc1", toolName: "bash", args: {}, result: "hi", isError: false }, occurredAt: at(6) });
  events.publish({ type: "steer.queued", sessionId, payload: { entryId: "e9", text: "注入" }, occurredAt: at(7) });
  events.publish({ type: "steer.drained", sessionId, payload: { entryId: "e9" }, occurredAt: at(8) });
  events.publish({ type: "usage.recorded", sessionId, payload: { instanceId: "main", usage: { input: 1, output: 2 }, source: "turn" }, occurredAt: at(9) });
  events.publishDelta({ channel: "message", sessionId, messageId: "m1", delta: "片段" });
  events.publishDelta({ channel: "thinking", sessionId, messageId: "m1", instanceId: "main", delta: "思考" });
}

function typesAfter(frames: EventEnvelope[], index: number): string[] {
  return frames.slice(index).map((f) => f.type);
}

describe("TP-CL2-2/3/4/5：monitor 档订阅（连接级 tier 表 + 白名单过滤）", () => {
  test("TP-CL2-3：白名单常量唯一出处 = EventStream（MONITOR_TIER_EVENT_TYPES 机械定义）", () => {
    expect([...MONITOR_TIER_EVENT_TYPES].sort()).toEqual([...MONITOR_WHITELIST].sort());
  });

  test("TP-CL2-2：同一连接重复 subscribe 同会话换 tier 幂等更新（最后档生效）", async () => {
    const { adapter, events } = makeTierRig();
    try {
      const client = await connectTierClient(adapter.port);
      // ① 握手默认 full：非白名单事件照常收
      let baseline = client.frames.length;
      events.publish({ type: "agent.state.changed", sessionId: "spy-s1", payload: { state: "running" }, occurredAt: "2026-08-15T00:00:10.000Z" });
      await until(() => typesAfter(client.frames, baseline).includes("agent.state.changed"));

      // ② subscribe 换 monitor（幂等更新）：快照重推 = subscribe 已生效的观察点
      client.send({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "session.subscribe", payload: { tier: "monitor" } });
      await until(() => typesAfter(client.frames, baseline).includes("session.snapshot"));
      baseline = client.frames.length;
      events.publish({ type: "agent.state.changed", sessionId: "spy-s1", payload: { state: "idle" }, occurredAt: "2026-08-15T00:00:11.000Z" });
      events.publish({ type: "message.completed", sessionId: "spy-s1", payload: { entryId: "e2", role: "assistant", text: "档内", isSteer: false }, occurredAt: "2026-08-15T00:00:12.000Z" });
      await until(() => typesAfter(client.frames, baseline).includes("chat.message.completed"));
      await new Promise((r) => setTimeout(r, 100));
      expect(typesAfter(client.frames, baseline)).not.toContain("agent.state.changed"); // monitor 档过滤生效

      // ③ subscribe 换回 full（再幂等更新）：非白名单恢复全量
      client.send({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "session.subscribe", payload: { tier: "full" } });
      await until(() => typesAfter(client.frames, baseline).filter((t) => t === "session.snapshot").length >= 1);
      baseline = client.frames.length;
      events.publish({ type: "agent.state.changed", sessionId: "spy-s1", payload: { state: "running" }, occurredAt: "2026-08-15T00:00:13.000Z" });
      await until(() => typesAfter(client.frames, baseline).includes("agent.state.changed"));

      // ④ 非法 tier 值 → command.invalid_payload（可选参数带缺省语义，目录外值拒绝）
      client.send({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "session.subscribe", payload: { tier: "bogus" } });
      await until(() => client.frames.some((f) => f.type === "connection.error" && (f.payload as { code: string }).code === "command.invalid_payload"));
      client.close();
    } finally {
      adapter.stop();
    }
  }, 8000);

  test("TP-CL2-3：monitor 档连接只收 3 白名单事件（逐类型断言）；系统级帧不受 tier 影响", async () => {
    const { adapter, events } = makeTierRig();
    try {
      const client = await connectTierClient(adapter.port);
      client.send({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "session.subscribe", payload: { tier: "monitor" } });
      const baseline = client.frames.length;
      await until(() => typesAfter(client.frames, baseline).includes("session.snapshot")); // subscribe 生效
      const afterSubscribe = client.frames.length;

      publishBattery(events, "spy-s1");
      // 系统级帧（session.list_changed）不受 tier 影响
      events.broadcastListChanged({ kind: "deleted", sessionId: "spy-s1" });
      await until(() => typesAfter(client.frames, afterSubscribe).includes("session.list_changed"));
      await new Promise((r) => setTimeout(r, 150));

      const got = typesAfter(client.frames, afterSubscribe);
      // 白名单 3 类型逐一在列
      for (const t of MONITOR_WHITELIST) expect(got, `monitor 档应收 ${t}`).toContain(t);
      // 白名单外事件类型零帧（逐类型断言）
      for (const t of BATTERY_NON_WHITELIST) expect(got, `monitor 档不应收 ${t}`).not.toContain(t);
      client.close();
    } finally {
      adapter.stop();
    }
  }, 8000);

  test("TP-CL2-4：双连接同会话不同档互不串扰（A full 全量 / B monitor 白名单）", async () => {
    const { adapter, events } = makeTierRig();
    try {
      const a = await connectTierClient(adapter.port); // 握手默认 full
      const b = await connectTierClient(adapter.port);
      b.send({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "session.subscribe", payload: { tier: "monitor" } });
      const bBaseline = b.frames.length;
      await until(() => typesAfter(b.frames, bBaseline).includes("session.snapshot"));

      const aBase = a.frames.length;
      const bBase = b.frames.length;
      publishBattery(events, "spy-s1");

      // A（full）：白名单 + 非白名单全量照旧
      await until(() => typesAfter(a.frames, aBase).includes("thinking.stream.delta"));
      const aGot = typesAfter(a.frames, aBase);
      for (const t of [...MONITOR_WHITELIST, ...BATTERY_NON_WHITELIST]) expect(aGot, `full 档应收 ${t}`).toContain(t);

      // B（monitor）：只收白名单 3 类型
      await until(() => typesAfter(b.frames, bBase).includes("chat.turn.completed"));
      await new Promise((r) => setTimeout(r, 150));
      const bGot = typesAfter(b.frames, bBase);
      for (const t of MONITOR_WHITELIST) expect(bGot, `B 应收 ${t}`).toContain(t);
      for (const t of BATTERY_NON_WHITELIST) expect(bGot, `B 不应收 ${t}`).not.toContain(t);
      a.close();
      b.close();
    } finally {
      adapter.stop();
    }
  }, 8000);

  test("TP-CL2-5：断连即丢（tier 表随连接销毁）+ 重连重放订阅图生效；created 补订 / deleted 退订回归", async () => {
    const { adapter, events } = makeTierRig();
    try {
      // ① monitor 档连接断开 → tier 表丢弃（不持跨连接状态）
      const first = await connectTierClient(adapter.port);
      first.send({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "session.subscribe", payload: { tier: "monitor" } });
      const firstBase = first.frames.length;
      await until(() => typesAfter(first.frames, firstBase).includes("session.snapshot"));
      first.close();
      await new Promise((r) => setTimeout(r, 150)); // 等服务端 close 流程 detach

      // ② 重连（新连接）：握手自动 attach 默认 full——上一连接的 monitor 档不残留
      const second = await connectTierClient(adapter.port);
      let base = second.frames.length;
      events.publish({ type: "agent.state.changed", sessionId: "spy-s1", payload: { state: "running" }, occurredAt: "2026-08-15T00:00:20.000Z" });
      await until(() => typesAfter(second.frames, base).includes("agent.state.changed"));

      // ③ shell 重放订阅图：subscribe monitor 再生效
      second.send({ v: PROTOCOL_VERSION, sessionId: "spy-s1", type: "session.subscribe", payload: { tier: "monitor" } });
      base = second.frames.length;
      await until(() => typesAfter(second.frames, base).includes("session.snapshot"));
      base = second.frames.length;
      events.publish({ type: "agent.state.changed", sessionId: "spy-s1", payload: { state: "idle" }, occurredAt: "2026-08-15T00:00:21.000Z" });
      events.publish({ type: "message.completed", sessionId: "spy-s1", payload: { entryId: "e3", role: "assistant", text: "重放后", isSteer: false }, occurredAt: "2026-08-15T00:00:22.000Z" });
      await until(() => typesAfter(second.frames, base).includes("chat.message.completed"));
      await new Promise((r) => setTimeout(r, 100));
      expect(typesAfter(second.frames, base)).not.toContain("agent.state.changed");

      // ④ created 补订回归：订阅新会话缺省 full（不带 tier = 既有语义不变）
      second.send({ v: PROTOCOL_VERSION, sessionId: "spy-s2", type: "session.subscribe", payload: {} });
      base = second.frames.length;
      await until(() => typesAfter(second.frames, base).includes("session.snapshot"));
      base = second.frames.length;
      events.publish({ type: "agent.state.changed", sessionId: "spy-s2", payload: { state: "running" }, occurredAt: "2026-08-15T00:00:23.000Z" });
      await until(() => typesAfter(second.frames, base).includes("agent.state.changed")); // spy-s2 默认 full 全量

      // ⑤ deleted 退订回归：unsubscribe 后该会话事件停推
      second.send({ v: PROTOCOL_VERSION, sessionId: "spy-s2", type: "session.unsubscribe", payload: {} });
      await new Promise((r) => setTimeout(r, 100));
      base = second.frames.length;
      events.publish({ type: "agent.state.changed", sessionId: "spy-s2", payload: { state: "idle" }, occurredAt: "2026-08-15T00:00:24.000Z" });
      await new Promise((r) => setTimeout(r, 100));
      expect(typesAfter(second.frames, base)).not.toContain("agent.state.changed");
      second.close();
    } finally {
      adapter.stop();
    }
  }, 10000);
});

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

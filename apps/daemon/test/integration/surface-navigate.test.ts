/**
 * surface 协议地基集成测试（M0；设计稿 §1/D2/D7/D8/D9）：
 *
 * 真实链路 = WsServerAdapter + EventStream + SurfaceRegistry + StewardService
 * （组合根同构接线：emitNavigate → registry.act("navigate")；兼容期镜像
 * emitLegacyNavigate → broadcastStewardNavigate）。
 *
 * 1. 双发期新旧帧都到（D8 ③）：deliver_to_session 受理（触发点①）与
 *    create_session 建成（触发点②——D9 待解耦焊点，本批帧归一）均产生
 *    surface.action {verb:"navigate"} + steward.navigate 双帧；
 * 2. 新帧定向语义（与旧帧广播正交）：未注册表面的连接只收旧帧不收新帧；
 * 3. observe 归一：surface.event 上行 → 观察者收盖章 surfaceId
 *    （shell:<connId>:<page>）；词汇表外 kind 回 command.invalid_payload；
 * 4. 执行回执（D7-1）：surface.action.result 上行销账 pending；
 * 5. 注册面：surface.register → surface.registered 回执；非法 descriptor 回
 *    command.invalid_payload。
 */
import { describe, expect, test } from "bun:test";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";
import type { SessionDirectoryPort } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { SystemPort } from "../../src/application/ports/inbound/SystemPort";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { SurfaceRegistry } from "../../src/application/surface/SurfaceRegistry";
import { StewardService } from "../../src/application/steward/StewardService";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { PROTOCOL_VERSION, type EventEnvelope, type SurfaceEvent } from "@helix/protocol";

function until(cond: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - started > ms) return reject(new Error("until 超时"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function fakeView(): SessionStateView {
  return {
    session: {
      sessionId: "surf-s1",
      createdAt: "2026-10-05T00:00:00.000Z",
      entries: [],
      turns: [],
      pendingSteer: [],
    },
    toolCalls: [],
  };
}

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort {
  let round = 0;
  return {
    modelId: "deepseek/deepseek-v4-flash",
    async complete(): Promise<StewardLlmResponse> {
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
}

const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "toolCall", id, name, args }],
  stopReason: "toolUse",
});

interface Rig {
  adapter: WsServerAdapter;
  eventStream: EventStream;
  registry: SurfaceRegistry;
  steward: StewardService;
  observed: SurfaceEvent[];
  /** deliverToSession idle 全轮闸（受理后挂起模拟）。 */
  releaseDelivery: () => void;
}

function makeRig(llmScript: readonly StewardLlmResponse[]): Rig {
  const eventStream = new EventStream();
  const registry = new SurfaceRegistry({
    sendAction: (key, action) => eventStream.sendSurfaceAction(key as never, action),
    // 兼容期双发（D8 ③——M1 删除点）：navigate 镜像旧 steward.navigate
    emitLegacyNavigate: (args) => eventStream.broadcastStewardNavigate(args),
  });
  const observed: SurfaceEvent[] = [];
  registry.addObserver((e) => observed.push(e));

  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const steward = new StewardService({
    llm: fakeLlm(llmScript),
    orchestration: { status: () => [], send: () => ({ delivered: true, detail: "已投递" }) },
    tasks: { listTasks: () => [] },
    config: (() => {
      const kv = new Map([["steward.enabled", "1"]]);
      return {
        get: (k: string) => kv.get(k),
        set: async (k: string, v: string) => {
          kv.set(k, v);
        },
      } satisfies RuntimeConfigPort;
    })(),
    feedGate: { hasStewardSubscribers: () => true },
    emitFeed: () => {},
    // 组合根同构接线（M0 navigate 收编）：域出口不再直发页面指令帧——
    // 经 Registry 路由 surface.action（risk=write——D3 挂动作）
    emitNavigate: (payload) => registry.act("navigate", { sessionId: payload.sessionId }, { risk: "write" }),
    sessions: {
      sessionExists: async () => true,
      readSessionTail: async () => undefined,
      deliverToSession: async (sessionId: string, text: string) => {
        await gate;
        return { delivered: true, detail: "已送达" };
      },
      listSessionMetadata: async () => [],
      startDraftSession: async () => ({ sessionId: "sess-draft" }),
      createTitledSession: async () => ({ sessionId: "sess-new" }),
    },
    createEngine: createEngineFromPort(fakeLlm(llmScript)),
  });

  const directory: SessionDirectoryPort = {
    listSessions: async () => [],
    sessionExists: async (id) => id === "surf-s1",
    resolveTarget: async (id) => id ?? "surf-s1",
    getSessionView: async () => fakeView(),
    startDraftSession: async () => {
      throw new Error("surface rig 不装配草稿链");
    },
    deleteSession: async () => {
      throw new Error("surface rig 不装配删除链");
    },
    currentSessionId: () => "surf-s1",
  };
  const adapter = new WsServerAdapter({
    chat: {
      sendMessage: async () => {
        throw new Error("surface rig 不装配 chat");
      },
      steer: async () => {
        throw new Error("surface rig 不装配 chat");
      },
      abort: () => {},
    },
    directory,
    system: {
      getStatus: () => ({
        running: true,
        locked: true,
        home: "/tmp/surf-home",
        sessionId: "surf-s1",
        agentState: "idle",
        model: "surf/model",
      }),
      shutdown: async () => {},
    },
    orchestration: {
      spawn: () => ({ status: "rejected", error: "surface rig 不装配调度" }),
      send: () => ({ delivered: false, detail: "surf" }),
      status: () => [],
      kill: () => ({ killed: false, error: "surface rig 不装配调度" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "surface rig 不装配调度" }),
      resume: () => ({ resumed: false as const, error: "surface rig 不装配调度" }),
    },
    model: {
      setModel: async () => {
        throw new Error("surface rig 不装配模型链");
      },
      setThinking: async () => {
        throw new Error("surface rig 不装配模型链");
      },
      getModel: async () => {
        throw new Error("surface rig 不装配模型链");
      },
      catalog: async () => {
        throw new Error("surface rig 不装配模型链");
      },
      catalogRefresh: async () => {
        throw new Error("surface rig 不装配模型链");
      },
      setThinkingDefault: async () => ({ previous: null }),
      setDefault: async () => {
        throw new Error("surface rig 不装配模型链");
      },
      getDefault: () => ({ model: "surf/model", thinkingDefault: null }),
      authList: async () => [],
      authSetKey: async () => {
        throw new Error("surface rig 不装配模型链");
      },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail", reason: "surf" }),
    },
    resource: {
      list: async () => {
        throw new Error("surface rig 不装配资源配置链");
      },
      getEffectiveSkills: async () => [],
      setEnabled: async () => {
        throw new Error("surface rig 不装配资源配置链");
      },
      setModelSlot: async () => {
        throw new Error("surface rig 不装配资源配置链");
      },
      clearModelSlot: async () => {
        throw new Error("surface rig 不装配资源配置链");
      },
      setThinkingSlot: async () => {
        throw new Error("surface rig 不装配资源配置链");
      },
      modelSlot: () => undefined,
      thinkingSlot: () => undefined,
      clearThinkingSlot: async () => {
        throw new Error("surface rig 不装配资源配置链");
      },
    },
    hasModel: () => false,
    kgWriterPinnedTools: ["kg-update"],
    basePrompts: {},
    browser: new StubBrowserPort(),
    events: eventStream,
    steward: { service: steward, stream: eventStream },
    surface: { registry },
    token: "surf-token",
    port: 0,
  });
  return { adapter, eventStream, registry, steward, observed, releaseDelivery: release };
}

interface Client {
  frames: EventEnvelope[];
  send(type: string, payload: unknown): void;
  close(): void;
}

async function connect(adapter: WsServerAdapter, token: string): Promise<Client> {
  const frames: EventEnvelope[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${adapter.port}`);
  ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
  await until(() => frames.some((f) => f.type === "connection.welcome"));
  return {
    frames,
    send: (type, payload) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload })),
    close: () => ws.close(),
  };
}

describe("surface 协议地基（M0）：navigate 收编 + 双发 + 归一 + 回执", () => {
  test("注册回执 + observe 归一（surfaceId 盖章）+ 词汇表外 kind 拒收", async () => {
    const rig = makeRig([]);
    try {
      const c = await connect(rig.adapter, "surf-token");
      c.send("surface.register", { descriptor: { kind: "shell", capabilities: ["navigate"] } });
      await until(() => c.frames.some((f) => f.type === "surface.registered"));
      const reg = c.frames.find((f) => f.type === "surface.registered")!;
      expect(reg.payload).toEqual({ namespace: "shell", connId: "c1" });

      c.send("surface.event", { kind: "navigated", origin: "user", page: "tasks", detail: { from: "chat" } });
      await until(() => rig.observed.length === 1);
      expect(rig.observed[0]!.surfaceId).toBe("shell:c1:tasks");
      expect(rig.observed[0]!.kind).toBe("navigated");

      c.send("surface.event", { kind: "scrolled", origin: "user", page: "chat" });
      await until(() =>
        c.frames.some((f) => f.type === "connection.error" && String(f.payload.code).startsWith("command.invalid_payload")),
      );

      c.send("surface.register", { descriptor: { kind: "web", capabilities: ["navigate"] } });
      await until(() => c.frames.filter((f) => String(f.type === "connection.error" && String(f.payload.code).startsWith("command.invalid_payload"))).length >= 2);
      c.close();
    } finally {
      rig.adapter.stop();
    }
  }, 8000);

  test("deliver_to_session 受理（触发点①）：双发期新旧帧都到 + 回执销账", async () => {
    const rig = makeRig([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" }),
    ]);
    try {
      const c = await connect(rig.adapter, "surf-token");
      c.send("surface.register", { descriptor: { kind: "shell", capabilities: ["navigate"] } });
      await until(() => c.frames.some((f) => f.type === "surface.registered"));
      c.send("steward.subscribe", {});
      await new Promise((r) => setTimeout(r, 50));

      c.send("steward.ask", { text: "投递到 sess-1" });
      await until(() => c.frames.some((f) => f.type === "steward.ask.result" && f.payload.status === "confirm_required"));
      const ask = c.frames.find((f) => f.type === "steward.ask.result")!;
      if (ask.payload.status !== "confirm_required") throw new Error("expect confirm_required");
      c.send("steward.confirm", { actionId: ask.payload.actionId });

      // 双发：新帧 surface.action（定向到已注册表面）+ 旧帧 steward.navigate（广播）
      await until(() => c.frames.some((f) => f.type === "surface.action"));
      await until(() => c.frames.some((f) => f.type === "steward.navigate"));
      const action = c.frames.find((f) => f.type === "surface.action")!;
      expect(action.payload.verb).toBe("navigate");
      expect(action.payload.args).toEqual({ sessionId: "sess-1" });
      expect(action.payload.risk).toBe("write");
      expect(action.payload.seq).toBe(1);
      expect(action.payload.origin).toBe("steward");
      expect(action.payload.surfaceIds).toEqual(["shell:c1"]);
      const legacy = c.frames.find((f) => f.type === "steward.navigate")!;
      expect(legacy.payload).toEqual({ sessionId: "sess-1" });

      // 执行回执（D7-1）：pending 销账
      expect(rig.registry.pendingActions().length).toBe(1);
      c.send("surface.action.result", { seq: action.payload.seq, ok: true, detail: "已呈现" });
      await until(() => rig.registry.pendingActions().length === 0);
      expect(rig.registry.completedActions()[0]!.ok).toBe(true);

      rig.releaseDelivery();
      c.close();
    } finally {
      rig.adapter.stop();
    }
  }, 8000);

  test("start_session 建成（触发点②——D9 焊点帧归一）：双帧都到", async () => {
    // createSession 执行体走 start_session 提案（initial_message 属其 schema；
    // 空会话 create_session 同一执行分支——E-211 带话题开新会话）
    const rig = makeRig([
      toolCall("call-1", "start_session", { title: "新会话", initial_message: "开工" }),
    ]);
    try {
      const c = await connect(rig.adapter, "surf-token");
      c.send("surface.register", { descriptor: { kind: "shell", capabilities: ["navigate"] } });
      await until(() => c.frames.some((f) => f.type === "surface.registered"));
      c.send("steward.subscribe", {});
      await new Promise((r) => setTimeout(r, 50));

      c.send("steward.ask", { text: "开个新会话" });
      await until(() => c.frames.some((f) => f.type === "steward.ask.result" && f.payload.status === "confirm_required"));
      const ask = c.frames.find((f) => f.type === "steward.ask.result")!;
      if (ask.payload.status !== "confirm_required") throw new Error("expect confirm_required");
      c.send("steward.confirm", { actionId: ask.payload.actionId });

      // createSession 分支：建成即双发（sessionId 执行后才产生——仍在执行体，
      // D9 编排解耦后续批；本批先帧归一）
      await until(() => c.frames.some((f) => f.type === "surface.action"));
      await until(() => c.frames.some((f) => f.type === "steward.navigate"));
      const action = c.frames.find((f) => f.type === "surface.action")!;
      expect(action.payload.args).toEqual({ sessionId: "sess-new" });
      const legacy = c.frames.find((f) => f.type === "steward.navigate")!;
      expect(legacy.payload).toEqual({ sessionId: "sess-new" });
      rig.releaseDelivery(); // 初始话题投递闸放开（执行体收口）
      c.close();
    } finally {
      rig.adapter.stop();
    }
  }, 8000);

  test("定向 vs 广播：未注册表面的连接只收旧帧不收新帧", async () => {
    const rig = makeRig([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" }),
    ]);
    try {
      const registered = await connect(rig.adapter, "surf-token");
      const bystander = await connect(rig.adapter, "surf-token");
      registered.send("surface.register", { descriptor: { kind: "shell", capabilities: ["navigate"] } });
      await until(() => registered.frames.some((f) => f.type === "surface.registered"));
      // 注册表面连接同时订 steward（旧帧广播闸）——两闸门正交的受控变量
      registered.send("steward.subscribe", {});
      // 旁观连接只订阅 steward（不注册表面）
      bystander.send("steward.subscribe", {});
      await new Promise((r) => setTimeout(r, 50));

      registered.send("steward.ask", { text: "投递到 sess-1" });
      await until(() => registered.frames.some((f) => f.type === "steward.ask.result" && f.payload.status === "confirm_required"));
      const ask = registered.frames.find((f) => f.type === "steward.ask.result")!;
      if (ask.payload.status !== "confirm_required") throw new Error("expect confirm_required");
      registered.send("steward.confirm", { actionId: ask.payload.actionId });

      await until(() => registered.frames.some((f) => f.type === "surface.action"));
      await until(() => bystander.frames.some((f) => f.type === "steward.navigate"));
      expect(registered.frames.some((f) => f.type === "steward.navigate")).toBe(true);
      // 新帧定向：旁观连接（未注册表面）零 surface.action
      expect(bystander.frames.some((f) => f.type === "surface.action")).toBe(false);

      rig.releaseDelivery();
      registered.close();
      bystander.close();
    } finally {
      rig.adapter.stop();
    }
  }, 8000);
});

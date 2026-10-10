/**
 * 管家 steward.tool 两相帧 WS 端到端验证（用户报障「光球看不到工具调用」）。
 *
 * 覆盖此前零覆盖的段：pi 引擎真执行工具（剧本 toolCall 响应）→
 * PiAgentEngineAdapter 事件转发 → persistentListener → StewardService
 * forwardStreamCallbacks → WS handler steward.tool 帧 → loopback WS 客户端。
 * 断言 start（name+argsSummary）/ end（resultSummary）两相帧都到客户端，
 * 顺序先于 answer 收口。绿 = daemon→WS 线上全链通；红 = 断点实锤。
 */
import { describe, expect, test } from "bun:test";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { SurfaceRegistry } from "../../src/application/surface/SurfaceRegistry";
import { StewardService } from "../../src/application/steward/StewardService";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { PROTOCOL_VERSION, type EventEnvelope } from "@helix/protocol";

function until(cond: () => boolean, ms = 5000): Promise<void> {
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

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort {
  let round = 0;
  return {
    modelId: "deepseek/deepseek-v4-flash",
    async complete(_req: StewardLlmRequest): Promise<StewardLlmResponse> {
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
}

function makeRig(llmScript: readonly StewardLlmResponse[]) {
  const eventStream = new EventStream();
  const registry = new SurfaceRegistry({
    sendAction: () => undefined,
    emitLegacyNavigate: () => undefined,
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
    createEngine: createEngineFromPort(fakeLlm(llmScript)),
  });
  const adapter = new WsServerAdapter({
    chat: {
      sendMessage: async () => {
        throw new Error("tool rig 不装配 chat");
      },
      steer: async () => {
        throw new Error("tool rig 不装配 chat");
      },
      abort: () => {},
    },
    directory: {
      listSessions: async () => [],
      sessionExists: async () => true,
      resolveTarget: async (id) => id ?? "surf-s1",
      getSessionView: async () => ({
        session: {
          sessionId: "surf-s1",
          createdAt: "2026-10-05T00:00:00.000Z",
          entries: [],
          turns: [],
          pendingSteer: [],
        },
        toolCalls: [],
      }),
      startDraftSession: async () => {
        throw new Error("tool rig 不装配草稿链");
      },
      deleteSession: async () => {
        throw new Error("tool rig 不装配删除链");
      },
      currentSessionId: () => "surf-s1",
    },
    system: {
      getStatus: () => ({
        running: true,
        locked: true,
        home: "/tmp/tool-home",
        sessionId: "surf-s1",
        agentState: "idle",
        model: "surf/model",
      }),
      shutdown: async () => {},
    },
    orchestration: {
      spawn: () => ({ status: "rejected", error: "tool rig 不装配调度" }),
      send: () => ({ delivered: false, detail: "surf" }),
      status: () => [],
      kill: () => ({ killed: false, error: "tool rig 不装配调度" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "tool rig 不装配调度" }),
      resume: () => ({ resumed: false, error: "tool rig 不装配调度" }),
    },
    model: {
      setModel: async () => {
        throw new Error("tool rig 不装配模型链");
      },
      setThinking: async () => {
        throw new Error("tool rig 不装配模型链");
      },
      getModel: async () => {
        throw new Error("tool rig 不装配模型链");
      },
      catalog: async () => {
        throw new Error("tool rig 不装配模型链");
      },
      catalogRefresh: async () => {
        throw new Error("tool rig 不装配模型链");
      },
      setThinkingDefault: async () => ({ previous: null }),
      setDefault: async () => {
        throw new Error("tool rig 不装配模型链");
      },
      getDefault: () => ({ model: "surf/model", thinkingDefault: null }),
      authList: async () => [],
      authSetKey: async () => {
        throw new Error("tool rig 不装配模型链");
      },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail", reason: "surf" }),
    },
    resource: {
      list: async () => {
        throw new Error("tool rig 不装配资源配置链");
      },
      getEffectiveSkills: async () => [],
      setEnabled: async () => {
        throw new Error("tool rig 不装配资源配置链");
      },
      setModelSlot: async () => {
        throw new Error("tool rig 不装配资源配置链");
      },
      clearModelSlot: async () => {
        throw new Error("tool rig 不装配资源配置链");
      },
      setThinkingSlot: async () => {
        throw new Error("tool rig 不装配资源配置链");
      },
      modelSlot: () => undefined,
      thinkingSlot: () => undefined,
      clearThinkingSlot: async () => {
        throw new Error("tool rig 不装配资源配置链");
      },
    },
    hasModel: () => false,
    kgWriterPinnedTools: [],
    basePrompts: {},
    browser: new StubBrowserPort(),
    events: eventStream,
    steward: { service: steward, stream: eventStream },
    surface: { registry },
    token: "tool-token",
    port: 0,
  });
  return { adapter, steward };
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

describe("管家 steward.tool 两相帧（WS 端到端——pi 真工具轮）", () => {
  test("只读工具（list_tasks）：start/end 两相帧到客户端，先于 answer 收口", async () => {
    const rig = makeRig([
      // 第一轮：模型直接调工具（零先行文本——与真机 21:49 deliver_to_session 轮同形态）
      {
        kind: "blocks",
        blocks: [{ type: "toolCall", id: "call-t1", name: "list_tasks", args: {} }],
        stopReason: "toolUse",
      },
      // 第二轮：工具结果回填后文本终答
      { kind: "blocks", blocks: [{ type: "text", text: "当前没有在途任务" }], stopReason: "stop" },
    ]);
    try {
      const c = await connect(rig.adapter, "tool-token");
      c.send("steward.ask", { text: "查一下任务" });

      await until(() => c.frames.some((f) => f.type === "steward.ask.result"));
      const toolFrames = c.frames.filter((f) => f.type === "steward.tool");
      const askResultIdx = c.frames.findIndex((f) => f.type === "steward.ask.result");
      const toolIdx = c.frames.findIndex((f) => f.type === "steward.tool");

      console.log(
        "帧序列:",
        c.frames.map((f) => f.type).join(" → "),
      );
      for (const f of toolFrames) console.log("steward.tool payload:", JSON.stringify(f.payload));

      // 两相帧都在，且先于 answer 收口
      expect(toolFrames.length).toBeGreaterThanOrEqual(2);
      expect(toolIdx).toBeGreaterThanOrEqual(0);
      expect(toolIdx).toBeLessThan(askResultIdx);
      const start = toolFrames.find((f) => (f.payload as { phase?: string }).phase === "start");
      const end = toolFrames.find((f) => (f.payload as { phase?: string }).phase === "end");
      expect(start?.payload).toMatchObject({ phase: "start", name: "list_tasks" });
      expect(typeof (start?.payload as { argsSummary?: unknown }).argsSummary).toBe("string");
      expect(end?.payload).toMatchObject({ phase: "end", name: "list_tasks" });
      // 收口 answer
      const result = c.frames.find((f) => f.type === "steward.ask.result")!;
      expect(result.payload).toMatchObject({ status: "answer" });
      c.close();
    } finally {
      rig.adapter.stop();
    }
  }, 15_000);
});

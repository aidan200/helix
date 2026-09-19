import { describe, expect, test } from "bun:test";
import type { SessionChatPort, SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";
import type { SessionDirectoryPort } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { SystemPort } from "../../src/application/ports/inbound/SystemPort";
import type { ModelPort } from "../../src/application/ports/inbound/ModelPort";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { PROTOCOL_VERSION, type DaemonFreshnessDto, type EventEnvelope } from "@helix/protocol";

/**
 * stale-indicator 批：welcome 帧透传 daemonFreshness（additive，E-54 帧序不动）。
 * - freshness 读面注入（stale=true / false）→ welcome payload 原样携带；
 * - 未注入（stub rig / 打包态）→ 字段缺省（additive 语义）。
 * spy rig 形态同 ws-server-spy.test.ts（只覆盖握手面，不驱动命令族）。
 */

function fakeView(): SessionStateView {
  return {
    session: {
      sessionId: "fresh-s1",
      createdAt: "2026-08-15T00:00:00.000Z",
      entries: [],
      turns: [],
      pendingSteer: [],
    },
    toolCalls: [],
  };
}

interface RigDeps {
  readonly freshness?: () => DaemonFreshnessDto | undefined;
}

async function makeRig(extra: RigDeps): Promise<{ adapter: WsServerAdapter; frames: EventEnvelope[] }> {
  const chat: SessionChatPort = {
    sendMessage: async (): Promise<SendOutcome> => ({ mode: "turn", turnId: "t1", entryId: "e1" }),
    steer: async () => ({ entryId: "e2" }),
    abort: () => {},
  };
  const directory: SessionDirectoryPort = {
    listSessions: async () => [],
    sessionExists: async () => true,
    resolveTarget: async (id?: string) => id ?? "fresh-s1",
    getSessionView: async () => fakeView(),
    startDraftSession: async () => {
      throw new Error("freshness rig 不装配草稿链");
    },
    deleteSession: async () => {
      throw new Error("freshness rig 不装配删除链");
    },
    currentSessionId: () => "fresh-s1",
  };
  const system: SystemPort = {
    getStatus: () => ({
      running: true,
      locked: true,
      home: "/tmp/fresh-home",
      sessionId: "fresh-s1",
      agentState: "idle",
      model: "fresh/model",
    }),
    shutdown: async () => {},
  };
  const model: ModelPort = {
    setModel: async () => {
      throw new Error("freshness rig 不装配模型链");
    },
    setThinking: async () => {
      throw new Error("freshness rig 不装配模型链");
    },
    getModel: async () => {
      throw new Error("freshness rig 不装配模型链");
    },
    catalog: async () => {
      throw new Error("freshness rig 不装配模型链");
    },
    catalogRefresh: async () => {
      throw new Error("freshness rig 不装配模型链");
    },
    setThinkingDefault: async () => ({ previous: null }),
    setDefault: async () => {
      throw new Error("freshness rig 不装配模型链");
    },
    getDefault: () => ({ model: "fresh/model", thinkingDefault: null }),
    authList: async () => [],
    authSetKey: async () => {
      throw new Error("freshness rig 不装配模型链");
    },
    authDeleteKey: async () => {},
    authVerify: async () => ({ status: "fail", reason: "rig" }),
  };
  const adapter = new WsServerAdapter({
    chat,
    directory,
    system,
    orchestration: {
      spawn: () => ({ status: "rejected", error: "freshness rig 不装配调度" }),
      send: () => ({ delivered: false, detail: "rig" }),
      status: () => [],
      kill: () => ({ killed: false, error: "rig" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "测试桩不挂起" }),
      resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
    },
    model,
    resource: {
      list: async () => {
        throw new Error("rig");
      },
      getEffectiveSkills: async () => [],
      setEnabled: async () => {
        throw new Error("rig");
      },
      setModelSlot: async () => {
        throw new Error("rig");
      },
      clearModelSlot: async () => {
        throw new Error("rig");
      },
      setThinkingSlot: async () => {
        throw new Error("rig");
      },
      modelSlot: () => undefined,
      thinkingSlot: () => undefined,
      clearThinkingSlot: async () => {
        throw new Error("rig");
      },
    },
    hasModel: () => false,
    kgWriterPinnedTools: [],
    basePrompts: {},
    browser: new StubBrowserPort(),
    events: new EventStream(),
    token: "fresh-token",
    port: 0,
    ...(extra.freshness !== undefined ? { freshness: extra.freshness } : {}),
  });
  const frames: EventEnvelope[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${adapter.port}`);
  ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "fresh-token", protocolVersion: PROTOCOL_VERSION } }));
  const welcome = await untilWelcome(frames);
  ws.close();
  return { adapter, frames: [...frames, welcome] };
}

function untilWelcome(frames: EventEnvelope[]): Promise<EventEnvelope> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const hit = frames.find((f) => f.type === "connection.welcome");
      if (hit !== undefined) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - t0 > 3000) {
        clearInterval(timer);
        reject(new Error("untilWelcome 超时"));
      }
    }, 10);
  });
}

describe("welcome daemonFreshness 透传（stale-indicator 批）", () => {
  test("freshness() → { startedAt, stale:true } → welcome 原样携带（additive，帧序不变）", async () => {
    const rig = await makeRig({
      freshness: () => ({ startedAt: 1_760_000_000_000, stale: true }),
    });
    try {
      const welcome = rig.frames.find((f) => f.type === "connection.welcome")!;
      expect(welcome.payload).toMatchObject({
        sessionId: "fresh-s1",
        model: "fresh/model",
        daemonFreshness: { startedAt: 1_760_000_000_000, stale: true },
      });
    } finally {
      rig.adapter.stop();
    }
  }, 8000);

  test("freshness() → { stale:false } → welcome 携带 fresh 态", async () => {
    const rig = await makeRig({
      freshness: () => ({ startedAt: 9_000, stale: false }),
    });
    try {
      const welcome = rig.frames.find((f) => f.type === "connection.welcome")!;
      expect(welcome.payload.daemonFreshness).toEqual({ startedAt: 9_000, stale: false });
    } finally {
      rig.adapter.stop();
    }
  }, 8000);

  test("未注入 freshness（stub rig / 打包态读面）→ 字段缺省（additive 语义）", async () => {
    const rig = await makeRig({});
    try {
      const welcome = rig.frames.find((f) => f.type === "connection.welcome")!;
      expect(welcome.payload.daemonFreshness).toBeUndefined();
    } finally {
      rig.adapter.stop();
    }
  }, 8000);

  test("freshness() → undefined（打包态源码目录缺失）→ 字段缺省", async () => {
    const rig = await makeRig({ freshness: () => undefined });
    try {
      const welcome = rig.frames.find((f) => f.type === "connection.welcome")!;
      expect(welcome.payload.daemonFreshness).toBeUndefined();
    } finally {
      rig.adapter.stop();
    }
  }, 8000);
});

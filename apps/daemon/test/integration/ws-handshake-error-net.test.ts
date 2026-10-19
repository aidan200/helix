import { describe, expect, test } from "bun:test";
import type { SessionChatPort, SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";
import type { SessionDirectoryPort } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { SystemPort } from "../../src/application/ports/inbound/SystemPort";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { PROTOCOL_VERSION, type EventEnvelope } from "@helix/protocol";

/**
 * 修复批（评审 B9）：握手异步链整体异常兜底——probeCurrentDraft/getStatus/
 * events.attach/freshness/getDefault 任一抛错时，修复前为 unhandledRejection +
 * 连接悬挂（authed 已置位、welcome/snapshot 永不发）+ finally 排队帧照常回放
 *（*.result 回执早于 welcome，破 E-54③）。
 *
 * 契约（E-54 拒绝路径同处置）：握手链路中段抛错 → connection.error
 * {daemon.internal} + close（先发帧再 close）；排队命令帧不回放（无任何
 * *.result 帧早于 welcome 到达）。
 */

function fakeView(): SessionStateView {
  return {
    session: {
      sessionId: "hs-err-s1",
      createdAt: "2026-10-19T00:00:00.000Z",
      entries: [],
      turns: [],
      pendingSteer: [],
    },
    toolCalls: [],
  };
}

function makeRig(probeImpl: () => Promise<boolean>): { adapter: WsServerAdapter; stop(): void } {
  const chat: SessionChatPort = {
    sendMessage: async (): Promise<SendOutcome> => ({ mode: "turn", turnId: "t1", entryId: "e1" }),
    steer: async () => ({ entryId: "e2" }),
    abort: () => {},
  };
  const directory: SessionDirectoryPort = {
    listSessions: async () => [],
    sessionExists: async () => true,
    resolveTarget: async (id?: string) => id ?? "hs-err-s1",
    getSessionView: async () => fakeView(),
    startDraftSession: async () => { throw new Error("测试桩不装配草稿链"); },
    deleteSession: async () => { throw new Error("测试桩不装配删除链"); },
    currentSessionId: () => "hs-err-s1",
    // 异常注入点①：握手链中段（authed 置位之后、welcome 之前）抛错
    probeCurrentDraft: probeImpl,
  };
  const system: SystemPort = {
    getStatus: () => ({
      running: true,
      locked: true,
      home: "/tmp/hs-err-home",
      sessionId: "hs-err-s1",
      agentState: "idle",
      model: "hs/model",
    }),
    shutdown: async () => {},
  };
  const adapter = new WsServerAdapter({
    chat,
    directory,
    system,
    orchestration: {
      spawn: () => ({ status: "rejected", error: "测试桩不装配调度" }),
      send: () => ({ delivered: false, detail: "stub" }),
      status: () => [],
      kill: () => ({ killed: false, error: "测试桩不装配调度" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "测试桩不挂起" }),
      resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
    },
    model: {
      setModel: async () => { throw new Error("测试桩不装配模型链"); },
      setThinking: async () => { throw new Error("测试桩不装配模型链"); },
      getModel: async () => { throw new Error("测试桩不装配模型链"); },
      catalog: async () => { throw new Error("测试桩不装配模型链"); },
      catalogRefresh: async () => { throw new Error("测试桩不装配模型链"); },
      setThinkingDefault: async () => ({ previous: null }),
      setDefault: async () => { throw new Error("测试桩不装配模型链"); },
      getDefault: () => ({ model: "hs/model", thinkingDefault: null }),
      authList: async () => [],
      authSetKey: async () => { throw new Error("测试桩不装配模型链"); },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail", reason: "stub" }),
    },
    resource: {
      list: async () => { throw new Error("测试桩不装配资源配置链"); },
      getEffectiveSkills: async () => [],
      setEnabled: async () => { throw new Error("测试桩不装配资源配置链"); },
      setModelSlot: async () => { throw new Error("测试桩不装配资源配置链"); },
      clearModelSlot: async () => { throw new Error("测试桩不装配资源配置链"); },
      setThinkingSlot: async () => { throw new Error("测试桩不装配资源配置链"); },
      modelSlot: () => undefined,
      thinkingSlot: () => undefined,
      clearThinkingSlot: async () => { throw new Error("测试桩不装配资源配置链"); },
    },
    hasModel: () => false,
    kgWriterPinnedTools: ["kg-update"],
    basePrompts: {},
    browser: new StubBrowserPort(),
    events: new EventStream(),
    token: "hs-err-token",
    port: 0,
  });
  return { adapter, stop: () => adapter.stop() };
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 崩溃剧本：authed 置位后、welcome 前，probeCurrentDraft 延迟一拍抛错
 *（留出命令帧排队窗口）。 */
const boomAfterTick = async (): Promise<boolean> => {
  await new Promise((r) => setTimeout(r, 30));
  throw new Error("probe 崩了（注入）");
};

describe("评审 B9：握手异步链整体异常兜底", () => {
  test("链路中段抛错 → connection.error{daemon.internal} + close（不悬挂、不 unhandledRejection）", async () => {
    const rig = makeRig(boomAfterTick);
    try {
      const frames: EventEnvelope[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${rig.adapter.port}`);
      ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "hs-err-token", protocolVersion: PROTOCOL_VERSION } }));

      await until(() => frames.some((f) => f.type === "connection.error"), 3000, "daemon.internal 拒绝帧");
      const err = frames.find((f) => f.type === "connection.error")!;
      expect((err.payload as { code: string }).code).toBe("daemon.internal");
      // 先发帧再 close（E-54 拒绝路径同处置）
      await until(() => ws.readyState === WebSocket.CLOSED, 3000, "异常连接关闭");
      // welcome 从未发出（悬挂面的反面证明）
      expect(frames.some((f) => f.type === "connection.welcome")).toBe(false);
    } finally {
      rig.stop();
    }
  }, 8000);

  test("抛错前排队的命令帧不回放——无 *.result 回执早于 welcome（E-54③）", async () => {
    const rig = makeRig(boomAfterTick);
    try {
      const frames: EventEnvelope[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${rig.adapter.port}`);
      ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
      await new Promise<void>((r) => (ws.onopen = () => r()));
      // hello 后立刻发命令帧：await 窗口内进 handshakeQueues 排队
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "hs-err-token", protocolVersion: PROTOCOL_VERSION } }));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "session.list", payload: {} }));

      await until(() => ws.readyState === WebSocket.CLOSED, 3000, "异常连接关闭");
      // 排队帧不得回放：无任何 *.result 回执（welcome 未发，回放即破 E-54）
      await new Promise((r) => setTimeout(r, 200));
      expect(frames.some((f) => f.type.endsWith(".result"))).toBe(false);
    } finally {
      rig.stop();
    }
  }, 8000);
});

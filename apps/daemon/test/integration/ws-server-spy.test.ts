import { describe, expect, test } from "bun:test";
import type { ChatPort, SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SessionPort, SessionStateView, SessionStreamEvent } from "../../src/application/ports/inbound/SessionPort";
import type { SystemPort } from "../../src/application/ports/inbound/SystemPort";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { EventEnvelope } from "@helix/protocol";

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
    const session: SessionPort = {
      getSnapshot: () => {
        snapshotCalls++;
        return fakeView();
      },
      subscribe: (_l: (e: SessionStreamEvent) => void) => () => {},
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
      session,
      system,
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
      ws.send(JSON.stringify({ v: 0, type: "hello", payload: { token: "spy-token", protocolVersion: 0 } }));
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
      await until(() => snapshotCalls === 2); // subscribe 重推快照（经 SessionPort 取数）
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
});

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * code-review M：WS 发送背压守护（createRawSender）。
 * 缺陷现场：rawSender 只判 readyState 不消费 send 返回值、无 bufferedAmount
 * 监测——token 级流式 delta 发往慢客户端时发送缓冲无限堆积（内存注入面）。
 * 修复：缓冲超阈值（8MB）→ 应用自定义码 4000 断连慢客户端（重连经快照收敛）。
 */
import { describe, expect, test } from "bun:test";
import { createRawSender, WS_BUFFER_LIMIT_BYTES } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import type { EventEnvelope } from "@helix/protocol";

const frame = { v: 1, type: "agent.state.changed", payload: { state: "idle" } } as unknown as EventEnvelope;

function fakeWs(buffered: number) {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  return {
    sent,
    closed,
    ws: {
      readyState: WebSocket.OPEN,
      send(data: string) {
        sent.push(data);
        return data.length;
      },
      getBufferedAmount: () => buffered,
      close(code?: number, reason?: string) {
        closed.push({ code, reason });
      },
    },
  };
}

describe("code-review M：createRawSender 背压守护", () => {
  test("缓冲超阈值 → 不发送 + 4000 断连 + onDrop 观测", () => {
    const { ws, sent, closed } = fakeWs(WS_BUFFER_LIMIT_BYTES + 1);
    let dropped: number | undefined;
    const sender = createRawSender(ws, (b) => (dropped = b));
    sender(frame);
    expect(sent).toHaveLength(0); // 现行行为红：无监测照常 send（缓冲无限堆积）
    expect(closed).toHaveLength(1);
    expect(closed[0]!.code).toBe(4000);
    expect(dropped).toBe(WS_BUFFER_LIMIT_BYTES + 1);
  });

  test("缓冲正常 → 照常发送（回归面）", () => {
    const { ws, sent, closed } = fakeWs(1024);
    const sender = createRawSender(ws);
    sender(frame);
    expect(sent).toHaveLength(1);
    expect(closed).toHaveLength(0);
  });

  test("连接非 OPEN → 静默不发送（既有语义保持）", () => {
    const { ws, sent } = fakeWs(0);
    (ws as { readyState: number }).readyState = WebSocket.CLOSED;
    const sender = createRawSender(ws);
    sender(frame);
    expect(sent).toHaveLength(0);
  });

  test("快照体量批：缓冲越过半限 → onWatermark 预警回调（水位线）；半限内不触发", () => {
    const half = Math.floor(WS_BUFFER_LIMIT_BYTES / 2);
    // 半限内：不触发
    {
      const { ws } = fakeWs(half);
      let marks = 0;
      const sender = createRawSender(ws, undefined, () => {
        marks++;
      });
      sender(frame);
      expect(marks).toBe(0);
    }
    // 越过半限且未超限：触发并照常发送
    {
      const { ws, sent } = fakeWs(half + 1);
      const seen: number[] = [];
      const sender = createRawSender(ws, undefined, (b) => seen.push(b));
      sender(frame);
      expect(seen).toEqual([half + 1]);
      expect(sent).toHaveLength(1); // 水位线不是断连——照常发送
    }
  });
});

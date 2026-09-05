import { describe, expect, test } from "bun:test";
import { diffChangedFrame } from "../../src/adapters/driving/ws-server/EnvelopeMapper";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { DiffChangedPayload, EventEnvelope } from "@helix/protocol";
import { SYSTEM_SESSION_ID } from "@helix/protocol";

/**
 * T3 diff.changed 瞬态推送帧 daemon 侧接线单测：
 * - EnvelopeMapper.diffChangedFrame：diff delta → 协议帧纯翻译（信封
 *   sessionId=归属会话、channel=session、type=diff.changed、payload 原样）；
 * - EventStream.publishDelta 的 diff 分支：按会话订阅路由（只有订阅该会话
 *   的连接收到；未订阅连接零帧——TR-38 per-session 不变式）；monitor 档
 *   白名单外事件同样过滤。
 */

const PAYLOAD: DiffChangedPayload = { turnId: "t-1", phase: "active", adds: 12, dels: 4, fileCount: 3 };

describe("diffChangedFrame（EnvelopeMapper diff 翻译）", () => {
  test("信封章印：sessionId=归属会话、channel=session、type=diff.changed、v=当前版本", () => {
    const frame = diffChangedFrame("sess-9", PAYLOAD);
    expect(frame.type).toBe("diff.changed");
    expect(frame.channel).toBe("session");
    expect(frame.sessionId).toBe("sess-9");
    expect(frame.v).toBe("0.11");
    expect(frame.payload).toEqual(PAYLOAD);
  });

  test("payload 不变形（三态 round-trip）", () => {
    for (const phase of ["cleared", "active", "frozen"] as const) {
      const p: DiffChangedPayload = { turnId: "t", phase, adds: 0, dels: 7, fileCount: 1 };
      expect(diffChangedFrame("s", p).payload).toEqual(p);
    }
  });
});

describe("EventStream.publishDelta diff 分支：per-session 订阅路由", () => {
  function rig() {
    const stream = new EventStream();
    const framesA: EventEnvelope[] = [];
    const framesB: EventEnvelope[] = [];
    const senderA = (f: EventEnvelope) => {
      framesA.push(f);
    };
    const senderB = (f: EventEnvelope) => {
      framesB.push(f);
    };
    stream.attach(senderA);
    stream.attach(senderB);
    stream.subscribeSession(senderA, "sess-1");
    stream.subscribeSession(senderB, "sess-2");
    return { stream, framesA, framesB, senderA };
  }

  test("只有订阅归属会话的连接收到 diff.changed 帧", () => {
    const { stream, framesA, framesB } = rig();
    stream.publishDelta({ messageId: "", delta: "", channel: "diff", sessionId: "sess-1", diff: PAYLOAD });
    expect(framesA).toHaveLength(1);
    expect(framesB).toHaveLength(0);
    expect(framesA[0]!.type).toBe("diff.changed");
    expect(framesA[0]!.channel).toBe("session");
    expect(framesA[0]!.sessionId).toBe("sess-1");
    expect(framesA[0]!.payload).toEqual(PAYLOAD);
  });

  test("monitor 档连接不放行（白名单外事件——TR-38 §2）", () => {
    const { stream, senderA } = rig();
    stream.subscribeSession(senderA, "sess-1", "monitor"); // 重复订阅换档幂等
    const seen: EventEnvelope[] = [];
    const monitorConn = (f: EventEnvelope) => {
      seen.push(f);
    };
    stream.attach(monitorConn);
    stream.subscribeSession(monitorConn, "sess-1", "monitor");
    stream.publishDelta({ messageId: "", delta: "", channel: "diff", sessionId: "sess-1", diff: PAYLOAD });
    expect(seen).toHaveLength(0);
  });

  test("无 sessionId 的 diff delta 丢弃（M13 广播串话防御同口径）", () => {
    const stream = new EventStream();
    const seen: EventEnvelope[] = [];
    const sender = (f: EventEnvelope) => {
      seen.push(f);
    };
    stream.attach(sender);
    stream.subscribeSession(sender, SYSTEM_SESSION_ID);
    stream.publishDelta({ messageId: "", delta: "", channel: "diff", diff: PAYLOAD });
    expect(seen).toHaveLength(0);
  });
});

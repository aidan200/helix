/**
 * 管家语音交互闭环批 ⑤ notify 出口加日志（TDD 红→绿）。
 *
 * 事故盲区定性（2026-10-06 22:16-22:17 排障实录）：两条同模板可达性提醒双端
 * 放行——shell 去重 key 不同全放（正确），daemon 出口零日志（排障全靠猜）。
 * 修法：broadcastStewardNotify 发出即打 INFO（title + seq + 订阅连接数）、
 * 去重窗丢弃打 WARN（同 title/seq）——通知行为可观测。
 */
import { describe, expect, test } from "bun:test";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { StewardNotifyPayload, EventEnvelope } from "@helix/protocol";

function makeLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
  };
}

describe("⑤ steward.notify 出口日志（发出 INFO / 去重丢弃 WARN）", () => {
  test("订阅连接收到通知 → INFO 日志含 title 与 seq；发送帧面不变", () => {
    const logger = makeLogger();
    const sent: EventEnvelope[] = [];
    let now = 1_000;
    const stream = new EventStream({ clock: () => now, logger });
    const sender = (frame: EventEnvelope) => sent.push(frame);
    stream.attach(sender);
    stream.subscribeSteward(sender);

    const payload: StewardNotifyPayload = { urgency: "normal", title: "待确认操作", body: "管家有一个操作等你确认", seq: 1 };
    stream.broadcastStewardNotify(payload);

    expect(sent.length).toBe(1);
    expect(logger.infos.length).toBe(1);
    expect(logger.infos[0]).toContain("待确认操作");
    expect(logger.infos[0]).toContain("seq=1");
  });

  test("同 key 60s 内重复 → 丢弃且 WARN 日志（不重发帧）", () => {
    const logger = makeLogger();
    const sent: EventEnvelope[] = [];
    let now = 1_000;
    const stream = new EventStream({ clock: () => now, logger });
    const sender = (frame: EventEnvelope) => sent.push(frame);
    stream.attach(sender);
    stream.subscribeSteward(sender);

    const payload: StewardNotifyPayload = { urgency: "normal", title: "待确认操作", body: "管家有 2 个操作等你确认", seq: 2 };
    stream.broadcastStewardNotify(payload);
    stream.broadcastStewardNotify(payload); // 短窗重复
    expect(sent.length).toBe(1);
    expect(logger.warns.length).toBe(1);
    expect(logger.warns[0]).toContain("待确认操作");
    expect(logger.warns[0]).toContain("seq=2");

    // 窗外（60s 后）→ 放行 + INFO
    now += 60_001;
    stream.broadcastStewardNotify(payload);
    expect(sent.length).toBe(2);
    expect(logger.infos.length).toBe(2);
  });

  test("零订阅连接 → 仍打 INFO（发出语义=出口受理——订阅闸门过滤是投递面非受理面）", () => {
    const logger = makeLogger();
    const stream = new EventStream({ clock: () => 0, logger });
    const sender = () => undefined;
    stream.attach(sender); // 未订阅 steward 的连接
    stream.subscribeSteward(() => undefined);

    stream.broadcastStewardNotify({ urgency: "normal", title: "确认已超时", body: "x", seq: 3 });
    expect(logger.infos.length).toBe(1);
  });

  test("logger 缺席 → 零日志不抛错（旧装配兼容）", () => {
    const stream = new EventStream({ clock: () => 0 });
    const sender = () => undefined;
    stream.attach(sender);
    stream.subscribeSteward(sender);
    expect(() =>
      stream.broadcastStewardNotify({ urgency: "normal", title: "t", body: "b", seq: 1 }),
    ).not.toThrow();
  });
});

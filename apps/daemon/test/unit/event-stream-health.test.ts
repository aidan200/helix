/**
 * steward.health 窗口去重（光球健康角标去残留修复，TDD 红→绿）。
 *
 * 背景：徽标 TTL（shell 60s 无新证据自动灭）需要 daemon 侧「持续故障续报」
 * 配合——原同态去重（状态不变永不重发）会让持续故障在 TTL 过期后徽标再也
 * 亮不起来。修法：同态去重改窗口制——同状态 30s 窗口内只报一次（降级风暴
 * 不刷帧），窗口届满同态续报（持续故障持续有证据续期徽标）；状态变化立即报。
 */
import { describe, expect, test } from "bun:test";
import { EventStream, STEWARD_HEALTH_REEMIT_MS } from "../../src/adapters/driving/ws-server/EventStream";
import type { EventEnvelope } from "@helix/protocol";

function makeLogger() {
  return { info: () => {}, warn: () => {} };
}

function harness() {
  const sent: EventEnvelope[] = [];
  let now = 1_000;
  const stream = new EventStream({ clock: () => now, logger: makeLogger() });
  const sender = (frame: EventEnvelope) => sent.push(frame);
  stream.attach(sender);
  stream.subscribeSteward(sender);
  return {
    sent,
    stream,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("steward.health 窗口去重（同态窗口去重 + 届满续报）", () => {
  test("同态窗口内只报一次；窗口届满同态续报（持续故障续证徽标）", () => {
    const h = harness();
    h.stream.reportStewardHealth("tts", "degraded", "411");
    h.stream.reportStewardHealth("tts", "degraded", "411"); // 窗口内同态 → 去重
    expect(h.sent.length).toBe(1);
    h.advance(STEWARD_HEALTH_REEMIT_MS + 1_000);
    h.stream.reportStewardHealth("tts", "degraded", "411"); // 窗口届满 → 续报
    expect(h.sent.length).toBe(2);
  });

  test("状态变化立即报（不受窗口压制）", () => {
    const h = harness();
    h.stream.reportStewardHealth("tts", "degraded", "411");
    h.stream.reportStewardHealth("tts", "ok"); // 恢复立即报
    h.stream.reportStewardHealth("tts", "degraded", "411"); // 再坏立即报
    expect(h.sent.length).toBe(3);
  });

  test("ok→ok 窗口内同样去重（逐句合成成功不刷帧）", () => {
    const h = harness();
    h.stream.reportStewardHealth("tts", "ok");
    h.stream.reportStewardHealth("tts", "ok");
    h.stream.reportStewardHealth("tts", "ok");
    expect(h.sent.length).toBe(1);
    h.advance(STEWARD_HEALTH_REEMIT_MS + 1_000);
    h.stream.reportStewardHealth("tts", "ok");
    expect(h.sent.length).toBe(2);
  });

  test("组件独立：tts 窗口压制不影响 judge 通道", () => {
    const h = harness();
    h.stream.reportStewardHealth("tts", "degraded", "411");
    h.stream.reportStewardHealth("judge", "degraded", "451");
    expect(h.sent.length).toBe(2);
  });
});

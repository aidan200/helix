import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ConnectionWelcomeEvent, type ConnectionWelcomePayload, type DaemonFreshnessDto } from "../../src/index";

/**
 * daemon 新鲜度自检（stale-indicator 批，additive 微批）：connection.welcome
 * payload 新增可选字段 daemonFreshness { startedAt; stale }——握手时 daemon
 * 源码 mtime 晚于进程启动则 stale=true（前端连接状态区琥珀 chip「建议重启」）。
 * shape 契约：additive——缺省字段合法（旧 daemon / 打包态不带）；携带时
 * startedAt 为 epoch ms、stale 为布尔判别。
 */

describe("welcome daemonFreshness（stale-indicator 批，additive）", () => {
  test("字段形状：DaemonFreshnessDto = { startedAt: number; stale: boolean }（类型位钉死）", () => {
    const fresh: DaemonFreshnessDto = { startedAt: 1_760_000_000_000, stale: false };
    const stale: DaemonFreshnessDto = { startedAt: 1_760_000_000_000, stale: true };
    expect(fresh.startedAt).toBe(1_760_000_000_000);
    expect(fresh.stale).toBe(false);
    expect(stale.stale).toBe(true);
  });

  test("welcome 携带 daemonFreshness：帧合法（notification 通道 + SYSTEM_SESSION_ID 同构）", () => {
    const frame: ConnectionWelcomeEvent = {
      v: PROTOCOL_VERSION,
      sessionId: "__system__",
      channel: "notification",
      type: "connection.welcome",
      payload: {
        sessionId: "s1",
        model: "anthropic/claude-sonnet-4-5",
        agentState: "idle",
        daemonFreshness: { startedAt: 1_760_000_000_000, stale: true },
      },
    };
    expect(frame.payload.daemonFreshness?.stale).toBe(true);
    expect(frame.payload.daemonFreshness?.startedAt).toBe(1_760_000_000_000);
  });

  test("缺省合法（additive）：旧 daemon / 打包态不带 daemonFreshness 的 welcome 不变形", () => {
    const legacy: ConnectionWelcomePayload = {
      sessionId: "s1",
      model: "m/x",
      agentState: "idle",
    };
    expect(legacy.daemonFreshness).toBeUndefined();
    const packaged: ConnectionWelcomePayload = {
      sessionId: "s1",
      model: "m/x",
      agentState: "idle",
      daemonFreshness: { startedAt: 1_760_000_000_000, stale: false },
    };
    expect(packaged.daemonFreshness?.stale).toBe(false);
  });
});

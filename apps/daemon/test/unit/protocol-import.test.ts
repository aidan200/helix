import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  type ChatSendCommand,
  type EventEnvelope,
} from "@helix/protocol";

/**
 * TP-CL2-2 基线（A 简版）：daemon 侧以 workspace 包名 import @helix/protocol。
 * 验证 monorepo 依赖解析（bun workspace 链接 + tsc bundler resolution）就位；
 * ws-server adapter 正式接线在 T1.6（CL-6），此处仅守护「两端同源」的解析基线
 * （AD-8 / AG-13：仓库内不得存在平行手写协议类型）。
 */
describe("@helix/protocol 工作区解析（TP-CL2-2 基线）", () => {
  test("daemon 侧 import 同一协议包并使用其类型", () => {
    expect(PROTOCOL_VERSION).toBe(0);

    const cmd: ChatSendCommand = { v: 0, type: "chat.send", payload: { text: "ping" } };
    expect(cmd.type).toBe("chat.send");
    expect(cmd.payload.text).toBe("ping");

    const evt: EventEnvelope = {
      v: 0,
      type: "agent.state.changed",
      payload: { state: "idle" },
    };
    expect(evt.type).toBe("agent.state.changed");
  });
});

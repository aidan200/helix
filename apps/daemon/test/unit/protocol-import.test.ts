import { describe, expect, test } from "bun:test";
import {
  MAIN_INSTANCE_ID as PROTOCOL_MAIN_INSTANCE_ID,
  PROTOCOL_VERSION,
  type ChatSendCommand,
  type EventEnvelope,
} from "@helix/protocol";
import { MAIN_INSTANCE_ID as DOMAIN_MAIN_INSTANCE_ID } from "../../src/domain/agent/AgentInstance";

/**
 * TP-CL2-2 基线（A 简版）：daemon 侧以 workspace 包名 import @helix/protocol。
 * 验证 monorepo 依赖解析（bun workspace 链接 + tsc bundler resolution）就位；
 * ws-server adapter 正式接线在 T1.6（CL-6），此处仅守护「两端同源」的解析基线
 * （AD-8 / AG-13：仓库内不得存在平行手写协议类型）。
 */
describe("@helix/protocol 工作区解析（TP-CL2-2 基线）", () => {
  test("daemon 侧 import 同一协议包并使用其类型", () => {
    expect(PROTOCOL_VERSION).toBe("0.9"); // v0.9 升位（批次标记；契约 = PROTOCOL.md §17.9）

    const cmd: ChatSendCommand = { v: PROTOCOL_VERSION, type: "chat.send", payload: { text: "ping" } };
    expect(cmd.type).toBe("chat.send");
    expect(cmd.payload.text).toBe("ping");

    const evt: EventEnvelope = {
      v: 0, // v0/v0.1 历史帧兼容读（FrameVersion = 0 | "0.9"）
      type: "agent.state.changed",
      payload: { state: "idle" },
    };
    expect(evt.type).toBe("agent.state.changed");
  });

  test("MAIN_INSTANCE_ID 双源相等守护（OI 收口 F-2⑬；AG-02 强制 domain 保留本地定义）", () => {
    // 协议导出（线上权威）↔ domain 内部值语义锚点：两定义漂移即红
    expect(PROTOCOL_MAIN_INSTANCE_ID).toBe("main");
    expect(DOMAIN_MAIN_INSTANCE_ID).toBe("main");
    expect(PROTOCOL_MAIN_INSTANCE_ID).toBe(DOMAIN_MAIN_INSTANCE_ID);
  });
});

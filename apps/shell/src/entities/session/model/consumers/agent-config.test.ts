/**
 * agent-config 拓扑级消费者占位单测（M6 T3；TR-AD-21 先例：dispatcher 先
 * no-op 占位后接真消费——T4 智能体页接真消费）。
 *
 * 机械判据：
 * ① 注册面恰为 [agent.config.changed]（agent.config 族广播；两结果帧走
 *    registry no-op 占位——trace.query.result 先例，T4 页面查询链接真消费）；
 * ② 占位语义 = 拓扑原引用返回（帧到达不炸不写；dispatcher/frame.ts 前置
 *    门路由参照 model 族）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import { AGENT_CONFIG_EVENT_TYPES, applyAgentConfigEvent, isAgentConfigEventType } from "./agent-config";
import { createInitialTopologyState } from "../state";

describe("agent-config 拓扑级消费者（M6 T3 占位）", () => {
  it("① 注册面恰为 [agent.config.changed]；判定函数窄化正确", () => {
    expect([...AGENT_CONFIG_EVENT_TYPES]).toEqual(["agent.config.changed"]);
    expect(isAgentConfigEventType("agent.config.changed")).toBe(true);
    // 两结果帧不入拓扑级前置门（registry no-op 占位，dispatcher/index.ts）
    expect(isAgentConfigEventType("agent.config.list.result")).toBe(false);
    expect(isAgentConfigEventType("agent.config.set_enabled.result")).toBe(false);
    expect(isAgentConfigEventType("model.changed")).toBe(false);
    expect(isAgentConfigEventType("session.list_changed")).toBe(false);
  });

  it("② applyAgentConfigEvent：占位 no-op——拓扑原引用返回（含 model clear name=null 形态不炸）", () => {
    const topo = createInitialTopologyState();
    const frame = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "agent",
      type: "agent.config.changed",
      payload: { profileKind: "main-session", resourceType: "model", name: null, enabled: false },
    } as EventEnvelope;
    expect(applyAgentConfigEvent(topo, frame)).toBe(topo);
  });
});

/**
 * agent-config 拓扑级消费者单测（M6 T4 真消费；T3 占位阶段的升级）。
 *
 * 机械判据：
 * ① 注册面恰为 agent.config 族三 type（changed 广播 + 两点对点结果帧）——
 *    changed 接真消费（失效重拉信号），两结果帧拓扑级直通（真消费归页面
 *    查询链，trace.query.result 先例；registry no-op 已注销，T3 遗留②收口）；
 * ② changed → agentConfig.revision 递增（每次广播 +1；智能体页失效重拉面）；
 * ③ 两结果帧 → 拓扑原引用返回（不炸不写；点对点回执不落拓扑态）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import { AGENT_CONFIG_EVENT_TYPES, applyAgentConfigEvent, isAgentConfigEventType } from "./agent-config";
import { createInitialTopologyState } from "../state";

function frameOf(type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "agent",
    type,
    payload,
  } as EventEnvelope;
}

describe("agent-config 拓扑级消费者（M6 T4 真消费）", () => {
  it("① 注册面恰为 agent.config 族三 type；判定函数窄化正确", () => {
    expect([...AGENT_CONFIG_EVENT_TYPES]).toEqual([
      "agent.config.changed",
      "agent.config.list.result",
      "agent.config.set_enabled.result",
    ]);
    for (const type of AGENT_CONFIG_EVENT_TYPES) {
      expect(isAgentConfigEventType(type)).toBe(true);
    }
    expect(isAgentConfigEventType("model.changed")).toBe(false);
    expect(isAgentConfigEventType("session.list_changed")).toBe(false);
    expect(isAgentConfigEventType("agent.config")).toBe(false);
  });

  it("② changed → agentConfig.revision 递增（失效重拉信号；连续两次广播 +2）", () => {
    const topo = createInitialTopologyState();
    expect(topo.agentConfig.revision).toBe(0);
    const once = applyAgentConfigEvent(
      topo,
      frameOf("agent.config.changed", {
        profileKind: "main-session",
        resourceType: "tool",
        name: "grep",
        enabled: false,
      }),
    );
    expect(once).not.toBe(topo);
    expect(once.agentConfig.revision).toBe(1);
    expect(once.active).toBe(topo.active); // 只动配置失效面，活跃 store 原引用
    const twice = applyAgentConfigEvent(
      once,
      frameOf("agent.config.changed", {
        profileKind: "subagent-worker",
        resourceType: "model",
        name: null,
        enabled: false,
      }),
    );
    expect(twice.agentConfig.revision).toBe(2);
  });

  it("③ 两结果帧 → 拓扑原引用返回（点对点回执不落拓扑态；页面查询链消费）", () => {
    const topo = createInitialTopologyState();
    const listFrame = frameOf("agent.config.list.result", {
      profiles: [
        {
          profileKind: "main-session",
          tools: [{ name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
          skills: [],
          diagnostics: [],
          model: null,
        },
      ],
    });
    expect(applyAgentConfigEvent(topo, listFrame)).toBe(topo);
    expect(applyAgentConfigEvent(topo, frameOf("agent.config.set_enabled.result", { status: "applied" }))).toBe(topo);
    expect(
      applyAgentConfigEvent(topo, frameOf("agent.config.set_enabled.result", { status: "skipped", reason: "unknown-name" })),
    ).toBe(topo);
  });
});

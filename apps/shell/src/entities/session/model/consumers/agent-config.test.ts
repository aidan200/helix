/**
 * agent-config 拓扑级消费者单测（M6 T4 真消费；T3 占位阶段的升级；P1 T4
 * 槽位轻量读面真消费）。
 *
 * 机械判据：
 * ① 注册面恰为 agent.config 族五 type（changed 广播 + 四点对点结果帧，
 *    含 base prompt 批 agent.base_prompt.get.result + skill-content 批
 *    agent.skill_content.get.result）；
 * ② changed → agentConfig.revision 递增（每次广播 +1；智能体页失效重拉面）；
 * ③ set_enabled.result → 拓扑原引用返回（点对点回执归页面查询链）；
 * ④ list.result → 槽位轻量读面真消费（P1 T4）：profiles[].model/
 *    thinkingLevel 提升为 topology 级（草稿徽标链/刻度基准第二级回退）；
 * ⑤ selectModeSlot：mode → profileKind 槽位解析（未知 mode 回落 default；
 *    slots 未拉取/未列 kind → null）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MODE_ID, PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import { AGENT_CONFIG_EVENT_TYPES, applyAgentConfigEvent, isAgentConfigEventType, selectModeSlot } from "./agent-config";
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
  it("① 注册面恰为 agent.config 族五 type；判定函数窄化正确", () => {
    expect([...AGENT_CONFIG_EVENT_TYPES]).toEqual([
      "agent.config.changed",
      "agent.config.list.result",
      "agent.config.set_enabled.result",
      "agent.base_prompt.get.result",
      "agent.skill_content.get.result",
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

  it("③ set_enabled.result → 拓扑原引用返回（点对点回执不落拓扑态；页面查询链消费）", () => {
    const topo = createInitialTopologyState();
    expect(applyAgentConfigEvent(topo, frameOf("agent.config.set_enabled.result", { status: "applied" }))).toBe(topo);
    expect(
      applyAgentConfigEvent(topo, frameOf("agent.config.set_enabled.result", { status: "skipped", reason: "unknown-name" })),
    ).toBe(topo);
  });

  it("④ list.result → 槽位轻量读面真消费（P1 T4：profiles 提升为 topology 级 slots）", () => {
    const topo = createInitialTopologyState();
    expect(topo.agentConfig.slots).toBeNull(); // 初始未拉取
    const next = applyAgentConfigEvent(
      topo,
      frameOf("agent.config.list.result", {
        profiles: [
          {
            profileKind: "main-session",
            tools: [],
            skills: [],
            diagnostics: [],
            model: "anthropic/claude-sonnet-4-5",
            thinkingLevel: "high",
          },
          {
            profileKind: "subagent-worker",
            tools: [],
            skills: [],
            diagnostics: [],
            model: null,
            thinkingLevel: null,
          },
        ],
      }),
    );
    expect(next).not.toBe(topo);
    expect(next.active).toBe(topo.active); // 只动拓扑配置面，活跃 store 原引用
    expect(next.agentConfig.revision).toBe(0); // 结果帧不动 revision
    expect(next.agentConfig.slots).toEqual({
      "main-session": { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
      "subagent-worker": { model: null, thinking: null },
    });
    // 全量覆盖语义：再次到达整体替换（旧值不残留）
    const again = applyAgentConfigEvent(
      next,
      frameOf("agent.config.list.result", {
        profiles: [
          {
            profileKind: "main-session",
            tools: [],
            skills: [],
            diagnostics: [],
            model: "openai/gpt-5",
            thinkingLevel: null,
          },
        ],
      }),
    );
    expect(again.agentConfig.slots).toEqual({
      "main-session": { model: "openai/gpt-5", thinking: null },
    });
  });

  it("⑤ selectModeSlot：mode → profileKind 槽位解析（P1 T4 草稿回退链第二级）", () => {
    const topo = applyAgentConfigEvent(
      createInitialTopologyState(),
      frameOf("agent.config.list.result", {
        profiles: [
          {
            profileKind: "main-session",
            tools: [],
            skills: [],
            diagnostics: [],
            model: "anthropic/claude-sonnet-4-5",
            thinkingLevel: "high",
          },
        ],
      }),
    );
    // default 模式 → main-session 槽位（MODES 数据驱动）
    expect(selectModeSlot(topo, "default")).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
    });
    // 未知 mode（wire 防御）→ 回落 default 模式槽位
    expect(selectModeSlot(topo, "unknown-mode")).toEqual(
      selectModeSlot(topo, DEFAULT_MODE_ID),
    );
    // slots 未拉取 → null
    expect(selectModeSlot(createInitialTopologyState(), "default")).toBeNull();
    // slots 已拉取但该 profileKind 未列（单 kind 请求）→ null
    const partial = applyAgentConfigEvent(
      createInitialTopologyState(),
      frameOf("agent.config.list.result", {
        profiles: [
          {
            profileKind: "subagent-worker",
            tools: [],
            skills: [],
            diagnostics: [],
            model: "openai/gpt-5",
            thinkingLevel: null,
          },
        ],
      }),
    );
    expect(selectModeSlot(partial, "default")).toBeNull();
  });
});

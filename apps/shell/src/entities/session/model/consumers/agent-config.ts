/**
 * agent-config 拓扑级消费者（M6 T4 真消费；契约 v0.6 agent.config 族）。
 *
 * 拓扑级消费（操作 TopologyState，与 directory/model-config 同构）：配置是
 * daemon 级全局数据（信封 sessionId = SYSTEM_SESSION_ID，订阅无关全连接），
 * 不入活跃会话 store 注册表（dispatcher/index.ts），经 dispatcher/frame.ts
 * 前置门路由（isAgentConfigEventType，参照 model 族两层拓扑）。
 *
 * 三 type 分工：
 * - agent.config.changed：真消费——agentConfig.revision +1（失效重拉信号；
 *   智能体页 effect 观测 revision 变更重发 agent.config.list，多页一致；
 *   provider（SessionContext）同观测重发，拓扑 slots 失效重拉）；
 * - agent.config.list.result：P1 T4 起真消费——profiles[].model/thinkingLevel
 *   提升为 topology 级 slots 槽位轻量读面（草稿徽标链/刻度基准第二级回退，
 *   selectModeSlot 解析）。数据源复用本帧（AgentPage 页面链同帧各取所需），
 *   **不新建第三条平行配置读面**；
 * - agent.config.set_enabled.result / agent.base_prompt.get.result：点对点
 *   回执，真消费归页面查询链（SessionContext 转发层 → 页面私有 reducer，
 *   trace.query.result 先例）——拓扑级路由仅作前置门，拓扑态原引用返回。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import { DEFAULT_MODE_ID, MODES } from "@helix/protocol";
import type { TopologyState } from "../state";

/** 本块承接的帧事件 type（拓扑级注册面；dispatcher/frame.ts 消费）。 */
export const AGENT_CONFIG_EVENT_TYPES = [
  "agent.config.changed",
  "agent.config.list.result",
  "agent.config.set_enabled.result",
  "agent.base_prompt.get.result",
] as const;

/** 是否 agent.config 配置族事件（dispatcher 路由前置判定）。 */
export function isAgentConfigEventType(type: string): type is (typeof AGENT_CONFIG_EVENT_TYPES)[number] {
  return (AGENT_CONFIG_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * 帧消费（dispatcher/frame.ts 前置路由）。changed → revision 递增（失效
 * 重拉信号）；list.result → slots 全量覆盖（P1 T4 槽位读面）；set_enabled
 * 结果帧 → 拓扑原引用（点对点回执归页面查询链，见文件头注）。
 */
export function applyAgentConfigEvent(topo: TopologyState, frame: EventEnvelope): TopologyState {
  if (frame.type === "agent.config.changed") {
    return { ...topo, agentConfig: { ...topo.agentConfig, revision: topo.agentConfig.revision + 1 } };
  }
  if (frame.type === "agent.config.list.result") {
    // P1 T4 槽位轻量读面：单 kind 块序（main-session 在前）取 model/thinking
    // 槽位现值；全量覆盖（再次到达整体替换，旧值不残留）
    const slots: NonNullable<TopologyState["agentConfig"]["slots"]> = {};
    for (const block of frame.payload.profiles) {
      slots[block.profileKind] = { model: block.model, thinking: block.thinkingLevel };
    }
    return { ...topo, agentConfig: { ...topo.agentConfig, slots } };
  }
  return topo; // set_enabled.result：直通（页面查询链消费）
}

/**
 * 模式 → 槽位解析（P1 T4 草稿回退链第二级）：mode 经 MODES 注册表解析
 * profileKind，取该槽位现值；未知 mode（wire 面防御，daemon fallback 同构）
 * 回落 default 模式槽位；slots 未拉取 / 该 kind 未列 → null（回退链继续
 * 向下至全局默认）。MODES 数据驱动（P2 增 staged/orchestrated 零改动）。
 */
export function selectModeSlot(topo: TopologyState, mode: string): { model: string | null; thinking: string | null } | null {
  const spec = MODES.find((m) => m.id === mode) ?? MODES.find((m) => m.id === DEFAULT_MODE_ID);
  if (spec === undefined) return null;
  return topo.agentConfig.slots?.[spec.profileKind] ?? null;
}

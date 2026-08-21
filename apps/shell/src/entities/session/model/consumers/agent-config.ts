/**
 * agent-config 拓扑级消费者（M6 T4 真消费；契约 v0.6 agent.config 族）。
 *
 * 拓扑级消费（操作 TopologyState，与 directory/model-config 同构）：配置是
 * daemon 级全局数据（信封 sessionId = SYSTEM_SESSION_ID，订阅无关全连接），
 * 不入活跃会话 store 注册表（dispatcher/index.ts），经 dispatcher/frame.ts
 * 前置门路由（isAgentConfigEventType，参照 model 族两层拓扑）。
 *
 * 三 type 分工（T3 遗留②收口：registry no-op 占位 → 拓扑级直通）：
 * - agent.config.changed：真消费——agentConfig.revision +1（失效重拉信号；
 *   智能体页 effect 观测 revision 变更重发 agent.config.list，多页一致）；
 * - agent.config.list.result / set_enabled.result：点对点回执，真消费归
 *   页面查询链（SessionContext 转发层 → 页面私有 reducer，trace.query.result
 *   先例）——拓扑级路由仅作前置门（不落入活跃会话 store 注册表），拓扑态
 *   原引用返回。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { TopologyState } from "../state";

/** 本块承接的帧事件 type（拓扑级注册面；dispatcher/frame.ts 消费）。 */
export const AGENT_CONFIG_EVENT_TYPES = [
  "agent.config.changed",
  "agent.config.list.result",
  "agent.config.set_enabled.result",
] as const;

/** 是否 agent.config 配置族事件（dispatcher 路由前置判定）。 */
export function isAgentConfigEventType(type: string): type is (typeof AGENT_CONFIG_EVENT_TYPES)[number] {
  return (AGENT_CONFIG_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * 帧消费（dispatcher/frame.ts 前置路由）。changed → revision 递增（失效
 * 重拉信号）；两结果帧 → 拓扑原引用（点对点回执归页面查询链，见文件头注）。
 */
export function applyAgentConfigEvent(topo: TopologyState, frame: EventEnvelope): TopologyState {
  if (frame.type === "agent.config.changed") {
    return { ...topo, agentConfig: { revision: topo.agentConfig.revision + 1 } };
  }
  return topo; // list.result / set_enabled.result：直通（页面查询链消费）
}

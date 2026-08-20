/**
 * agent-config 拓扑级消费者（M6 T3；契约 v0.6 agent.config.changed）。
 *
 * **占位阶段**（TR-AD-21 先例：dispatcher 先 no-op 占位后接真消费）：帧到达
 * 保持拓扑原引用（不炸不写）；T4 智能体页落地时在此接真消费（kind 维配置
 * 面状态 + 失效重拉）。
 *
 * 拓扑级消费（操作 TopologyState，与 directory/model-config 同构）：配置是
 * daemon 级全局数据（信封 sessionId = SYSTEM_SESSION_ID，订阅无关全连接），
 * 不入活跃会话 store 注册表（dispatcher/index.ts），经 dispatcher/frame.ts
 * 前置门路由（isAgentConfigEventType，参照 model 族两层拓扑）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { TopologyState } from "../state";

/** 本块承接的帧事件 type（拓扑级注册面；dispatcher/frame.ts 消费）。 */
export const AGENT_CONFIG_EVENT_TYPES = ["agent.config.changed"] as const;

/** 是否 agent.config 配置族事件（dispatcher 路由前置判定）。 */
export function isAgentConfigEventType(type: string): type is (typeof AGENT_CONFIG_EVENT_TYPES)[number] {
  return (AGENT_CONFIG_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * 帧消费（dispatcher/frame.ts 前置路由）。M6 T3 占位 = no-op（拓扑原引用）；
 * T4 真消费面：agent.config.changed → 智能体页配置态失效/重拉。
 */
export function applyAgentConfigEvent(topo: TopologyState, _frame: EventEnvelope): TopologyState {
  return topo;
}

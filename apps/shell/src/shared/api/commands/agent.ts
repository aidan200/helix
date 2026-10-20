/**
 * shared/api/commands/agent —— agent 域（实例 kill/subscribe/unsubscribe + 资源配置/提示词/技能读面 + 管家档案读面）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  AgentBasePromptGetCommand,
  AgentBasePromptGetPayload,
  AgentConfigListCommand,
  AgentKillCommand,
  AgentSubscribeCommand,
  AgentUnsubscribeCommand,
  AgentConfigSetEnabledCommand,
  AgentConfigSetEnabledPayload,
  AgentSkillContentGetCommand,
  AgentSkillContentGetPayload,
  AgentSkillCreateCommand,
  AgentSkillCreatePayload,
  AgentStewardProfileGetCommand,
} from "@helix/protocol";

// ── agent 实例三命令（契约 v0.1 §4；抽屉 kill 两步确认 / 订阅全流）────
// 全部全局命令（信封 sessionId 省略，payload.agentId 寻址）。

/** agent.kill：用户终止实例（抽屉两步确认后发送；回执 agent.killed 事件）。 */
export function agentKillCommand(agentId: string): AgentKillCommand {
  return { v: PROTOCOL_VERSION, type: "agent.kill", payload: { agentId } };
}

/** agent.subscribe：订阅实例事件流（抽屉打开；v0.1 通路语义，契约 §8-1）。 */
export function agentSubscribeCommand(agentId: string): AgentSubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "agent.subscribe", payload: { agentId } };
}

/** agent.unsubscribe：退订实例事件流（抽屉关闭/换订）。 */
export function agentUnsubscribeCommand(agentId: string): AgentUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "agent.unsubscribe", payload: { agentId } };
}

// ── v0.6 agent.config 命令族（M6 T4 智能体页）────────────

/** agent.config.list：资源配置读面（全局命令无信封 sessionId；缺省 =
 *  全部 kind 双块；结果 = agent.config.list.result 点对点回执）。 */
export function agentConfigListCommand(): AgentConfigListCommand {
  return { v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} };
}

/** agent.config.set_enabled：资源启停/槽位写面（全局命令；回执 =
 *  set_enabled.result 点对点 + applied 时 agent.config.changed 全局广播）。 */
export function agentConfigSetEnabledCommand(payload: AgentConfigSetEnabledPayload): AgentConfigSetEnabledCommand {
  return { v: PROTOCOL_VERSION, type: "agent.config.set_enabled", payload };
}

/** agent.base_prompt.get：base 段系统提示词懒查询读面（base prompt 批；
 *  全局命令；回执 = agent.base_prompt.get.result 点对点）。 */
export function agentBasePromptGetCommand(payload: AgentBasePromptGetPayload): AgentBasePromptGetCommand {
  return { v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload };
}

/** agent.skill_content.get：skill 正文（SKILL.md 全文）懒查询读面
 *（skill-content 批；全局命令；回执 = agent.skill_content.get.result 点对点）。 */
export function agentSkillContentGetCommand(payload: AgentSkillContentGetPayload): AgentSkillContentGetCommand {
  return { v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload };
}

/** agent.skill.create：用户级技能创建写面（skills 添加批；全局命令；
 *  入参 = SKILL.md 全文统一形态；回执 = agent.skill.create.result 点对点）。 */
export function agentSkillCreateCommand(payload: AgentSkillCreatePayload): AgentSkillCreateCommand {
  return { v: PROTOCOL_VERSION, type: "agent.skill.create", payload };
}

/** agent.steward_profile.get：管家只读档案读面（管家公民权批；全局命令；
 *  零载荷；回执 = agent.steward_profile.get.result 点对点——prompt 全文/
 *  工具清单/模型槽位/kindLabel）。 */
export function agentStewardProfileGetCommand(): AgentStewardProfileGetCommand {
  return { v: PROTOCOL_VERSION, type: "agent.steward_profile.get", payload: {} };
}

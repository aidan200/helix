import type { AgentProfile } from "../AgentProfile";
import { SubAgentProfile, SUBAGENT_SYSTEM_PROMPT } from "./SubAgentProfile";
import { loadPrompt } from "../prompts";

/**
 * SubAgentKgWriterProfile —— 图谱产出型批次 profile（D8 W-R6，kg-driven-dev-loop
 * 设计 2026-08-30 裁决：kg 写面收权 + 图谱任务豁免）。
 *
 * 由 SubAgentProfile 派生（零复制）：工具集 = 通用 worker + kg-update
 * （worker 面已摘 kg-update——W-R6 硬层；本 profile 是唯一豁免出口），
 * base prompt = 通用版 + 一句图谱产出型纪律（后缀覆盖 worker 版
 * 「supersede/createNode 走 closure findings 申报」的改后纪律——图谱
 * 产出型任务的 kg 变更直接落库，不走 findings 中转）。
 *
 * 消费链：TaskOrchestratorService 按任务类型分流 profileKind
 * （kg-bootstrap / kg-review → 本 kind，W-R5 主树执行；其余 → subagent-worker）
 * → SchedulerService.spawn 登记 AgentInstance.profileKind → 组合根组装快照
 * 按本 kind 派发（生效集 = worker 生效集 + SUBAGENT_KG_WRITER_EXTRA_TOOLS，
 * buildSessionStack 单点拼装——增量常量导出即为此单源）。
 *
 * model/thinking 槽位与 worker 同链（subagent-worker kind 槽位）——派生面
 * 零分叉；单轮收敛（single-shot）与 hooks 同 SubAgentProfile。
 */

/** kg-writer 相对通用 worker 的增量工具（worker 摘 kg-update 后的豁免面；组装快照派生单源）。 */
export const SUBAGENT_KG_WRITER_EXTRA_TOOLS = ["kg-update"] as const;

/** kg-writer base prompt 增量句（加在通用 worker 版之后——特定纪律后置覆盖通用纪律；正文事实源 = resources/prompts/roles/subagent-kg-writer.md）。 */
export const SUBAGENT_KG_WRITER_PROMPT_SUFFIX = loadPrompt("roles/subagent-kg-writer.md");

export const SubAgentKgWriterProfile: AgentProfile = {
  kind: "subagent-kg-writer",
  systemPrompt: SUBAGENT_SYSTEM_PROMPT + "\n\n" + SUBAGENT_KG_WRITER_PROMPT_SUFFIX,
  tools: [...SubAgentProfile.tools, ...SUBAGENT_KG_WRITER_EXTRA_TOOLS],
  lifecycle: SubAgentProfile.lifecycle,
  hooks: SubAgentProfile.hooks,
  // AD-3 派生面零分叉：与 worker 同走 subagent-worker kind 槽位链（不另设槽位）
  model: SubAgentProfile.model,
};

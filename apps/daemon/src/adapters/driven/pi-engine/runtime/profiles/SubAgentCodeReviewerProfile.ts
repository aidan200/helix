import type { AgentProfile } from "../AgentProfile";
import { SubAgentProfile, SUBAGENT_SYSTEM_PROMPT } from "./SubAgentProfile";
import { loadPrompt } from "../prompts";

/**
 * SubAgentCodeReviewerProfile —— 代码评审批次专用 profile（code-review
 * 任务设计 D5，2026-08 评审定稿：机械解耦，非 SOP 软约束）。
 *
 * 由 SubAgentProfile 派生（零复制，SubAgentKgWriterProfile 同模板）：
 * 工具集 = 通用 worker **摘 write/edit**（评审批次的代码写面机械关闭），
 * 保留 bash（报告/findings 旁路文件 + linter 等评审辅助）与只读面
 * （kg/codegraph/plan 三件套）；base prompt = 通用版 + 评审纪律后缀
 * （只读评审/证据纪律/findings kind=issue/报告经 bash 写
 * HELIX_REPORT_PATH）。
 *
 * 消费链：TaskOrchestratorService 按任务类型分流 profileKind
 * （code-review → 本 kind；kg-bootstrap/kg-review → subagent-kg-writer；
 * 其余 → subagent-worker）→ SchedulerService.spawn 登记
 * AgentInstance.profileKind → 组合根组装快照按本 kind 派发（生效集 =
 * worker 生效集 − SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS + prompt 后缀，
 * buildSessionStack 单点拼装——摘除常量导出即为此单源）。
 *
 * model/thinking 走本 kind 独立槽位（TR-42 两级链：kind 槽位 ?? 全局默认，
 * 不联动 worker）——评审模型可与执行模型不同配（专用 profile 附带收益）。
 * 单轮收敛（single-shot）与 hooks 同 SubAgentProfile。
 *
 * 诚实边界（D5）：保留 bash 意味着写代码的逃生舱仍在（bash 可跑 sed/tee）
 * ——摘 write/edit 关掉的是「顺手的直接改码路径」并给出独立身份/提示词/
 * 模型槽位，不是形式化只读证明；彻底只读需摘 bash，但那样报告/findings
 * 文件无处写、linter 跑不了，crippling 评审能力，不取。
 */

/** reviewer 相对通用 worker 的摘除工具（代码写面机械关闭；组装快照派生单源）。 */
export const SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS = ["write", "edit"] as const;

/** reviewer base prompt 增量句（加在通用 worker 版之后——特定纪律后置覆盖通用纪律；正文事实源 = resources/prompts/roles/subagent-code-reviewer.md）。 */
export const SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX = loadPrompt("roles/subagent-code-reviewer.md");

export const SubAgentCodeReviewerProfile: AgentProfile = {
  kind: "subagent-code-reviewer",
  systemPrompt: SUBAGENT_SYSTEM_PROMPT + "\n\n" + SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX,
  // 声明 = 通用 worker − SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS（纯声明纪律：
  // profiles/ 禁函数式派生——arch-guard AG-10 硬层；与 worker 声明面的
  // 同步奇偶由 profile 契约测试机械断言，漂移即红）
  tools: [
    "bash",
    "read",
    "grep",
    "web_search",
    "web_fetch",
    "browser",
    "kg",
    "codegraph",
    "plan_create",
    "plan_update",
    "plan_read",
  ],
  lifecycle: SubAgentProfile.lifecycle,
  hooks: SubAgentProfile.hooks,
  // TR-42：不声明静态槽位——本 kind 槽位 ?? 全局默认两级链（组合根 per-kind 解析）
  model: SubAgentProfile.model,
};

import type { AgentProfile } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";
import { REPORT_ASSEMBLY_GUIDE } from "../templates/guide";
import { loadPrompt } from "../prompts";

/**
 * SubAgent worker profile（architecture.md §4.4「实例化」）。
 *
 * 纯声明式配置（无行为方法，AD-3 同构）：单轮收敛（single-shot）+ steer
 * 转投接线 + 全工具集（照抄主会话工具名清单，不新增）。
 * 「单轮收敛」由 ChildMain 消费——驱动一次 run、解析 closure、exit；
 * runtime 侧不感知（AG-10 零 kind 分支）。
 *
 * **hooks 为构造器引用而非实例（T1）**：与主会话同坑同填——SteerHooks.bind
 * 绑定 agent 引用，共享实例即跨 runtime 覆盖泄漏；类引用保持纯声明，
 * 实例化在 AgentRuntime 装配点（每 runtime 新建）。
 *
 * model 槽位（AD-3 三级链第一级，TR-AD-24）：声明即最高优先级
 * （SubagentLauncher.resolveModelFor 解析单点，装配期 resolveModel 解析，
 * 失败 fail-fast 含 id）；未声明（undefined）→ 走第二级 spawn 会话快照 →
 * 第三级全局兜底。声明入口为代码层真实槽位；UI 管理归 skills 页下迭代。
 */
/**
 * SubAgent base prompt（prompts-as-resources）：正文唯一事实源 =
 * resources/prompts/{roles/subagent-worker.md + disciplines/*.md}，TS 零内联
 * 散文；**不列工具名清单**——清单唯一来源 = SystemPromptAssembler 组装产物
 * （spawn 时刻定格经 env 透传子进程）。
 *
 * T4.2（AD-18）：导出常量 = base + report 装配指引段（段库目录+三条硬约束
 * +装配示例引用，templates/guide 同源）——收口时 SubAgent 按段库组任务
 * 完成报告（report 装配端）。
 *
 * W3-G（kg-driven-dev-loop 设计 R11/R23）：disciplines/knowledge-core.md =
 * SOP 软层纪律本体（第一铁律/开工链路）；角色文件带 worker 面改后纪律
 * （findings 申报）/闭环纪律/提交纪律/收口协议——纪律句引用的 codegraph/kg
 * 工具名是行为指引非清单枚举（profile-slim 词边界检查对这两名单项放行）。
 *
 * D8 W-R6（kg 写面收权，2026-08-30 裁决）：tools 摘除 kg-update——通用
 * worker 不再持即时落账面，supersede/createNode 声明改经 closure findings
 * 申报、MainAgent 阶段检查点统一落账；图谱产出型任务（kg-bootstrap/
 * kg-review）经 SubAgentKgWriterProfile（=本 profile 工具集 + kg-update）
 * 豁免，编排层分流（TaskOrchestratorService.dispatchProfileKindOf）。
 */
const SUBAGENT_BASE_PROMPT = loadPrompt(
  "roles/subagent-worker.md",
  "disciplines/knowledge-core.md",
  "disciplines/engineering.md",
);

/** base + report 装配指引（AD-18：提示词携带段库+硬约束+装配示例引用）。 */
export const SUBAGENT_SYSTEM_PROMPT = SUBAGENT_BASE_PROMPT + "\n\n" + REPORT_ASSEMBLY_GUIDE;

export const SubAgentProfile: AgentProfile = {
  kind: "subagent-worker",
  systemPrompt: SUBAGENT_SYSTEM_PROMPT,
  tools: [
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "web_search",
    "web_fetch",
    "browser", // H-3：+browser（经 wire 转发通道接 daemon CDP 单例；装配经 CoreToolExecutor.resolveTools）
    "kg", // T3.3：只读查询面（search→get；ChildMain 本地栈装配）；D8 W-R6：无 kg-update（写面收权——豁免面在 SubAgentKgWriterProfile）
    "codegraph", // W1-B（R5/R7）：代码索引只读查询（ChildMain 本地栈装配）
    "plan_create", // T1.4（AD-6①）：实例工作台账——全量配给所有 SubAgent（chat/task 两域同构；不进 MainAgent）
    "plan_update",
    "plan_read",
  ],
  lifecycle: { mode: "single-shot" },
  hooks: [SteerHooks, MinimalHooks], // 构造器引用（T1：与主会话同坑同填——装配点实例化）
  // AD-3：真实声明槽位——声明即最高优先级；生产默认不设值（走会话快照/全局兜底；UI 管理归 skills 页下迭代）
  model: undefined,
};

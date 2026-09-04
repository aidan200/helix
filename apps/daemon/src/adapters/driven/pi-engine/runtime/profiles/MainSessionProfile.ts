import type { AgentProfile } from "../AgentProfile";
import { DEFAULT_COMPACTION } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";
import { BRIEF_ASSEMBLY_GUIDE } from "../templates/guide";
import { loadPrompt } from "../prompts";

/**
 * 主会话 profile（architecture.md §4.4「实例化」）。
 *
 * 纯声明式配置（无行为方法）：常驻多轮 + steer/abort 语义 + 最小钩子。
 * 「常驻」由生命周期策略声明，CLI/WS 驱动入口经 ChatService 反复
 * sendMessage 即多轮复用——runtime 侧不做任何轮次计数。
 *
 * **hooks 为构造器引用而非实例（T1）**：SteerHooks.bind 会把 agent 绑进
 * 钩子实例，模块级共享实例会让后建 runtime 覆盖先建 runtime 的
 * steer/abort 通道（跨会话串台，P0）——故此处只声明类引用（纯数据），
 * 实例化在 AgentRuntime 装配点（每 runtime 新建）。快照读面用类的
 * hookName（与实例 .name 等值）。
 *
 * 工具集：十八工具按名声明（编排六工具 + 静态联网两工具 +
 * 动态族单 browser 工具），装配在组合根
 * （CoreToolExecutor → resolveTools；bash/read/write/edit 为 pi 内置、grep 自写、
 * agent_spawn/agent_send/agent_status/agent_inspect/agent_park/agent_resume
 * 经 AgentOrchestrationPort 回调度器，
 * browser 经 BrowserPort 薄转投（零 CDP 知识），同一沙箱 cwd 与端口注入）。
 *
 * compaction：默认参数保留（实测值）；摘要执行受 provider
 * 约束（非流式 complete），daemon 侧容忍失败不崩会话，
 * 实际生效经集成验收。
 */
/**
 * 主会话 base prompt（prompts-as-resources）：正文唯一事实源 =
 * resources/prompts/{roles/main-session.md + disciplines/*.md}，TS 零内联
 * 散文；**不枚举工具清单**——可用工具清单唯一来源 = SystemPromptAssembler
 * 组装产物（工具段从 resolveTools 产物同源派生，消双源漂移事实 8）。
 * 角色文件保留「并行委派」行为策略措辞（T3-C 正向契约：结束回合 +
 * closure/进展报告自动注入 + 不轮询不抢跑 + 零增量 agent_inspect 核实）；
 * disciplines/knowledge-core.md = SOP 软层纪律本体（W3-G R11/R23），
 * disciplines/engineering.md = worktree/commit 全局纪律——纪律句引用的
 * codegraph/kg/kg-update 工具名是行为指引非清单枚举（profile-slim 词边界
 * 检查对这三名单项放行）。三条硬约束与 PLAN_HARD_CONSTRAINT_SEGMENT 不动
 * （R12：本批全是软层，不装新门禁）。
 */
const MAIN_SESSION_BASE_PROMPT = loadPrompt(
  "roles/main-session.md",
  "disciplines/knowledge-core.md",
  "disciplines/engineering.md",
);

/**
 * T4.2（AD-18）：导出常量 = base + brief 装配指引段（段库目录+三条硬约束
 * +装配示例引用，templates/guide 同源）——派发时 MainAgent 按段库组任务
 * brief（brief 装配端；kg 约束切片注入区见段库）。
 */
export const MAIN_SESSION_SYSTEM_PROMPT = MAIN_SESSION_BASE_PROMPT + "\n\n" + BRIEF_ASSEMBLY_GUIDE;

export const MainSessionProfile: AgentProfile = {
  kind: "main-session",
  systemPrompt: MAIN_SESSION_SYSTEM_PROMPT,
  tools: [
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "web_search",
    "web_fetch",
    "agent_spawn",
    "agent_send",
    "agent_status",
    "agent_inspect", // T3-B：死循环核实（编排四工具）
    // ⑤ 链 C 挂起/恢复（P1 裁决：专用工具仅 Main——挂起是调度器级机械
    // 动作不靠 LLM 措辞；SubAgent/Orchestrator/kg-writer 均不声明）
    "agent_park",
    "agent_resume",
    // 动态族（单 browser 工具 + action 参数；条件注册——CoreToolExecutor options.browser）
    "browser",
    // kg 双工具（T3.3，CL-4/CL-3）：只读查询面 + 即时落账面
    //（AD-14 协议行兑现在 edit 现场——findings 收口通道之外的第二通道）
    "kg",
    "kg-update",
    // codegraph（W1-B，R5/R7）：代码索引只读查询（改代码前 impact 查影响面）
    "codegraph",
    // task_create（T2.4，AD-7）：chat 第二创建入口（对话即确认）——仅
    // MainAgent 生效集（SubAgent 不能建任务，AD-2 创建按宿主）；与
    // /project 入口同一 createTask API
    "task_create",
    // task_report（D3）：chat 回流通用报告查询面（list/get 只读，全任务
    // 类型通用）——仅 MainAgent 生效集；报告全文不进回执，MainAgent 用
    // read 按路径按需读（token 经济）
    "task_report",
    // plan 三工具（main-session plan 批）：主会话工作台账（instanceId =
    // sessionId 作用域，台账落 helix.db work_item 表）——多步/多阶段任务
    // 开工前建台账、逐项推进；SubAgent 子进程同款声明（两域同构，AD-6①
    // 扩展到主会话）
    "plan_create",
    "plan_update",
    "plan_read",
  ], // 装配经 CoreToolExecutor.resolveTools（组合根）
  lifecycle: { mode: "persistent" },
  hooks: [SteerHooks, MinimalHooks], // 构造器引用（T1：实例化在 AgentRuntime 装配点，每 runtime 独立）
  compaction: DEFAULT_COMPACTION,
};

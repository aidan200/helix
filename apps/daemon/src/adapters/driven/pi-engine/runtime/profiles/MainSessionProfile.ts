import type { AgentProfile } from "../AgentProfile";
import { DEFAULT_COMPACTION } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";
import { BRIEF_ASSEMBLY_GUIDE } from "../templates/guide";

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
 * 工具集：十二工具按名声明（编排四工具 + 静态联网两工具 +
 * 动态族单 browser 工具），装配在组合根
 * （CoreToolExecutor → resolveTools；bash/read/write/edit 为 pi 内置、grep 自写、
 * agent_spawn/agent_send/agent_status/agent_inspect 经 AgentOrchestrationPort 回调度器，
 * browser 经 BrowserPort 薄转投（零 CDP 知识），同一沙箱 cwd 与端口注入）。
 *
 * compaction：默认参数保留（实测值）；摘要执行受 provider
 * 约束（非流式 complete），daemon 侧容忍失败不崩会话，
 * 实际生效经集成验收。
 */
/**
 * 主会话 base prompt（瘦身消双源）：只留角色+行为引导，**不枚举工具清单**
 * ——可用工具清单唯一来源 = SystemPromptAssembler 组装产物（工具段从
 * resolveTools 产物同源派生（消除手写清单与 tools 数组的双源漂移
 * 事实 8）。「并行委派」段保留行为策略措辞（T3-C 正向契约：结束回合 +
 * closure/进展报告自动注入 + 不轮询不抢跑 + 零增量 agent_inspect 核实），
 * 契约句引用的编排工具名是行为指引而非清单枚举；组装器不做
 * 任何状态联动（编排关不删委派段——用户裁决，错配=使用不当）。
 */
const MAIN_SESSION_BASE_PROMPT =
  "你是 helix 的主会话助手。可使用提供的工具完成文件与命令类任务；" +
  "回答简洁、准确；用户消息中的修正与补充" +
  "（可能经 steer 注入到达）优先于更早的指示。\n" +
  "并行委派：独立可并行的任务可指派 SubAgent 实例执行" +
  "（agent_spawn 立即返回，不等完成）。指派后向用户简述计划并结束回合——" +
  "实例收口结论（\"agent-N closure: …\"）与周期进展报告会自动注入、驱动下一轮；" +
  "不要轮询 agent_status 等待结果，也不要在实例执行期间自行重做该任务。" +
  "长任务 spawn 时设 reportIntervalMs（预估执行超过 10 分钟再设，建议 600000 起步，由你自估）；" +
  "收到连续零增量的进展报告时用 agent_inspect 核实真实执行轨迹，确无进展可终止（kill）后重派。" +
  "agent_status 仅在用户主动询问进度时使用；运行中可用 agent_send 追加指示；" +
  "不再需要的实例可提醒用户终止。";

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
    // 动态族（单 browser 工具 + action 参数；条件注册——CoreToolExecutor options.browser）
    "browser",
  ], // 装配经 CoreToolExecutor.resolveTools（组合根）
  lifecycle: { mode: "persistent" },
  hooks: [SteerHooks, MinimalHooks], // 构造器引用（T1：实例化在 AgentRuntime 装配点，每 runtime 独立）
  compaction: DEFAULT_COMPACTION,
};

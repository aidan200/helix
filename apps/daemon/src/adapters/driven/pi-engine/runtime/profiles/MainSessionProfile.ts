import type { AgentProfile } from "../AgentProfile";
import { DEFAULT_COMPACTION } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";

/**
 * 主会话 profile（architecture.md §4.4「实例化」）。
 *
 * 纯声明式配置（无行为方法）：常驻多轮 + steer/abort 语义 + 最小钩子。
 * 「常驻」由生命周期策略声明，CLI/WS 驱动入口经 ChatService 反复
 * sendMessage 即多轮复用——runtime 侧不做任何轮次计数。
 *
 * 工具集（T1.5，CL-5；T2.3 扩编排三工具；web-access T1 扩静态联网两工具、
 * T3r 扩动态族单 browser 工具）：十一工具按名声明，装配在组合根
 * （CoreToolExecutor → resolveTools；bash/read/write/edit 为 pi 内置、grep 自写、
 * agent_spawn/agent_send/agent_status 经 AgentOrchestrationPort 回调度器，
 * browser 经 BrowserPort 薄转投（零 CDP 知识），同一沙箱 cwd 与端口注入）。
 *
 * compaction：默认参数保留（spike §3 实测值）；摘要执行受 provider
 * 约束（非流式 complete，spike 坑 8），daemon 侧容忍失败不崩会话，
 * 实际生效验证后移 M2（GO 附条件）。
 */
/**
 * 主会话 base prompt（M6 T2 瘦身消双源）：只留角色+行为引导，**不列工具名**
 * ——可用工具清单唯一来源 = SystemPromptAssembler 组装产物（工具段从
 * resolveTools 产物同源派生；手写清单与 tools 数组双源漂移问题见 M6 §二
 * 事实 8）。「并行委派」段保留行为策略措辞但不列具体工具名；组装器不做
 * 任何状态联动（编排关不删委派段——用户裁决，错配=使用不当）。
 */
export const MAIN_SESSION_SYSTEM_PROMPT =
  "你是 helix 的主会话助手。可使用提供的工具完成文件与命令类任务；" +
  "回答简洁、准确；用户消息中的修正与补充" +
  "（可能经 steer 注入到达）优先于更早的指示。\n" +
  "并行委派：独立可并行的任务可指派 SubAgent 实例执行" +
  "（立即返回不等完成）；实例收口结论会以 \"agent-N closure: …\" 注入回来；" +
  "运行中可向实例追加指示、查询进度；不再需要的实例可提醒用户终止。";

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
    // T3r 动态族（单 browser 工具 + action 参数；条件注册——CoreToolExecutor options.browser）
    "browser",
  ], // 装配经 CoreToolExecutor.resolveTools（组合根）
  lifecycle: { mode: "persistent" },
  hooks: [new SteerHooks(), new MinimalHooks()],
  compaction: DEFAULT_COMPACTION,
};

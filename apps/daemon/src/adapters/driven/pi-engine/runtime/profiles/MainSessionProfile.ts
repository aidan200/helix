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
 * 工具集（T1.5，CL-5）：五工具按名声明，装配在组合根（CoreToolExecutor
 * → resolveTools；bash/read/write/edit 为 pi 内置、grep 自写，同沙箱 cwd）。
 *
 * compaction：默认参数保留（spike §3 实测值）；摘要执行受 provider
 * 约束（非流式 complete，spike 坑 8），daemon 侧容忍失败不崩会话，
 * 实际生效验证后移 M2（GO 附条件）。
 */
export const MAIN_SESSION_SYSTEM_PROMPT =
  "你是 helix 的主会话助手。可使用提供的工具（bash/read/write/edit/grep）" +
  "完成文件与命令类任务；回答简洁、准确；用户消息中的修正与补充" +
  "（可能经 steer 注入到达）优先于更早的指示。";

export const MainSessionProfile: AgentProfile = {
  kind: "main-session",
  systemPrompt: MAIN_SESSION_SYSTEM_PROMPT,
  tools: ["bash", "read", "write", "edit", "grep"], // 装配经 CoreToolExecutor.resolveTools（组合根）
  lifecycle: { mode: "persistent" },
  hooks: [new SteerHooks(), new MinimalHooks()],
  compaction: DEFAULT_COMPACTION,
};

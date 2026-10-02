import type { AgentProfile } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";

/**
 * Steward profile（管家批段B——profiles 家族新成员，同轨裁定）。
 *
 * 管家逻辑上也是一个 Agent，与其他 agent 共轨（MainSession/Orchestrator/
 * SubAgent 同族）：引擎 = 同一 PiAgentEngineAdapter，事件 = 同一
 * AgentEnginePort 面，暂停/打断/压缩 = 全仓共享钩子。本 profile 只声明
 * 管家的差异面：
 * - **persistent 生命周期 + 跨 run 工作记忆**：dialog KV 懒加载回填经
 *   initialMessages（构造期注入），与主会话恢复回填同一机制；
 * - **systemPrompt 运行期变异**：管家每 run 组装情景快照（感知 + 记忆召回
 *   段）——经 adapter setSystemPrompt 面直改（E-165 七段链同轨），profile
 *   声明值仅是装配期初值；
 * - **工具集 = 管家八工具**（StewardToolSpec 中立声明经 StewardToolBridge
 *   投影，resolveTools 标准选项供应——非 CoreToolExecutor 注册面）；
 * - **写类工具挂闸**：approvalGate 适配器选项（builder 装配），本 profile
 *   不感知（gate 是运行期策略非 profile 声明）。
 *
 * hooks：SteerHooks（steer/abort/followUp 接线——管家 abortInFlight 面）
 * + MinimalHooks（无操作基座）。压缩：管家压缩参数经 builder 选项注入
 * CompactionHook（profile.compaction 声明缺省关闭——管家压缩阈值
 * 12k/keepRecent 6 与主会话默认不同参，由 builder 显式携带）。
 */
export const StewardProfile: AgentProfile = {
  kind: "steward",
  systemPrompt: "", // 装配期初值空——首 run 前 setSystemPrompt 组装真值（动态快照面）
  tools: [], // 声明面空——管家工具经 resolveTools 供应（builder 选项），不走名解析
  lifecycle: { mode: "persistent" },
  hooks: [SteerHooks, MinimalHooks],
};

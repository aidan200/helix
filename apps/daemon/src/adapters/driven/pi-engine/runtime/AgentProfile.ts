import type { HookSet } from "./HookSet";

/**
 * AgentProfile —— 声明式 agent 规格（architecture.md §4.2 三层抽象的第一层）。
 *
 * 「编排模式 = 配置差异」（AD-15）：一个 profile 是纯声明式对象——
 * kind/系统提示/工具集/生命周期策略/hooks 装配，**无行为方法**；
 * AgentRuntime 对它只做装配消费，不按 kind 分支（AG-10）。
 * 新增编排形态 = 新 profile（+ 新 HookSet），runtime 零改动（AG-11）。
 */

/** 生命周期策略：常驻多轮（可反复 drive）vs 单轮收敛（驱动一次即收口）。 */
export type LifecycleMode = "persistent" | "single-shot";

/** compaction 声明（spike §3 实测默认参数保留；执行接线后移 M2，GO 附条件）。 */
export interface CompactionSettings {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** 声明式 agent 规格（纯数据 + hooks 装配，无行为方法）。 */
export interface AgentProfile {
  /** 规格标识（诊断/日志用；runtime 不解析其值）。 */
  readonly kind: string;
  /** 系统提示。 */
  readonly systemPrompt: string;
  /** 工具集（按名声明；经 ToolResolver 在装配期解析，T1.5 接真工具前恒空）。 */
  readonly tools: readonly string[];
  /** 生命周期策略。 */
  readonly lifecycle: { readonly mode: LifecycleMode };
  /** 钩子装配（装配即启用，§4.2）。 */
  readonly hooks: readonly HookSet[];
  /** compaction 参数声明（可选；缺省 DEFAULT_COMPACTION）。 */
  readonly compaction?: CompactionSettings;
}

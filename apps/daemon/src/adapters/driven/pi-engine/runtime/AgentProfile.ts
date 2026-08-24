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

/** compaction 声明（实测默认参数保留）。 */
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

/**
 * Hook 构造器声明（数据形态）。实例化在 AgentRuntime 装配点——每 runtime
 * 新实例（SteerHooks.bind 携带 agent 引用，跨 runtime 共享实例 = steer/abort
 * 串台，P0）。hookName 供快照读面（原实例 .name 的等值替代）。
 */
export interface HookCtor {
  new (): HookSet;
  readonly hookName: string;
}

/** 声明式 agent 规格（纯数据 + hooks 装配，无行为方法）。 */
export interface AgentProfile {
  /** 规格标识（诊断/日志用；runtime 不解析其值）。 */
  readonly kind: string;
  /** 系统提示。 */
  readonly systemPrompt: string;
  /** 工具集（按名声明；经 ToolResolver 在装配期解析）。 */
  readonly tools: readonly string[];
  /** 生命周期策略。 */
  readonly lifecycle: { readonly mode: LifecycleMode };
  /** 钩子装配（构造器引用声明，装配即启用且每 runtime 实例化，§4.2）。 */
  readonly hooks: readonly HookCtor[];
  /** compaction 参数声明（可选；undefined = 不装配 CompactionHook，无 fallback——
   *  实装见 AgentRuntime.compactionHooks（声明 enabled 才装配）；DEFAULT_COMPACTION
   *  仅为 MainSessionProfile 的声明值非缺省行为；SubAgentProfile 未声明即无压缩）。 */
  readonly compaction?: CompactionSettings;
  /**
   * 模型槽位（AD-6）："provider/model-id"；缺省 undefined = 继承
   * config 解析出的完整 Model 对象（同引用透传，非按 id 重建）。
   * 声明值在装配期经 registry 解析（失败 fail-fast 含 id）——解析单点
   * resolveModelSlot（model-provider）。
   */
  readonly model?: string;
  /**
   * thinking 档位槽位（thinking 批 AD-6 扩维，iter-20260823-6ps5 T1.3）：
   * pi-ai ThinkingLevel 字符串透传（helix 不维护第二份枚举，AD-2）；
   * 可选——留空（undefined）= 未配置 = 解析链后续档（全链未配置 → 默认
   * 关，AD-1）；纯声明数据（profile 无行为方法既有规则不变，不引入命令式分支）。
   */
  readonly thinkingLevel?: string;
}

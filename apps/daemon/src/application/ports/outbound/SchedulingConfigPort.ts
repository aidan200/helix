/**
 * SubAgent 调度预算配置出站端口（outbound）。实现体 = driven
 * sqlite-session/SchedulingConfigStore.ts（RuntimeConfigPort KV 底座上
 * scheduling_config 键的语义包装，写经 WriteQueue 单写通道 AG-06）。
 *
 * AD-2 同款分层语义：「经常变的状态不进 JSON」——2026-09-05 config.json
 * 瘦身裁决：maxConcurrent/maxQueued 从 config.json 启动参数迁 runtime_config
 * KV（运行期可调——设置页改，下一次预算判定即生效）；缺省回落
 * domain DEFAULT_SCHEDULING（未设置 = 内置默认 3/8）。
 *
 * stalledThresholdMs 不在本面（domain 内部阈值，非用户配置）。
 */

/** SubAgent 调度预算（KV 单键 JSON 序列化 {maxConcurrent, maxQueued}）。 */
export interface SchedulingBudget {
  /** 运行中 SubAgent 实例数上限（daemon 全局预算）。 */
  readonly maxConcurrent: number;
  /** FIFO 排队上限；达上限才报错回 LLM。 */
  readonly maxQueued: number;
}

export interface SchedulingConfigPort {
  /** 当前生效调度预算（存储值 ?? 内置默认；永不 undefined）。 */
  current(): SchedulingBudget;
  /** 写入调度预算（单写通道，落盘完成即返回）。 */
  set(budget: SchedulingBudget): Promise<void>;
}

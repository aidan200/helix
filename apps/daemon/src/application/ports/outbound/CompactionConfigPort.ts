/**
 * 压缩参数配置出站端口（outbound，TR-AD-2）。实现体 = driven
 * sqlite-session/CompactionConfigStore.ts（RuntimeConfigPort KV 底座上
 * compaction_config 键的语义包装，写经 WriteQueue 单写通道 AG-06）。
 *
 * AD-2 同款分层语义：「经常变的状态不进 JSON」——落 SQLite KV；缺省
 * 回落 AgentProfile.DEFAULT_COMPACTION（未设置 = 内置默认阈值）。
 */
export interface CompactionConfig {
  /** 预留余量（token 绝对值）：contextTokens > contextWindow - reserveTokens 触发压缩。 */
  readonly reserveTokens: number;
  /** 压缩后保留的最近 token 数（尾部保留窗）。 */
  readonly keepRecentTokens: number;
  /**
   * 经济水位（token 绝对值，可选）：上下文超过此值即提前触发压缩（与防溢出线取 min）。
   * undefined = 未配置 → tiers 自动推导（model.cost.tiers 最低 inputTokensAbove；
   * 无 tiers 模型回落纯防溢出线）；0 = 显式关闭经济线（回落纯防溢出线）。
   * 分层计价模型（如 gpt-6.1-sol >27.2万 input $2/M→$4/M）的账单失血点前置。
   */
  readonly economicCeilingTokens?: number;
}

export interface CompactionConfigPort {
  /** 当前生效压缩参数（存储值 ?? 内置默认；永不 undefined）。 */
  current(): CompactionConfig;
  /** 写入压缩参数（单写通道，落盘完成即返回）。 */
  set(config: CompactionConfig): Promise<void>;
}

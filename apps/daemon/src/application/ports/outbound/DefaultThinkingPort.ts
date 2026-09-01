/**
 * 全局默认推理强度存储出站端口（outbound，R7 全局兜底批）。实现体 =
 * driven sqlite-session/DefaultThinkingStore.ts（DefaultModelPort 同构：
 * RuntimeConfigPort KV 底座上 default_thinking 键的语义包装，写经
 * WriteQueue 单写通道 AG-06）。
 *
 * R7 语义：所有 agent 的 thinking 解析链统一两级（kind 槽位 ?? 本全局
 * 默认）；本键未配置 = null（各 agent 未配槽位 → 默认关，与 thinking 批
 * D 方案「无 medium 兜底」兼容——全局默认本身就是可显式配置的一级）。
 */
export interface DefaultThinkingPort {
  /** KV 原值（未设置 → null）。 */
  stored(): string | null;
  /** 写入全局默认推理强度（单写通道，落盘完成即返回）；null = 清除。 */
  set(level: string | null): Promise<void>;
}

/**
 * 账目 DTO（契约 protocol-v0.1.md §6.2；AD-4 token/usage 统计链路 / AD-9③ 账目不漏）。
 *
 * pi 侧 Usage 对象的防腐映射：七字段全量透出、cost 拍平为 number
 * （不透传嵌套对象）。daemon 侧由 T2.x/T3.x 从 message_end / CompactResult
 * 提取转换；本包只定义协议线格式。
 */

/**
 * 单次（或累计）用量。七字段全显式（pi Usage 防腐映射，cost 拍平为 number）。
 */
export interface UsageDto {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** 各项 token 合计（徽标值直接取此字段，前端不重算） */
  totalTokens: number;
  cost: number;
}

/**
 * 会话账目聚合（SessionSnapshotDto.usage 载体）。
 * 缺省 = 未携带（旧剧本兼容）；快照恢复徽标/popover 的唯一数据源。
 */
export interface SessionUsageDto {
  /** 徽标值 = 各实例行合计（数字自洽，原型 INSTANCES） */
  total: UsageDto;
  /** compaction 摘要小计（popover 独立行 + 归属说明） */
  compaction: UsageDto;
}

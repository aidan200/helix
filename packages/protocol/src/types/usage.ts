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
  /**
   * 上下文水位（instanceId → 最近一次调用的窗口占用 tokens；观察面 TR-59）。
   * 缺省 = 旧 daemon 未携带（shell 回落 compaction 兜底）；daemon 侧由事件
   * 重放/活投影维护，重启恢复精确到终态实例——徽标百分比以此 ÷ 行模型
   * contextWindow。与账目累计正交：账目只增、水位只覆写。
   */
  ctx?: Readonly<Record<string, number>>;
  /**
   * per-turn 账目（additive，轮末 token 用量显示面）：turnId → 该轮
   * usage.recorded(source=turn) 入账累计。与 total/byInstance 同一事件流
   * 的挂载投影（AD-9③ 不双计——账本 byTurn 槽，事件重放同规则重建）。
   * 缺省 = 旧 daemon 未携带（气泡 meta 行不显示）。
   */
  byTurn?: Readonly<Record<string, UsageDto>>;
}

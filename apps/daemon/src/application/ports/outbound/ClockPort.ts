/**
 * 时间源出口端口（outbound，architecture.md §3.4，可选积木）。
 *
 * domain/application 不直接依赖系统时钟全局态（可测性）：
 * 领域事件 occurredAt、Entry/Turn 时间戳统一经本端口取值，
 * 测试注入固定时钟即可断言确定性时间。
 * 本文件只有接口定义（AG-01）。
 */
export interface ClockPort {
  /** 当前时刻（ISO 8601 字符串；领域事件 occurredAt / 实例 createdAt）。 */
  now(): string;
  /** 当前时刻（epoch 毫秒；时间差判定（如 stalled 轮询 idle 阈值）统一取本面，
   * 避免毫秒级路径直调 Date.now 造成双时间源。 */
  nowMs(): number;
}

import type { EntryData } from "./Entry";
import type { TurnData } from "./Turn";
import type { SteerItem } from "../agent/SteerQueue";

/**
 * 会话快照（architecture.md §3.3，值对象）：domain 聚合的可序列化全量视图。
 *
 * 用途：SessionRepositoryPort.save/restore 的载荷（write-through 持久化对象）、
 * SessionPort.getSnapshot 的重连/恢复推送给前端（AD-16：快照+增量事件）。
 * 纯数据（贫血），充血 ↔ 贫血的转换在 Session.toSnapshot / restoreFrom。
 */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly createdAt: string;
  /** 全量条目（语义单元，不含流式中间态）。 */
  readonly entries: readonly EntryData[];
  /** 全量轮次。 */
  readonly turns: readonly TurnData[];
  /** 未消费的 steer 队列（重启后仍可注入，spike ④）。 */
  readonly pendingSteer: readonly SteerItem[];
}

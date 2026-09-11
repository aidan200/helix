/**
 * 写事实纯类型（U0a——跨轮跨会话的写事实底座）。
 *
 * 为什么存在：TurnDiffService 的记账口是轮窗口语义（轮外写丢弃），
 * 跨会话协调（U1 护栏 / U4 占用 / U7 足迹）需要「per-agent 累积、
 * daemon 生命周期内持久」的写事实面。本文件是纯类型单点——
 * application（WriteFactRegistry）与 driven（wrap/wire）共同 import，
 * 零 IO 零依赖（domain 底层纪律）。
 */

/** 写事实置信（消费者按误伤方向取门槛——U1 全取 / U4 ≥inferred / U7 全集）。 */
export type WriteConfidence =
  | "precise" // 工具写（write/edit/edit-lines）——事件即归属，唯一精确事实
  | "inferred" // bash 快照 diff 归属（U0b L2）——执行边界推断
  | "uncertain" // bash 静态预扫描（U0b L1）——命令文本提取，未验证
  | "unknown"; // 周期对账发现（U0b L3——后续批）——变更存在但归属不明

/** 置信序（高覆盖低：同路径高置信事实覆盖低置信条目）。 */
export const CONFIDENCE_ORDER: Readonly<Record<WriteConfidence, number>> = {
  precise: 3,
  inferred: 2,
  uncertain: 1,
  unknown: 0,
};

/** 单条写事实（registry 记账单位）。 */
export interface WriteFact {
  readonly instanceId: string;
  readonly sessionId: string;
  /** 绝对路径（main 侧装配归一；subagent 侧 wire 行自带）。 */
  readonly path: string;
  /** epoch ms。 */
  readonly at: number;
  readonly confidence: WriteConfidence;
}

/** 实例写事实聚合（registry 查询产物——instanceId 内含：会话多实例消费面需要归属）。 */
export interface InstanceWriteFacts {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly paths: ReadonlyMap<string, WriteConfidence>;
  readonly writeCount: number;
  /** 0 = 无写。 */
  readonly lastWriteAt: number;
}

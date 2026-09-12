/**
 * 占用协调事件（v0.12 §94，U5）——daemon 级 notification 通道广播。
 *
 * 领域五个 coord.* 事件（claimed/released/settled/undeclared/conflict）
 * 统一映射本帧类型，kind 字段区分——「协调面发生了什么」对用户可见的
 * 轻通知面（shell 活动窗口 toast；不进 entries 不进上下文——协调状态
 * 是 daemon 级事实，会话 store 零写入，task.changed 同构先例）。
 *
 * 文案字段 text 由 daemon 侧生成（人读审计面单源，前端零二次叙述，
 * TaskChangedPayload.syncHint 同规）。
 */
import type { EventFrame } from "../envelope";

/** coord.changed 事件帧（notification 通道；EventFrame 基座 + channel 字面量登记，task.ts 同构）。 */
export interface CoordChangedEvent extends EventFrame<CoordChangedPayload> {
  channel?: "notification";
  type: "coord.changed";
}

export interface CoordChangedPayload {
  /** 领域事件类别（coord.* 尾段）。 */
  readonly kind: "claimed" | "released" | "settled" | "undeclared" | "conflict";
  readonly leaseId: string;
  /** 占用者 agent 标识（人读；本会话占用时同 owner）。 */
  readonly ownerAgentId: string;
  /** 归一范围描述（项目根或 paths 逗号拼接）。 */
  readonly scopeDesc: string;
  /** 声明意图（undeclared 自动补登时为机械文案）。 */
  readonly intent: string;
  /** daemon 侧生成的人读通知文案（toast 直渲）。 */
  readonly text: string;
  /** 冲突升级（同一冲突对反复 claim 无动作 ≥2 次——留给人裁决的信号）。 */
  readonly escalated?: boolean;
  readonly ts: number;
}

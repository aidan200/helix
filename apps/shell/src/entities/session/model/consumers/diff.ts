/**
 * diff 消费者族（T3+T4 diff 批）——轮次 diff 状态面（diff.changed →
 * state.diff）。
 *
 * 语义：diff.changed 是 publishDelta 瞬态通道的会话广播帧（daemon
 * TurnDiffService 经组合根推送回调发出——开轮 cleared / 写记账 active /
 * 收轮 frozen 三相位，全量帧整体替换，幂等）。phase=cleared → null
 * （开轮清零：chip 隐藏、下轮重计）；active/frozen → 载荷整体落切片
 * （frozen 灰态定格归 CSS 层呈现，store 不改形）。
 *
 * daemon 侧内存态（重启丢失、快照不携带）——初始态 null = 无记录如实
 * 呈现；会话切换/重建 store 归零（快照消费不触碰本字段）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { DiffChangedPayload, EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const DIFF_EVENT_TYPES = ["diff.changed"] as const;

export function applyDiffEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  if (event.type !== "diff.changed") return s;
  const p = event.payload as DiffChangedPayload;
  // cleared = 开轮清零帧（daemon beginTurn 推送）→ 无可呈现数据如实置空
  return { ...s, diff: p.phase === "cleared" ? null : p };
}

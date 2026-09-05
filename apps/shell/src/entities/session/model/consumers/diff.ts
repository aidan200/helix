/**
 * diff 消费者族（T3+T4 diff 批 + v0.3.1 §29 rehydrate 微批）——轮次 diff
 * 状态面（diff.changed / diff.get.result → state.diff）。
 *
 * 语义：
 * - diff.changed（publishDelta 瞬态通道会话广播帧）：active/frozen →
 *   载荷整体落切片（幂等整体替换）；**cleared → 忽略**（§29：开轮不抹
 *   上一轮灰态显示——流式期 agent 未写文件时 chip 不消失；轮切换由首个
 *   active 帧整体替换驱动，frozen 灰态归 CSS 层呈现，store 不改形）。
 * - diff.get.result（§29 真消费）：回执摘要落切片（会话切回 rehydrate——
 *   瞬态帧错过不重放，切回时 chip 组件单查询补拉）。**轮次守卫**：仅
 *   空态或同 turnId 时落——在途回执不降级覆盖新轮数据（文件明细仍经
 *   LISTEN_SURFACE 转发归 DiffOverlay 私有 reducer，AG-15 不进本切片）。
 *
 * daemon 侧内存态（重启丢失、快照不携带）——初始态 null = 无记录如实
 * 呈现；会话切换/重建 store 归零由 chip 组件 rehydrate 补拉。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { DiffChangedPayload, DiffGetResultPayload, EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const DIFF_EVENT_TYPES = ["diff.changed", "diff.get.result"] as const;

export function applyDiffEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  if (event.type === "diff.changed") {
    const p = event.payload as DiffChangedPayload;
    // cleared = 开轮清零帧（§29 起忽略：保留上一轮灰态显示，首个 active 帧替换）
    if (p.phase === "cleared") return s;
    return { ...s, diff: p };
  }
  // diff.get.result 为窄化点对点回执（不入 EVENT_TYPES 目录——task 族先例）：
  // 联合外宽松判别（DiffOverlay/TasksPage 先例同构）
  if ((event.type as string) === "diff.get.result") {
    const p = event.payload as DiffGetResultPayload;
    // 轮次守卫：空态或同 turnId 才落（在途回执不降级覆盖新轮数据）
    if (s.diff !== null && s.diff.turnId !== p.turnId) return s;
    return {
      ...s,
      diff: {
        turnId: p.turnId,
        phase: p.phase,
        adds: p.summary.adds,
        dels: p.summary.dels,
        fileCount: p.files.length,
      },
    };
  }
  return s;
}

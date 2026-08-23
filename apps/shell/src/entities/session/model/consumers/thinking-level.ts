/**
 * thinking-level 消费者 —— 会话 thinking 档覆盖生效广播（thinking.changed；
 * 契约 v0.11 §17.11，thinking 批①；T2.1）。
 *
 * 活跃 store 级消费者（信封 sessionId = 会话归属，仿 consumers/model.ts
 * model.changed 先例）：thinking 切片双位（override/effective）整体替换——
 * daemon 权威（F1.3 意图/生效分离的 store 面；滑块位置/强调 = effective，
 * override≠effective 轻提示归 UI 层派生，reducer 不持渲染文本）。
 * 后台会话的 thinking.changed 不入本块（轻量 store 无 thinking 字段，
 * dispatcher 后台路由不计未读——frame.ts model.changed 同判先例）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const THINKING_LEVEL_EVENT_TYPES = ["thinking.changed"] as const;

export function applyThinkingLevelEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "thinking.changed":
      // daemon 权威整体替换（override/effective 双位同帧到达，不存在半更新）
      return { ...s, thinking: { override: event.payload.override, effective: event.payload.effective } };
    default:
      return s;
  }
}

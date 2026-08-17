/**
 * model 消费者 —— 运行期换模生效（model.changed；契约 C §2.1；T3.1）。
 *
 * 活跃 store 级消费者（信封 sessionId = 会话归属）：会话 model 态更新
 * （P-1 header 模型徽标数据源——「徽标即时同步」的 store 面；UI 消费归
 * T3.2/T3.3）。后台会话的 model.changed 不入本块（轻量 store 无 model 字段，
 * dispatcher 后台路由不计未读）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const MODEL_EVENT_TYPES = ["model.changed"] as const;

export function applyModelChangedEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "model.changed":
      return { ...s, model: event.payload.model };
    default:
      return s;
  }
}

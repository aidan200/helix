/**
 * plan 消费者 —— 主会话工作台账增量面（main-session plan 批；
 * session.plan.changed → state.plan/ledger）。
 *
 * 语义：plan 三工具执行成功后 daemon 广播全量台账（plan 行 + ledger 计数
 * 摘要，服务端组装——前端零拼装，AD-4② 同规）；失败路径不发帧（台账未动
 * 无需通知）。载荷即终态整体替换（非增量合并——全量帧幂等，乱序/重复安全）。
 * plan/ledger 双 null = 无台账（重建清场后同帧形状——观察面条整条隐藏）。
 * 恢复种子面 = session.snapshot 的 plan/ledger 字段（consumers/snapshot）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope, SessionPlanChangedPayload } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const PLAN_EVENT_TYPES = ["session.plan.changed"] as const;

export function applyPlanEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "session.plan.changed": {
      const p = event.payload as SessionPlanChangedPayload;
      // 全量帧整体替换（幂等）；双 null = 无台账如实落（观察面隐藏判据）
      return { ...s, plan: p.plan, ledger: p.ledger };
    }
    default:
      return s;
  }
}

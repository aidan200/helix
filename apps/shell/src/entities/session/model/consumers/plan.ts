/**
 * plan 消费者 —— 工作台账增量面（main-session plan 批 + SubAgent 抽屉
 * plan 面；session.plan.changed → state.plan/ledger 或 instancePlans 分片）。
 *
 * 语义：plan 三工具执行成功后 daemon 广播全量台账（plan 行 + ledger 计数
 * 摘要，服务端组装——前端零拼装，AD-4② 同规）；失败路径不发帧（台账未动
 * 无需通知）。载荷即终态整体替换（非增量合并——全量帧幂等，乱序/重复安全）。
 * 路由（实例台账增型）：payload.instanceId 携带 = SubAgent 实例台账 →
 * state.instancePlans[instanceId] 整存/整删（信封 sessionId 仍 = 归属会话，
 * 订阅路由维度不变——本消费只按载荷分片，不校验归属）；缺省 = 主会话台账
 *（instanceId 维度 = sessionId，既有口径零变化）。
 * plan/ledger 双 null = 无台账（重建清场后同帧形状——观察面条整条隐藏）。
 * 恢复种子面 = session.snapshot 的 plan/ledger 字段与 instances[].plan
 * （consumers/snapshot）。纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope, SessionPlanChangedPayload } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const PLAN_EVENT_TYPES = ["session.plan.changed"] as const;

export function applyPlanEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "session.plan.changed": {
      const p = event.payload as SessionPlanChangedPayload;
      // 实例分片路由（SubAgent 抽屉 plan 面）：携带 instanceId = 实例台账
      // 帧 → 分片整存（双 null = 整删如实落——条隐藏）；缺省 = 主会话
      // 台账整体替换（幂等；双 null = 无台账如实落）
      if (p.instanceId !== undefined) {
        if (p.plan === null || p.ledger === null) {
          if (s.instancePlans[p.instanceId] === undefined) return s; // 无键无台账→幂等无操作
          const { [p.instanceId]: _drop, ...rest } = s.instancePlans;
          return { ...s, instancePlans: rest };
        }
        return {
          ...s,
          instancePlans: {
            ...s.instancePlans,
            [p.instanceId]: { plan: p.plan, ledger: p.ledger },
          },
        };
      }
      return { ...s, plan: p.plan, ledger: p.ledger };
    }
    default:
      return s;
  }
}

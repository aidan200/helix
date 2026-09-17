/**
 * ask 消费者 —— 提权申请问答卡（permission_request 批，interaction 通道双帧）。
 *
 * 承接 2 case（承接面定稿，写入模块头）：
 * - ask.started：agent 发起一次性沙箱外执行申请 → pendingAsk 置位（会话
 *   底部问答卡数据源：命令 + 理由 + 倒计时 + 批准/拒绝按钮）；
 * - ask.resolved：三终态收口（approved/denied/timeout，daemon AskService
 *   单 pending 不变式 + 60s 机械超时）→ pendingAsk 清除。
 *
 * 瞬态不落盘——时间轴条目（daemon 落盘 pending 态）在重连后由快照
 * pendingAsk 字段权威重建（consumers/snapshot），本族只驱动热态。
 * 单 pending 不变式：started 恒整体替换（daemon 保证同会话同刻至多一笔）。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const ASK_EVENT_TYPES = ["ask.started", "ask.resolved"] as const;

export function applyAskEvent(s: SessionState, frame: EventEnvelope): SessionState {
  if (frame.type === "ask.started") {
    const p = frame.payload as {
      askId: string;
      kind?: "permission_request";
      command: string;
      reason: string;
      instanceId: string;
      expiresAt: number;
    };
    return {
      ...s,
      pendingAsk: {
        askId: p.askId,
        ...(p.kind !== undefined ? { kind: p.kind } : {}), // TR-159：additive 可选位显式透传
        command: p.command,
        reason: p.reason,
        instanceId: p.instanceId,
        expiresAt: p.expiresAt,
      },
    };
  }
  if (frame.type === "ask.resolved") {
    return { ...s, pendingAsk: null };
  }
  return s;
}

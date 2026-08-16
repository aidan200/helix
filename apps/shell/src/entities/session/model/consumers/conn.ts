/**
 * conn 消费者 —— 连接状态机（SM-1/SM-2；C2 拆分，AD-3 前端形态，T1.1）。
 *
 * 承接面定稿（brief 决策消解，写入模块头）：
 * - conn/* 四 action（connecting / disconnected / gave-up / manual-retry）：
 *   客户端驱动的连接态切换，非帧驱动 → 不经 dispatcher 注册表，由主
 *   reducer 经 isConnAction 直达本块；
 * - connection.welcome / connection.error 两帧事件：帧驱动 → 经 dispatcher
 *   注册表路由（types 登记见 CONN_EVENT_TYPES），conn 语义归本块承接——
 *   welcome 落 connected + toast 悬置判定（首连/重连/手动重试三分支）；
 *   error 不投影（错误收口归 WS 客户端 gave-up，重放幂等友好）。
 *
 * 连接态切换从不清空投影与草稿（SM 规则 4/5）。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { SessionAction, SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const CONN_EVENT_TYPES = ["connection.welcome", "connection.error"] as const;

export type ConnAction = Extract<
  SessionAction,
  { type: "conn/connecting" | "conn/disconnected" | "conn/gave-up" | "conn/manual-retry" }
>;

export function isConnAction(action: SessionAction): action is ConnAction {
  return action.type.startsWith("conn/");
}

export function applyConnAction(state: SessionState, action: ConnAction): SessionState {
  switch (action.type) {
    case "conn/connecting":
      return { ...state, conn: "connecting", connAttempts: action.attempt };
    case "conn/disconnected":
      return { ...state, conn: "disconnected" };
    case "conn/gave-up":
      return {
        ...state,
        conn: "error",
        connError: { message: action.message, attempts: action.attempts },
      };
    case "conn/manual-retry":
      return {
        ...state,
        conn: "connecting",
        connAttempts: 1,
        pendingManualRetry: true,
      };
  }
}

export function applyConnEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "connection.welcome": {
      const toastPending = s.pendingManualRetry
        ? ("retry" as const)
        : s.hasConnected
          ? ("restore" as const)
          : null;
      return {
        ...s,
        conn: "connected",
        hasConnected: true,
        pendingManualRetry: false,
        toastPending,
        sessionId: event.payload.sessionId,
        model: event.payload.model,
        agentState: event.payload.agentState,
      };
    }
    case "connection.error":
      // 握手拒绝 / 命令回执：错误信息由 WS 客户端收口进 gave-up；连接保持类
      // 错误（command.*）不改变连接态。此处不投影（重放幂等友好）。
      return s;
    default:
      return s;
  }
}

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
import { DEFAULT_MODE_ID } from "@helix/protocol";
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
      // 草稿标记承接（T3，bug1 前端半面；TR-AD-23①）：draft===true = daemon
      // 当前会话是零条目内存草稿（握手不 attach 不推快照）→ 前端落草稿态：
      // sessionId 保持 null（不激活幻影会话）、view=ready、model 落 store
      // （daemon 全局默认——草稿徽标数据源）；草稿态断连重连天然规避「welcome
      // 把草稿顶回 daemon 当前会话」裂缝。agentState 不动（草稿无代理态）。
      if (event.payload.draft === true) {
        return {
          ...s,
          conn: "connected",
          hasConnected: true,
          pendingManualRetry: false,
          toastPending,
          sessionId: null,
          model: event.payload.model,
          // P1 T4：草稿态 welcome 不带 mode——本地所选保持（重连不丢草稿选择）
          view: "ready",
        };
      }
      return {
        ...s,
        conn: "connected",
        hasConnected: true,
        pendingManualRetry: false,
        toastPending,
        sessionId: event.payload.sessionId,
        model: event.payload.model,
        // P1 T4 welcome mode 回带（已建会话 = session.mode 定格值）；缺省 =
        // default 兜底（旧 daemon 兼容）
        mode: event.payload.mode ?? DEFAULT_MODE_ID,
        agentState: event.payload.agentState,
        // 首连两阶段（P-1s）：welcome 即就绪可发（快照随后重建内容并再次确认
        // ready）；切换路径的 loading 骨架只由 session.snapshot 解除（同连
        // 接不重握手，welcome 不会再到）
        view: "ready",
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

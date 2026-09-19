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
 *   会话面采纳分两支：无本地活跃（首连/草稿/冷启动）采纳 welcome 会话；
 *   本地已有活跃会话保持不采纳（重连视图劫持防线，对账归快照——见
 *   applyConnEvent 非 draft 分支）；error 不投影（错误收口归 WS 客户端
 *   gave-up，重放幂等友好）。
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
          daemonFreshness: event.payload.daemonFreshness ?? null,
          // P1 T4：草稿态 welcome 不带 mode——本地所选保持（重连不丢草稿选择）
          view: "ready",
        };
      }
      // 本地活跃会话优先（症状B修复方案1）：本地已持有活跃会话（sessionId
      // 非 null = 用户打开的会话，非草稿新建态）时不采纳 welcome 的会话面
      // 字段——welcome 的 sessionId/model/mode/agentState 是 daemon 当前会话
      // （全局最近活跃投影）的描述，多会话/后台任务更新别会话时与用户所在
      // 视图恒错位；保持本地视图（entries/投影随活跃位保留，SM 规则 4/5），
      // 重连对账由 replay 的 subscribe(活跃会话) 回推快照权威重建（onSnapshot
      // 活跃重建 → dispatch → snapshot 消费者整体替换）。与 ledger.
      // learnAttached「已有活跃位不覆盖——用户当前选择优先」对称收口：store
      // /簿记两面对「活跃」的认知不再分叉（分叉即视图劫持根因）。view 不越权
      // 改写（两阶段协议：仅 session.snapshot 解除 loading）；连接面字段照常。
      // 无本地活跃（首连/草稿态/冷启动）→ 照旧采纳（行为不变）。
      if (s.sessionId !== null) {
        return {
          ...s,
          conn: "connected",
          hasConnected: true,
          pendingManualRetry: false,
          toastPending,
          daemonFreshness: event.payload.daemonFreshness ?? null,
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
        daemonFreshness: event.payload.daemonFreshness ?? null,
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

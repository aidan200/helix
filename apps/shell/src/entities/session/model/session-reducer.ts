/**
 * entities/session —— 会话投影 reducer（W7/CL-7；AD-16 纯投影）。
 *
 * 状态 = 连接态 × 会话投影。全部领域内容由 WS 事件流（@helix/protocol
 * EventEnvelope）投影而来：前端零权威状态，重连恢复 = daemon 快照 + 增量，
 * 无本地补齐。本文件为纯函数（无 React / 无 IO / 无 Date.now），可重放：
 *   ① 同一 action 序列重放两次 → 状态幂等一致；
 *   ② 前缀投影快照 + 后续增量 = 全量重放（session-reducer.test.ts 守护）。
 *
 * 本地仅存纯 UI 态：draft（输入草稿）、工具卡展开（组件态）、主题/i18n
 * （localStorage 白名单键，AG-14）。
 */
import type {
  AgentStateDto,
  EntryDto,
  EventEnvelope,
  MessageEntryDto,
} from "@helix/protocol";

/** 连接四态（互斥；SM-1）。loading = connecting 的可视形态，不设第五态。 */
export type ConnState = "connecting" | "connected" | "disconnected" | "error";

/** 流式中间态投影（chat.stream.delta 累积；不落盘语义的前端侧镜像）。 */
export interface StreamingState {
  messageId: string;
  text: string;
}

/** 恢复 toast（重连成功后由快照条数填满，UI 消费后置空）。 */
export interface RestoreToast {
  kind: "restore" | "retry";
  count: number;
}

export interface SessionState {
  /** 连接态（SM-1 四态互斥） */
  conn: ConnState;
  /** 当前重连尝试次数（横幅「第 n 次尝试」） */
  connAttempts: number;
  /** error 态失败卡数据（gave-up 时由客户端填入真实错误信息） */
  connError: { message: string; attempts: number } | null;
  /** 手动重试挂起（welcome 后 toast 走 retry 文案而非 restore） */
  pendingManualRetry: boolean;
  /** 是否曾连接成功过（区分首连与重连：仅重连触发恢复 toast） */
  hasConnected: boolean;
  /** welcome/snapshot 待填的 toast 类型（快照到达时取条数） */
  toastPending: "restore" | "retry" | null;
  /** 恢复 toast（一次性，UI 消费） */
  restoreToast: RestoreToast | null;
  sessionId: string | null;
  model: string;
  agentState: AgentStateDto;
  /** 会话投影（daemon 权威；快照整体替换 + 增量事件 upsert） */
  entries: EntryDto[];
  streaming: StreamingState | null;
  /** 输入草稿（纯 UI 态；跨连接态保留，发送成功才清空） */
  draft: string;
  /** 本地 steer echo 序号（确定性 id，保证重放幂等） */
  nextLocalSeq: number;
}

export type SessionAction =
  // ── 连接态（shared/api 客户端驱动；SM-1/2 转换矩阵）──
  /** 一次连接尝试开始（首连 attempt=1；自动重连递增） */
  | { type: "conn/connecting"; attempt: number }
  /** 已建立的连接意外断开（自动重连序列随后启动） */
  | { type: "conn/disconnected" }
  /** 自动重试耗尽 / 握手持续被拒（失败卡；等待手动重试） */
  | { type: "conn/gave-up"; message: string; attempts: number }
  /** 用户点击失败卡「重试连接」（error → connecting） */
  | { type: "conn/manual-retry" }
  // ── 协议事件（唯一领域数据来源）──
  | { type: "event"; event: EventEnvelope }
  // ── 纯 UI 态 ──
  | { type: "ui/set-draft"; text: string }
  /** 发送提交（turn = chat.send / steer = chat.steer；ts 由调用方注入保证重放确定） */
  | { type: "ui/send"; text: string; mode: "turn" | "steer"; ts: number }
  | { type: "ui/consume-restore-toast" };

export function createInitialSessionState(): SessionState {
  return {
    conn: "connecting",
    connAttempts: 1,
    connError: null,
    pendingManualRetry: false,
    hasConnected: false,
    toastPending: null,
    restoreToast: null,
    sessionId: null,
    model: "",
    agentState: "idle",
    entries: [],
    streaming: null,
    draft: "",
    nextLocalSeq: 1,
  };
}

// ── 派生选择子（纯函数）──────────────────────────────────────

/** 空会话态：connected 且无条目且无流式且非生成中（empty 引导页可见条件）。 */
export function selectIsEmpty(s: SessionState): boolean {
  return (
    s.conn === "connected" &&
    s.entries.length === 0 &&
    s.streaming === null &&
    !selectIsGenerating(s)
  );
}

/** 生成中（steer 提示行 / 输入不锁死的判据）：流式或有活跃 agent 态。 */
export function selectIsGenerating(s: SessionState): boolean {
  return (
    s.streaming !== null || s.agentState === "running" || s.agentState === "steering"
  );
}

/** 发送前置条件 = connected（SM 规则 6：非 connected 不给出可发入口）。 */
export function selectCanSend(s: SessionState): boolean {
  return s.conn === "connected";
}

// ── 内部工具 ────────────────────────────────────────────────

const LOCAL_PREFIX = "local:";

/** entries 按 id upsert（已存在则原位替换，否则尾部追加；保持到达序）。 */
function upsertEntry(entries: EntryDto[], entry: EntryDto): EntryDto[] {
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...entries, entry];
  const next = entries.slice();
  next[idx] = entry;
  return next;
}

/** steer.queued：把最早的未确认本地 echo 换成 daemon entryId（确认对账）。 */
function confirmSteerEcho(entries: EntryDto[], entryId: string): EntryDto[] {
  const idx = entries.findIndex(
    (e) => e.kind === "message" && e.id.startsWith(LOCAL_PREFIX) && e.steerState === "queued",
  );
  if (idx === -1) return entries; // 无 echo（他端发送等场景）：等快照对账
  const next = entries.slice();
  const echo = next[idx] as MessageEntryDto;
  next[idx] = { ...echo, id: entryId };
  return next;
}

/** steer.drained：徽标 queued → drained（SM-3 第二态）。 */
function drainSteer(entries: EntryDto[], entryId: string): EntryDto[] {
  return entries.map((e) =>
    e.kind === "message" && e.id === entryId && e.steerState === "queued"
      ? { ...e, steerState: "drained" as const }
      : e,
  );
}

// ── 事件投影 ────────────────────────────────────────────────

function applyEvent(s: SessionState, event: EventEnvelope): SessionState {
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
    case "session.snapshot": {
      const snap = event.payload.snapshot;
      return {
        ...s,
        entries: snap.entries, // 整体替换：重连恢复全量来自 daemon（无本地补齐）
        model: snap.model,
        agentState: snap.agentState,
        sessionId: snap.sessionId,
        streaming: null, // 快照为落盘终态；进行中的流随重连作废
        restoreToast: s.toastPending ? { kind: s.toastPending, count: snap.entries.length } : s.restoreToast,
        toastPending: null,
      };
    }
    case "chat.stream.delta": {
      const { messageId, delta } = event.payload;
      const streaming =
        s.streaming && s.streaming.messageId === messageId
          ? { messageId, text: s.streaming.text + delta }
          : { messageId, text: delta };
      return { ...s, streaming };
    }
    case "chat.message.completed": {
      const entry = event.payload.entry;
      const cleared =
        entry.kind === "message" && entry.role === "assistant" ? null : s.streaming;
      return { ...s, entries: upsertEntry(s.entries, entry), streaming: cleared };
    }
    case "chat.turn.started":
      return s; // 轮次里程碑（v0 无 UI 投影面）
    case "chat.turn.completed":
      return { ...s, streaming: null };
    case "steer.queued":
      return { ...s, entries: confirmSteerEcho(s.entries, event.payload.entryId) };
    case "steer.drained":
      return { ...s, entries: drainSteer(s.entries, event.payload.entryId) };
    case "tool.call.started":
    case "tool.call.result":
      return { ...s, entries: upsertEntry(s.entries, event.payload.entry) };
    case "agent.state.changed": {
      const agentState = event.payload.state;
      return { ...s, agentState, streaming: agentState === "idle" ? null : s.streaming };
    }
    default:
      return s;
  }
}

// ── reducer ─────────────────────────────────────────────────

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    // 连接态切换从不清空投影与草稿（SM 规则 4/5）
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
    case "event":
      return applyEvent(state, action.event);
    case "ui/set-draft":
      return { ...state, draft: action.text };
    case "ui/send": {
      const text = action.text.trim();
      if (!selectCanSend(state) || text === "") return state; // SM 规则 6：非 connected 拒发
      if (action.mode === "steer") {
        // steer echo：立即可见的 user 气泡 + queued 徽标；id 对账交给 steer.queued
        const echo: MessageEntryDto = {
          kind: "message",
          id: `${LOCAL_PREFIX}${state.nextLocalSeq}`,
          role: "user",
          content: text,
          ts: action.ts,
          steerState: "queued",
        };
        return {
          ...state,
          draft: "",
          entries: [...state.entries, echo],
          nextLocalSeq: state.nextLocalSeq + 1,
        };
      }
      // turn 模式不做本地 echo：气泡由 daemon 的 chat.message.completed 投影
      return { ...state, draft: "" };
    }
    case "ui/consume-restore-toast":
      return { ...state, restoreToast: null };
    default:
      return state;
  }
}

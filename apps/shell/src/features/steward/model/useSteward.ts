/**
 * useSteward —— V2.5 文本管家面板状态钩子（设计 §2/§5.2/§5.3 消费端）。
 *
 * 链路：
 * - 配置面：mount → steward.get_config → config.result（enabled/model 态；
 *   daemon 侧 RuntimeConfig 持久化——开关默认关）；
 * - 订阅闸门：面板开 + conn=connected + enabled → steward.subscribe（daemon
 *   连接级 feed 闸门登记；断连自动清位，重连由 conn 依赖重放——
 *   useVoiceBroadcast 先例同构）；面板关/未启用 → unsubscribe；
 * - 对话面：ask(text) → steward.ask → steward.ask.result 三判别
 *   （answer 直答入消息流 / confirm_required 入 pending 确认闸 /
 *   error 入消息流——零静默失败）；
 * - 确认闸（§5.2 防火墙客户端面）：pending 携带 actionId + 递话全文，
 *   confirmPending() → steward.confirm（actionId 单次消费——daemon 侧
 *   权威）；confirm.result ok/error 均入消息流；
 * - feed 面：steward.feed 文本行 → 滚动窗口（上限截尾保最新）。
 *
 * 防自激纪律（TR-169）：订阅 effect 只按 [conn, open, enabled] 离散依赖
 * 发命令，不在 effect 体内因 send 失败复位任何守卫 ref；send 返回值消费
 * 一律 === false 严格判（TR-168）——面板对未连接态静默不重试。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import type { EventEnvelope } from "@helix/protocol";

/** feed 滚动窗口上限（截尾保最新；面板轻量态不落 store）。 */
export const STEWARD_FEED_MAX_LINES = 50;

/** 面板消息行（会话内——不持久化，与 daemon 侧滚动窗口同语义）。 */
export interface StewardMessage {
  readonly role: "user" | "steward";
  readonly text: string;
}

/** 待确认写动作（确认闸面板态；执行权威在 daemon——actionId 单次消费）。 */
export interface StewardPendingAction {
  readonly actionId: string;
  readonly agentId: string;
  readonly message: string;
}

interface FeedLine {
  readonly kind: string;
  readonly agentId: string;
  readonly text: string;
  readonly seq: number;
}

interface StewardConfig {
  readonly enabled: boolean;
  readonly model: string;
}

export interface UseSteward {
  /** 对话消息流（user/steward 两方）。 */
  readonly messages: readonly StewardMessage[];
  /** 待确认写动作（null = 无）。 */
  readonly pending: StewardPendingAction | null;
  /** feed 文本行（新序，截尾保最新）。 */
  readonly feed: readonly FeedLine[];
  /** ask 在途（面板禁用输入面）。 */
  readonly askInFlight: boolean;
  /** 设置现态（null = 未收到 config.result）。 */
  readonly config: StewardConfig | null;
  /** 发送一轮对话（未连接返回 false——零静默丢消息，submit 同语义）。 */
  ask(text: string): boolean;
  /** 确认闸放行（发送 steward.confirm；未连接返回 false）。 */
  confirmPending(): boolean;
  /** 放弃当前待确认动作（仅本地清卡——daemon 侧动作过期自然失效）。 */
  dismissPending(): void;
}

/** 消息滚动窗口上限（与 daemon HISTORY_WINDOW 同量级；防无界增长）。 */
const MESSAGE_WINDOW = 60;

export function useSteward(open: boolean): UseSteward {
  const {
    topology,
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    subscribeStewardFrames,
  } = useSession() as {
    topology?: { active?: { conn?: string } };
    sendStewardAsk?: (text: string) => boolean;
    sendStewardConfirm?: (actionId: string) => boolean;
    sendStewardSubscribe?: () => boolean;
    sendStewardUnsubscribe?: () => boolean;
    sendStewardGetConfig?: () => boolean;
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };

  const [messages, setMessages] = useState<readonly StewardMessage[]>([]);
  const [pending, setPending] = useState<StewardPendingAction | null>(null);
  const [feed, setFeed] = useState<readonly FeedLine[]>([]);
  const [askInFlight, setAskInFlight] = useState(false);
  const [config, setConfig] = useState<StewardConfig | null>(null);

  const pushMessage = useCallback((message: StewardMessage) => {
    setMessages((prev) => {
      const next = [...prev, message];
      return next.length > MESSAGE_WINDOW ? next.slice(-MESSAGE_WINDOW) : next;
    });
  }, []);

  // ── 配置读面：mount / 重连 → steward.get_config（幂等读，daemon 回现态）──
  const conn = topology?.active?.conn;
  const getConfigSentFor = useRef<string | null>(null);
  useEffect(() => {
    if (conn !== "connected") return;
    if (typeof sendStewardGetConfig !== "function") return;
    if (getConfigSentFor.current === conn) return; // 同连接幂等（防重渲染重发）
    getConfigSentFor.current = conn;
    sendStewardGetConfig();
  }, [conn, sendStewardGetConfig]);

  // ── 订阅闸门：面板开 + connected + enabled → subscribe；否则 unsubscribe ──
  // （依赖均为离散态（conn/open/config.enabled），无数据流回写——不自激）
  const enabled = config?.enabled === true;
  useEffect(() => {
    if (typeof sendStewardSubscribe !== "function" || typeof sendStewardUnsubscribe !== "function") return;
    if (conn === "connected" && open && enabled) {
      sendStewardSubscribe();
    } else if (conn === "connected") {
      sendStewardUnsubscribe();
    }
  }, [conn, open, enabled, sendStewardSubscribe, sendStewardUnsubscribe]);

  // ── 帧消费：ask/confirm/config 三回执 + feed 广播（单 listener 单点分发）──
  const inFlightRef = useRef(false);
  const askInFlightRef = useRef(false);
  const markAskInFlight = (v: boolean) => {
    askInFlightRef.current = v;
    setAskInFlight(v);
  };
  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type === "steward.ask.result") {
        const payload = event.payload as
          | { status: "answer"; text: string }
          | { status: "confirm_required"; actionId: string; agentId: string; message: string }
          | { status: "error"; reason: string };
        if (payload.status === "answer") {
          pushMessage({ role: "steward", text: payload.text });
        } else if (payload.status === "confirm_required") {
          setPending({ actionId: payload.actionId, agentId: payload.agentId, message: payload.message });
        } else {
          pushMessage({ role: "steward", text: payload.reason });
        }
        markAskInFlight(false);
        return;
      }
      if (event.type === "steward.confirm.result") {
        const payload = event.payload as
          | { status: "ok"; agentId: string; detail: string }
          | { status: "error"; reason: string };
        setPending(null);
        if (payload.status === "ok") {
          pushMessage({ role: "steward", text: `${payload.agentId}：${payload.detail}` });
        } else {
          pushMessage({ role: "steward", text: payload.reason });
        }
        return;
      }
      if (event.type === "steward.config.result") {
        const payload = event.payload as StewardConfig;
        setConfig({ enabled: payload.enabled === true, model: String(payload.model ?? "") });
        return;
      }
      if (event.type === "steward.feed") {
        const payload = event.payload as FeedLine;
        if (typeof payload.seq !== "number" || typeof payload.text !== "string") return;
        setFeed((prev) => {
          // seq 去重（连接内单调；重连后 seq 重置——按 (seq,text) 宽松去重保尾窗）
          if (prev.length > 0 && prev[prev.length - 1]!.seq === payload.seq && prev[prev.length - 1]!.text === payload.text) return prev;
          const next = [...prev, payload];
          return next.length > STEWARD_FEED_MAX_LINES ? next.slice(-STEWARD_FEED_MAX_LINES) : next;
        });
      }
    });
  }, [subscribeStewardFrames, pushMessage]);
  void inFlightRef;

  const ask = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (trimmed === "") return false;
      if (typeof sendStewardAsk !== "function") return false;
      const ok = sendStewardAsk(trimmed);
      if (ok === false) return false; // 未连接：零静默丢消息（TR-168 严格判）
      pushMessage({ role: "user", text: trimmed });
      markAskInFlight(true);
      return true;
    },
    [sendStewardAsk, pushMessage],
  );

  const confirmPending = useCallback((): boolean => {
    if (pending === null) return false;
    if (typeof sendStewardConfirm !== "function") return false;
    const ok = sendStewardConfirm(pending.actionId);
    if (ok === false) return false;
    return true;
  }, [pending, sendStewardConfirm]);

  const dismissPending = useCallback(() => setPending(null), []);

  return { messages, pending, feed, askInFlight, config, ask, confirmPending, dismissPending };
}

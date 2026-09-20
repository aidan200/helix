/**
 * useSteward —— 管家面板状态钩子（V2.5 设计 §2/§5.2/§5.3 消费端；A1 工作记忆
 * 批改造：完整过程条目模型 + 回放同源 + 新对话三清）。
 *
 * 链路：
 * - 配置面：mount → steward.get_config → config.result（enabled/model 态；
 *   daemon 侧 RuntimeConfig 持久化——开关默认关）；
 * - 订阅闸门：面板开 + conn=connected + enabled → steward.subscribe（daemon
 *   连接级 feed 闸门登记；断连自动清位，重连由 conn 依赖重放——
 *   useVoiceBroadcast 先例同构）；面板关/未启用 → unsubscribe；
 * - 对话面：ask(text) → steward.ask → steward.ask.delta 流式增量帧
 *   （streamingText 增量聚合；终态权威覆盖）+ steward.thinking 段级 /
 *   steward.tool 两相过程帧（A1：工具/thinking 过程屏幕可见——条目追加，
 *   TTS 播报链路零接入：useStewardVoice 只听 ask.result answer 文本）→
 *   steward.ask.result 三判别（answer 直答入条目流并清 streamingText /
 *   confirm_required 入 pending 确认闸 / error 入条目流——零静默失败）；
 * - 回放面（A1）：conn=connected → steward.history → history.result →
 *   items 从记录数组同源重建（UI 显示的 = LLM 记得的——daemon KV 单源）；
 * - 新对话（A1）：newDialog() → steward.history {clear:true}（daemon 清 KV
 *   + LLM 窗口）+ 本地 items 清空（回执空数组幂等覆盖）——三处同步清；
 * - 确认闸（§5.2 防火墙客户端面）：pending 携带 actionId + 递话全文，
 *   confirmPending() → steward.confirm（actionId 单次消费——daemon 侧
 *   权威）；confirm.result ok/error 均入条目流；
 * - feed 面：steward.feed 文本行 → 滚动窗口（上限截尾保最新）。
 *
 * 防自激纪律（TR-169）：订阅 effect 只按 [conn, open, enabled] 离散依赖
 * 发命令，不在 effect 体内因 send 失败复位任何守卫 ref；send 返回值消费
 * 一律 === false 严格判（TR-168）——面板对未连接态静默不重试。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import type { EventEnvelope, StewardHistoryRecord } from "@helix/protocol";

/** feed 滚动窗口上限（截尾保最新；面板轻量态不落 store）。 */
export const STEWARD_FEED_MAX_LINES = 50;

/**
 * 面板过程条目（A1：完整记录形态的 UI 投影——thinking 折叠条目 / 工具
 * 过程行 / 对话气泡；由回放记录与实时过程帧同构映射）。
 */
export type StewardPanelItem =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly argsSummary: string;
      readonly resultSummary: string | null;
    };

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
  /** 对话过程条目流（user/assistant 气泡 + thinking 折叠 + 工具行；A1）。 */
  readonly items: readonly StewardPanelItem[];
  /** 在途流式文本（null = 无流；增量聚合——终态 result 权威覆盖后清空；
   *  不落盘不持久化，与主聊天 streaming 槽同语义）。 */
  readonly streamingText: string | null;
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
  /** 新对话（A1：三处同步清——本地条目 + daemon KV + LLM 窗口）。 */
  newDialog(): boolean;
}

/** 条目滚动窗口上限（防无界；回放源在 daemon KV——超窗可再拉）。 */
const ITEM_WINDOW = 200;

/** 工具参数摘要截断（行内密度面）。 */
const ARGS_SUMMARY_MAX = 80;

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args) ?? "{}";
  return s.length <= ARGS_SUMMARY_MAX ? s : `${s.slice(0, ARGS_SUMMARY_MAX)}…`;
}

/** 回放记录 → 面板条目（同源映射：一条 assistant 记录可投影多个条目——
 *  thinking → 折叠条目、toolCall → 工具行；toolResult 按 toolCallId 配对
 *  回填结果摘要）。 */
export function recordsToItems(records: readonly StewardHistoryRecord[]): StewardPanelItem[] {
  const items: StewardPanelItem[] = [];
  for (const r of records) {
    if (r.kind === "user") {
      items.push({ kind: "user", text: r.text });
      continue;
    }
    if (r.kind === "toolResult") {
      // 配对回填（找不到配对行 = 防御态：独立成行不丢信息）
      const target = [...items].reverse().find((i) => i.kind === "tool" && i.toolCallId === r.toolCallId);
      if (target !== undefined && target.kind === "tool") {
        const idx = items.indexOf(target);
        items[idx] = { ...target, resultSummary: r.text.slice(0, ARGS_SUMMARY_MAX) };
      } else {
        items.push({
          kind: "tool",
          toolCallId: r.toolCallId,
          name: r.name,
          argsSummary: "",
          resultSummary: r.text.slice(0, ARGS_SUMMARY_MAX),
        });
      }
      continue;
    }
    if (r.thinking !== undefined && r.thinking.text !== "") items.push({ kind: "thinking", text: r.thinking.text });
    if (r.toolCall !== undefined) {
      items.push({
        kind: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        argsSummary: summarizeArgs(r.toolCall.args),
        resultSummary: null,
      });
    }
    if (r.text !== undefined && r.text !== "") items.push({ kind: "assistant", text: r.text });
  }
  return items;
}

export function useSteward(open: boolean): UseSteward {
  const {
    topology,
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardHistory,
    subscribeStewardFrames,
  } = useSession() as {
    topology?: { active?: { conn?: string } };
    sendStewardAsk?: (text: string) => boolean;
    sendStewardConfirm?: (actionId: string) => boolean;
    sendStewardSubscribe?: () => boolean;
    sendStewardUnsubscribe?: () => boolean;
    sendStewardGetConfig?: () => boolean;
    sendStewardHistory?: (clear?: boolean) => boolean;
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };

  const [items, setItems] = useState<readonly StewardPanelItem[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [pending, setPending] = useState<StewardPendingAction | null>(null);
  const [feed, setFeed] = useState<readonly FeedLine[]>([]);
  const [askInFlight, setAskInFlight] = useState(false);
  const [config, setConfig] = useState<StewardConfig | null>(null);
  const { t } = useI18n();

  const pushItem = useCallback((item: StewardPanelItem) => {
    setItems((prev) => {
      const next = [...prev, item];
      return next.length > ITEM_WINDOW ? next.slice(-ITEM_WINDOW) : next;
    });
  }, []);

  // ── 配置读面：mount / 重连 → steward.get_config（幂等读，daemon 回现态）──
  // ── 断连即弃流式缓冲（V2.5 体验批）：daemon 不持 delta 状态，重连不重放——
  // 与主聊天 streaming 槽同语义（切走/断连即弃，终态权威面另行到达）──
  const conn = topology?.active?.conn;
  useEffect(() => {
    if (conn !== "connected") setStreamingText(null);
  }, [conn]);
  const getConfigSentFor = useRef<string | null>(null);
  useEffect(() => {
    if (conn !== "connected") return;
    if (typeof sendStewardGetConfig !== "function") return;
    if (getConfigSentFor.current === conn) return; // 同连接幂等（防重渲染重发）
    getConfigSentFor.current = conn;
    sendStewardGetConfig();
  }, [conn, sendStewardGetConfig]);

  // ── 回放面（A1）：conn=connected → steward.history → 同源重建 items。
  // 守卫 ref 复位只在离散事件（连接变更由 conn 依赖驱动重设）——TR-169。──
  const historySentFor = useRef<string | null>(null);
  useEffect(() => {
    if (conn !== "connected") return;
    if (typeof sendStewardHistory !== "function") return;
    if (historySentFor.current === conn) return; // 同连接幂等
    historySentFor.current = conn;
    sendStewardHistory();
  }, [conn, sendStewardHistory]);

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

  // ── 帧消费：ask/confirm/config/history 回执 + tool/thinking 过程帧 + feed ──
  const askInFlightRef = useRef(false);
  const markAskInFlight = (v: boolean) => {
    askInFlightRef.current = v;
    setAskInFlight(v);
  };
  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type === "steward.ask.delta") {
        // 流式增量聚合（V2.5 体验批）：不落盘（items 不动）——终态 result
        // 到达时清空并落权威消息；非在途（迟到 delta）忽略防脏写
        const payload = event.payload as { delta?: unknown };
        if (typeof payload.delta !== "string" || payload.delta === "") return;
        if (!askInFlightRef.current) return;
        setStreamingText((prev) => (prev ?? "") + payload.delta);
        return;
      }
      if (event.type === "steward.thinking") {
        // thinking 段级（A1）：一完成块一条目（屏幕折叠显示）
        const payload = event.payload as { text?: unknown };
        if (typeof payload.text !== "string" || payload.text === "") return;
        pushItem({ kind: "thinking", text: payload.text });
        return;
      }
      if (event.type === "steward.tool") {
        // 工具两相（A1）：start 开行（结果待配对）；end 回填最近同名待配对行
        const payload = event.payload as
          | { phase: "start"; name?: unknown; argsSummary?: unknown }
          | { phase: "end"; name?: unknown; resultSummary?: unknown };
        if (payload.phase === "start") {
          if (typeof payload.name !== "string") return;
          const argsSummary = typeof payload.argsSummary === "string" ? payload.argsSummary : "{}";
          pushItem({ kind: "tool", toolCallId: `live-${Date.now()}`, name: payload.name, argsSummary, resultSummary: null });
          return;
        }
        if (typeof payload.name !== "string") return;
        const resultSummary = typeof payload.resultSummary === "string" ? payload.resultSummary : "";
        setItems((prev) => {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const it = prev[i]!;
            if (it.kind === "tool" && it.name === payload.name && it.resultSummary === null) {
              const next = [...prev];
              next[i] = { ...it, resultSummary };
              return next;
            }
          }
          return prev;
        });
        return;
      }
      if (event.type === "steward.history.result") {
        // 回放同源（A1）：daemon KV 记录数组 → items 整体替换（权威面）
        const payload = event.payload as { records?: unknown };
        if (!Array.isArray(payload.records)) return;
        setItems(recordsToItems(payload.records as StewardHistoryRecord[]));
        return;
      }
      if (event.type === "steward.ask.result") {
        const payload = event.payload as
          | { status: "answer"; text: string }
          | { status: "confirm_required"; actionId: string; agentId: string; message: string }
          | { status: "queued"; queued: true; position: number }
          | { status: "error"; reason: string };
        // L1 件二：排队确认帧——显示「已排队」，不清流式缓冲、不结束在途态
        //（本轮仍在跑；结果帧随后到达时再收口）
        if (payload.status === "queued") {
          pushItem({ kind: "assistant", text: t("steward.askQueued", { position: payload.position }) });
          return;
        }
        setStreamingText(null); // 终态权威覆盖：清流式缓冲（answer/error/confirm 同口径）
        if (payload.status === "answer") {
          pushItem({ kind: "assistant", text: payload.text });
        } else if (payload.status === "confirm_required") {
          setPending({ actionId: payload.actionId, agentId: payload.agentId, message: payload.message });
        } else {
          pushItem({ kind: "assistant", text: payload.reason });
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
          pushItem({ kind: "assistant", text: `${payload.agentId}：${payload.detail}` });
        } else {
          pushItem({ kind: "assistant", text: payload.reason });
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
  }, [subscribeStewardFrames, pushItem, t]);

  const ask = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (trimmed === "") return false;
      if (typeof sendStewardAsk !== "function") return false;
      const ok = sendStewardAsk(trimmed);
      if (ok === false) return false; // 未连接：零静默丢消息（TR-168 严格判）
      setStreamingText(null); // 新一轮复位（防御：上轮断连残留）
      pushItem({ kind: "user", text: trimmed });
      markAskInFlight(true);
      return true;
    },
    [sendStewardAsk, pushItem],
  );

  const confirmPending = useCallback((): boolean => {
    if (pending === null) return false;
    if (typeof sendStewardConfirm !== "function") return false;
    const ok = sendStewardConfirm(pending.actionId);
    if (ok === false) return false;
    return true;
  }, [pending, sendStewardConfirm]);

  const dismissPending = useCallback(() => setPending(null), []);

  const newDialog = useCallback((): boolean => {
    if (typeof sendStewardHistory !== "function") return false;
    const ok = sendStewardHistory(true);
    if (ok === false) return false; // 未连接：不清（三处一致以 daemon 为准）
    setItems([]); // 本地先行清（回执空数组幂等覆盖）
    setPending(null);
    return true;
  }, [sendStewardHistory]);

  return { items, streamingText, pending, feed, askInFlight, config, ask, confirmPending, dismissPending, newDialog };
}

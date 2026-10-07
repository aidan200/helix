/**
 * useSteward —— 管家面板状态钩子（V2.5 设计 §2/§5.2/§5.3 消费端；A1 工作记忆
 * 批改造：完整过程条目模型 + 回放同源 + 新对话三清）。
 *
 * 链路：
 * - 配置面：mount → steward.get_config → config.result（enabled/model 态；
 *   daemon 侧 RuntimeConfig 持久化——开关默认关）；
 * - 订阅闸门（B1 订阅解绑，设计稿 §3.5）：connected + enabled →
 *   steward.subscribe（daemon 连接级 feed 闸门登记；断连自动清位，重连
 *   由 conn 依赖重放）——**面板开合不再影响订阅**（消灭「关面板=关耳朵」
 *   的 G2 错位：navigate/提案/feed 帧照达）；money gate 语义不变（开关关
 *   仍零订阅零推送）；
 * - 对话面：ask(text) → steward.ask → steward.ask.delta 流式增量帧
 *   （streamingText 增量聚合；终态权威覆盖）+ steward.thinking 段级 /
 *   steward.tool 两相过程帧 → steward.ask.result（answer 直答入条目流 /
 *   error 入条目流；confirm_required 的确认卡归全局 ConfirmStack
 *   （useStewardActions，B1 卡栈移出面板）——本面零处理）→
 *   steward.action.completed 执行回执入条目流（历史留痕）；
 * - 回放面（A1）：conn=connected → steward.history → history.result →
 *   items 从记录数组同源重建；
 * - 新对话（A1）：newDialog() → steward.history {clear:true}（daemon 清 KV
 *   + LLM 窗口）+ 本地 items 清空——三处同步清；
 * - feed 面：steward.feed 文本行 → 滚动窗口（上限截尾保最新）。
 *
 * 防自激纪律（TR-169）：订阅 effect 只按 [conn, enabled] 离散依赖发命令，
 * 不在 effect 体内因 send 失败复位任何守卫 ref；send 返回值消费一律
 * === false 严格判（TR-168）——未连接态静默不重试。
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
      /** 实时帧耗时锦（start 帧到达时刻；回放条目无——历史无耗时语义）。 */
      readonly startedAt: number | null;
      /** 定格锦（end 帧到达时刻；pending 态 null）。 */
      readonly endedAt: number | null;
    };

/** ask 进行中态投影（过程反馈 UI 批：状态区两行滚动——状态文 + 已完成
 *  thinking 块首行摘要窗口；phase 随最近过程帧切换）。 */
export interface StewardAskActivity {
  /** 最近过程帧类型：thinking（思考/消化）| tool（工具执行中）。 */
  readonly phase: "thinking" | "tool";
  /** phase=tool 时的工具名（状态文插值）。 */
  readonly toolName: string | null;
  /** 已完成 thinking 块首行摘要（最近 THINKING_LINE_WINDOW 条，旧块滚出）。 */
  readonly thinkingLines: readonly string[];
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
  /** feed 文本行（新序，截尾保最新）。 */
  readonly feed: readonly FeedLine[];
  /** ask 在途（面板禁用输入面）。 */
  readonly askInFlight: boolean;
  /** ask 进行中态投影（过程反馈 UI 批；null = 非在途——状态区收起）。 */
  readonly askActivity: StewardAskActivity | null;
  /** 设置现态（null = 未收到 config.result）。 */
  readonly config: StewardConfig | null;
  /** 发送一轮对话（未连接返回 false——零静默丢消息，submit 同语义）。 */
  ask(text: string): boolean;
  /** 新对话（A1：三处同步清——本地条目 + daemon KV + LLM 窗口）。 */
  newDialog(): boolean;
}

/** 条目滚动窗口上限（防无界；回放源在 daemon KV——超窗可再拉）。 */
const ITEM_WINDOW = 200;

/** 工具参数摘要截断（行内密度面）。 */
const ARGS_SUMMARY_MAX = 80;

/** 状态区摘要滚动窗（两行——超出滚出；模型层截窗即滚出语义，jsdom 同口径可断言）。 */
export const STEWARD_THINKING_LINE_WINDOW = 2;

/** 摘要行截断（密度面，ARGS_SUMMARY_MAX 同族）。 */
const THINKING_SUMMARY_MAX = 60;

/** thinking 块 → 首行摘要（首非空行；超长截断——「知道在想什么」而非读全文）。 */
function firstThinkingLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length <= THINKING_SUMMARY_MAX ? line : `${line.slice(0, THINKING_SUMMARY_MAX)}…`;
}

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
    if (r.kind === "compaction") {
      continue; // 压缩摘要记录（事故热修批⑤）：内部上下文状态非用户话轮——零渲染
    }
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
          startedAt: null,
          endedAt: null,
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
        startedAt: null, // 回放无耗时锦（历史行不显示计时）
        endedAt: null,
      });
    }
    if (r.text !== undefined && r.text !== "") items.push({ kind: "assistant", text: r.text });
  }
  return items;
}

/** open 参数退役（B1 订阅解绑：订阅闸不再随面板开合——设计稿 §3.5）；
 * 签名保留无参形态，调用方（useStewardVoice）透传面同步瘦身。 */
export function useSteward(): UseSteward {
  const {
    topology,
    sendStewardAsk,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardHistory,
    subscribeStewardFrames,
  } = useSession() as {
    topology?: { active?: { conn?: string } };
    sendStewardAsk?: (text: string) => boolean;
    sendStewardSubscribe?: () => boolean;
    sendStewardUnsubscribe?: () => boolean;
    sendStewardGetConfig?: () => boolean;
    sendStewardHistory?: (clear?: boolean) => boolean;
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };

  const [items, setItems] = useState<readonly StewardPanelItem[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [feed, setFeed] = useState<readonly FeedLine[]>([]);
  const [askInFlight, setAskInFlight] = useState(false);
  const [askActivity, setAskActivity] = useState<StewardAskActivity | null>(null);
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

  // ── 订阅闸门（B1 订阅解绑，设计稿 §3.5）：connected + enabled →
  //    subscribe；connected + 未启用 → unsubscribe（money gate 语义不变：
  //    开关关零订阅零推送）。面板开合不再影响订阅——navigate/提案/feed
  //    帧在面板关闭时照达（G2 解耦；依赖均为离散态，无数据流回写——不自激）──
  const enabled = config?.enabled === true;
  useEffect(() => {
    if (typeof sendStewardSubscribe !== "function" || typeof sendStewardUnsubscribe !== "function") return;
    if (conn === "connected" && enabled) {
      sendStewardSubscribe();
    } else if (conn === "connected") {
      sendStewardUnsubscribe();
    }
  }, [conn, enabled, sendStewardSubscribe, sendStewardUnsubscribe]);

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
        // thinking 段级（A1）：一完成块一条目（屏幕折叠显示）；首行摘要进
        // 状态区滚动窗（过程反馈 UI 批——仅在途时更新，防孤立帧脏写）
        const payload = event.payload as { text?: unknown };
        if (typeof payload.text !== "string" || payload.text === "") return;
        pushItem({ kind: "thinking", text: payload.text });
        if (askInFlightRef.current) {
          setAskActivity((prev) => {
            if (prev === null) return null; // 非在途防御（迟到孤立帧）
            const next = [...prev.thinkingLines, firstThinkingLine(payload.text as string)];
            return {
              phase: "thinking",
              toolName: null,
              thinkingLines: next.length > STEWARD_THINKING_LINE_WINDOW ? next.slice(-STEWARD_THINKING_LINE_WINDOW) : next,
            };
          });
        }
        return;
      }
      if (event.type === "steward.tool") {
        // 工具两相（A1）：start 开行（结果待配对）；end 回填最近同名待配对行。
        // 过程反馈 UI 批：start 启表（startedAt 锦）+ activity 切工具态；
        // end 定格（endedAt 锦）+ activity 回思考态（模型消化结果继续思考）。
        const payload = event.payload as
          | { phase: "start"; name?: unknown; argsSummary?: unknown }
          | { phase: "end"; name?: unknown; resultSummary?: unknown };
        if (payload.phase === "start") {
          if (typeof payload.name !== "string") return;
          const argsSummary = typeof payload.argsSummary === "string" ? payload.argsSummary : "{}";
          const startedAt = Date.now();
          pushItem({ kind: "tool", toolCallId: `live-${startedAt}`, name: payload.name, argsSummary, resultSummary: null, startedAt, endedAt: null });
          setAskActivity((prev) => (prev === null ? prev : { ...prev, phase: "tool", toolName: payload.name as string }));
          return;
        }
        if (typeof payload.name !== "string") return;
        const resultSummary = typeof payload.resultSummary === "string" ? payload.resultSummary : "";
        const endedAt = Date.now();
        setItems((prev) => {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const it = prev[i]!;
            if (it.kind === "tool" && it.name === payload.name && it.resultSummary === null) {
              const next = [...prev];
              next[i] = { ...it, resultSummary, endedAt };
              return next;
            }
          }
          return prev;
        });
        setAskActivity((prev) => (prev === null ? prev : { ...prev, phase: "thinking", toolName: null }));
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
        setStreamingText(null); // 终态权威覆盖：清流式缓冲（answer/error 同口径）
        setAskActivity(null); // 过程反馈 UI 批：收口状态区收起
        if (payload.status === "answer") {
          pushItem({ kind: "assistant", text: payload.text });
        } else {
          // confirm_required 的确认卡归全局 ConfirmStack（useStewardActions
          // 订阅同一帧入栈——B1 卡栈移出面板）；error 入条目流零静默失败
          if (payload.status === "error") pushItem({ kind: "assistant", text: payload.reason });
        }
        markAskInFlight(false);
        return;
      }
      if (event.type === "steward.action.completed") {
        // B1 两段式第二段：执行回执历史留痕（卡栈态流转/结果 toast 归
        // useStewardActions——多听众扇出各取所需）。收敛/撤回帧（outcome=
        // superseded）静默——零留痕零通知（确认链路修复批）。
        const payload = event.payload as { actionId?: unknown; ok?: unknown; detail?: unknown; outcome?: unknown };
        if (payload.outcome === "superseded") return;
        if (typeof payload.detail !== "string") return;
        pushItem({ kind: "assistant", text: payload.ok === true ? payload.detail : payload.detail });
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
      setAskActivity({ phase: "thinking", toolName: null, thinkingLines: [] }); // 过程反馈 UI 批：在途态启表
      return true;
    },
    [sendStewardAsk, pushItem],
  );

  const newDialog = useCallback((): boolean => {
    if (typeof sendStewardHistory !== "function") return false;
    const ok = sendStewardHistory(true);
    if (ok === false) return false; // 未连接：不清（三处一致以 daemon 为准）
    setItems([]); // 本地先行清（回执空数组幂等覆盖）
    return true;
  }, [sendStewardHistory]);

  return { items, streamingText, feed, askInFlight, askActivity, config, ask, newDialog };
}

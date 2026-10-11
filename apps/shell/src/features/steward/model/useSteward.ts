/**
 * useSteward —— 管家对话状态钩子（薄接线层；状态本体在 steward-store 共享
 * 单例——面板/语音层/光球层同源批）。
 *
 * 同源批动机：原 useState 每实例一份，语音轮 ask 置不了面板实例的 askInFlight
 * → 面板 delta 守卫丢光语音轮流式增量（中间过程不可见、用户问句行缺失），
 * 反向光球过程行缺失——两面各见一半。状态收敛进 stewardStore 单例后：
 * 任一入口（面板打字 / 语音问句 / 会话投递）的轮次，面板与光球都全程可见
 * 过程输出（thinking/工具/流式发言）与终态。
 *
 * 链路（语义不变）：
 * - 配置面：connected → steward.get_config（同连接幂等）；
 * - 订阅闸门（B1）：connected + enabled → steward.subscribe（开关关零订阅
 *   零推送；面板开合不影响订阅）；
 * - 对话面：ask → steward.ask → delta 流式聚合 + thinking/tool 过程帧 →
 *   ask.result 终态（confirm_required 归全局 ConfirmStack，本面零处理）；
 * - 回放面：connected → steward.history → items 同源重建；
 * - feed 面：steward.feed 文本行滚动窗口。
 *
 * 防自激纪律（TR-169）不变：命令只按离散依赖触发；send === false 严格判
 * （TR-168）。共享单例 refs 0→1 清位重置（测试隔离——RTL cleanup 后下一
 * 用例拿干净态）。
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import type { EventEnvelope, StewardAskSource } from "@helix/protocol";
import {
  stewardStore,
  STEWARD_FEED_MAX_LINES,
  STEWARD_THINKING_LINE_WINDOW,
  recordsToItems,
  type StewardAskActivity,
  type StewardPanelItem,
} from "./steward-store";

export {
  STEWARD_FEED_MAX_LINES,
  STEWARD_THINKING_LINE_WINDOW,
  recordsToItems,
  type StewardAskActivity,
  type StewardPanelItem,
};

export interface UseSteward {
  /** 对话过程条目流（user/assistant 气泡 + thinking 折叠 + 工具行；A1）。 */
  readonly items: readonly StewardPanelItem[];
  /** 在途流式文本（null = 无流；增量聚合——终态 result 权威覆盖后清空）。 */
  readonly streamingText: string | null;
  /** feed 文本行（新序，截尾保最新）。 */
  readonly feed: readonly { readonly kind: string; readonly agentId: string; readonly text: string; readonly seq: number }[];
  /** ask 在途（面板禁用输入面）。 */
  readonly askInFlight: boolean;
  /** ask 进行中态投影（null = 非在途——状态区收起）。 */
  readonly askActivity: StewardAskActivity | null;
  /** 设置现态（null = 未收到 config.result）。 */
  readonly config: { readonly enabled: boolean; readonly model: string } | null;
  /** dropped 通知序号（addressee 判「非对管家说」静默丢弃时递增——光球
   *  输入流水淡行消费：「没识别到/声纹不匹配/被判旁人」三种静默可辨）。 */
  readonly dropNoticeSeq: number;
  /** 发送一轮对话（未连接返回 false——零静默丢消息，submit 同语义）。 */
  ask(text: string, source?: StewardAskSource): boolean;
  /** 手动停在途轮（steward.interrupt → daemon abortInFlight）。 */
  stopInFlight(): boolean;
  /** 新对话（三处同步清——本地条目 + daemon KV + LLM 窗口）。 */
  newDialog(): boolean;
}

export function useSteward(): UseSteward {
  const {
    topology,
    sendStewardAsk,
    sendStewardInterrupt,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardHistory,
    subscribeStewardFrames,
  } = useSession() as {
    topology?: { active?: { conn?: string } };
    sendStewardAsk?: (text: string, source?: StewardAskSource) => boolean;
    sendStewardInterrupt?: (reason?: string) => boolean;
    sendStewardSubscribe?: () => boolean;
    sendStewardUnsubscribe?: () => boolean;
    sendStewardGetConfig?: () => boolean;
    sendStewardHistory?: (clear?: boolean) => boolean;
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const { t } = useI18n();
  const conn = topology?.active?.conn;
  const state = useSyncExternalStore(stewardStore.subscribe, stewardStore.getSnapshot);

  // ── 挂接（mount 一次；帧订阅驱动按 subscribeStewardFrames 身份变化才换订
  //    ——setSenders 面补装/换订，防身份每渲染新的 mock 每渲染拆装冲状态）──
  useEffect(() => {
    return stewardStore.attach(
      {
        sendStewardAsk,
        sendStewardInterrupt,
        sendStewardSubscribe,
        sendStewardUnsubscribe,
        sendStewardGetConfig,
        sendStewardHistory,
        subscribeStewardFrames,
      },
      t,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 发送面/locale 刷新（每渲染最新值）──
  useEffect(() => {
    stewardStore.setSenders(
      {
        sendStewardAsk,
        sendStewardInterrupt,
        sendStewardSubscribe,
        sendStewardUnsubscribe,
        sendStewardGetConfig,
        sendStewardHistory,
        subscribeStewardFrames,
      },
      t,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, sendStewardAsk, sendStewardInterrupt, sendStewardSubscribe, sendStewardUnsubscribe, sendStewardGetConfig, sendStewardHistory]);

  // ── 断连即弃流式缓冲（V2.5 体验批）──
  useEffect(() => {
    if (conn !== "connected") stewardStore.onDisconnect();
  }, [conn]);

  // ── 配置读面（mount / 重连 → get_config 幂等读）──
  useEffect(() => {
    if (conn !== "connected") return;
    if (typeof sendStewardGetConfig !== "function") return;
    stewardStore.requestConfigOnce(conn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, sendStewardGetConfig]);

  // ── 回放面（conn=connected → history 同源重建）──
  useEffect(() => {
    if (conn !== "connected") return;
    if (typeof sendStewardHistory !== "function") return;
    stewardStore.requestHistoryOnce(conn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, sendStewardHistory]);

  // ── 订阅闸门（B1：connected + enabled → subscribe）──
  const enabled = state.config?.enabled === true;
  useEffect(() => {
    if (typeof sendStewardSubscribe !== "function" || typeof sendStewardUnsubscribe !== "function") return;
    stewardStore.syncSubscription(conn, enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, enabled, sendStewardSubscribe, sendStewardUnsubscribe]);

  const ask = useCallback((text: string, source?: StewardAskSource): boolean => stewardStore.ask(text, source), []);
  const stopInFlight = useCallback((): boolean => stewardStore.stopInFlight(), []);
  const newDialog = useCallback((): boolean => stewardStore.newDialog(), []);

  return {
    items: state.items,
    streamingText: state.streamingText,
    feed: state.feed,
    askInFlight: state.askInFlight,
    askActivity: state.askActivity,
    config: state.config,
    dropNoticeSeq: state.dropNoticeSeq,
    ask,
    stopInFlight,
    newDialog,
  };
}

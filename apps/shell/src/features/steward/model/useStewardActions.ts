/**
 * useStewardActions —— 全局确认卡栈数据面（B1 管家文本链路批；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.4）。
 *
 * 取代 useSteward 单槽 pending 的多卡模型（解 G4 单槽覆盖/无在途态）：
 * - `steward.ask.result{confirm_required}` 确认卡与 `steward.memory_written`
 *   记忆落盘通知卡同栈合流（kind 区分渲染——通知卡无操作面）；
 * - 卡片到手即编号（seq 单调递增，永不重排——B2 语音口令「确认N号」的
 *   指认锚点预留）；
 * - 三态流转：awaiting（确认/放弃）→ accepted（B1 受理即回——按钮禁用防
 *   双击）→ done（steward.action.completed 到达，淡出后移除）；
 * - 放弃 = 本地移卡 + `steward.cancel`（daemon 侧 pending 作废——消灭孤儿
 *   actionId；未连接尽力而为）；
 * - 执行结果经 toast 交代（ok/err）——面板历史留痕归 useSteward（另一
 *   订阅者，多听众扇出）。
 *
 * 挂载面：ConfirmStack（app 壳级，AppRoutes 内）——订阅独立于管家面板
 * 开合（无光球/纯文本期卡栈照常出现），G2 解耦的卡栈侧同构。
 *
 * 防自激纪律（TR-169 族）：订阅 effect 只按 [subscribeStewardFrames] 离散
 * 依赖挂载；send 返回值消费 === false 严格判（TR-168）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useToast } from "@/shared/ui/Toast";
import { useI18n } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

/** 卡片生命周期态（B1 两段式：accepted = daemon 已受理执行中）。 */
export type StewardCardState = "awaiting" | "accepted" | "done";

/** 卡片种类：action = 确认卡（确认/放弃操作面）；memory = 记忆落盘通知卡
 *  （B5 静默化：无操作面，自动淡出——大脑图标 + 新增主题色/更新警告色）。 */
export type StewardCardKind = "action" | "memory";

/** 确认卡（confirm_required；memory 通知卡同栈合流——kind 区分渲染）。 */
export interface StewardActionCard {
  readonly actionId: string;
  /** 目标标识（递话实例 / 「长期记忆」等动作标识——渲染语义重载）。 */
  readonly agentId: string;
  /** 递话/提案/记忆文本全文。 */
  readonly message: string;
  /** 到手编号（1 起单调，永不重排）。 */
  readonly seq: number;
  state: StewardCardState;
  readonly kind: StewardCardKind;
  /** memory 卡渲染色面：added = 主题色 / updated = 警告色。 */
  readonly memoryMode?: "added" | "updated";
}

/** memory 通知卡驻留窗（ms；无操作面——自动收场，仅信息交代）。 */
export const STEWARD_MEMORY_CARD_LINGER_MS = 6000;

/** done 态淡出驻留窗（ms；ConfirmStack CSS 淡出时长对齐——reduced-motion
 *  直切时同样经此时窗移除，动画缺席仅视觉差异）。 */
export const STEWARD_CARD_DONE_LINGER_MS = 500;

/** 折叠阈值：超此数折叠「还有 N 张」抽屉（设计稿 §3.4）。 */
export const STEWARD_CARD_COLLAPSE_AT = 5;

export interface UseStewardActions {
  /** 卡栈（新卡在尾；渲染面自定方向）。 */
  readonly cards: readonly StewardActionCard[];
  /** awaiting 态卡确认（发 steward.confirm；受理回执到达即转 accepted）。
   *  非 awaiting/发送失败返回 false（防双击：accepted 态不可再点）。 */
  confirmCard(actionId: string): boolean;
  /** 放弃：本地移卡 + steward.cancel（作废 daemon 侧 pending）。 */
  cancelCard(actionId: string): void;
}

export function useStewardActions(): UseStewardActions {
  const {
    sendStewardConfirm,
    sendStewardCancel,
    subscribeStewardFrames,
  } = useSession() as {
    sendStewardConfirm?: (actionId: string) => boolean;
    sendStewardCancel?: (actionId: string) => boolean;
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const toast = useToast();
  const { t } = useI18n();
  /** 最近发起 confirm 的 actionId（confirm.result error 归因面——点对点回执
   *  只回发起连接，本连接在途动作单飞口径）。 */
  const lastConfirmedRef = useRef<string | null>(null);

  const [cards, setCards] = useState<readonly StewardActionCard[]>([]);
  /** 卡栈镜像（事件回调读最新卡集——闭包不依赖 cards 重渲染；幂等去重判据面）。 */
  const cardsRef = useRef<readonly StewardActionCard[]>([]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  const seqRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(
    () => () => {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  /** done 态淡出后移除（memory 通知卡复用同机制——驻留窗独立）。 */
  const scheduleRemoval = useCallback((actionId: string, lingerMs: number = STEWARD_CARD_DONE_LINGER_MS) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setCards((prev) => prev.filter((c) => c.actionId !== actionId));
    }, lingerMs);
    timersRef.current.add(timer);
  }, []);

  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type === "steward.ask.result") {
        const payload = event.payload as
          | { status?: unknown; actionId?: unknown; agentId?: unknown; message?: unknown };
        if (payload.status !== "confirm_required") return;
        const actionId = payload.actionId;
        if (typeof actionId !== "string" || actionId === "") return;
        // 幂等去重（确认链路修复批）：daemon 登记簿复用旧卡时同 actionId 回执
        //  重放——已入栈的卡不重复弹（治事故六卡并存的呈现面；重连重放同理）
        if (cardsRef.current.some((c) => c.actionId === actionId)) return;
        const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
        const message = typeof payload.message === "string" ? payload.message : "";
        seqRef.current += 1;
        setCards((prev) =>
          prev.some((c) => c.actionId === actionId)
            ? prev
            : [...prev, { actionId, agentId, message, seq: seqRef.current, state: "awaiting" as const, kind: "action" as const }],
        );
        return;
      }
      if (event.type === "steward.pending.snapshot") {
        // 订阅对账/清场（确认链路修复批：daemon 重启后空集即清场指令；非空集
        //  = 不在册的卡已失效应撤——卡栈以 daemon 快照为权威对账）
        const payload = event.payload as { actionIds?: unknown };
        if (!Array.isArray(payload.actionIds)) return;
        const keep = new Set(payload.actionIds.filter((id): id is string => typeof id === "string"));
        setCards((prev) => prev.filter((c) => c.kind !== "action" || keep.has(c.actionId)));
        return;
      }
      if (event.type === "steward.memory_written") {
        // 记忆落盘通知（B5 静默化）：无操作面——展示后自动收场（新增/更新色阶）
        const payload = event.payload as { text?: unknown; mode?: unknown };
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text === "") return;
        const memoryMode = payload.mode === "updated" ? "updated" : "added";
        seqRef.current += 1;
        const actionId = `memory-${seqRef.current}`;
        setCards((prev) => [
          ...prev,
          { actionId, agentId: "", message: text, seq: seqRef.current, state: "awaiting", kind: "memory", memoryMode },
        ]);
        scheduleRemoval(actionId, STEWARD_MEMORY_CARD_LINGER_MS);
        return;
      }
      if (event.type === "steward.confirm.result") {
        // 受理面：accepted = 该卡转 accepted（按钮禁用）；error = 已消费/已作废
        // （多窗口竞态/迟到放弃）——本连接在途的那张卡移卡交代，不静默。
        const payload = event.payload as
          | { status: "accepted"; actionId: string }
          | { status: "error"; reason: string };
        if (payload.status === "accepted") {
          const actionId = payload.actionId;
          if (typeof actionId !== "string") return;
          setCards((prev) =>
            prev.map((c) => (c.actionId === actionId ? { ...c, state: "accepted" as const } : c)),
          );
          return;
        }
        const culprit = lastConfirmedRef.current;
        if (culprit !== null) {
          lastConfirmedRef.current = null;
          setCards((prev) => prev.filter((c) => !(c.actionId === culprit && c.state === "awaiting")));
        }
        return;
      }
      if (event.type === "steward.action.completed") {
        // 执行完成：卡转 done（淡出）+ 结果 toast（历史留痕归 useSteward）。
        // 收敛/撤回帧（outcome=superseded）：静默移卡——零 toast 零 done 态
        //（治「已送达后又弹两条失效投递通知」；多窗卡栈同步收口）。
        const payload = event.payload as { actionId?: unknown; ok?: unknown; detail?: unknown; outcome?: unknown };
        const actionId = payload.actionId;
        if (typeof actionId !== "string") return;
        if (payload.outcome === "superseded") {
          setCards((prev) => prev.filter((c) => c.actionId !== actionId));
          return;
        }
        const ok = payload.ok === true;
        const detail = typeof payload.detail === "string" ? payload.detail : "";
        setCards((prev) =>
          prev.map((c) => (c.actionId === actionId ? { ...c, state: "done" as const } : c)),
        );
        scheduleRemoval(actionId);
        toast.push(ok ? "ok" : "err", detail === "" ? (ok ? t("steward.actionDone") : t("steward.actionFailed")) : detail);
      }
    });
  }, [subscribeStewardFrames, t, toast, scheduleRemoval]);

  const confirmCard = useCallback(
    (actionId: string): boolean => {
      // 防双击：accepted/done 态零发送（受理即回后按钮亦禁用——双闸）
      const target = cards.find((c) => c.actionId === actionId);
      if (target === undefined || target.state !== "awaiting") return false;
      if (typeof sendStewardConfirm !== "function") return false;
      const ok = sendStewardConfirm(actionId);
      if (ok === false) return false; // 未连接（TR-168 严格判）
      lastConfirmedRef.current = actionId;
      return true;
    },
    [cards, sendStewardConfirm],
  );

  const cancelCard = useCallback(
    (actionId: string): void => {
      setCards((prev) => prev.filter((c) => c.actionId !== actionId));
      if (typeof sendStewardCancel === "function") sendStewardCancel(actionId); // 作废尽力而为（未连接不阻断本地收场）
    },
    [sendStewardCancel],
  );

  return { cards, confirmCard, cancelCard };
}

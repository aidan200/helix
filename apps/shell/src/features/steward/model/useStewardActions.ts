/**
 * useStewardActions —— 全局确认卡栈数据面（B1 管家文本链路批；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.4）。
 *
 * 取代 useSteward 单槽 pending 的多卡模型（解 G4 单槽覆盖/无在途态）：
 * - `steward.ask.result{confirm_required}` 与 `steward.sediment_proposal`
 *   各自入栈（pendingActions[]，actionId 键）——不再互相覆盖；
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

/** 确认卡（confirm_required 与 sediment_proposal 同构合流）。 */
export interface StewardActionCard {
  readonly actionId: string;
  /** 目标标识（递话实例 / 「长期记忆」等动作标识——渲染语义重载）。 */
  readonly agentId: string;
  /** 递话/提案全文（确认闸透明性）。 */
  readonly message: string;
  /** 到手编号（1 起单调，永不重排）。 */
  readonly seq: number;
  state: StewardCardState;
}

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
  const seqRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(
    () => () => {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  /** done 态淡出后移除。 */
  const scheduleRemoval = useCallback((actionId: string) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setCards((prev) => prev.filter((c) => c.actionId !== actionId));
    }, STEWARD_CARD_DONE_LINGER_MS);
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
        const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
        const message = typeof payload.message === "string" ? payload.message : "";
        seqRef.current += 1;
        setCards((prev) => [
          ...prev,
          { actionId, agentId, message, seq: seqRef.current, state: "awaiting" },
        ]);
        return;
      }
      if (event.type === "steward.sediment_proposal") {
        // 自动沉淀提案：确认卡与 confirm_required 同构合流（agentId 语义重载
        // 为动作标识——useSteward 旧 pending 先例）
        const payload = event.payload as { actionId?: unknown; text?: unknown };
        const actionId = payload.actionId;
        if (typeof actionId !== "string" || actionId === "") return;
        const text = typeof payload.text === "string" ? payload.text : "";
        seqRef.current += 1;
        setCards((prev) => [
          ...prev,
          {
            actionId,
            agentId: t("steward.sedimentTarget"),
            message: t("steward.sedimentProposalMessage", { text }),
            seq: seqRef.current,
            state: "awaiting",
          },
        ]);
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
        // 执行完成：卡转 done（淡出）+ 结果 toast（历史留痕归 useSteward）
        const payload = event.payload as { actionId?: unknown; ok?: unknown; detail?: unknown };
        const actionId = payload.actionId;
        if (typeof actionId !== "string") return;
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

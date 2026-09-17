/**
 * 越权执行申请卡（sandbox_request 批）：ask.started 帧 → 聊天流底部问答卡。
 *
 * - 数据源：session state.pendingAsk（瞬态——ask.resolved 帧清除；重建权威 =
 *   快照 pendingAsk 字段，consumers/snapshot 原位复活）；
 * - 交互：批准/拒绝 → command-surface answerAsk（ask.answer 命令）；不乐观
 *   清卡——resolved 帧必达收口（daemon settle 唯一通道），双击幂等容忍；
 * - 倒计时：expiresAt 剩余秒数每秒 tick；到零仅置灰展示（daemon 60s 机械
 *   超时是终裁，resolved{outcome:timeout} 帧必达清卡）；
 * - 视觉：warning 系（待定申请 ≠ 错误——network-retry-card 同族设计语言）；
 * - 命令原文 = 领域数据不 i18n（ee-body 同口径）。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const AskCard = function AskCard() {
  const { t } = useI18n();
  const { state, answerAsk } = useSession();
  const ask = state.pendingAsk;
  const [now, setNow] = useState(() => Date.now());

  // 倒计时 tick：卡片在架期间每秒走（到零后停表——置灰展示等 resolved）
  const expired = ask !== null && now >= ask.expiresAt;
  useEffect(() => {
    if (ask === null || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ask, expired]);

  if (ask === null) return null;
  const secs = Math.max(0, Math.ceil((ask.expiresAt - now) / 1000));
  return (
    <div className="msg ask-card" role="alert">
      <div className="ak-head">
        <span className="ak-dot" aria-hidden />
        {t("chat.ask.title")}
        <span className="ak-from">{t("chat.ask.from", { instanceId: ask.instanceId })}</span>
        <span className="ak-countdown">
          {expired ? t("chat.ask.expired") : t("chat.ask.countdown", { secs })}
        </span>
      </div>
      <div className="ak-command">{ask.command}</div>
      <div className="ak-reason">{ask.reason}</div>
      <div className="ak-actions">
        <button
          type="button"
          className="ak-btn ak-btn-approve"
          disabled={expired}
          onClick={() => answerAsk(ask.askId, true)}
        >
          {t("chat.ask.approve")}
        </button>
        <button
          type="button"
          className="ak-btn ak-btn-deny"
          disabled={expired}
          onClick={() => answerAsk(ask.askId, false)}
        >
          {t("chat.ask.deny")}
        </button>
      </div>
      <div className="ak-hint">{t("chat.ask.hint")}</div>
    </div>
  );
};

export default AskCard;

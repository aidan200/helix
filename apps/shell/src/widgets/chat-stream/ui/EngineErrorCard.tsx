/**
 * 引擎错误卡片（终验热修）：engine.error 帧 → 聊天流内联失败卡。
 *
 * - 数据源：session state.engineError（瞬态——新轮 turn.started 清除，不落盘）；
 * - 正文 = provider 原文透传（领域数据，不 i18n——与 drawer.lc.crashed 同口径）；
 * - 视觉复用连接失败卡 ErrorCard 的红系 danger 样式（同一设计语言）；
 * - 不提供自动重试按钮：重试语义 = 重发消息（draft 已清，需用户重新输入，
 *   避免热修引入重放语义的边界问题）。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const EngineErrorCard = function EngineErrorCard() {
  const { t } = useI18n();
  const { state } = useSession();
  if (state.engineError === null) return null;
  return (
    <div className="msg engine-error-card" role="alert">
      <div className="ee-head">
        <span className="ee-dot" aria-hidden />
        {t("chat.engineError.title")}
      </div>
      <div className="ee-body">{state.engineError.message}</div>
      <div className="ee-hint">{t("chat.engineError.hint")}</div>
    </div>
  );
};

export default EngineErrorCard;

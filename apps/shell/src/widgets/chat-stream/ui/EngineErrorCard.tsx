/**
 * 引擎错误卡片（终验热修）：engine.error 帧 → 聊天流内联失败卡。
 *
 * - 数据源：session state.engineError（瞬态——error entry 批起：错误条目帧
 *   （error.entry）到达即清除转正为原位红条，新轮 turn.started 清除保留作兜底）；
 * - 正文 = provider 原文透传（领域数据，不 i18n——与 drawer.lc.crashed 同口径）；
 * - 视觉复用连接失败卡 ErrorCard 的红系 danger 样式（同一设计语言）；
 * - 不提供自动重试按钮：重试语义 = 重发消息（draft 已清，需用户重新输入，
 *   避免热修引入重放语义的边界问题）。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import type { ErrorEntryDto } from "@helix/protocol";

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

/**
 * 错误条目原位红条（error entry 批）：EntryDto kind="error" 变体的 EntryView
 * 分支——视觉复用本卡红系 danger 样式（ee-head/ee-body 族，同一设计语言）。
 * 数据源 = entries 序列（落盘条目）：刷新/切换后经快照原位可见；与瞬态卡
 * 互斥（error.entry 帧到达即清瞬态卡，同一错误不双显）。
 */
export const ErrorEntryBar = function ErrorEntryBar({ entry }: { entry: ErrorEntryDto }) {
  const { t } = useI18n();
  return (
    <div className="msg engine-error-card" role="alert">
      <div className="ee-head">
        <span className="ee-dot" aria-hidden />
        {t("chat.engineError.title")}
      </div>
      <div className="ee-body">{entry.message}</div>
      <div className="ee-hint">{t("chat.engineError.hint")}</div>
    </div>
  );
};

export default EngineErrorCard;

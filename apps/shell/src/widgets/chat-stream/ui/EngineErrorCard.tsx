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

/** 内部展示子组件（code-review 低危组9：两消费面 head/body/hint 同构结构
 *  收拢）——瞬态卡与落盘红条共享红系 danger 视觉（ee-* 族单一实现）。 */
function ErrorShell({ title, body, hint }: { title: string; body: string; hint: string }) {
  return (
    <div className="msg engine-error-card" role="alert">
      <div className="ee-head">
        <span className="ee-dot" aria-hidden />
        {title}
      </div>
      <div className="ee-body">{body}</div>
      <div className="ee-hint">{hint}</div>
    </div>
  );
}

const EngineErrorCard = function EngineErrorCard() {
  const { t } = useI18n();
  const { state } = useSession();
  if (state.engineError === null) return null;
  return (
    <ErrorShell
      title={t("chat.engineError.title")}
      body={state.engineError.message}
      hint={t("chat.engineError.hint")}
    />
  );
};

/**
 * 错误条目原位红条（error entry 批）：EntryDto kind="error" 变体的 EntryView
 * 分支——视觉复用本卡红系 danger 样式（ee-head/ee-body 族，ErrorShell 单一
 * 实现）。数据源 = entries 序列（落盘条目）：刷新/切换后经快照原位可见；与瞬态卡
 * 互斥（error.entry 帧到达即清瞬态卡，同一错误不双显）。
 */
export const ErrorEntryBar = function ErrorEntryBar({ entry }: { entry: ErrorEntryDto }) {
  const { t } = useI18n();
  return (
    <ErrorShell
      title={t("chat.engineError.title")}
      body={entry.message}
      hint={t("chat.engineError.hint")}
    />
  );
};

export default EngineErrorCard;

/**
 * 空会话引导（P-1 empty 态）：HX 方标（violet 辉光）+ 呼吸文案 + violet 方块
 * 光标 + 建议 chip 三枚（点击回填输入框并聚焦）。
 * M52：聚焦走 props 回调（pages 层接线 Composer ref），不做魔法 id DOM 直达。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const SessionEmpty = function SessionEmpty({ onFocusInput }: { onFocusInput?: () => void }) {
  const { t } = useI18n();
  const { setDraft } = useSession();

  const suggests = [
    t("chat.empty.suggest.read"),
    t("chat.empty.suggest.test"),
    t("chat.empty.suggest.grep"),
  ];

  const onSuggest = (text: string) => {
    setDraft(text);
    onFocusInput?.();
  };

  return (
    <div className="session-empty">
      <div className="empty-logo">HX</div>
      <div className="empty-await">
        {t("chat.empty.title")}
        <span className="empty-cursor" />
      </div>
      <div className="empty-suggest">
        {suggests.map((s) => (
          <button key={s} type="button" onClick={() => onSuggest(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
};

export default SessionEmpty;

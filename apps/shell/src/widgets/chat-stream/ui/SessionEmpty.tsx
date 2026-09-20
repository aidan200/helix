/**
 * 空会话引导（P-1 empty 态；空态统一版）：HX 方标（violet 辉光）+ 呼吸文案 +
 * violet 方块光标 + 建议 chip 三枚（点击回填输入框并聚焦）。
 * 空态统一（用户裁决）：草稿空态（sessionId === null，手动新建）与真实空会话
 * （管家建的、有 id 零条目）同构渲染本件——消除「管家建的会话有欢迎引导、
 * 手动新建没有」的不一致；草稿仅额外一行「发送第一条消息后将创建会话」条件
 * 提示（chat.draftEmpty.hint）。草稿判别组件内部完成（state.sessionId），
 * 调用方（MessageFlow）单一路径零分叉，两态不会再漂成两套形态。
 * M52：聚焦走 props 回调（pages 层接线 Composer ref），不做魔法 id DOM 直达。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const SessionEmpty = function SessionEmpty({ onFocusInput }: { onFocusInput?: () => void }) {
  const { t } = useI18n();
  const { state, setDraft } = useSession();
  // 草稿空态（sessionId === null）：唯一差异行——建会话提示
  const isDraft = state.sessionId === null;

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
      {isDraft && <p className="empty-hint">{t("chat.draftEmpty.hint")}</p>}
    </div>
  );
};

export default SessionEmpty;

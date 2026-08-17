/**
 * P-1 草稿空态（F(1.2).1；CL-1）：新建草稿后主区空白聊天区——呼吸文案 +
 * violet 方块光标 + 「发送第一条消息后将创建会话」提示（区别于首连空会话
 * 的 SessionEmpty 引导面：草稿无建议 chip，等待即语义）。
 * 可见性 CSS 门控：.app[data-session="empty"][data-conn="connected"]（与
 * session-empty 同门；sessionId === null 时由 MessageFlow 选用本件）。
 */
import { useI18n } from "@/shared/i18n";

const DraftEmpty = function DraftEmpty() {
  const { t } = useI18n();
  return (
    <div className="draft-empty" data-draft-empty>
      <p className="empty-await">
        {t("chat.draftEmpty.title")}
        <span className="empty-cursor" />
      </p>
      <p className="empty-hint">{t("chat.draftEmpty.hint")}</p>
    </div>
  );
};

export default DraftEmpty;

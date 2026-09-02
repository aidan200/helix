/**
 * 消息气泡（F(7).1；tokens.md 14 节形态契约）：
 * user = violet 气泡（右上角 2px 小角）+ U 头像；assistant = cyan 气泡（左上角
 * 2px 小角）+ HX 头像 + glow；steer 消息带队列徽标（两态，SM-3）。
 * 时间轴语义分层：source=closure/progress 的系统注入条目不进气泡面
 * （MessageFlow EntryView 分发为 SystemInjectBar 细条），气泡徽标只剩
 * 用户 steer 两态。
 */
import { memo } from "react";
import type { MessageEntryDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { formatTs } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import MarkdownMessage from "./MarkdownMessage";
import ImageStrip from "@/shared/ui/ImageStrip";

/** steer 徽标：queued = violet 脉冲点；drained = success「已注入」（SM-3 两态）。 */
function SteerBadge({ state }: { state: "queued" | "drained" }) {
  const { t } = useI18n();
  if (state === "drained") {
    return <span className="steer-badge drained">{t("chat.steer.drained")}</span>;
  }
  return (
    <span className="steer-badge">
      <span className="q-dot" />
      {t("chat.steer.queued")}
    </span>
  );
}

interface MessageBubbleProps {
  entry: MessageEntryDto;
  /** 流式中的 assistant 气泡（尾部光标 + 边框提亮） */
  streaming?: boolean;
  /** 流式文本（streaming=true 时替代 markdown 正文，末尾接光标） */
  streamingText?: string;
}

const MessageBubble = memo(function MessageBubble({
  entry,
  streaming = false,
  streamingText,
}: MessageBubbleProps) {
  const { t } = useI18n();
  const isUser = entry.role === "user";
  return (
    <div className={cn("msg", isUser ? "user" : "assistant", streaming && "streaming")}>
      <div className="avatar">{isUser ? "U" : "HX"}</div>
      <div className="col">
        <div className="meta">
          <span className="who">{isUser ? t("chat.msg.you") : t("chat.msg.agent")}</span>
          <span className="ts">{formatTs(entry.ts, t("chat.tsFormat"))}</span>
        </div>
        {entry.steerState && <SteerBadge state={entry.steerState} />}
        <div className="bubble">
          {streaming ? (
            <>
              <MarkdownMessage text={streamingText ?? ""} />
              <span className="stream-cursor" />
            </>
          ) : (
            <MarkdownMessage text={entry.content} />
          )}
          {/* T9 图片附件缩略图（v0.10 MessageEntryDto.images；仅 user 消息携带） */}
          {entry.images && entry.images.length > 0 && <ImageStrip images={entry.images} />}
        </div>
      </div>
    </div>
  );
});

export default MessageBubble;

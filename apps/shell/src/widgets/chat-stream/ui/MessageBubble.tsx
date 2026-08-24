/**
 * 消息气泡（F(7).1；tokens.md 14 节形态契约）：
 * user = violet 气泡（右上角 2px 小角）+ U 头像；assistant = cyan 气泡（左上角
 * 2px 小角）+ HX 头像 + glow；steer 消息带队列徽标（两态，SM-3）。
 * T11b：徽标按 entry.source 分族——closure/progress 注入与用户 steer 视觉分离
 * （idle closure 注入无 steerState 也带 CLOSURE 标记）。
 */
import { memo } from "react";
import type { MessageEntryDto, SteerSource } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { formatTs } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import MarkdownMessage from "./MarkdownMessage";
import ImageStrip from "@/shared/ui/ImageStrip";

/**
 * steer 徽标：queued = violet 脉冲点；drained = success「已注入」。
 * source 变体（T11b）：closure = amber「CLOSURE ·」前缀族；progress = cyan
 * 「PROGRESS ·」前缀族；user/缺省 = 既有 STEER 形态不变。无 steerState 的
 * 注入条目（idle closure/progress 注入）= 来源标记静态徽标（无脉冲/状态文）。
 */
function SteerBadge({ state, source }: { state?: "queued" | "drained"; source?: SteerSource }) {
  const { t } = useI18n();
  const variant = source === "closure" || source === "progress" ? source : undefined;
  const label =
    source === "closure"
      ? t("chat.steer.closureBadge")
      : source === "progress"
        ? t("chat.steer.progressBadge")
        : null;
  if (state === "drained") {
    return (
      <span className={cn("steer-badge drained", variant)}>
        {label !== null && `${label} · `}
        {t("chat.steer.drained")}
      </span>
    );
  }
  if (state === "queued") {
    return (
      <span className={cn("steer-badge", variant)}>
        <span className="q-dot" />
        {label !== null && `${label} · `}
        {t("chat.steer.queued")}
      </span>
    );
  }
  // 无 steerState：idle 注入的来源标记（静态徽标，仅 closure/progress 进入此分支）
  return <span className={cn("steer-badge", variant)}>{label}</span>;
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
        {(entry.steerState || entry.source === "closure" || entry.source === "progress") && (
          <SteerBadge state={entry.steerState} source={entry.source} />
        )}
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

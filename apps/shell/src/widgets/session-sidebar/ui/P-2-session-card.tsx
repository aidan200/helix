/**
 * P-2 会话卡片（F(1.2).2 展示面 / F(1.2).4 删除二次确认；CL-1）。
 *
 * 信息密度（review.md 必须还原）：标题 + 相对时间 + 运行态徽标（跑
 * SUBAGENT = violet 脉冲 / 流式中 = cyan 脉冲 / 空闲 = off 静点）+ 未读
 * 计数 pill（badge-pop 纯 transform）。删除：hover 显现 trash → confirming
 * 态（正文降透明 + 红边确认条，文案交代「取消全部执行 + 不可恢复」）——
 * 互斥由父级 confirmingId 单值保证（一次仅一张卡）。
 * 纯展示件：数据投影经 props 注入（时间标签由父级渲染时计算）。
 */
import { memo } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import type { BackgroundSessionState } from "@/entities/session/SessionContext";

export type SessionRunState = BackgroundSessionState["runState"];

/** 运行态徽标三态（SessionMeta.runState 同源；徽标类名 + 状态点 + 文案 key）。 */
export function runBadgeOf(runState: SessionRunState): {
  badge: string;
  dot: string;
  labelKey: string;
} {
  switch (runState) {
    case "streaming":
      return { badge: "hud-badge-cyan", dot: "hud-dot-cyan hud-dot-pulse", labelKey: "chat.sidebar.runStreaming" };
    case "subagent_running":
      return {
        badge: "hud-badge-violet",
        dot: "hud-dot-violet hud-dot-pulse",
        labelKey: "chat.sidebar.runSubagent",
      };
    default:
      return { badge: "hud-badge-off", dot: "hud-dot-idle", labelKey: "chat.sidebar.runIdle" };
  }
}

export interface SessionCardProps {
  sessionId: string;
  title: string;
  timeLabel: string;
  runState: SessionRunState;
  unread: number;
  active: boolean;
  confirming: boolean;
  onSwitch: (sessionId: string) => void;
  onDeleteRequest: (sessionId: string) => void;
  onDeleteConfirm: (sessionId: string) => void;
  onDeleteCancel: () => void;
}

const SessionCard = memo(function SessionCard({
  sessionId,
  title,
  timeLabel,
  runState,
  unread,
  active,
  confirming,
  onSwitch,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: SessionCardProps) {
  const { t } = useI18n();
  const badge = runBadgeOf(runState);
  return (
    <div
      className={cn("ses", active && "active", confirming && "confirming")}
      data-session-card={sessionId}
      data-run-state={runState}
      data-unread={unread > 0 ? unread : undefined}
      data-title={title}
      data-active={active ? "1" : undefined}
      data-confirming={confirming ? "1" : undefined}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      onClick={() => {
        if (confirming) return; // confirming 态点击卡片不触发切换
        onSwitch(sessionId);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!confirming) onSwitch(sessionId);
        }
      }}
    >
      <div className="ses-row1">
        <span className="ses-title">{title}</span>
        <button
          className="ses-del"
          type="button"
          title={t("chat.sidebar.deleteTitle")}
          aria-label={t("chat.sidebar.deleteTitle")}
          onClick={(e) => {
            e.stopPropagation();
            onDeleteRequest(sessionId);
          }}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="ses-row2">
        <span className="ses-time">{timeLabel}</span>
        {unread > 0 && (
          <span className="ses-unread pulse" title={String(unread)}>
            {unread}
          </span>
        )}
        <span className={cn("hud-badge", badge.badge)}>
          <span className={cn("hud-dot", badge.dot)} />
          {t(badge.labelKey)}
        </span>
      </div>
      <div className="ses-confirm">
        <p className="sc-text">{t("chat.sidebar.deleteConfirmText")}</p>
        <div className="sc-row">
          <button
            className="hud-btn hud-btn-danger sc-yes"
            type="button"
            data-del-confirm
            onClick={(e) => {
              e.stopPropagation();
              onDeleteConfirm(sessionId);
            }}
          >
            {t("chat.sidebar.deleteConfirm")}
          </button>
          <button
            className="hud-btn hud-btn-ghost sc-no"
            type="button"
            data-del-cancel
            onClick={(e) => {
              e.stopPropagation();
              onDeleteCancel();
            }}
          >
            {t("chat.sidebar.deleteCancel")}
          </button>
        </div>
      </div>
    </div>
  );
});

export default SessionCard;

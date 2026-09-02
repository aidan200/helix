/**
 * 系统注入细条（时间轴语义分层：气泡 = 人说的话，细条 = 系统的注入）：
 * closure（SubAgent 收口注入）/ progress（周期进展报告）条目不再是 user
 * 气泡——它们是系统行为，披气泡易被读成「用户说过这话」。
 *
 * 形态与 DirectedSteer 同族（行内轻量细条，非气泡）：2px 左边线 +
 * 来源 chip（CLOSURE / PROGRESS）+ 正文 + steerState 两态小字
 * （queued=已入队 / drained=已注入；idle 注入无 steerState 不显示状态文）。
 * 色面复用既有通道（closure=--warning-rgb / progress=--accent-rgb），无新 token。
 */
import { memo } from "react";
import type { SteerState } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";

interface SystemInjectBarProps {
  /** 注入来源（判别键；chip 文案与色调随源分族） */
  source: "closure" | "progress";
  /** 注入正文（closure 摘要 / 进展报告原文） */
  text: string;
  /** 运行中注入的两态（idle 注入缺省 → 无状态文） */
  steerState?: SteerState;
}

const SystemInjectBar = memo(function SystemInjectBar({ source, text, steerState }: SystemInjectBarProps) {
  const { t } = useI18n();
  const chip = source === "closure" ? t("chat.steer.closureBadge") : t("chat.steer.progressBadge");
  const stateText =
    steerState === "queued"
      ? t("chat.steer.queued")
      : steerState === "drained"
        ? t("chat.steer.drained")
        : null;
  return (
    <div className={cn("system-inject", source)} data-kind="system-inject" data-source={source}>
      <span className="si-chip">{chip}</span>
      <span className="si-text">{text}</span>
      {stateText !== null && <span className="si-state">{stateText}</span>}
    </div>
  );
});

export default SystemInjectBar;

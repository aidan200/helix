/**
 * 定向 steer 细条（CL-3，契约 v0.3 §3.2 Q-3a 双处可见的同构物种）：
 * violet 2px 左边线 + 「steer → {目标}」chip + 正文——行内轻量细条，非气泡。
 * 双处消费：时间轴侧 MessageFlow（主轴 isSteer && instanceId≠main entry）
 * 与抽屉侧 ChannelTimeline（steer-directed channel 条目）；两侧同组件同
 * 类名，物种一致性由 F 层剧本断言（R-P3-4）。
 * 色面全引 --violet-rgb 既有通道（review.md §7：无新 token）。
 */
import { memo } from "react";
import { useI18n } from "@/shared/i18n";

interface DirectedSteerProps {
  /** 目标实例 id（chip 文本 + data-target 锚点） */
  target: string;
  /** 干预正文 */
  text: string;
}

const DirectedSteer = memo(function DirectedSteer({ target, text }: DirectedSteerProps) {
  const { t } = useI18n();
  return (
    <div className="steer-directed" data-kind="steer-directed" data-target={target}>
      <span className="sd-chip">{t("chat.steer.directedChip", { id: target })}</span>
      <span className="sd-text">{text}</span>
    </div>
  );
});

export default DirectedSteer;

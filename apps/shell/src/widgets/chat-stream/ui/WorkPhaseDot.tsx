/**
 * WorkPhaseDot —— chat 状态行右槽工作段位呼吸光点（纯展示组件；
 * widgets/chat-stream 域组件，仅 ChatStatusBar 消费；T1 行内形态）。
 *
 * 数据源 = selectWorkPhase 槽位活跃推导（aborting > thinking > tool >
 * reply > working；idle 不渲染——现状逻辑保留，idle 时右槽空）。颜色
 * 语义走主题主副配色：
 * - thinking → violet（副色 = 对内思考惯例：think-live 光标/steer 族同源）；
 * - tool/reply → accent（主色 = 对外产出惯例：工具卡 running/assistant 流）；
 * - working → text-dim 中性（活着但无具体产出——静默兜底段）；
 * - aborting → warning（语义警示，仅中断瞬间）。
 * 全部消费 tokens.css 变量，暗/亮主题自动跟随。呼吸动画复用 hud-pulse。
 * E-89：行内槽位驻 ChatStatusBar（滚动容器之外）——旧浮动形态
 * （absolute 钉 .msg-flow-wrap 右下）随 T1 状态行收拢退役；sticky 驻
 * 滚动容器内自始禁用（WKWebView 对 sticky 元素内文本更新不重绘缺陷）。
 */
import { memo } from "react";
import { useI18n } from "@/shared/i18n";
import type { WorkPhase } from "@/entities/session/model/session-reducer";

const PHASE_I18N_KEY: Record<Exclude<WorkPhase, "idle">, string> = {
  thinking: "chat.phase.thinking",
  tool: "chat.phase.tool",
  reply: "chat.phase.reply",
  working: "chat.phase.working",
  aborting: "chat.phase.aborting",
};

export const WorkPhaseDot = memo(function WorkPhaseDot({ phase }: { phase: Exclude<WorkPhase, "idle"> }) {
  const { t } = useI18n();
  return (
    <div className="wp-inline" data-phase={phase}>
      <span className="hud-dot hud-dot-pulse wp-dot" aria-hidden="true" />
      <span className="wp-label">{t(PHASE_I18N_KEY[phase])}</span>
    </div>
  );
});

export default WorkPhaseDot;

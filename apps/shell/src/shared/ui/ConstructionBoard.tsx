/**
 * 静态施工牌模板（F(4.4).3；CL-4，Q-4c；T3.4）。
 *
 * Cyber HUD 空态语言的围挡扩展：虚线围挡边框大框（edge/0.18 dashed +
 * 四角 HUD 角标）+ 64px 虚线图标格 + 页名 + 路由行 + 一句话能力预告
 * （≤32ch，只陈述能力不做路线暗示）+「规划中」徽标（hud-badge-cyan）。
 * 全静态：无动效、无操作入口（与断连态三重区分：色相 accent vs error /
 * 线型虚线围挡 vs 实边 / 无操作 vs 重连按钮）。
 *
 * 现仅 project 占位页使用（S4 时点：trace/settings 已实页、skills 已升格
 * 智能体页，均不再用施工牌），仅图标/页名/路由/预告文案由页面注入；
 * 占位页本身是终态呈现（无 loading/error）。
 */
import type { LucideIcon } from "lucide-react";
import { useI18n } from "@/shared/i18n";

export interface ConstructionBoardProps {
  icon: LucideIcon;
  /** 页名（text-head 600）。 */
  name: string;
  /** 路由行（text-micro faint；同时作 data-construction 断言锚）。 */
  route: string;
  /** 一句话能力预告（≤32ch，无时间承诺词）。 */
  preview: string;
}

const ConstructionBoard = function ConstructionBoard({
  icon: Icon,
  name,
  route,
  preview,
}: ConstructionBoardProps) {
  const { t } = useI18n();
  return (
    <div className="construction" data-construction={route}>
      <div className="construction-frame">
        <div className="cs-icon">
          <Icon size={28} strokeWidth={1.75} aria-hidden="true" />
        </div>
        <p className="cs-name">{name}</p>
        <p className="cs-route">{route}</p>
        <p className="cs-preview">{preview}</p>
        <span className="hud-badge hud-badge-cyan">{t("chat.nav.plannedBadge")}</span>
      </div>
    </div>
  );
};

export default ConstructionBoard;

/**
 * IconRail 导航壳（F(4.4).1；CL-4，Q-4a；T3.4；S1 应用壳统一改造）。
 *
 * 64px glass 竖条 = HelixLogo 渐变图标（S1 用户裁决：替换原 "HX" 文字，
 * 同 chat header 品牌图标；40px 发光外框保留）+ 六图标钮（40×40，序 =
 * chat/models/skills/trace/project/settings，lucide 同名）+ 主题切换
 * 单钮（Sun/Moon 显示切换目标，置于底部头像块上方）+ 头像块。激活态
 * 三件套（cyan 发光底 + 左 2px 指示条 + BorderBeam 巡游，样式全部在
 * nav-rail.css）；非激活 hover 提亮。
 *
 * 纯展示组件（页面域/会话域分离，TR-AD-8 修订条款）：路由表/激活态/
 * 导航回调/主题态全部由 app 层经 props 注入，不读会话 store、不读
 * ThemeContext、不感知 URL 机制。
 */
import type { LucideIcon } from "lucide-react";
import { Moon, Sun } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import HelixLogo from "@/shared/ui/HelixLogo";
import type { Theme } from "@/shared/ui/theme";

/** 单个导航位（app 层装配注入；route 为路由常量字符串）。 */
export interface IconRailItem<T extends string = string> {
  /** 页 id（chat/models/skills/trace/project/settings；data-page 断言面）。 */
  id: string;
  /** 目标路由（点击 pushState 由调用方执行）。 */
  route: T;
  /** i18n label key（aria-label/title）。 */
  labelKey: string;
  icon: LucideIcon;
}

export interface IconRailProps<T extends string = string> {
  items: readonly IconRailItem<T>[];
  /** 当前激活路由（六态互斥恰一激活由路由层保证）。 */
  active: T;
  onNavigate: (route: T) => void;
  /** 当前主题（app 层 useTheme 注入；单钮图标 = 切换目标）。 */
  theme: Theme;
  /** 主题切换回调（纯 props 注入，不读 ThemeContext）。 */
  onToggleTheme: () => void;
}

const IconRail = function IconRail<T extends string>({
  items,
  active,
  onNavigate,
  theme,
  onToggleTheme,
}: IconRailProps<T>) {
  const { t } = useI18n();
  return (
    <nav className="icon-rail" aria-label={t("chat.nav.railLabel")}>
      <div className="rail-logo" aria-hidden="true">
        <HelixLogo size={22} />
      </div>
      <div className="rail-nav" role="tablist">
        {items.map((item) => {
          const Icon = item.icon;
          const on = item.route === active;
          const label = t(item.labelKey);
          return (
            <button
              key={item.id}
              className={cn("rail-btn", on && "on")}
              type="button"
              role="tab"
              aria-selected={on}
              data-page={item.id}
              title={label}
              aria-label={label}
              onClick={() => onNavigate(item.route)}
            >
              <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {/* 主题切换单钮（S1 用户裁决：头像块上方；Sun/Moon = 切换目标） */}
      <button
        id="btn-theme-toggle"
        className="rail-btn rail-theme-btn"
        type="button"
        title={t("chat.nav.themeToggle")}
        aria-label={t("chat.nav.themeToggle")}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? (
          <Sun size={18} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Moon size={18} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
      {/* 底部头像块（静态占位，无用户系统——AD-1 只做框架） */}
      <div className="rail-avatar" aria-hidden="true">
        SI
      </div>
    </nav>
  );
};

export default IconRail;

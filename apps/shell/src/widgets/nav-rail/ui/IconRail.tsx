/**
 * IconRail 导航壳（F(4.4).1；CL-4，Q-4a；T3.4；S1 应用壳统一改造）。
 *
 * 64px glass 竖条 = HelixLogo 渐变图标（S1 用户裁决：替换原 "HX" 文字，
 * 同 chat header 品牌图标；40px 发光外框保留）+ 五图标钮（40×40，序 =
 * chat/skills/trace/project/settings，lucide 同名；S2：models 位退役，
 * 模型配置归设置页分区）+ 联网状态钮（T4，契约 v0.7 web 族：主题钮
 * 上方，三态灰/绿/红 + 点击 popover 连接详情与 tab 清单 + 停止并清理）+
 * 主题切换单钮（Sun/Moon 显示切换目标，置于底部头像块上方）+ 头像块。
 * 激活态三件套（cyan 发光底 + 左 2px 指示条 + BorderBeam 巡游，样式全部在
 * nav-rail.css）；非激活 hover 提亮。
 *
 * 纯展示组件（页面域/会话域分离，TR-AD-8 修订条款）：路由表/激活态/
 * 导航回调/主题态/联网状态/停止回调全部由 app 层经 props 注入，不读会话
 * store、不读 ThemeContext、不感知 URL 机制（popover 开合为组件本地 UI
 * 态，与外部数据面零耦合）。
 */
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Globe, Moon, Sun } from "lucide-react";
import type { WebStatusPayload } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import HelixLogo from "@/shared/ui/HelixLogo";
import type { Theme } from "@/shared/ui/theme";

/** 单个导航位（app 层装配注入；route 为路由常量字符串）。 */
export interface IconRailItem<T extends string = string> {
  /** 页 id（chat/skills/trace/project/settings；data-page 断言面）。 */
  id: string;
  /** 目标路由（点击 pushState 由调用方执行）。 */
  route: T;
  /** i18n label key（aria-label/title）。 */
  labelKey: string;
  icon: LucideIcon;
}

export interface IconRailProps<T extends string = string> {
  items: readonly IconRailItem<T>[];
  /** 当前激活路由（五态互斥恰一激活由路由层保证）。 */
  active: T;
  onNavigate: (route: T) => void;
  /** 当前主题（app 层 useTheme 注入；单钮图标 = 切换目标）。 */
  theme: Theme;
  /** 主题切换回调（纯 props 注入，不读 ThemeContext）。 */
  onToggleTheme: () => void;
  /** CDP 联网状态（app 层注入 topology.webStatus；null = 未收到任何状态帧 → 灰态）。 */
  webStatus: WebStatusPayload | null;
  /** 停止并清理回调（纯 props 注入；app 层发 web.stop 命令帧）。 */
  onStopWeb: () => void;
}

const IconRail = function IconRail<T extends string>({
  items,
  active,
  onNavigate,
  theme,
  onToggleTheme,
  webStatus,
  onStopWeb,
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
      {/* 联网状态钮（T4：主题钮上方；三态 + popover 详情/清单/停止） */}
      <WebStatusButton webStatus={webStatus} onStopWeb={onStopWeb} />
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

/** tab 行闲置时长三档（<1min 刚刚 / <1h 分钟 / 小时）。 */
function idleText(t: (key: string, params?: Record<string, string | number>) => string, lastAccessed: number): string {
  const ms = Date.now() - lastAccessed;
  if (ms < 60_000) return t("chat.web.idleJustNow");
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return t("chat.web.idleMinutes", { minutes });
  return t("chat.web.idleHours", { hours: Math.floor(minutes / 60) });
}

/**
 * 联网状态钮（T4，契约 v0.7 web 族）：三态（idle/connecting 灰 →
 * connected 绿点呼吸 → error 红）+ 点击 popover（连接详情 + tab 清单 +
 * 停止并清理）。props 注入纯展示（popover 开合为本地 UI 态）。
 */
function WebStatusButton({ webStatus, onStopWeb }: { webStatus: WebStatusPayload | null; onStopWeb: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const state = webStatus?.state ?? "idle"; // null（首连前未收帧）= 灰态未连接
  const stateText =
    state === "connected"
      ? t("chat.web.stateConnected")
      : state === "connecting"
        ? t("chat.web.stateConnecting")
        : state === "error"
          ? t("chat.web.stateError")
          : t("chat.web.stateIdle");
  const title =
    state === "connected" && webStatus?.browser !== undefined
      ? `${t("chat.web.button")}：${t("chat.web.connectedTitle", { browser: webStatus.browser.label, count: webStatus.tabCount })}`
      : `${t("chat.web.button")}：${stateText}`;

  // 点外关闭 / Esc（model-switch popover 先例；钮自身点击归 toggle 不在此误关）
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest("#btn-web-status, .web-pop")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="rail-web">
      <button
        id="btn-web-status"
        className={cn("rail-btn rail-web-btn", open && "open")}
        type="button"
        data-web-state={state}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Globe size={18} strokeWidth={1.75} aria-hidden="true" />
        <span className="web-dot" aria-hidden="true" />
      </button>
      {open && (
        <div className="web-pop" role="dialog" aria-label={t("chat.web.button")}>
          <div className="web-pop-head">
            <span className="web-pop-title">{t("chat.web.button")}</span>
            <span className={cn("web-state-chip", `is-${state}`)}>{stateText}</span>
          </div>
          {state === "error" && webStatus?.error !== undefined && (
            <div className="web-pop-error">{webStatus.error}</div>
          )}
          {webStatus?.browser !== undefined && (
            <div className="web-pop-rows">
              <div className="web-pop-row">
                <span className="wp-label">{t("chat.web.browserLabel")}</span>
                <span className="wp-value">{webStatus.browser.label}</span>
              </div>
              <div className="web-pop-row">
                <span className="wp-label">{t("chat.web.portLabel")}</span>
                <span className="wp-value">{webStatus.browser.port}</span>
              </div>
              <div className="web-pop-row">
                <span className="wp-label">{t("chat.web.tabCountLabel")}</span>
                <span className="wp-value">{webStatus.tabCount}</span>
              </div>
            </div>
          )}
          <div className="web-pop-tabs">
            <div className="wp-label">{t("chat.web.tabsTitle")}</div>
            {webStatus !== null && webStatus.tabs.length > 0 ? (
              <ul className="web-tab-list">
                {webStatus.tabs.map((tab) => (
                  <li className="web-tab-row" key={tab.tabId}>
                    <span className="wt-title" title={tab.url}>{tab.title || tab.url}</span>
                    <span className="wt-meta">{tab.ownerId} · {idleText(t, tab.lastAccessed)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="web-tab-empty">{t("chat.web.tabsEmpty")}</div>
            )}
          </div>
          <button
            id="btn-web-stop"
            className="hud-btn hud-btn-ghost sm web-stop-btn"
            type="button"
            disabled={state === "idle"} // 未连接无可停（stop 幂等；禁用防误点）
            onClick={onStopWeb}
          >
            {t("chat.web.stop")}
          </button>
        </div>
      )}
    </div>
  );
}

export default IconRail;

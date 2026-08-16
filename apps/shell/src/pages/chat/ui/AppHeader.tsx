/**
 * 应用壳 header（48px）：brand + main-session/~/.helix chip + 统计徽标
 * （F3.3，插模型徽标左侧）+ 模型徽标（welcome/快照 DTO 下发的 config model
 * 值）+ 连接状态四态 + 主题切换。
 *
 * v0.1（T4.2）：usage popover（F3.4）以 .app 直接子元素渲染（header 自带
 * backdrop-filter 会成为 absolute 后代的包含块，浮层定位需挂在 .app 层——
 * 与原型 DOM 同构：stats-pop 为 app-header 的兄弟节点）；开合态归本组件
 * （纯 UI 态）。
 */
import { useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/ui/theme";
import { useSession, type ConnState } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import { StatsBadge, UsagePopover } from "./SessionStats";

/** 连接 dot 类名（F(7).4 四态：绿常亮/黄脉冲/红脉冲/红常亮）。 */
function dotClass(conn: ConnState): string {
  switch (conn) {
    case "connected":
      return "hud-dot hud-dot-ok";
    case "connecting":
      return "hud-dot hud-dot-warn hud-dot-pulse";
    case "disconnected":
      return "hud-dot hud-dot-error hud-dot-pulse";
    case "error":
      return "hud-dot hud-dot-error";
  }
}

interface AppHeaderProps {
  /** 开实例抽屉（T4.3 接线；当前占位）——popover SubAgent 行尾跳转，payload = instanceId（≡ agentId，AD-3） */
  onOpenInstance?: (instanceId: string) => void;
}

const AppHeader = function AppHeader({ onOpenInstance }: AppHeaderProps = {}) {
  const { t } = useI18n();
  const { state } = useSession();
  const { theme, setTheme } = useTheme();
  const [statsOpen, setStatsOpen] = useState(false);

  const connLabel = t(`chat.conn.${state.conn}`);

  return (
    <>
      <header className="app-header">
        <div className="brand">
          HELiX<span className="b2">·2</span>
        </div>
        <span className="hud-chip">{t("chat.header.session")}</span>
        <span className="hud-chip">{t("chat.header.home")}</span>
        <div className="header-right">
          <StatsBadge open={statsOpen} onToggle={() => setStatsOpen((v) => !v)} />
          {state.model && <span className="hud-badge hud-badge-off">{state.model}</span>}
          <span className="conn-status" role="status">
            <span className={dotClass(state.conn)} />
            <span>{connLabel}</span>
          </span>
          <div className="theme-toggle" role="group" aria-label="theme">
            <button
              id="btn-dark"
              className={cn("tt-btn", theme === "dark" && "on")}
              type="button"
              onClick={() => setTheme("dark")}
            >
              {t("chat.theme.dark")}
            </button>
            <button
              id="btn-light"
              className={cn("tt-btn", theme === "light" && "on")}
              type="button"
              onClick={() => setTheme("light")}
            >
              {t("chat.theme.light")}
            </button>
          </div>
        </div>
      </header>
      {statsOpen && (
        <UsagePopover onClose={() => setStatsOpen(false)} onOpenInstance={onOpenInstance} />
      )}
    </>
  );
};

export default AppHeader;

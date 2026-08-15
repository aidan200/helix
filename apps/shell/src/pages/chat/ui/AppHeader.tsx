/**
 * 应用壳 header（48px）：brand + main-session/~/.helix chip + 模型徽标
 * （welcome/快照 DTO 下发的 config model 值）+ 连接状态四态 + 主题切换。
 */
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/ui/theme";
import { useSession, type ConnState } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";

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

const AppHeader = function AppHeader() {
  const { t } = useI18n();
  const { state } = useSession();
  const { theme, setTheme } = useTheme();

  const connLabel = t(`chat.conn.${state.conn}`);

  return (
    <header className="app-header">
      <div className="brand">
        HELiX<span className="b2">·2</span>
      </div>
      <span className="hud-chip">{t("chat.header.session")}</span>
      <span className="hud-chip">{t("chat.header.home")}</span>
      <div className="header-right">
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
  );
};

export default AppHeader;

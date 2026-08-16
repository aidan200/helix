/**
 * P-1 顶栏（F(2.1).3 信息区；CL-2；widgets/top-bar）。
 *
 * 左 = brand + 会话标题（随切换同步；草稿态取词条）+ main-session/~/.helix
 * chip + daemon 状态徽标（连接语义沿既有连接状态剧本 F(7).4 四态）；右 =
 * 统计徽标（F3.3）+ 模型徽标位（P-3 入口——本任务渲染 topology 面 model
 * 态，点击行为 T3.3）+ 主题切换 + 设置齿轮（P-4 路由入口 F(2.1).4）。
 *
 * 升级自 pages/chat/ui/AppHeader（48px .app-header 语义不变——F 层既有
 * 断言面）；usage popover 仍以 .app 直接子元素渲染（backdrop-filter 包含
 * 块约束，与原型 DOM 同构）。
 */
import { useState } from "react";
import { ChevronDown, Settings } from "lucide-react";
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

export interface TopBarProps {
  /** 开实例抽屉（popover SubAgent 行尾跳转；payload = instanceId ≡ agentId） */
  onOpenInstance?: (instanceId: string) => void;
  /** P-4 路由入口（F(2.1).4 齿轮；app 层注入 navigate） */
  onOpenSettings?: () => void;
}

const noop = () => {};

const AppHeader = function AppHeader({ onOpenInstance = noop, onOpenSettings = noop }: TopBarProps = {}) {
  const { t } = useI18n();
  const { state, topology } = useSession();
  const { theme, setTheme } = useTheme();
  const [statsOpen, setStatsOpen] = useState(false);

  const connLabel = t(`chat.conn.${state.conn}`);
  // 会话标题（F(2.1).3 左区）：清单元数据；草稿态取词条
  const sessionTitle =
    state.sessionId === null
      ? t("chat.topbar.draftTitle")
      : (topology.list.find((m) => m.sessionId === state.sessionId)?.title ?? "");

  return (
    <>
      <header className="app-header">
        <div className="brand">
          HELiX<span className="b2">·2</span>
        </div>
        <span className="tb-title" data-session-title title={sessionTitle}>
          {sessionTitle}
        </span>
        <span className="hud-chip">{t("chat.header.session")}</span>
        <span className="hud-chip">{t("chat.header.home")}</span>
        <div className="header-right">
          <StatsBadge open={statsOpen} onToggle={() => setStatsOpen((v) => !v)} />
          {state.model && (
            <button
              className="hud-badge model-badge"
              type="button"
              data-model-badge
              title={t("chat.topbar.modelTitle")}
              aria-label={t("chat.topbar.modelTitle")}
            >
              <span className="mb-dot" aria-hidden="true" />
              {state.model}
              <ChevronDown className="mb-chev" size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
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
          <button
            className="icon-btn"
            id="btn-settings"
            type="button"
            data-settings
            title={t("chat.topbar.settingsTitle")}
            aria-label={t("chat.topbar.settingsTitle")}
            onClick={onOpenSettings}
          >
            <Settings size={16} strokeWidth={1.75} />
          </button>
        </div>
      </header>
      {statsOpen && (
        <UsagePopover onClose={() => setStatsOpen(false)} onOpenInstance={onOpenInstance} />
      )}
    </>
  );
};

export default AppHeader;

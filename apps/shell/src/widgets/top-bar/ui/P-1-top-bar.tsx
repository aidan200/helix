/**
 * P-1 顶栏槽内容（F(2.1).3 信息区；CL-2；widgets/top-bar）。S1 应用壳
 * 统一重构：AppHeader 退役，拆为两个「header 槽内容」组件（不自渲染
 * `<header>`——header 壳归 AppLayout）：
 *
 * - TopBarInfo（headerLeft 槽）= 会话标题（随切换同步；草稿态取词条）+
 *   main-session/~/.helix chip；
 * - TopBarActions（headerRight 槽，受控开合）= 统计徽标（F3.3）+ 模型
 *   徽标位（P-3 入口——渲染 topology 面 model 态）+ 连接状态徽标（F(7).4
 *   四态）。popover（UsagePopover/ModelSwitchMenu）由装配层（Workbench）
 *   渲染在 AppLayout 平级——backdrop-filter 包含块约束：.app-header 带
 *   blur，popover 若入 header 会丢失毛玻璃采样（S1 布局契约 docblock）。
 *
 * 草稿徽标 fallback 加载链（bug4 追修）原样保留在 TopBarActions。
 * S1 清理：brand 位（HelixLogo 迁 IconRail）、主题分段双钮（迁 IconRail
 * 单钮）、设置齿轮及 onOpenSettings prop 链全部退役。
 */
import { useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { useSession, type ConnState } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import { StatsBadge } from "./SessionStats";

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

/** headerLeft 槽内容：会话标题 + 环境双 chip。 */
export const TopBarInfo = function TopBarInfo() {
  const { t } = useI18n();
  const { state, topology } = useSession();
  // 会话标题（F(2.1).3 左区）：清单元数据；草稿态取词条
  const sessionTitle =
    state.sessionId === null
      ? t("chat.topbar.draftTitle")
      : (topology.list.find((m) => m.sessionId === state.sessionId)?.title ?? "");
  return (
    <>
      <span className="tb-title" data-session-title title={sessionTitle}>
        {sessionTitle}
      </span>
      <span className="hud-chip">{t("chat.header.session")}</span>
      <span className="hud-chip">{t("chat.header.home")}</span>
    </>
  );
};

export interface TopBarActionsProps {
  /** 统计 popover 开合（受控——popover 由装配层渲染）。 */
  statsOpen: boolean;
  /** 模型菜单开合（受控——popover 由装配层渲染）。 */
  modelMenuOpen: boolean;
  onToggleStats: () => void;
  onToggleModelMenu: () => void;
}

/** headerRight 槽内容：StatsBadge + 模型徽标 + 连接状态（受控开合）。 */
export const TopBarActions = function TopBarActions({
  statsOpen,
  modelMenuOpen,
  onToggleStats,
  onToggleModelMenu,
}: TopBarActionsProps) {
  const { t } = useI18n();
  const { state, topology, requestModelConfig } = useSession();

  const connLabel = t(`chat.conn.${state.conn}`);
  // 草稿态徽标数据源（T3，bug4）：sessionId===null + view ready + connected 时
  // state.model（本地暂存所选）空 → 回退全局默认模型；两者皆空才不显示。
  // 其余态维持现状（state.model 空不显示）。
  const isDraftReady =
    state.sessionId === null && state.view === "ready" && state.conn === "connected";
  const badgeModel = isDraftReady
    ? state.model || topology.modelConfig.defaultModel
    : state.model;

  // 草稿徽标 fallback 加载链（bug4 追修）：草稿态展示模型为空且全局默认
  // 未加载时主动拉取——新建草稿不经菜单/模型页，defaultModel 可能从未
  // 请求过（provider 侧幂等：defaultModel 非空零重发）。
  useEffect(() => {
    if (isDraftReady && !state.model && topology.modelConfig.defaultModel === "") {
      requestModelConfig();
    }
  }, [isDraftReady, state.model, topology.modelConfig.defaultModel, requestModelConfig]);

  return (
    <>
      <StatsBadge open={statsOpen} onToggle={onToggleStats} />
      {badgeModel && (
        <button
          className={cn("hud-badge model-badge", modelMenuOpen && "open")}
          type="button"
          data-model-badge
          title={t("chat.topbar.modelTitle")}
          aria-label={t("chat.topbar.modelTitle")}
          aria-expanded={modelMenuOpen}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            onToggleModelMenu();
          }}
        >
          <span className="mb-dot" aria-hidden="true" />
          {badgeModel}
          <ChevronDown className="mb-chev" size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
      <span className="conn-status" role="status">
        <span className={dotClass(state.conn)} />
        <span>{connLabel}</span>
      </span>
    </>
  );
};

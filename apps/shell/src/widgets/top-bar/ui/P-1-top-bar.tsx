/**
 * P-1 顶栏槽内容（F(2.1).3 信息区；CL-2；widgets/top-bar）。S1 应用壳
 * 统一重构：AppHeader 退役，拆为两个「header 槽内容」组件（不自渲染
 * `<header>`——header 壳归 AppLayout）：
 *
 * - TopBarInfo（headerLeft 槽）= 会话标题（随切换同步；草稿态取词条）+
 *   main-session/~/.helix chip；
 * - TopBarActions（headerRight 槽，受控开合）= 统计徽标（F3.3）+ 模型徽标位
 *   （P-3 入口——渲染 topology 面 model 态）+ 连接状态徽标（F(7).4 四态）。
 *   管家入口已随全局化批退役（IconRail 管家位接管——app 壳级常驻能力）。
 *   popover（UsagePopover/ModelSwitchMenu）由装配层（Workbench）渲染在
 *   AppLayout 平级——backdrop-filter 包含块约束：.app-header 带 blur，
 *   popover 若入 header 会丢失毛玻璃采样（S1 布局契约 docblock）。
 *
 * 草稿徽标 fallback 加载链（bug4 追修）原样保留在 TopBarActions。
 * S1 清理：brand 位（HelixLogo 迁 IconRail）、主题分段双钮（迁 IconRail
 * 单钮）、设置齿轮及 onOpenSettings prop 链全部退役。
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { MODES } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { useSession, type ConnState } from "@/entities/session/SessionContext";
import { selectModeSlot } from "@/entities/session/model/consumers/agent-config";
import { selectActiveRunState } from "@/entities/session/model/topology";
import { useWorkspace } from "@/entities/workspace/WorkspaceContext";
import { cn } from "@/shared/lib/cn";
import { useDismissOnOutside } from "@/shared/lib/useDismissOnOutside";
import { MODEL_BADGE_ATTR } from "@/shared/lib/model-menu-contract";
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

/**
 * daemon 陈旧警示 chip（stale-indicator 批，§17.15）：welcome.daemonFreshness.
 * stale=true 时渲染在连接状态区（琥珀警告色 hud-chip 语言）。hover 显示 daemon
 * 启动时间；点击复制重启提示（Ctrl+C 后 bun run dev）。无轮询——状态随
 * 握手定格，daemon 重启重连即消警。
 */
function DaemonStaleChip({ startedAt }: { startedAt: number }) {
  const { t } = useI18n();
  const started = new Date(startedAt).toLocaleString();
  const copyHint = t("chat.conn.staleChipCopy");
  return (
    <button
      type="button"
      className="hud-chip stale-chip"
      data-testid="daemon-stale-chip"
      title={t("chat.conn.staleChipTitle", { time: started })}
      aria-label={`${t("chat.conn.staleChip")}（${started}）`}
      onClick={() => {
        void navigator.clipboard?.writeText(copyHint);
      }}
    >
      <span className="hud-dot hud-dot-warn" aria-hidden="true" />
      {t("chat.conn.staleChip")}
    </button>
  );
}

/** 模式显示名（P1 T4）：注册表内 id → chat.mode.<id> 词条；未知 id（wire
 *  防御）原样透显（不落词条 fallback 避免渲染 key 本身）。 */
function modeLabelOf(t: (key: string) => string, mode: string): string {
  return MODES.some((m) => m.id === mode) ? t(`chat.mode.${mode}`) : mode;
}

/** 模式 chip（headerLeft 槽；P1 T4）：草稿态 = 选择器（下拉选项 = MODES
 *  注册表数据驱动；切换 = setDraftMode 本地 action，reducer 内同步丢弃
 *  draft model/thinking 暂存——零 daemon 交互，mode 随首条
 *  chat.send{draft:true, mode} 上送）；已建会话 = 只读显示（快照/welcome
 *  回带定格值，缺省 default；锁定 = 无第二条写路径）。注册表单选项
 *  （MODES.length===1，code-review 低危组9）时草稿态同降级只读 chip——单
 *  选项下拉零选择面；P2 增模式后自动恢复选择器形态。 */
function ModeChip() {
  const { t } = useI18n();
  const { state, setDraftMode } = useSession();
  const [open, setOpen] = useState(false);
  const isDraft = state.sessionId === null;
  const label = modeLabelOf(t, state.mode);

  // 点外 pointerdown / Escape 关闭（open 态才挂监听；trigger 点击开合归自身；
  // 共享 hook，code-review 低危组9 三处同构收拢——pointerdown 事件形态保持，
  // 菜单项点击不误触关闭）
  useDismissOnOutside(open, ".mode-chip-wrap", () => setOpen(false), { event: "pointerdown" });

  if (!isDraft || MODES.length === 1) {
    // 已建会话 / 注册表单选项：只读显示（快照/welcome 回带；title 交代锁定语义）
    return (
      <span className="hud-chip" data-mode-chip title={t("chat.header.modeTitle")}>
        {label}
      </span>
    );
  }
  return (
    <span className="mode-chip-wrap">
      <button
        type="button"
        className="hud-chip mode-chip"
        data-mode-chip
        title={t("chat.header.modeTitle")}
        aria-label={t("chat.header.modeTitle")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <ChevronDown className="mb-chev" size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="mode-chip-menu"
          role="menu"
          aria-label={t("chat.header.modeTitle")}
          data-mode-menu
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={cn("mcm-item", m.id === state.mode && "sel")}
              role="menuitemradio"
              aria-checked={m.id === state.mode}
              data-mode-item={m.id}
              onClick={() => {
                setOpen(false); // 选中即关（mm/menu 先例）
                setDraftMode(m.id);
              }}
            >
              <span className="mcm-name">{modeLabelOf(t, m.id)}</span>
              <span className="mcm-check">
                <Check size={14} strokeWidth={1.75} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** basename（显示名；WorkspaceService.basenameOf 同式，前端展示面本地版）。 */
function basenameOfRoot(root: string): string {
  const parts = root.split(/[/\\]/).filter((s) => s !== "");
  return parts.length > 0 ? parts[parts.length - 1]! : root;
}

/**
 * workspace 指示器（W4；设计稿 §2.3 / brief 任务 1）：basename 显示 +
 * title/tooltip 全路径；点击 = 直接进入切换流（WorkspaceGatePage 带取消
 * 逃逸——top-bar 交互从简：无下拉菜单直接进 gate，mode chip 同款轻量）。
 * F2 裁决：有活跃 agent（任一会话运行中，含 SubAgent/后台）时禁用 +
 * 文案说明（selectActiveRunState + 清单 runState 双面，设置页同口径；
 * daemon WORKSPACE_E_ACTIVE_AGENT 门禁兜底）。
 */
function WorkspaceChip() {
  const { t } = useI18n();
  const { state: session, topology } = useSession();
  const { state: ws, startSwitch } = useWorkspace();
  const root = ws.current?.root ?? null;
  const agentBusy =
    selectActiveRunState(session) !== "idle" || topology.list.some((m) => m.runState !== "idle");
  if (root === null) return null; // 防御：main 态恒有绑定（门禁保证）
  return (
    <button
      type="button"
      className="hud-chip ws-chip"
      data-ws-chip
      data-busy={agentBusy ? "1" : "0"}
      title={agentBusy ? t("workspace.indicator.busyTitle", { path: root }) : root}
      aria-label={t("workspace.indicator.label", { name: basenameOfRoot(root) })}
      disabled={agentBusy}
      onClick={startSwitch}
    >
      {basenameOfRoot(root)}
    </button>
  );
}

/** headerLeft 槽内容：会话标题 + 环境双 chip + workspace 指示器。 */
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
      <ModeChip />
      <span className="hud-chip" data-home-chip>{t("chat.header.home")}</span>
      <WorkspaceChip />
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
  // 草稿态徽标数据源（P1 T4 三级回退）：sessionId===null + view ready +
  // connected 时 state.model（本地暂存所选）空 → 当前模式槽位模型
  //（agentConfig.slots，P1 T4 提升的拓扑级轻量读面）空 → 回退全局默认
  // 模型；三缀皆空才不显示。其余态维持现状（state.model 空不显示）。
  const isDraftReady =
    state.sessionId === null && state.view === "ready" && state.conn === "connected";
  const draftSlotModel = isDraftReady ? selectModeSlot(topology, state.mode)?.model : undefined;
  const badgeModel = isDraftReady
    ? state.model || draftSlotModel || topology.modelConfig.defaultModel
    : state.model;

  // 草稿徽标 fallback 加载链（bug4 追修，P1 T4 三级化）：草稿态展示模型
  // 三缀全空（本地未选 + 槽位未配/未拉取 + 全局默认未加载）时主动拉取
  // ——新建草稿不经菜单/模型页，defaultModel 可能从未请求过（provider 侧
  // 幂等：defaultModel 非空零重发；槽位读面归 provider 连接就绪拉取）。
  useEffect(() => {
    if (isDraftReady && !state.model && !draftSlotModel && topology.modelConfig.defaultModel === "") {
      requestModelConfig();
    }
  }, [isDraftReady, state.model, draftSlotModel, topology.modelConfig.defaultModel, requestModelConfig]);

  return (
    <>
      <StatsBadge open={statsOpen} onToggle={onToggleStats} />
      {badgeModel && (
        <button
          className={cn("hud-badge model-badge", modelMenuOpen && "open")}
          type="button"
          // 触发钮豁免契约（菜单点外关闭豁免）：属性名由 shared 单点导出，
          // 改名只改 contract 文件、菜单侧同源跟上
          {...{ [MODEL_BADGE_ATTR]: "" }}
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
      {state.daemonFreshness?.stale === true && (
        <DaemonStaleChip startedAt={state.daemonFreshness.startedAt} />
      )}
    </>
  );
};

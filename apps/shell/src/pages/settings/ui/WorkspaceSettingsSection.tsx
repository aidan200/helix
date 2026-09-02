/**
 * 工作空间设置卡（W4；原独立「工作空间」分区，后并入「通用配置」分区——
 * 单配置独占一页浪费，S2 分区列表同步撤项）。
 *
 * 当前绑定（全路径）+ 切换按钮 → 进入 WorkspaceGatePage 切换流（App 门禁
 * 分支接管渲染；从主壳进入带取消逃逸——首启 gate 无逃逸语义不变）。
 *
 * F2 裁决 UI（设计稿 §6-F2：v1 禁止切换）：有活跃 agent 时切换按钮禁用 +
 * 文案说明（活跃态读面 = 既有会话 store 运行态信号——selectActiveRunState
 * + 清单 runState 覆盖活跃/后台与 SubAgent，Composer abortable 先例；daemon
 * 侧 WORKSPACE_E_ACTIVE_AGENT 门禁兜底，前端禁用为 UX 前置）。
 *
 * 数据面：entities/workspace（useWorkspace）+ entities/session 活跃信号；
 * 本卡零 WS 依赖（设置页分区纯展示 + store 注入分工）。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { selectActiveRunState } from "@/entities/session/model/topology";
import { useWorkspace } from "@/entities/workspace/WorkspaceContext";

const WorkspaceSettingsSection = function WorkspaceSettingsSection() {
  const { t } = useI18n();
  const { state: session, topology } = useSession();
  const { state: ws, startSwitch } = useWorkspace();
  const root = ws.current?.root ?? null;

  // 活跃 agent 判定（F2 前置 UX 面）：活跃会话运行态（含其 SubAgent 实例）
  // 或任一后台会话非 idle → 禁切（daemon 门禁同口径兜底）。
  const agentBusy =
    selectActiveRunState(session) !== "idle" || topology.list.some((m) => m.runState !== "idle");

  return (
    <div className="hud-card" data-workspace-section>
      <div className="ws-set-row">
        <div className="ws-set-info">
          <div className="ws-set-label">{t("workspace.settings.currentLabel")}</div>
          <div className="ws-set-root" data-ws-set-root>
            {root ?? t("workspace.settings.unbound")}
          </div>
        </div>
        <button
          type="button"
          className="hud-btn hud-btn-cyan"
          data-ws-set-switch
          disabled={agentBusy}
          onClick={startSwitch}
        >
          {t("workspace.settings.switchAction")}
        </button>
      </div>
      {agentBusy && (
        <div className="ws-set-note" data-ws-set-busy>
          {t("workspace.settings.busyNote")}
        </div>
      )}
    </div>
  );
};

export default WorkspaceSettingsSection;

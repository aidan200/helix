/**
 * 门禁 connecting 占位（W3；brief 任务 2）。
 *
 * phase=connecting（workspace.get 门禁判定前）的全屏轻量占位：conn=
 * connecting/disconnected → pulse dot + 连接文案（ConnBanner 视觉语言）；
 * conn=error（gave-up）→ 连接失败占位（err-icon + hud-btn——ErrorCard 视觉
 * 语言）+ 重试钮（useSession().retry，SM-2 手动重试路径）。复用既有加载/
 * 连接类 UI 风格，不新造视觉体系；连接层零改动（重连状态机照常）。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const WorkspaceBootScreen = function WorkspaceBootScreen() {
  const { t } = useI18n();
  const { state, retry } = useSession();

  if (state.conn === "error") {
    return (
      <div className="wsgate" data-wsgate-boot="error">
        <div className="wsgate-panel">
          <div className="err-icon">!</div>
          <div className="wsgate-title">{t("workspace.boot.errorTitle")}</div>
          <div className="wsgate-sub">{t("workspace.boot.errorSub")}</div>
          <button className="hud-btn hud-btn-cyan" type="button" onClick={retry}>
            {t("workspace.boot.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wsgate" data-wsgate-boot="connecting">
      <div className="wsgate-boot">
        <span className="hud-dot hud-dot-pulse" />
        <span>{t("workspace.boot.connecting")}</span>
      </div>
    </div>
  );
};

export default WorkspaceBootScreen;

/**
 * 选择工作空间页（W3 门禁 gate 态；设计稿 §2.2 / brief 任务 3）。
 *
 * 全屏门禁页（App.tsx 门禁分支渲染）：
 * - notice 区：workspace.get 降级说明（如「上次的工作空间已不可用：…」）
 *   置顶展示（daemon 生成的用户可读文本，直接渲染）；
 * - recents 区：MRU 列表（name=basename / root / lastUsedAt 本地化短格式），
 *   valid=false 项置灰 + 失效标注（disabled 不可点击）；点击 valid 项即 open；
 * - 输入区：路径输入 + 确认；行内错误区展示 daemon 返回的结构化错误
 *   （错误码区分文案 + message 附加行——前端不重复实现校验，§3.3 单点）；
 *   提交中禁用态（opening）。
 *
 * 逃逸语义按入口来源区分（W4 切换流）：switching=true（主壳入口）→ 底部
 * 取消按钮回主壳（open 在途时禁用防半途帧）；首启 gate（switching=false）
 * 恒无逃逸——不选不进主壳，勿改语义。
 *
 * 纯展示组件 + store 注入（ProjectPage/SettingsPage 分工先例）：数据面全在
 * entities/workspace（useWorkspace），本页零 WS 依赖。i18n 键全量登记
 * （zh/en 双语）。
 *
 * W6a 原生目录选择：壳注入 helixPickDirectory（seam 探测）时输入区渲染
 * 「浏览…」钮——选中路径只回填输入框不自动提交（用户确认后手动提交，防
 * 误绑）；无能力（纯浏览器 dev）不渲染该钮，输入框仍可用。路径零变换
 * 透传（Windows 反斜杠等平台原生形态原样入框，realpath/校验在 daemon 单点）。
 */
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { hasNativePicker, nativePickDirectory } from "@/shared/api/native-capability";
import { useWorkspace } from "@/entities/workspace/WorkspaceContext";

/** ISO → 「MM-DD HH:mm」短格式（fmtSyncedAt 先例；非法输入原样返回）。 */
function fmtLastUsedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 错误码 → 行内文案（错误码区分：无效根/活跃智能体/发送失败/兜底）。 */
function errorTextOf(code: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (code === "WORKSPACE_E_INVALID_ROOT") return t("workspace.gate.error.invalidRoot");
  if (code === "WORKSPACE_E_ACTIVE_AGENT") return t("workspace.gate.error.activeAgent");
  if (code === "send-failed") return t("workspace.gate.error.sendFailed");
  return t("workspace.gate.error.generic");
}

const WorkspaceGatePage = function WorkspaceGatePage() {
  const { t } = useI18n();
  const { state, openWorkspace, cancelSwitch } = useWorkspace();
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const trimmed = path.trim();
  // 壳注入脚本先于页面脚本执行，页面生命周期内恒定；渲染时探测即可
  const canBrowse = hasNativePicker();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (state.opening || trimmed === "") return;
    openWorkspace(trimmed);
  };

  /** 浏览钮：原生目录选择 → 选中回填输入框（不自动提交，防误绑）；
 *  defaultPath 提示位 = 当前输入或 recents[0]，透传不预校验（相对/无效
 *  由对话框自身忽略）。对话框在途防重入（picking 禁用）。 */
  const onBrowse = async () => {
    if (state.opening || picking) return;
    setPicking(true);
    try {
      const initial = trimmed !== "" ? trimmed : (state.recents[0]?.root ?? undefined);
      const picked = await nativePickDirectory(initial);
      if (picked !== null) setPath(picked);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="wsgate" data-wsgate-page="gate">
      <div className="wsgate-panel">
        <div className="wsgate-title">{t("workspace.gate.title")}</div>
        <div className="wsgate-sub">{t("workspace.gate.subtitle")}</div>
        {state.notice !== null && (
          <div className="wsgate-notice" data-wsgate-notice>
            {state.notice}
          </div>
        )}
        {state.recents.length > 0 && (
          <section className="wsgate-sec">
            <div className="wsgate-sec-title">{t("workspace.gate.recentsTitle")}</div>
            <div className="wsgate-recents" data-wsgate-recents aria-label={t("workspace.gate.recentsAriaLabel")}>
              {state.recents.map((r) => (
                <button
                  key={r.root}
                  type="button"
                  className="wsgate-recent"
                  data-valid={r.valid ? "1" : "0"}
                  disabled={!r.valid || state.opening}
                  onClick={() => openWorkspace(r.root)}
                >
                  <span className="wsgate-recent-main">
                    <span className="wsgate-recent-name">{r.name}</span>
                    {!r.valid && <span className="wsgate-recent-invalid">{t("workspace.gate.invalid")}</span>}
                  </span>
                  <span className="wsgate-recent-root">{r.root}</span>
                  <span className="wsgate-recent-time">
                    {t("workspace.gate.lastUsedAt", { time: fmtLastUsedAt(r.lastUsedAt) })}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="wsgate-sec">
          <div className="wsgate-sec-title">{t("workspace.gate.inputTitle")}</div>
          <form className="wsgate-form" onSubmit={onSubmit}>
            <input
              type="text"
              className="wsgate-input"
              data-wsgate-path
              value={path}
              placeholder={t("workspace.gate.pathPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={state.opening}
              onChange={(e) => setPath(e.target.value)}
            />
            {canBrowse && (
              <button
                type="button"
                className="hud-btn"
                data-wsgate-browse
                disabled={state.opening || picking}
                onClick={onBrowse}
              >
                <FolderOpen size={14} />
                {t("workspace.gate.browse")}
              </button>
            )}
            <button
              type="submit"
              className="hud-btn hud-btn-cyan"
              data-wsgate-submit
              disabled={state.opening || trimmed === ""}
            >
              {state.opening ? t("workspace.gate.opening") : t("workspace.gate.open")}
            </button>
          </form>
          {state.openError !== null && (
            <div className="wsgate-error" data-wsgate-error={state.openError.code}>
              <div>{errorTextOf(state.openError.code, t)}</div>
              {state.openError.message !== "" && (
                <div className="wsgate-error-detail">{state.openError.message}</div>
              )}
            </div>
          )}
        </section>
        {/* 切换流取消逃逸（W4）：仅主壳入口渲染；open 在途禁用（取消 = 放弃
            等待回执——在途中途取消会产生半途帧，防抖优先）。首启 gate 恒无
            此钮（无逃逸语义）。 */}
        {state.switching && (
          <button
            type="button"
            className="hud-btn hud-btn-ghost wsgate-cancel"
            data-wsgate-cancel
            disabled={state.opening}
            onClick={cancelSwitch}
          >
            {t("workspace.gate.cancelSwitch")}
          </button>
        )}
      </div>
    </div>
  );
};

export default WorkspaceGatePage;

/**
 * F5.5 索引状态面板（graph 态底部；三态互斥：building / synced / degraded）。
 *
 * 面板状态完全由 idx prop 驱动（kg.index.status 回执；null = 读取中）；
 * degraded = DEGRADED 警示徽章 + 影响说明 + 重新构建（rebuild:true →
 * 轮询至 synced，degraded 徽章永不静默）；building 有真实 progress =
 * 进度条 scaleX + 「N / M 符号」，无 progress = 不确定态（假「0 / 0」零渲染）。
 */
import type { KgIndexStatusDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { ProgressFill } from "./kg-progress";

type PanelState = "building" | "synced" | "degraded";

const KgIndexPanel = function KgIndexPanel({
  idx,
  rebuilding,
  onRebuild,
}: {
  idx: KgIndexStatusDto | null;
  rebuilding: boolean;
  onRebuild: () => void;
}) {
  const { t } = useI18n();

  const state: PanelState | null =
    idx === null
      ? null
      : idx.state === "absent"
        ? null // graph 态不呈现 absent（主区已消化；契约口径）
        : idx.state;
  /** 真实 daemon building 回执不带 progress —— 无进度时不确定态。 */
  const buildWaiting = idx?.progress === undefined || idx.progress.total === 0;
  const pct =
    idx?.progress !== undefined && idx.progress.total > 0 ? idx.progress.done / idx.progress.total : 0;

  return (
    <div className="kgv-index-panel" data-kg-index-panel={state ?? "loading"}>
      <div className="kgv-ip-head">
        <span className="kgv-ip-title">{t("pj.kg.idxTitle")}</span>
      </div>
      <div className="kgv-ip-body">
        {state === null && <div className="kgv-ip-sub">{t("pj.kg.idxLoading")}</div>}
        {state === "building" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="hud-badge pb-building">
                {buildWaiting ? t("pj.kg.idxBuildingWait") : t("pj.kg.idxBuilding", { pct: Math.round(pct * 100) })}
              </span>
            </div>
            <div className="kg-progress">
              {buildWaiting ? <ProgressFill indeterminate /> : <ProgressFill ratio={pct} />}
            </div>
            <div className="kgv-ip-sub">
              {buildWaiting
                ? t("pj.kg.idxBuildingSubWait")
                : t("pj.kg.idxBuildingSub", { done: idx?.progress?.done ?? 0, total: idx?.progress?.total ?? 0 })}
            </div>
          </>
        )}
        {state === "synced" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="kg-dot ok" />
              <span className="kgv-ip-label">{t("pj.kg.idxSynced")}</span>
            </div>
            <div className="kgv-ip-sub">
              {idx?.syncedAt !== undefined
                ? t("pj.kg.idxSyncedSub", { symbols: idx.symbolCount ?? 0, at: idx.syncedAt })
                : `${idx?.symbolCount ?? 0}`}
            </div>
          </>
        )}
        {state === "degraded" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="kg-sev-badge warn">DEGRADED</span>
              <span className="kgv-ip-label">{t("pj.kg.idxInterrupted")}</span>
            </div>
            <div className="kgv-ip-sub">
              {idx?.degradedNote ?? t("pj.kg.idxDegradedFallback")}
            </div>
            <button
              type="button"
              className="hud-btn hud-btn-ghost kg-btn-sm"
              data-kg-rebuild
              disabled={rebuilding}
              onClick={onRebuild}
            >
              {rebuilding ? t("pj.kg.rebuilding") : t("pj.kg.rebuild")}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default KgIndexPanel;

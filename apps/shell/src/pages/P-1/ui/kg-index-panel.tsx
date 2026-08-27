/**
 * F5.5 索引状态面板（graph 态底部；三态互斥：building / synced / degraded）。
 *
 * 按项目索引状态起步（prop idx = kg.index.status 回执；null = 读取中）；
 * degraded = DEGRADED 警示徽章 + 影响说明 + 重新构建（rebuild:true →
 * 轮询至 synced，degraded 徽章永不静默）；building = 进度条 scaleX +
 * 「N / M 符号 · codegraph 机械抽取中（仅代码层）」。
 *
 * 原型演示控件（三态 seg）转 isDev() 门控：dev 可见可用（mock mode F 层
 * 验其可用性），prod 不渲染（review.md 断言边界 §3.3）。
 */
import { useState } from "react";
import type { KgIndexStatusDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { isDev } from "@/shared/lib/is-dev";
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
  /** dev 演示覆盖（F5.5 三态 seg；prod 不渲染）。 */
  const { t } = useI18n();
  const [devOverride, setDevOverride] = useState<PanelState | null>(null);

  const state: PanelState | null =
    devOverride !== null
      ? devOverride
      : idx === null
        ? null
        : idx.state === "absent"
          ? null // graph 态不呈现 absent（主区已消化；契约口径）
          : idx.state;
  const pct =
    idx?.progress !== undefined && idx.progress.total > 0 ? idx.progress.done / idx.progress.total : 0;

  return (
    <div className="kgv-index-panel" data-kg-index-panel={state ?? "loading"}>
      <div className="kgv-ip-head">
        <span className="kgv-ip-title">{t("pj.kg.idxTitle")}</span>
        <div className="kgv-seg-row">
          {isDev() && (
            <>
              <span className="kg-dev-label">{t("pj.kg.idxDemo")}</span>
              <div className="kg-seg" data-demo data-kg-seg-idx>
                {(["building", "synced", "degraded"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={(devOverride ?? state) === v ? "active" : ""}
                    onClick={() => setDevOverride(devOverride === v ? null : v)}
                  >
                    {v === "building" ? t("pj.kg.idxSegBuilding") : v === "synced" ? t("pj.kg.idxSegSynced") : t("pj.kg.idxSegDegraded")}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="kgv-ip-body">
        {state === null && <div className="kgv-ip-sub">{t("pj.kg.idxLoading")}</div>}
        {state === "building" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="hud-badge pb-building">{t("pj.kg.idxBuilding", { pct: Math.round(pct * 100) })}</span>
            </div>
            <div className="kg-progress">
              <ProgressFill ratio={pct} />
            </div>
            <div className="kgv-ip-sub">
              {t("pj.kg.idxBuildingSub", { done: idx?.progress?.done ?? 0, total: idx?.progress?.total ?? 0 })}
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

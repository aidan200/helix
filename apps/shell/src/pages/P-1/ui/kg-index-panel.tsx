/**
 * F5.5 索引状态紧凑形态（kgv-head 右侧；三态互斥：building / synced / degraded）。
 *
 * 形态完全由 idx prop 驱动（kg.index.status 回执；null = 读取中）：
 * - building：pb-building 徽章 + 有真实 progress 时简短进度「N / M」
 *   （无 progress = 仅徽章，不确定态不假造「0 / 0」）；
 * - synced：绿点 + 「已同步」（符号数/完成时间入 title 悬浮）；
 * - degraded：DEGRADED 警示徽章（永不静默）+ 影响说明入 title +
 *   「重新构建」按钮（rebuild:true → 轮询至 synced）；
 * - absent：muted 徽章（C1 后出现面：kg.index.delete 删除索引后——原契约
 *   「graph 态不呈现 absent」被删除索引场景打破，显示中性徽章不假造同步态）。
 *
 * C1 kg 维护批：synced/degraded 态尾部加「删除」按钮（kg.index.delete——
 * 可重建、风险较低但需明示：两步内联确认条，复用 kgv-confirm-box 形态）。
 */
import { useState } from "react";
import type { KgIndexStatusDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";

type PanelState = "building" | "synced" | "degraded" | "absent";

const KgIndexPanel = function KgIndexPanel({
  idx,
  rebuilding,
  onRebuild,
  onDelete,
  deleting,
}: {
  idx: KgIndexStatusDto | null;
  rebuilding: boolean;
  onRebuild: () => void;
  /** kg.index.delete 发起（C1；单飞锁在 KgViewer——在途时面板经 deleting 禁用）。 */
  onDelete: () => void;
  /** 删除在途（确认条与按钮禁用）。 */
  deleting: boolean;
}) {
  const { t } = useI18n();
  /** 删除两步确认（内联确认条；kg-detail-pane confirmOpen 同形态）。 */
  const [deleteOpen, setDeleteOpen] = useState(false);

  const state: PanelState | null =
    idx === null
      ? null
      : idx.state; // absent 亦呈现（C1：删除索引后的中性徽章）
  /** 真实 daemon building 回执不带 progress —— 无进度时不确定态。 */
  const buildWaiting = idx?.progress === undefined || idx.progress.total === 0;

  return (
    <div className="kgv-index-panel" data-kg-index-panel={state ?? "loading"}>
      {state === null && <span className="kgv-ip-sub">{t("pj.kg.idxLoading")}</span>}
      {state === "absent" && <span className="hud-badge pb-absent">{t("pj.kg.idxAbsent")}</span>}
      {state === "building" && (
        <>
          <span className="hud-badge pb-building">{t("pj.kg.idxBuildingWait")}</span>
          {!buildWaiting && (
            <span className="kgv-ip-sub">
              {t("pj.kg.idxBuildingShort", { done: idx?.progress?.done ?? 0, total: idx?.progress?.total ?? 0 })}
            </span>
          )}
        </>
      )}
      {state === "synced" && (
        <span
          className="kgv-ip-synced"
          title={
            idx?.syncedAt !== undefined
              ? t("pj.kg.idxSyncedSub", { symbols: idx.symbolCount ?? 0, at: idx.syncedAt })
              : undefined
          }
        >
          <span className="kg-dot ok" />
          {t("pj.kg.idxSynced")}
        </span>
      )}
      {state === "degraded" && (
        <>
          <span className="kg-sev-badge warn" title={idx?.degradedNote ?? t("pj.kg.idxDegradedFallback")}>
            DEGRADED
          </span>
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
      {/* C1：删除索引入口（synced/degraded 态；building 进行中不开放） */}
      {(state === "synced" || state === "degraded") && !deleteOpen && (
        <button
          type="button"
          className="hud-btn hud-btn-ghost kg-btn-sm"
          data-kg-index-delete
          disabled={deleting || rebuilding}
          onClick={() => setDeleteOpen(true)}
        >
          {t("pj.kg.idxDelete")}
        </button>
      )}
      {deleteOpen && (
        <span className="kgv-confirm-box" data-kg-index-delete-confirm>
          <span className="kgv-confirm-text">{t("pj.kg.idxDeleteConfirm")}</span>
          <button
            type="button"
            className="hud-btn hud-btn-danger kg-btn-sm"
            data-act="confirm"
            disabled={deleting}
            onClick={() => {
              setDeleteOpen(false);
              onDelete();
            }}
          >
            {t("pj.kg.idxDeleteYes")}
          </button>
          <button
            type="button"
            className="hud-btn hud-btn-ghost kg-btn-sm"
            data-act="cancel"
            disabled={deleting}
            onClick={() => setDeleteOpen(false)}
          >
            {t("pj.kg.purgeNo")}
          </button>
        </span>
      )}
    </div>
  );
};

export default KgIndexPanel;

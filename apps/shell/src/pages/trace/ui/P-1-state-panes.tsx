/**
 * P-1 状态面（review.md 状态模型：五态互斥 + 断连 overlay 正交）。
 *
 * - TableSkeleton：表格同形骨架（p1-skel-row 栅格与行同形；上下文卡骨架
 *   归 P-1-context-card 内部）；
 * - EmptyPane：empty 双 flavor（会话无事件 vs 筛选后空）+ 呼吸标题 +
 *   光标（hud-empty 语言，与施工牌虚线围挡区分）；
 * - ErrorPane：实边 error 面板（role=alert）+ 重试入口；
 * - ConnOverlay：断连整区 overlay（实底压住内容区 + 重连入口）——正交层，
 *   与四态不互斥（压住任何视图）。
 */
import { TriangleAlert, Unplug, RotateCw } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import type { TraceEmptyFlavor } from "../model/trace-model";

/** loading：表格同形骨架（六行；栅格随混排/详情视图切换）。 */
export const TableSkeleton = function TableSkeleton({ detail }: { detail: boolean }) {
  return (
    <div className="p1-skel" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className={cn("p1-skel-row", detail && "detail")}>
          <span className="p1-skel-bar" style={{ width: 10 }} />
          <span className="p1-skel-bar" style={{ width: 78 + (i % 3) * 10 }} />
          {!detail && (
            <span className="p1-skel-bar" style={{ width: 120 - (i % 4) * 14 }} />
          )}
          <span className="p1-skel-bar" style={{ width: 56 }} />
          <span className="p1-skel-bar" style={{ width: `${62 - (i % 5) * 6}%` }} />
        </div>
      ))}
    </div>
  );
};

/** empty：双 flavor 文案（session = 会话无事件；filtered = 筛选后空）。 */
export const EmptyPane = function EmptyPane({ flavor }: { flavor: TraceEmptyFlavor }) {
  const { t } = useI18n();
  return (
    <div className="p1-empty">
      <p className="e-title">
        <span>
          {flavor === "session"
            ? t("trace.state.emptySession")
            : t("trace.state.emptyFiltered")}
        </span>
        <span className="e-cursor" aria-hidden="true" />
      </p>
      <p className="e-hint">
        {flavor === "session"
          ? t("trace.state.emptySessionHint")
          : t("trace.state.emptyFilteredHint")}
      </p>
    </div>
  );
};

/** error：实边 error 面板 + 重试（role=alert；与 empty 中性/断连 overlay 区分）。 */
export const ErrorPane = function ErrorPane({
  reason,
  onRetry,
}: {
  reason: string | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="p1-error" role="alert">
      <div className="err-icon">
        <TriangleAlert size={20} strokeWidth={1.75} />
      </div>
      <p className="err-t">{t("trace.state.errorTitle")}</p>
      {reason !== null && <p className="err-r">{reason}</p>}
      <button type="button" className="hud-btn hud-btn-danger sm" onClick={onRetry}>
        <RotateCw size={14} strokeWidth={1.75} />
        {t("trace.state.retry")}
      </button>
    </div>
  );
};

/** 断连：整区 overlay（正交层；实底遮罩 + 重连按钮）。 */
export const ConnOverlay = function ConnOverlay({ onReconnect }: { onReconnect: () => void }) {
  const { t } = useI18n();
  return (
    <div className="p1-conn show" role="alert">
      <div className="c-icon">
        <Unplug size={20} strokeWidth={1.75} />
      </div>
      <p className="t1">{t("trace.state.connTitle")}</p>
      <p className="t2">{t("trace.state.connDesc")}</p>
      <button type="button" className="hud-btn hud-btn-cyan" onClick={onReconnect}>
        <RotateCw size={14} strokeWidth={1.75} />
        {t("trace.state.reconnect")}
      </button>
    </div>
  );
};

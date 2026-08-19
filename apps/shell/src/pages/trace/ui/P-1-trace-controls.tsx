/**
 * P-1 控制条（F5.4 组合过滤入口）：会话选择器 + 时间范围四档 +
 * 事件类型多选 chips（作用于混排/详情两种视图，交集下推 daemon）。
 *
 * 视觉与行为基准 = prototype/P-1-trace.html `.p1-controls`；会话清单数据源 =
 * topology.list（SessionMeta），去重门控（未请求态才发）在 TracePage 侧。
 */
import { ChevronDown } from "lucide-react";
import type { SessionMeta } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import {
  TRACE_RANGE_OPTIONS,
  TRACE_TYPE_CATEGORIES,
  isCategoryOn,
} from "../model/trace-model";

export interface TraceControlsProps {
  sessions: readonly SessionMeta[];
  /** 当前选中会话（"" = 尚未解析）。 */
  sessionId: string;
  rangeSec: number | null;
  types: readonly string[] | null;
  onSelectSession: (sessionId: string) => void;
  onSelectRange: (rangeSec: number | null) => void;
  /** chip 点击：plain = 单选/再点回全量；multi（modifier）= 集合 toggle。 */
  onToggleChip: (key: string, multi: boolean) => void;
}

const RANGE_LABEL_KEYS = [
  "trace.controls.rangeAll",
  "trace.controls.range1h",
  "trace.controls.range15m",
  "trace.controls.range5m",
] as const;

const TraceControls = function TraceControls({
  sessions,
  sessionId,
  rangeSec,
  types,
  onSelectSession,
  onSelectRange,
  onToggleChip,
}: TraceControlsProps) {
  const { t } = useI18n();
  return (
    <section className="hud-card p1-controls" aria-label={t("trace.controls.ariaLabel")}>
      <div className="p1-fld f-session">
        <label className="hud-label" htmlFor="p1-sel-session">
          {t("trace.controls.session")}
        </label>
        <div className="sel-wrap">
          <select
            id="p1-sel-session"
            className="hud-input"
            value={sessionId}
            onChange={(e) => onSelectSession(e.target.value)}
          >
            {sessionId === "" && <option value="" disabled hidden />}
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.title !== "" ? `${s.sessionId} · ${s.title}` : s.sessionId}
              </option>
            ))}
          </select>
          <span className="sel-chev">
            <ChevronDown size={14} strokeWidth={1.75} />
          </span>
        </div>
      </div>

      <div className="p1-fld f-range">
        <label className="hud-label" htmlFor="p1-sel-range">
          {t("trace.controls.range")}
        </label>
        <div className="sel-wrap">
          <select
            id="p1-sel-range"
            className="hud-input"
            value={rangeSec === null ? "all" : String(rangeSec)}
            onChange={(e) =>
              onSelectRange(e.target.value === "all" ? null : Number(e.target.value))
            }
          >
            {TRACE_RANGE_OPTIONS.map((opt, i) => (
              <option key={opt ?? "all"} value={opt === null ? "all" : String(opt)}>
                {t(RANGE_LABEL_KEYS[i]!)}
              </option>
            ))}
          </select>
          <span className="sel-chev">
            <ChevronDown size={14} strokeWidth={1.75} />
          </span>
        </div>
      </div>

      <div className="p1-fld f-types">
        <span className="hud-label">{t("trace.controls.types")}</span>
        <div className="type-chips" role="group" aria-label={t("trace.controls.typesGroup")}>
          {TRACE_TYPE_CATEGORIES.map((cat) => {
            const on = isCategoryOn(types, cat);
            return (
              <button
                key={cat.key}
                type="button"
                className={cn("tchip", on && "on")}
                data-type={cat.key}
                aria-pressed={on}
                onClick={(e) =>
                  onToggleChip(cat.key, e.metaKey || e.ctrlKey || e.shiftKey)
                }
              >
                {cat.key}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default TraceControls;

/**
 * P-1 执行上下文卡（F5.2，AD-6 双段）：选中实例后插于事件流上方。
 *
 * 基准快照段：systemPrompt 全文（默认折叠 3 行 + 渐隐遮罩 + 字数，
 * 展开/收起）、工具集 chips、模型 provider/model-id、compaction（主有
 * Sub 无）、SubAgent spawn task blockquote；数据源 = TraceInstanceRecord.
 * snapshot（agent.instantiated 落盘载荷本体，F5.7）。
 * 变更轨迹段：模型时间线 from→to（当前生效值高亮 .tl-cur）+ compaction
 * 里程碑（tokensBefore→After；来自已加载事件页——契约无实例级 fold，
 * 记录在案）按 ts 升序合并；单发 Sub 无变更 → 整段不渲染（退化纯快照）。
 * 降级：snapshotMissing=true → 卡保留 + 「快照缺失」标注，不 throw。
 * 状态面纪律：loading 骨架化（同形）、error 由 TracePage 隐藏、empty 保留。
 */
import { useMemo } from "react";
import type { TraceEventRow, TraceInstanceRecord } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import {
  buildTimelineRows,
  instanceDisplayName,
  type TraceCompactionMilestone,
} from "../model/trace-model";
import { fmtClock, fmtNum } from "./format";
import { instanceTimeLine } from "./P-1-instance-panel";

export interface ContextCardProps {
  record: TraceInstanceRecord;
  /** 展示视图（loading = 骨架；error 不渲染本卡——由页面侧门控）。 */
  loading: boolean;
  promptOpen: boolean;
  onTogglePrompt: () => void;
  /** 已加载事件页（compaction 里程碑数据源；按 instanceId 过滤）。 */
  events: readonly TraceEventRow[];
  refMs: number;
}

const STATUS_KEY = {
  running: "trace.panel.statusRunning",
  completed: "trace.panel.statusCompleted",
  failed: "trace.panel.statusFailed",
  killed: "trace.panel.statusKilled",
} as const;

const ContextCard = function ContextCard({
  record,
  loading,
  promptOpen,
  onTogglePrompt,
  events,
  refMs,
}: ContextCardProps) {
  const { t } = useI18n();

  // compaction 里程碑（已加载事件页中本实例的 compaction.completed）
  const compactions = useMemo<TraceCompactionMilestone[]>(
    () =>
      events
        .filter((e) => e.type === "compaction.completed" && e.instanceId === record.instanceId)
        .map((e) => {
          const p = (e.payload ?? {}) as { tokensBefore?: unknown; tokensAfter?: unknown };
          return {
            at: e.ts,
            tokensBefore: Number(p.tokensBefore),
            tokensAfter: Number(p.tokensAfter),
          };
        })
        .filter((m) => Number.isFinite(m.tokensBefore) && Number.isFinite(m.tokensAfter)),
    [events, record.instanceId],
  );

  const timeline = buildTimelineRows(record, compactions);
  const snap = record.snapshot;
  const isMain = record.agentKind === "main";
  const currentModel = record.currentModel ?? snap?.model ?? record.model;
  const modelChangeCount = record.modelTimeline?.length ?? 0;

  return (
    <section className="hud-card ctx-card" aria-label={t("trace.ctx.ariaLabel")}>
      {loading ? (
        <div className="ctx-skel" aria-hidden="true">
          <span className="p1-skel-bar" style={{ width: 120 }} />
          <span className="p1-skel-bar" style={{ width: 220 }} />
          <span className="p1-skel-bar" style={{ width: 300 }} />
          <span className="p1-skel-bar" style={{ height: 62 }} />
        </div>
      ) : (
        <>
          <div className="ctx-head">
            <span className="ctx-title">{t("trace.ctx.title")}</span>
            {record.startedAt !== undefined && (
              <span className="ctx-src">
                {t("trace.ctx.source", { time: fmtClock(record.startedAt) })}
              </span>
            )}
          </div>

          <div className="ctx-id">
            <span className={cn("inst-badge", isMain ? "main" : "sub")}>
              <span className="hud-dot" aria-hidden="true" />
              {instanceDisplayName(record, t("trace.panel.mainName"))}
            </span>
            <span className={cn("st-badge", `st-${record.status}`)}>
              <span className="hud-dot" aria-hidden="true" />
              {t(STATUS_KEY[record.status])}
            </span>
            <span className="ctx-iid">{record.instanceId}</span>
            <span className="ctx-dur">{instanceTimeLine(record, refMs, t)}</span>
          </div>

          {record.task !== undefined && record.task !== "" && (
            <blockquote className="ctx-task">
              {record.task}
              <span className="cite">{t("trace.ctx.taskCite")}</span>
            </blockquote>
          )}

          {record.snapshotMissing || snap === undefined ? (
            <div className="ctx-missing">
              <span className="hud-badge hud-badge-error">{t("trace.ctx.snapshotMissing")}</span>
              <p className="ctx-missing-hint">{t("trace.ctx.snapshotMissingHint")}</p>
            </div>
          ) : (
            <>
              <div className="ctx-facts">
                {currentModel !== undefined && (
                  <span className="cf">
                    <span className="cf-k">{t("trace.ctx.model")}</span>
                    <span className="cf-v">
                      {currentModel}
                      {modelChangeCount > 0 && snap.model !== undefined && (
                        <span className="cf-note">
                          {" "}
                          {t("trace.ctx.baseModel", { model: snap.model, n: modelChangeCount })}
                        </span>
                      )}
                    </span>
                  </span>
                )}
                <span className="cf">
                  <span className="cf-k">{t("trace.ctx.tools", { n: snap.tools.length })}</span>
                </span>
                {snap.compaction !== undefined && (
                  <span className="cf">
                    <span className="cf-k">{t("trace.ctx.compaction")}</span>
                    <span className="cf-v">
                      {snap.compaction.enabled
                        ? t("trace.ctx.compactionValue", {
                            reserve: fmtNum(snap.compaction.reserveTokens),
                            keep: fmtNum(snap.compaction.keepRecentTokens),
                          })
                        : t("trace.ctx.compactionOff")}
                    </span>
                  </span>
                )}
              </div>

              <div className="ctx-tools">
                {snap.tools.map((tool) => (
                  <span key={tool} className="hud-chip">
                    {tool}
                  </span>
                ))}
              </div>

              <div className="ctx-prompt">
                <div className="cp-head">
                  <span className="cp-k">{t("trace.ctx.prompt")}</span>
                  <span className="cp-count">
                    {t("trace.ctx.promptChars", { n: fmtNum(snap.systemPrompt.length) })}
                  </span>
                  <button
                    type="button"
                    className="hud-btn hud-btn-ghost sm"
                    aria-expanded={promptOpen}
                    onClick={onTogglePrompt}
                  >
                    {promptOpen ? t("trace.ctx.collapse") : t("trace.ctx.expand")}
                  </button>
                </div>
                <pre className={cn("cp-body", !promptOpen && "folded")}>{snap.systemPrompt}</pre>
              </div>
            </>
          )}

          {timeline.length > 0 && (
            <div className="ctx-tl">
              <span className="ctx-tl-title">{t("trace.ctx.timeline")}</span>
              {timeline.map((row, i) => (
                <div key={`${row.at}-${i}`} className="tl-row">
                  <span className="tl-time">{fmtClock(row.at)}</span>
                  {row.kind === "model" ? (
                    <>
                      <span className={cn("tl-model", row.current && "tl-cur")}>
                        {row.from} <span className="tl-arrow">→</span> {row.to}
                        {row.current && ` · ${t("trace.ctx.current")}`}
                      </span>
                      <span className="cf-note">agent.model.changed</span>
                    </>
                  ) : (
                    <>
                      <span>
                        {t("trace.ctx.compactionMilestone", {
                          before: fmtNum(row.tokensBefore ?? 0),
                          after: fmtNum(row.tokensAfter ?? 0),
                        })}
                      </span>
                      <span className="cf-note">{t("trace.ctx.compactionEvent")}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default ContextCard;

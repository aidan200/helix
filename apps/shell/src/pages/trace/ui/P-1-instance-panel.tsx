/**
 * P-1 实例面板（F5.1；S3b 迁 TraceSidebar 下分区）：会话选择后列实例
 * （主 + 各 SubAgent）——profileKind 徽标（main-session accent / phase-*
 * violet 分对着色）、模型、生命周期状态（running 脉冲点 / completed /
 * failed / killed）、起止与时长、事件计数；「全部实例」= 全会话混排表格
 * 入口。S3b 起不再自持 hud-card 卡壳（sidebar 分区语言），保留 ip-* 断言面。
 *
 * 视觉基准 = prototype/P-1-trace.html `.inst-panel`；数据 = trace.query.result
 * 的 instances 摘要块（会话级 fold，不受事件过滤维影响，AF-5）。
 */
import type { TraceInstanceRecord } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { instanceDisplayName, instanceTimes } from "../model/trace-model";
import { fmtClock, fmtDur } from "./format";

/** 起止时间行（原型 timeLine 口径）：终态 = 起→止 + 时长；running = 起 + 已运行。 */
export function instanceTimeLine(
  rec: TraceInstanceRecord,
  refMs: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const times = instanceTimes(rec, refMs);
  if (times.startMs === null) return "";
  const start = fmtClock(new Date(times.startMs).toISOString());
  if (times.endMs !== null) {
    return `${start} → ${fmtClock(new Date(times.endMs).toISOString())} · ${fmtDur(times.durationMs ?? 0)}`;
  }
  return t("trace.panel.timeRunning", { start, dur: fmtDur(times.durationMs ?? 0) });
}

export interface InstancePanelProps {
  instances: readonly TraceInstanceRecord[];
  /** null = 全部实例（混排视图）。 */
  selected: string | null;
  /** 面板数据加载中且无旧面板可保留（切会话瞬间）。 */
  loading: boolean;
  /** running 实例时长参考点（会话最新事件 ts / 组件注入 now）。 */
  refMs: number;
  onSelect: (instanceId: string | null) => void;
}

const STATUS_KEY = {
  running: "trace.panel.statusRunning",
  completed: "trace.panel.statusCompleted",
  failed: "trace.panel.statusFailed",
  killed: "trace.panel.statusKilled",
} as const;

const InstancePanel = function InstancePanel({
  instances,
  selected,
  loading,
  refMs,
  onSelect,
}: InstancePanelProps) {
  const { t } = useI18n();
  const totalCount = instances.reduce((acc, r) => acc + r.eventCount, 0);
  return (
    <aside className="inst-panel" aria-label={t("trace.panel.ariaLabel")}>
      <div className="ip-head">
        <span className="ip-title">{t("trace.panel.title")}</span>
        <span className="ip-count">
          {instances.length > 0 ? t("trace.panel.count", { n: instances.length }) : ""}
        </span>
      </div>
      <div className="ip-list" role="list">
        {instances.length === 0 ? (
          loading ? (
            <div className="ip-skel" aria-hidden="true">
              <span className="p1-skel-bar" style={{ width: "72%" }} />
              <span className="p1-skel-bar" style={{ width: "54%" }} />
            </div>
          ) : (
            <p className="ip-empty">{t("trace.panel.empty")}</p>
          )
        ) : (
          <>
            <button
              type="button"
              className={cn("ip-item ip-all", selected === null && "on")}
              aria-pressed={selected === null}
              onClick={() => onSelect(null)}
            >
              <span className="ii-top">
                <span className="ii-name">{t("trace.panel.all")}</span>
                <span className="ii-cnt">{t("trace.panel.eventCount", { n: totalCount })}</span>
              </span>
              <span className="ii-sub">{t("trace.panel.allSub")}</span>
            </button>
            {instances.map((rec) => (
              <button
                key={rec.instanceId}
                type="button"
                className={cn("ip-item", selected === rec.instanceId && "on")}
                data-status={rec.status}
                aria-pressed={selected === rec.instanceId}
                onClick={() => onSelect(rec.instanceId)}
              >
                <span className="ii-top">
                  <span className="ii-dot" aria-hidden="true" />
                  <span className="ii-name">
                    {instanceDisplayName(rec, t("trace.panel.mainName"))}
                  </span>
                  <span className="ii-status">{t(STATUS_KEY[rec.status])}</span>
                </span>
                <span className="ii-meta">
                  <span className={cn("ii-pk", rec.agentKind === "main" && "main-pk")}>
                    {rec.profileKind}
                  </span>
                  {rec.model !== undefined && <span className="ii-model">{rec.model}</span>}
                </span>
                <span className="ii-time">
                  <span className="ii-iid">{rec.instanceId}</span>
                  {instanceTimeLine(rec, refMs, t)}
                  <span className="ii-cnt">
                    {t("trace.panel.eventCount", { n: rec.eventCount })}
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
};

export default InstancePanel;

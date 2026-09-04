/**
 * P-1 体检面板（W2-E 轨一结构体检看板，设计 kg-driven-dev-loop-design D5 +
 * R15）：顶部 = 项目概览统计卡（索引状态 + 符号数 + 知识节点数 + 最近同步
 * + 结构问题计数 + candidates 台账四态计数徽章，单一卡片承载全部统计），
 * 其下 = conflicts/orphans 问题清单（零问题 → 「结构健康」空态）。
 *
 * 任务发起模块（kg.review.create / code.review.create）已拆出为 KgTaskLaunch
 * 紧凑面板（kg-task-launch.tsx），由 KgViewer 排在台账面板之后——本组件
 * 只承载统计与问题读面。
 *
 * 展示纪律：只列不修零写路径；conflicts/orphans 条目 summary = 服务层人读
 * 文案直渲（AD-16 同规，前端零二次叙述）。纯展示组件：命令发送/回执消费/
 * 单飞锁归 KgViewer 常驻 listener，本组件只回调。
 */
import type { KgHealthDto } from "@helix/protocol";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 索引四态 → i18n 键位（wire 值不入文案——映射仅展示层）。 */
const STATE_KEY = {
  absent: "pj.health.stateAbsent",
  building: "pj.health.stateBuilding",
  synced: "pj.health.stateSynced",
  degraded: "pj.health.stateDegraded",
} as const;

/** 台账四态 → i18n 键位（与 KgCandidatesPanel 共用词条；静态映射不拼接）。 */
const CAND_KEY = {
  pending: "pj.health.candPending",
  deferred: "pj.health.candDeferred",
  applied: "pj.health.candApplied",
  discarded: "pj.health.candDiscarded",
} as const;

/** 同步时间紧凑形态（ISO → 「YYYY-MM-DD HH:mm」；缺省 = —）。 */
function fmtSyncedAt(at: string | undefined): string {
  if (at === undefined || at === "") return "—";
  return at.slice(0, 16).replace("T", " ");
}

export default function KgHealthPane({
  health,
  loading,
  nodeCount,
  candFilter,
  t,
  onCandFilter,
}: {
  /** kg.health 回执（null = 未拉取/读取中）。 */
  health: KgHealthDto | null;
  loading: boolean;
  /** 知识节点计数（kg.projects 行 nodeCount；缺省 = 未知 → —）。 */
  nodeCount: number | undefined;
  /** 台账过滤态（与 KgCandidatesPanel 共享；点击徽章设过滤——active 高亮）。 */
  candFilter: "all" | "pending" | "deferred" | "applied" | "discarded";
  t: T;
  /** 四态徽章点击 → 设台账过滤并拉取（KgViewer 持拉取面）。 */
  onCandFilter: (filter: "all" | "pending" | "deferred" | "applied" | "discarded") => void;
}) {
  if (loading || health === null) {
    return (
      <div className="kgv-empty" data-kg-health="loading">
        <div className="kgv-empty-t">{t("pj.health.loading")}</div>
      </div>
    );
  }
  const healthy = health.conflicts.length === 0 && health.orphans.length === 0;
  const issueCount = health.conflicts.length + health.orphanCount;
  return (
    <div className="kg-health" data-kg-health="ready">
      {/* ① 项目概览统计卡：索引状态/符号数/知识节点/最近同步/结构问题 +
          candidates 四态计数（可交互——点击徽章设台账面板过滤并拉取） */}
      <section className="kg-health-sec kg-health-overview" data-kg-health-overview>
        <div className="kg-health-sec-head">
          <span className="kg-health-sec-title">{t("pj.health.overviewTitle")}</span>
          <span className="hud-badge" data-kg-health-index>{t(STATE_KEY[health.index.state])}</span>
        </div>
        <div className="kg-health-stats">
          <div className="kg-health-stat" data-stat="symbols">
            <span className="kg-health-stat-k">{t("pj.health.statSymbols")}</span>
            <span className="kg-health-stat-v">{health.index.symbolCount ?? "—"}</span>
          </div>
          <div className="kg-health-stat" data-stat="nodes">
            <span className="kg-health-stat-k">{t("pj.health.statNodes")}</span>
            <span className="kg-health-stat-v">{nodeCount ?? "—"}</span>
          </div>
          <div className="kg-health-stat" data-stat="syncedAt">
            <span className="kg-health-stat-k">{t("pj.health.statSynced")}</span>
            <span className="kg-health-stat-v">{fmtSyncedAt(health.index.syncedAt)}</span>
          </div>
          <div className="kg-health-stat" data-stat="issues">
            <span className="kg-health-stat-k">{t("pj.health.statIssues")}</span>
            <span className="kg-health-stat-v">{issueCount}</span>
          </div>
        </div>
        <div className="kg-health-cand-row" data-kg-health-candidates>
          {([
            ["pending", health.candidates.pending],
            ["deferred", health.candidates.deferred],
            ["applied", health.candidates.applied],
            ["discarded", health.candidates.discarded],
          ] as const).map(([status, count]) => (
            <button
              key={status}
              type="button"
              className={`kg-cand-count-badge hud-badge${candFilter === status ? " active" : ""}`}
              data-cand-count={status}
              aria-pressed={candFilter === status}
              onClick={() => onCandFilter(status)}
            >
              {t(CAND_KEY[status])} {count}
            </button>
          ))}
        </div>
      </section>

      {/* ② 问题列表：conflicts / orphans 逐条（服务层人读 summary 直渲）；
          零问题 → 「结构健康」空态 */}
      {healthy ? (
        <div className="kgv-empty" data-kg-health-healthy>
          <div className="kgv-empty-t">{t("pj.health.healthyTitle")}</div>
          <div className="kgv-empty-s">{t("pj.health.healthySub")}</div>
        </div>
      ) : (
        <>
          {health.conflicts.length > 0 && (
            <section className="kg-health-sec" data-kg-health-conflicts>
              <div className="kg-health-sec-head">
                <span className="kg-health-sec-title">{t("pj.health.conflictsTitle")}</span>
                <span className="kg-sev-badge warn">{health.conflicts.length}</span>
              </div>
              <ul className="kg-health-list">
                {health.conflicts.map((c, i) => (
                  <li key={i} className="kg-health-item" data-kind={c.kind}>
                    {c.summary}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {health.orphans.length > 0 && (
            <section className="kg-health-sec" data-kg-health-orphans>
              <div className="kg-health-sec-head">
                <span className="kg-health-sec-title">{t("pj.health.orphansTitle")}</span>
                <span className="kg-sev-badge warn">{health.orphanCount}</span>
              </div>
              <ul className="kg-health-list">
                {health.orphans.map((o, i) => (
                  <li key={i} className="kg-health-item" data-kind={o.kind}>
                    {o.summary}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

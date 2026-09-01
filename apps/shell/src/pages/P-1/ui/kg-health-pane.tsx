/**
 * P-1 体检面板（W2-E 轨一结构体检看板，设计 kg-driven-dev-loop-design D5 +
 * R15）：kg.health 五项读面分组展示——逻辑冲突清单 / 孤儿·腐烂锚清单
 * （计数徽章）/ 索引状态 / candidates 台账四态计数 + 轨二（kg.review.create，
 * W2-F）发起入口（含运行态：项目行 reviewRunning 置位时无启动钮只留
 * 任务页观察出口——与 KgBootstrapEntry running 态同构，服务端为准，
 * 组件重挂后仍持正确态）。
 *
 * 展示纪律：只列不修零写路径（发起入口按钮除外——只调既有 ws 命令）；
 * conflicts/orphans 条目 summary = 服务层人读文案直渲（AD-16 同规，前端零
 * 二次叙述）；零问题 → 「结构健康」空态。纯展示组件：命令发送/回执消费/
 * 单飞锁归 KgViewer 常驻 listener（KgBootstrapEntry 同构），本组件只回调。
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

export default function KgHealthPane({
  health,
  loading,
  reviewBusy,
  reviewLaunched,
  reviewRunning,
  projectName,
  t,
  onLaunchReview,
  onOpenTasks,
}: {
  /** kg.health 回执（null = 未拉取/读取中）。 */
  health: KgHealthDto | null;
  loading: boolean;
  /** kg.review.create 在途（发起钮禁用；单飞锁在 KgViewer）。 */
  reviewBusy: boolean;
  /** 发起成功标记（ok-strip + 前往任务页出口）。 */
  reviewLaunched: boolean;
  /** 该项目存在非终态 kg-review job（kg.projects 行 reviewRunning，
   *  bootstrapRunning 同规）：体检入口置运行态——无启动钮只留任务页
   *  出口；终态后恢复可发起（仅禁并发不绑一次性）。 */
  reviewRunning: boolean;
  projectName: string;
  t: T;
  onLaunchReview: () => void;
  onOpenTasks: () => void;
}) {
  if (loading || health === null) {
    return (
      <div className="kgv-empty" data-kg-health="loading">
        <div className="kgv-empty-t">{t("pj.health.loading")}</div>
      </div>
    );
  }
  const healthy = health.conflicts.length === 0 && health.orphans.length === 0;
  return (
    <div className="kg-health" data-kg-health="ready">
      {/* ① 问题列表：conflicts / orphans 逐条（服务层人读 summary 直渲）；
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

      {/* ② 计数/状态行：index 状态 + candidates 四态计数（只读聚合直渲） */}
      <section className="kg-health-sec" data-kg-health-index>
        <div className="kg-health-sec-head">
          <span className="kg-health-sec-title">{t("pj.health.indexTitle")}</span>
          <span className="hud-badge">{t(STATE_KEY[health.index.state])}</span>
        </div>
      </section>
      <section className="kg-health-sec" data-kg-health-candidates>
        <div className="kg-health-sec-head">
          <span className="kg-health-sec-title">{t("pj.health.candidatesTitle")}</span>
        </div>
        <div className="kg-health-cand-row">
          <span className="hud-badge">
            {t("pj.health.candPending")} {health.candidates.pending}
          </span>
          <span className="hud-badge">
            {t("pj.health.candDeferred")} {health.candidates.deferred}
          </span>
          <span className="hud-badge">
            {t("pj.health.candApplied")} {health.candidates.applied}
          </span>
          <span className="hud-badge">
            {t("pj.health.candDiscarded")} {health.candidates.discarded}
          </span>
        </div>
      </section>

      {/* ③ 轨二发起入口（W2-F kg.review.create——ws 命令已存在，直接接线；
          启动钮即「开启前一次确认」位，bootstrap 入口同规）；
          运行态（reviewRunning，bootstrap 入口卡 running 同构）：无启动钮
          只留观察出口——服务端为准（组件重挂后仍持正确态） */}
      <section className="kg-health-sec" data-kg-health-review>
        <div className="kg-health-sec-head">
          <span className="kg-health-sec-title">{t("pj.health.reviewTitle")}</span>
          <span className="hud-badge kbe-type">kg-review</span>
          {reviewRunning && <span className="hud-badge" data-review-running-badge>{t("pj.health.reviewRunningBadge")}</span>}
        </div>
        {reviewRunning ? (
          <div className="kbe-body">
            <div className="kg-ok-strip" data-review-running>
              <span>{t("pj.health.reviewRunningStrip", { name: projectName })}</span>
              <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
                {t("pj.health.reviewGoTasks")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="kbe-row">
              <span className="kbe-k">{t("pj.boot.desc")}</span>
              <span className="kbe-v muted">{t("pj.health.reviewDesc")}</span>
            </div>
            <div className="kbe-actions">
              <button
                type="button"
                className="hud-btn kg-btn-primary"
                data-review-launch-btn
                disabled={reviewBusy}
                onClick={onLaunchReview}
              >
                {t("pj.health.reviewLaunch")}
              </button>
              <span className="kbe-note muted">{t("pj.health.reviewLaunchNote")}</span>
            </div>
            {reviewLaunched && (
              <div className="kg-ok-strip" data-review-launched>
                <span>{t("pj.health.reviewLaunched", { name: projectName })}</span>
                <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
                  {t("pj.health.reviewGoTasks")}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

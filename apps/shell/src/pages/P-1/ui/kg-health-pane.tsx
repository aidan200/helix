/**
 * P-1 体检面板（W2-E 轨一结构体检看板，设计 kg-driven-dev-loop-design D5 +
 * R15）：顶部 = 项目概览卡，按业务三行——
 * ① 统计行：符号数 / 知识节点 / 结构问题（索引状态与同步时间归 kgv-head
 *    KgIndexPanel，本卡不重复）；
 * ② 台账行：candidates 四态计数（纯文字——过滤入口唯一归 KgCandidatesPanel）；
 * ③ 任务行：语义体检（kg.review.create）+ 代码评审（code.review.create）
 *    发起按钮直接入行（运行态徽标/已发起条随行——按钮状态即任务状态）。
 * 概览卡之下 = conflicts/orphans 问题清单（零问题 → 「结构健康」空态）。
 *
 * 展示纪律：只列不修零写路径（发起钮只调既有 ws 命令，启动钮即「开启前
 * 一次确认」位，bootstrap 入口同规）；conflicts/orphans 条目 summary =
 * 服务层人读文案直渲（AD-16 同规，前端零二次叙述）。纯展示组件：命令
 * 发送/回执消费/单飞锁归 KgViewer 常驻 listener，本组件只回调。
 */
import type { KgHealthDto } from "@helix/protocol";

type T = (key: string, vars?: Record<string, string | number>) => string;

export default function KgHealthPane({
  health,
  loading,
  nodeCount,
  reviewBusy,
  reviewLaunched,
  reviewRunning,
  codeReviewBusy,
  codeReviewLaunched,
  codeReviewRunning,
  projectName,
  t,
  onLaunchReview,
  onLaunchCodeReview,
  onOpenTasks,
}: {
  /** kg.health 回执（null = 未拉取/读取中）。 */
  health: KgHealthDto | null;
  loading: boolean;
  /** 知识节点计数（kg.projects 行 nodeCount；缺省 = 未知 → —）。 */
  nodeCount: number | undefined;
  /** kg.review.create 在途（发起钮禁用；单飞锁在 KgViewer）。 */
  reviewBusy: boolean;
  /** 发起成功标记（ok-strip + 前往任务页出口）。 */
  reviewLaunched: boolean;
  /** 该项目存在非终态 kg-review job（kg.projects 行 reviewRunning）：
   *  运行态徽标 + 任务页出口；终态后恢复可发起（仅禁并发）。 */
  reviewRunning: boolean;
  /** code.review.create 在途（发起钮禁用；单飞锁在 KgViewer）。 */
  codeReviewBusy: boolean;
  /** 发起成功标记（ok-strip + 前往任务页出口）。 */
  codeReviewLaunched: boolean;
  /** 该项目存在非终态 code-review job（kg.projects 行 codeReviewRunning）。 */
  codeReviewRunning: boolean;
  projectName: string;
  t: T;
  onLaunchReview: () => void;
  onLaunchCodeReview: () => void;
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
  const issueCount = health.conflicts.length + health.orphanCount;
  return (
    <div className="kg-health" data-kg-health="ready">
      {/* ① 项目概览卡：统计行 / 台账行 / 任务行（按业务分行） */}
      <section className="kg-health-sec kg-health-overview" data-kg-health-overview>
        <div className="kg-health-sec-head">
          <span className="kg-health-sec-title">{t("pj.health.overviewTitle")}</span>
        </div>

        {/* 统计行（同步态/同步时间归头部索引面板，不重复） */}
        <div className="kg-health-stats">
          <div className="kg-health-stat" data-stat="symbols">
            <span className="kg-health-stat-k">{t("pj.health.statSymbols")}</span>
            <span className="kg-health-stat-v">{health.index.symbolCount ?? "—"}</span>
          </div>
          <div className="kg-health-stat" data-stat="nodes">
            <span className="kg-health-stat-k">{t("pj.health.statNodes")}</span>
            <span className="kg-health-stat-v">{nodeCount ?? "—"}</span>
          </div>
          <div className="kg-health-stat" data-stat="issues">
            <span className="kg-health-stat-k">{t("pj.health.statIssues")}</span>
            <span className="kg-health-stat-v">{issueCount}</span>
          </div>
        </div>

        {/* 台账行（纯文字计数；过滤入口唯一归台账面板） */}
        <div className="kg-health-row" data-kg-health-ledger>
          <span className="kg-health-stat-k">{t("pj.health.ledgerTitle")}</span>
          <span className="kg-health-ledger-v" data-stat="cand-pending">
            {t("pj.health.candPending")} {health.candidates.pending}
          </span>
          <span className="kg-health-ledger-v" data-stat="cand-deferred">
            {t("pj.health.candDeferred")} {health.candidates.deferred}
          </span>
          <span className="kg-health-ledger-v" data-stat="cand-applied">
            {t("pj.health.candApplied")} {health.candidates.applied}
          </span>
          <span className="kg-health-ledger-v" data-stat="cand-discarded">
            {t("pj.health.candDiscarded")} {health.candidates.discarded}
          </span>
        </div>

        {/* 任务行：发起按钮直接入行（按钮状态即任务状态） */}
        <div className="kg-health-row kg-health-tasks" data-kg-task-launch>
          <div className="kg-task-block" data-kg-health-review>
            <div className="kg-task-row">
              <span className="hud-badge kbe-type">kg-review</span>
              <span className="kg-task-name">{t("pj.health.reviewTitle")}</span>
              {reviewRunning ? (
                <span className="hud-badge" data-review-running-badge>{t("pj.health.reviewRunningBadge")}</span>
              ) : (
                <button
                  type="button"
                  className="hud-btn kg-btn-primary kg-btn-sm"
                  data-review-launch-btn
                  disabled={reviewBusy}
                  onClick={onLaunchReview}
                >
                  {t("pj.health.reviewLaunch")}
                </button>
              )}
            </div>
            {reviewRunning && (
              <div className="kg-ok-strip" data-review-running>
                <span>{t("pj.health.reviewRunningStrip", { name: projectName })}</span>
                <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
                  {t("pj.health.reviewGoTasks")}
                </button>
              </div>
            )}
            {!reviewRunning && reviewLaunched && (
              <div className="kg-ok-strip" data-review-launched>
                <span>{t("pj.health.reviewLaunched", { name: projectName })}</span>
                <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
                  {t("pj.health.reviewGoTasks")}
                </button>
              </div>
            )}
          </div>
          <div className="kg-task-block" data-kg-health-code-review>
            <div className="kg-task-row">
              <span className="hud-badge kbe-type">code-review</span>
              <span className="kg-task-name">{t("pj.health.codeReviewTitle")}</span>
              {codeReviewRunning ? (
                <span className="hud-badge" data-code-review-running-badge>{t("pj.health.reviewRunningBadge")}</span>
              ) : (
                <button
                  type="button"
                  className="hud-btn kg-btn-primary kg-btn-sm"
                  data-code-review-launch-btn
                  disabled={codeReviewBusy}
                  onClick={onLaunchCodeReview}
                >
                  {t("pj.health.codeReviewLaunch")}
                </button>
              )}
            </div>
            {codeReviewRunning && (
              <div className="kg-ok-strip" data-code-review-running>
                <span>{t("pj.health.codeReviewRunningStrip", { name: projectName })}</span>
                <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
                  {t("pj.health.reviewGoTasks")}
                </button>
              </div>
            )}
            {!codeReviewRunning && codeReviewLaunched && (
              <div className="kg-ok-strip" data-code-review-launched>
                <span>{t("pj.health.codeReviewLaunched", { name: projectName })}</span>
                <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
                  {t("pj.health.reviewGoTasks")}
                </button>
              </div>
            )}
          </div>
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

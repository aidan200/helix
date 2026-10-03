/**
 * P-1 体检面板（W2-E 轨一结构体检看板，设计 kg-driven-dev-loop-design D5 +
 * R15）：顶部 = 项目概览卡，按业务三行——
 * ① 统计行：符号数 / 知识节点 / 最近同步 / 结构问题；
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
import type { KgAutoAuditDto, KgHealthDto } from "@helix/protocol";
import { fmtLocaleDateTime } from "@/shared/lib/format";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 任务块（kg-review / code-review 近同构——参数化单组件；d = data 前缀
 *  与 e2e 断言锚（review / code-review），文案键/三态由调用方注入）。 */
function TaskBlock({
  d,
  badge,
  titleKey,
  launchKey,
  runningStripKey,
  launchedKey,
  running,
  busy,
  launched,
  onLaunch,
  t,
  projectName,
  onOpenTasks,
}: {
  d: string;
  badge: string;
  titleKey: string;
  launchKey: string;
  runningStripKey: string;
  launchedKey: string;
  running: boolean;
  busy: boolean;
  launched: boolean;
  onLaunch: () => void;
  t: T;
  projectName: string;
  onOpenTasks: () => void;
}) {
  const attrs = (suffix: string) => ({ [`data-${d}-${suffix}`]: true });
  return (
    <div className="kg-task-block" {...{ [`data-kg-health-${d}`]: true }}>
      <div className="kg-task-row">
        <span className="hud-badge kbe-type">{badge}</span>
        <span className="kg-task-name">{t(titleKey)}</span>
        {running ? (
          <span className="hud-badge" {...attrs("running-badge")}>{t("pj.health.reviewRunningBadge")}</span>
        ) : (
          <button
            type="button"
            className="hud-btn kg-btn-primary kg-btn-sm"
            {...attrs("launch-btn")}
            disabled={busy}
            onClick={onLaunch}
          >
            {t(launchKey)}
          </button>
        )}
      </div>
      {running && (
        <div className="kg-ok-strip" {...attrs("running")}>
          <span>{t(runningStripKey, { name: projectName })}</span>
          <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
            {t("pj.health.reviewGoTasks")}
          </button>
        </div>
      )}
      {!running && launched && (
        <div className="kg-ok-strip" {...attrs("launched")}>
          <span>{t(launchedKey, { name: projectName })}</span>
          <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
            {t("pj.health.reviewGoTasks")}
          </button>
        </div>
      )}
    </div>
  );
}

export default function KgHealthPane({
  health,
  loading,
  failed,
  nodeCount,
  reviewBusy,
  reviewLaunched,
  reviewRunning,
  codeReviewBusy,
  codeReviewLaunched,
  codeReviewRunning,
  triageBusy,
  triageLaunched,
  triageRunning,
  audit,
  auditLoading,
  projectName,
  t,
  onLaunchReview,
  onLaunchCodeReview,
  onLaunchTriage,
  onAuditRefresh,
  onOpenTasks,
  onDraftAction,
}: {
  /** kg.health 回执（null = 未拉取/读取中）。 */
  health: KgHealthDto | null;
  loading: boolean;
  /** 拉取失败（code-review 族A 两态区分：「加载失败」非「永挂加载中」——重进 tab 重试）。 */
  failed: boolean;
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
  /** kg.triage.create 在途（P1 发起钮；单飞锁在 KgViewer）。 */
  triageBusy: boolean;
  /** 发起成功标记（ok-strip + 前往任务页出口）。 */
  triageLaunched: boolean;
  /** 该项目存在非终态 kg-triage job（kg.projects 行 triageRunning，P2 链路）。 */
  triageRunning: boolean;
  /** kg.auto.audit 回执（P2 抽查面；null = 未拉取）。 */
  audit: KgAutoAuditDto | null;
  /** 审计拉取在途（按钮态）。 */
  auditLoading: boolean;
  projectName: string;
  t: T;
  onLaunchReview: () => void;
  onLaunchCodeReview: () => void;
  onLaunchTriage: () => void;
  onAuditRefresh: () => void;
  onOpenTasks: () => void;
  /** P5 草稿裁决动作（仅携 id 的条目渲染动作钮；confirm=转正 / discard=驳回）。 */
  onDraftAction?: (kind: "confirm" | "discard", id: string) => void;
}) {
  if (loading || health === null) {
    if (failed && !loading) {
      return (
        <div className="kgv-empty" data-kg-health="failed">
          <div className="kgv-empty-t">{t("pj.health.loadFail")}</div>
        </div>
      );
    }
    return (
      <div className="kgv-empty" data-kg-health="loading">
        <div className="kgv-empty-t">{t("pj.health.loading")}</div>
      </div>
    );
  }
  const healthy = health.conflicts.length === 0 && health.orphans.length === 0;
  const issueCount = health.conflicts.length + health.orphanCount;
  // P3 拆栏：优先新可选字段（deadAnchors/unanchoredNodes），旧 daemon 缺字段
  // 时从 orphans 按 kind 派生（协议 additive 演进——旧 payload 零影响）
  const deadAnchors = health.deadAnchors ?? health.orphans.filter((o) => o.kind === "dead_anchor");
  const unanchoredNodes =
    health.unanchoredNodes ??
    health.orphans.filter((o) => o.kind === "orphan_node" || o.kind === "unanchored_node");
  const drafts = health.drafts ?? [];
  const draftCount = { ready: 0, stale: 0, "anchor-debt": 0 } as Record<string, number>;
  for (const d of drafts) draftCount[d.kind] = (draftCount[d.kind] ?? 0) + 1;
  return (
    <div className="kg-health" data-kg-health="ready">
      {/* ① 项目概览卡：统计行 / 台账行 / 任务行（按业务分行） */}
      <section className="kg-health-sec kg-health-overview" data-kg-health-overview>
        <div className="kg-health-sec-head">
          <span className="kg-health-sec-title">{t("pj.health.overviewTitle")}</span>
        </div>

        {/* 统计行（最近同步随统计行直显） */}
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
            <span className="kg-health-stat-k">{t("pj.health.statLastSync")}</span>
            <span className="kg-health-stat-v">{fmtLocaleDateTime(health.index.syncedAt)}</span>
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

        {/* 任务行：发起按钮直接入行（按钮状态即任务状态；两任务块参数化
            共用 TaskBlock 单组件） */}
        <div className="kg-health-row kg-health-tasks" data-kg-task-launch>
          <TaskBlock
            d="review"
            badge="kg-review"
            titleKey="pj.health.reviewTitle"
            launchKey="pj.health.reviewLaunch"
            runningStripKey="pj.health.reviewRunningStrip"
            launchedKey="pj.health.reviewLaunched"
            running={reviewRunning}
            busy={reviewBusy}
            launched={reviewLaunched}
            onLaunch={onLaunchReview}
            t={t}
            projectName={projectName}
            onOpenTasks={onOpenTasks}
          />
          <TaskBlock
            d="code-review"
            badge="code-review"
            titleKey="pj.health.codeReviewTitle"
            launchKey="pj.health.codeReviewLaunch"
            runningStripKey="pj.health.codeReviewRunningStrip"
            launchedKey="pj.health.codeReviewLaunched"
            running={codeReviewRunning}
            busy={codeReviewBusy}
            launched={codeReviewLaunched}
            onLaunch={onLaunchCodeReview}
            t={t}
            projectName={projectName}
            onOpenTasks={onOpenTasks}
          />
          {/* P1 kg-triage 待办面裁决（第三任务块——hint 建议位的一键入口） */}
          <TaskBlock
            d="triage"
            badge="kg-triage"
            titleKey="pj.health.triageTitle"
            launchKey="pj.health.triageLaunch"
            runningStripKey="pj.health.triageRunningStrip"
            launchedKey="pj.health.triageLaunched"
            running={triageRunning}
            busy={triageBusy}
            launched={triageLaunched}
            onLaunch={onLaunchTriage}
            t={t}
            projectName={projectName}
            onOpenTasks={onOpenTasks}
          />
        </div>

        {/* P2 triage 积压提示行（待办面三计数 ≥ 阈值；只提示不自动开任务） */}
        {health.triageHint !== undefined && health.triageHint.suggested && (
          <div className="kg-health-row" data-kg-triage-hint>
            <span className="kg-health-stat-k">{t("pj.health.triageHint")}</span>
            <span className="kg-health-ledger-v">{t("pj.health.triageHintCount", { count: health.triageHint.pendingTotal })}</span>
          </div>
        )}

        {/* P2 自动裁决审计段（低频抽查：拉取按钮 + stats + 最近条目） */}
        <div className="kg-health-row" data-kg-auto-audit>
          <span className="kg-health-stat-k">{t("pj.health.autoAuditTitle")}</span>
          <span className="kg-health-ledger-v">
            {audit === null ? t("pj.health.autoAuditIdle") : t("pj.health.autoAuditCount", { count: audit.stats.total })}
          </span>
          <button
            type="button"
            className="hud-btn kg-btn-primary kg-btn-sm"
            data-auto-audit-refresh
            disabled={auditLoading}
            onClick={onAuditRefresh}
          >
            {t("pj.health.autoAuditRefresh")}
          </button>
        </div>
        {audit !== null && audit.entries.length > 0 && (
          <ul className="kg-health-list" data-kg-auto-audit-entries>
            {audit.entries.slice(0, 5).map((e, i) => (
              <li key={i} className="kg-health-item" data-op={e.op}>
                {`${e.ts.slice(0, 19).replace("T", " ")} · ${e.op} · ${e.reason}`}
              </li>
            ))}
          </ul>
        )}
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
          {deadAnchors.length > 0 && (
            <section className="kg-health-sec" data-kg-health-dead-anchors>
              <div className="kg-health-sec-head">
                <span className="kg-health-sec-title">{t("pj.health.deadAnchorsTitle")}</span>
                <span className="kg-sev-badge warn">{deadAnchors.length}</span>
              </div>
              <ul className="kg-health-list">
                {deadAnchors.map((o, i) => (
                  <li key={i} className="kg-health-item" data-kind={o.kind}>
                    {o.summary}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {unanchoredNodes.length > 0 && (
            <section className="kg-health-sec" data-kg-health-unanchored>
              <div className="kg-health-sec-head">
                <span className="kg-health-sec-title">{t("pj.health.unanchoredTitle")}</span>
                <span className="kg-sev-badge warn">{unanchoredNodes.length}</span>
              </div>
              <ul className="kg-health-list">
                {unanchoredNodes.map((o, i) => (
                  <li key={i} className="kg-health-item" data-kind={o.kind}>
                    {o.summary}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {/* P3 草稿栏：三分类计数 + 明细（含 age）——信息级非错误（待裁决是
          正常态，不参与 healthy 判定）；零草稿时整栏隐藏 */}
      {drafts.length > 0 && (
        <section className="kg-health-sec" data-kg-health-drafts>
          <div className="kg-health-sec-head">
            <span className="kg-health-sec-title">{t("pj.health.draftsTitle")}</span>
            <span className="kg-health-ledger-v" data-stat="draft-ready">
              {t("pj.health.draftReady")} {draftCount["ready"] ?? 0}
            </span>
            <span className="kg-health-ledger-v" data-stat="draft-stale">
              {t("pj.health.draftStale")} {draftCount["stale"] ?? 0}
            </span>
            <span className="kg-health-ledger-v" data-stat="draft-debt">
              {t("pj.health.draftDebt")} {draftCount["anchor-debt"] ?? 0}
            </span>
          </div>
          <ul className="kg-health-list">
            {drafts.map((d, i) => (
              <li key={i} className="kg-health-item" data-kind={d.kind}>
                {d.note !== undefined && d.note !== "" ? (
                  <span className="kg-health-note">{d.note}</span>
                ) : (
                  d.summary
                )}
                {d.ageDays !== null && (
                  <span className="kg-health-age"> · {t("pj.health.draftAgeDays", { n: d.ageDays })}</span>
                )}
                {d.note !== undefined && d.note !== "" && (
                  <span className="kg-health-age"> · {d.summary}</span>
                )}
                {d.id !== undefined && onDraftAction !== undefined && (
                  <span className="kg-health-draft-acts">
                    <button
                      type="button"
                      className="kg-health-act-btn"
                      data-kg-draft-act="confirm"
                      data-kg-draft-id={d.id}
                      onClick={() => onDraftAction("confirm", d.id!)}
                    >
                      {t("pj.health.draftConfirmBtn")}
                    </button>
                    <button
                      type="button"
                      className="kg-health-act-btn kg-health-act-danger"
                      data-kg-draft-act="discard"
                      data-kg-draft-id={d.id}
                      onClick={() => onDraftAction("discard", d.id!)}
                    >
                      {t("pj.health.draftDiscardBtn")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

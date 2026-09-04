/**
 * P-1 任务发起面板（W2-F 轨二发起入口紧凑形态；由 kg-health-pane 拆出）：
 * 单一卡片两行——语义体检（kg.review.create）+ 代码评审
 * （code.review.create，code-review v1.5），每行 = 类型徽章 + 名称 + 启动钮
 * （或运行态徽标 + 任务页观察出口）；零说明文案（启动钮即「开启前一次确认」
 * 位，bootstrap 入口同规）。
 *
 * 运行态（项目行级标记置位时无启动钮只留任务页观察出口——与
 * KgBootstrapEntry running 态同构，服务端为准，组件重挂后仍持正确态，
 * 两类徽标各行其是）。纯展示组件：命令发送/回执消费/单飞锁归 KgViewer
 * 常驻 listener，本组件只回调。
 */

type T = (key: string, vars?: Record<string, string | number>) => string;

export default function KgTaskLaunch({
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
  /** kg.review.create 在途（发起钮禁用；单飞锁在 KgViewer）。 */
  reviewBusy: boolean;
  /** 发起成功标记（ok-strip + 前往任务页出口）。 */
  reviewLaunched: boolean;
  /** 该项目存在非终态 kg-review job（kg.projects 行 reviewRunning）：
   *  入口置运行态——无启动钮只留任务页出口；终态后恢复可发起（仅禁并发）。 */
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
  return (
    <section className="kg-health-sec kg-task-launch" data-kg-task-launch>
      <div className="kg-health-sec-head">
        <span className="kg-health-sec-title">{t("pj.health.tasksTitle")}</span>
      </div>

      {/* 语义体检（kg-review）；block = 行 + 状态条（测试以本容器定位出口） */}
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

      {/* 代码评审（code-review） */}
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
    </section>
  );
}

/**
 * P-1 bootstrap 入口卡（T3.2；R-11/R-12，CL-1 F1.1/F1.2）：graph 态左栏
 * 索引面板区下方挂载（准入判定数据源 = 项目行索引态 + nodeCount，机械
 * 定义见 project-model.bootstrapEntryMode）。
 *
 * 四态互斥（review.md P-1 状态模型）：hidden（已有图谱/nodeCount 未知 →
 * 静默不渲染，V-1：无降级态无提示文案）/ ready（准入条件行 + 任务说明 +
 * 目标项目 + 范围参数 + 三阶段计划 L0/L1/L2 + 启动钮；degraded 附
 * warning 条如实提示）/ launched（ready 卡 + ok-strip + 「前往『任务』页
 * 观察 →」）。guide/building 态不在此渲染（absent/building 项目不进
 * graph 态——主区四态机消化，ProjectPage 引导链）。
 *
 * 纯展示组件：命令发送与回执消费归 KgViewer 常驻 listener（单飞关联），
 * 本组件只回调 onLaunch。AD-5：启动钮即「开启前一次确认」位——确认的
 * 是干什么（任务说明）+怎么分阶段（三阶段计划），无二次弹窗。
 */
import type { KgProjectRow } from "@helix/protocol";
import type { BootstrapEntryMode } from "../model/project-model";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 三阶段计划行（L0/L1/L2 序号行 + 各层职责；review.md R-12）。 */
const PLAN_ROWS: ReadonlyArray<{ seq: number; nameKey: string; descKey: string }> = [
  { seq: 1, nameKey: "pj.boot.planL0Name", descKey: "pj.boot.planL0Desc" },
  { seq: 2, nameKey: "pj.boot.planL1Name", descKey: "pj.boot.planL1Desc" },
  { seq: 3, nameKey: "pj.boot.planL2Name", descKey: "pj.boot.planL2Desc" },
];

export default function KgBootstrapEntry({
  row,
  mode,
  busy,
  t,
  onLaunch,
  onOpenTasks,
}: {
  row: KgProjectRow;
  mode: BootstrapEntryMode;
  /** kg.bootstrap.create 在途（启动钮禁用；单飞锁在 KgViewer）。 */
  busy: boolean;
  t: T;
  onLaunch: () => void;
  /** ok-strip「前往『任务』页观察 →」出口（App 层路由回调）。 */
  onOpenTasks: () => void;
}) {
  // V-1 静默：已有图谱（nodeCount>0/未知）与 guide/building 不渲染（后者
  // 理论不可达——graph 态行只余 synced/degraded；防御性同归静默）
  if (mode === "hidden" || mode === "guide" || mode === "building") return null;
  const degraded = row.status === "degraded";
  return (
    <div className="kg-boot-entry" data-boot-entry={mode} data-boot-project={row.name}>
      <div className="kbe-head">
        <span className="kbe-title">{t("pj.boot.sectionTitle")}</span>
        <span className="hud-badge kbe-type">{t("pj.boot.typeBadge")}</span>
        {degraded && <span className="kg-sev-badge warn">{t("pj.boot.degradedBadge")}</span>}
      </div>
      <div className="kbe-body">
        {degraded && (
          <div className="kg-warn-strip" data-boot-degraded-warn>
            {t("pj.boot.degradedWarn")}
          </div>
        )}
        <div className="kbe-row">
          <span className="kbe-k">{t("pj.boot.eligibility")}</span>
          <span className="kbe-v muted">{t("pj.boot.eligibilityValue")}</span>
        </div>
        <div className="kbe-row">
          <span className="kbe-k">{t("pj.boot.desc")}</span>
          <span className="kbe-v muted">{t("pj.boot.descValue")}</span>
        </div>
        <div className="kbe-row">
          <span className="kbe-k">{t("pj.boot.target")}</span>
          <span className="kbe-v">
            {row.name} <span className="muted">{row.path}</span>
          </span>
        </div>
        <div className="kbe-row">
          <span className="kbe-k">{t("pj.boot.scope")}</span>
          <span className="kbe-v muted">{t("pj.boot.scopeValue")}</span>
        </div>
        <div className="kbe-row">
          <span className="kbe-k">{t("pj.boot.plan")}</span>
          <div className="kbe-plan">
            {PLAN_ROWS.map((p) => (
              <div className="kbe-plan-row" key={p.seq}>
                <span className="kbe-plan-seq">{p.seq}</span>
                <span className="kbe-plan-name">{t(p.nameKey)}</span>
                <span className="kbe-plan-desc muted">{t(p.descKey)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="kbe-actions">
          <button
            type="button"
            className="hud-btn kg-btn-primary"
            data-launch-btn
            disabled={busy}
            onClick={onLaunch}
          >
            {t("pj.boot.launch")}
          </button>
          <span className="kbe-note muted">{t("pj.boot.launchNote")}</span>
        </div>
        {mode === "launched" && (
          <div className="kg-ok-strip" data-boot-launched>
            <span>{t("pj.boot.launchedStrip", { name: row.name })}</span>
            <button type="button" className="hud-btn kg-btn-primary kg-btn-sm" data-goto-tasks onClick={onOpenTasks}>
              {t("pj.boot.goTasks")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

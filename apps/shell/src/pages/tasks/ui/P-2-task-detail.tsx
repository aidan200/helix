/**
 * P-2 任务页详情头（T3.1；R-7/R-8/R-9/R-19）：类型+状态徽章+标题 +
 * 生命周期按钮（六态门控矩阵 lifecycleActions 单源）+ 元信息（项目 chip +
 * 创建时间 + 时长 + 发起来源双宿主如实）+ 终态「前往『项目』页」出口
 *（header 首行右端，accent 色 + hover 反馈；narrative-remove：叙述句块
 * 已拆除）+ 取消/删除两步内联确认条。
 *
 * 门控矩阵（F3.5/F3.6）：pending=取消 / running=暂停+取消 / paused=继续+取消 /
 * 三终态=删除（运行中须先取消，无删除钮）。两步确认文案含清理范围与
 * kg 产出不动交代（决策消解）。
 */
import type { TaskDetailDto } from "@helix/protocol";
import { cn } from "@/shared/lib/cn";
import {
  lifecycleActions,
  taskElapsedMs,
  type TaskLifecycleAction,
} from "../model/tasks-model";
import { ProjectChips, TaskStatusBadge, TaskTypeBadge, fmtElapsed, fmtShort } from "./P-2-task-atoms";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 生命周期按钮渲染序与样式（gate 矩阵输出 → 按钮集）。 */
const ACTION_LABEL: Readonly<Record<TaskLifecycleAction, string>> = {
  pause: "tk.act.pause",
  resume: "tk.act.resume",
  cancel: "tk.act.cancel",
  delete: "tk.act.delete",
};

const ACTION_CLASS: Readonly<Record<TaskLifecycleAction, string>> = {
  pause: "hud-btn hud-btn-ghost",
  resume: "hud-btn kg-btn-primary",
  cancel: "hud-btn hud-btn-danger",
  delete: "hud-btn hud-btn-danger",
};

/** 是否终态（行动出口显示位）。 */
const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

export default function TaskDetailHead({
  detail,
  now,
  t,
  busy,
  confirmBox,
  onAction,
  onConfirmOpen,
  onConfirmClose,
  onOpenProject,
}: {
  detail: TaskDetailDto;
  now: number;
  t: T;
  /** 生命周期命令在途（单飞锁：按钮禁用）。 */
  busy: boolean;
  confirmBox: "none" | "cancel" | "delete";
  onAction: (kind: TaskLifecycleAction) => void;
  onConfirmOpen: (box: "cancel" | "delete") => void;
  onConfirmClose: () => void;
  onOpenProject: () => void;
}) {
  const actions = lifecycleActions(detail.status);
  const durKey =
    detail.status === "running" || detail.status === "paused"
      ? "tk.dur.running"
      : detail.status === "pending"
        ? "tk.dur.createdAgo"
        : "tk.dur.final";
  const dur = t(durKey, { dur: fmtElapsed(taskElapsedMs(detail, now), t) });
  const src = detail.createdBy === "chat" ? t("tk.head.srcChat") : t("tk.head.srcPage");
  return (
    <div className="tk-head" data-tk-detail data-id={detail.jobId}>
      <div className="tk-head-top">
        <TaskTypeBadge type={detail.type} />
        <TaskStatusBadge status={detail.status} t={t} />
        <span className="tk-head-title">{detail.title}</span>
        <span className="tk-head-actions" data-tk-actions>
          {actions.map((kind) => (
            <button
              key={kind}
              type="button"
              className={cn(ACTION_CLASS[kind], "kg-btn-sm")}
              data-act={kind}
              disabled={busy}
              onClick={() => {
                if (kind === "cancel" || kind === "delete") onConfirmOpen(kind);
                else onAction(kind);
              }}
            >
              {t(ACTION_LABEL[kind])}
            </button>
          ))}
        </span>
        {/* R-8 终态行动出口：header 首行右端（与生命周期按钮同排右对齐） */}
        {TERMINAL.has(detail.status) && (
          <button type="button" className="tk-head-link" data-tk-go-project onClick={onOpenProject}>
            {t("tk.head.goProject")}
          </button>
        )}
      </div>
      <div className="tk-head-meta">
        <ProjectChips projects={detail.projects} />
        <span data-tk-created>{t("tk.head.created", { at: fmtShort(detail.createdAt) })}</span>
        <span>·</span>
        <span data-tk-duration>{dur}</span>
        <span>·</span>
        <span data-tk-source>{src}</span>
      </div>
      {/* F3.5 取消两步确认：批次收口 + 产出保留 + 不可撤销 */}
      {confirmBox === "cancel" && (
        <div className="tk-confirm" data-tk-confirm="cancel">
          <div className="tk-confirm-text">{t("tk.confirm.cancelText", { title: detail.title })}</div>
          <div className="tk-confirm-btns">
            <button
              type="button"
              className="hud-btn hud-btn-danger kg-btn-sm"
              data-tk-confirm-yes="cancel"
              disabled={busy}
              onClick={() => onAction("cancel")}
            >
              {t("tk.confirm.cancelYes")}
            </button>
            <button type="button" className="hud-btn kg-btn-sm" data-tk-confirm-back onClick={onConfirmClose}>
              {t("tk.confirm.back")}
            </button>
          </div>
        </div>
      )}
      {/* F3.6 删除两步确认：清任务域全部记录 + kg 产出不动 + 不可撤销 */}
      {confirmBox === "delete" && (
        <div className="tk-confirm" data-tk-confirm="delete">
          <div className="tk-confirm-text">{t("tk.confirm.deleteText", { title: detail.title })}</div>
          <div className="tk-confirm-btns">
            <button
              type="button"
              className="hud-btn hud-btn-danger kg-btn-sm"
              data-tk-confirm-yes="delete"
              disabled={busy}
              onClick={() => onAction("delete")}
            >
              {t("tk.confirm.deleteYes")}
            </button>
            <button type="button" className="hud-btn kg-btn-sm" data-tk-confirm-back onClick={onConfirmClose}>
              {t("tk.confirm.back")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * P-2 任务页左栏（T3.1；R-2/R-3）：过滤器（状态 seg 全部+六态 + 项目 seg
 * 数据驱动）+ 全局平铺任务列表（运行中置顶 + 创建时间倒序——视图行由
 * tasks-model selectListView 派生，组件零排序逻辑）。
 *
 * 状态模型互斥（review.md P-2）：loading 骨架 / empty（零任务，指路宿主——
 * CL-1.A7 零创建面）/ filter-empty（清除过滤出口）/ success 四态恰一渲染。
 * 原型标注（「列表演示」小字）已剥离；演示 seg（全状态/空列表）保留为
 * isDev() 门控 dev 机制（data-demo）。
 */
import type { TaskStatus, TaskSummaryDto } from "@helix/protocol";
import { cn } from "@/shared/lib/cn";
import { isDev } from "@/shared/lib/is-dev";
import {
  projectOptions,
  taskElapsedMs,
  type TasksListView,
  type TasksPageState,
} from "../model/tasks-model";
import { EmptyPanel, ProgressTrack, ProjectChips, TaskSkeleton, TaskStatusBadge, TaskTypeBadge, fmtElapsed, fmtShort } from "./P-2-task-atoms";

type T = (key: string, vars?: Record<string, string | number>) => string;

const STATUS_ORDER: readonly TaskStatus[] = ["running", "paused", "pending", "done", "failed", "cancelled"];

/** 列表行（六要素：类型徽章+状态徽章 / 粗体标题 / 进度条+阶段批次 / 项目徽章+时间）。 */
function TaskRow({
  task,
  selected,
  now,
  t,
  onSelect,
}: {
  task: TaskSummaryDto;
  selected: boolean;
  now: number;
  t: T;
  onSelect: (jobId: string) => void;
}) {
  const p = task.progress;
  let line = "";
  let ratio = 0;
  let tone: "accent" | "ok" | "err" = "accent";
  if (task.status === "done") {
    line = t("tk.list.progDone");
    ratio = 1;
    tone = "ok";
  } else if (task.status === "failed") {
    line = t("tk.list.progFailed");
    ratio = (p?.percent ?? 0) / 100;
    tone = "err";
  } else if (task.status === "cancelled") {
    line = t("tk.list.progCancelled");
    ratio = (p?.percent ?? 0) / 100;
  } else if (task.status === "pending") {
    line = t("tk.list.progPending");
  } else {
    // running / paused：当前阶段名 · 批次 x/y（progress 契约字段）
    line =
      p !== null
        ? t(task.status === "running" ? "tk.list.progRunning" : "tk.list.progPaused", {
            stage: p.stageName ?? "",
            done: p.batchesDone,
            total: p.batchesTotal,
          })
        : "";
    ratio = (p?.percent ?? 0) / 100;
  }
  const durKey =
    task.status === "running" || task.status === "paused"
      ? "tk.dur.running"
      : task.status === "pending"
        ? "tk.dur.createdAgo"
        : "tk.dur.final";
  const dur = t(durKey, { dur: fmtElapsed(taskElapsedMs(task, now), t) });
  return (
    <div
      className={cn(
        "tk-row",
        selected && "selected",
        (task.status === "failed" || task.status === "cancelled") && "dim",
      )}
      data-id={task.jobId}
      data-task={task.status}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(task.jobId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(task.jobId);
        }
      }}
    >
      <div className="tk-row-top">
        <TaskTypeBadge type={task.type} />
        <TaskStatusBadge status={task.status} t={t} />
      </div>
      <div className="tk-row-title">{task.title}</div>
      <div className="tk-row-prog">
        <ProgressTrack ratio={ratio} tone={tone} />
        <span className="tk-row-prog-t">{line}</span>
      </div>
      <div className="tk-row-meta">
        <ProjectChips projects={task.projects} />
        <span className="tk-time">
          {t("tk.list.created", { at: fmtShort(task.createdAt) })} · {dur}
        </span>
      </div>
    </div>
  );
}

/** seg 按钮（kg-seg 形态复用）。 */
function SegButton({
  value,
  active,
  label,
  marker,
  onClick,
}: {
  value: string;
  active: boolean;
  label: string;
  marker?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(active && "active")}
      data-v={value}
      data-tk-seg={marker}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** 左栏整体（过滤器 + 列表；视图态由 props 注入——组件零数据面）。 */
export default function TaskListPane({
  view,
  state,
  now,
  t,
  onSelect,
  onFilterStatus,
  onFilterProject,
  onClearFilters,
  onDemoEmpty,
  onOpenProject,
}: {
  view: TasksListView;
  state: TasksPageState;
  now: number;
  t: T;
  onSelect: (jobId: string) => void;
  onFilterStatus: (value: "all" | TaskStatus) => void;
  onFilterProject: (value: string) => void;
  onClearFilters: () => void;
  onDemoEmpty: (on: boolean) => void;
  /** 空态指路宿主（CL-1.A7：任务页零创建，空态唯一出口是宿主上下文）。 */
  onOpenProject: () => void;
}) {
  const projects = projectOptions(state);
  return (
    <aside className="tk-side" aria-label={t("tk.title")} data-tk-list-pane>
      <div className="tk-filters">
        {/* 演示控件（dev 机制；isDev 门控——prod 不渲染；原型标注「列表演示」已剥离） */}
        {isDev() && (
          <div className="tk-seg-row">
            <div className="kg-seg" data-demo data-tk-demo>
              <SegButton
                value="full"
                active={!state.demoEmpty}
                label={t("tk.demo.full")}
                onClick={() => onDemoEmpty(false)}
              />
              <SegButton
                value="empty"
                active={state.demoEmpty}
                label={t("tk.demo.empty")}
                onClick={() => onDemoEmpty(true)}
              />
            </div>
          </div>
        )}
        <div className="tk-seg-row">
          <div className="kg-seg" data-tk-filter-status>
            <SegButton
              value="all"
              active={state.filterStatus === "all"}
              label={t("tk.filter.all")}
              marker="status"
              onClick={() => onFilterStatus("all")}
            />
            {STATUS_ORDER.map((s) => (
              <SegButton
                key={s}
                value={s}
                active={state.filterStatus === s}
                label={t(`tk.status.${s}`)}
                marker="status"
                onClick={() => onFilterStatus(s)}
              />
            ))}
          </div>
        </div>
        <div className="tk-seg-row">
          <div className="kg-seg" data-tk-filter-project>
            <SegButton
              value="all"
              active={state.filterProject === "all"}
              label={t("tk.filter.allProjects")}
              marker="project"
              onClick={() => onFilterProject("all")}
            />
            {projects.map((p) => (
              <SegButton
                key={p}
                value={p}
                active={state.filterProject === p}
                label={p}
                marker="project"
                onClick={() => onFilterProject(p)}
              />
            ))}
          </div>
        </div>
        <div className="tk-count-line" data-tk-count>
          {view.mode === "success" && t("tk.countLine", { n: view.rows.length })}
        </div>
      </div>
      <div className="tk-list" data-tk-list>
        {view.mode === "loading" && <TaskSkeleton lines={3} />}
        {view.mode === "empty" && (
          <EmptyPanel
            marker="list"
            title={t("tk.emptyList.title")}
            sub={t("tk.emptyList.sub")}
            action={
              <button type="button" className="hud-btn" data-tk-goto-project onClick={onOpenProject}>
                {t("tk.emptyList.cta")}
              </button>
            }
          />
        )}
        {view.mode === "filter-empty" && (
          <EmptyPanel
            marker="filter"
            title={t("tk.filterEmpty.title")}
            sub={t("tk.filterEmpty.sub")}
            action={
              <button
                type="button"
                className="hud-btn"
                data-tk-clear-filters
                onClick={onClearFilters}
              >
                {t("tk.filterEmpty.clear")}
              </button>
            }
          />
        )}
        {view.mode === "success" &&
          view.rows.map((task) => (
            <TaskRow
              key={task.jobId}
              task={task}
              selected={state.selected === task.jobId}
              now={now}
              t={t}
              onSelect={onSelect}
            />
          ))}
      </div>
    </aside>
  );
}

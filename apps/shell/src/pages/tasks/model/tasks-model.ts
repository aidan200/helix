/**
 * P-2 任务页页面私有状态机（T3.1；CL-3 F3.1~F3.6）。
 *
 * 三个正交子模型（review.md P-2 状态模型）：
 * - 列表视图态：loading | empty | filter-empty | success（互斥，派生 selector
 *   selectListView——过滤切换先清旧态再渲染由派生天然保证）；
 * - 选中/详情态：选任务先重置三件套（tab=进度、确认条收起、plan 展开收起）
 *   + 旧详情/产物清空；list-result 自动选中首行（仅一次不夺位）；
 * - 生命周期在途锁：pendingLifecycle 单飞（错误回执 lifecycle-failed 清锁，
 *   toast 由页面听众发——reducer 不持 UI 副作用）。
 *
 * 纯函数（vitest 断言面，TDD RED 五组）：
 * - sortTasks：运行中置顶 + 创建时间倒序（服务端排序契约 §2 的客户端镜像
 *   ——排序权威在服务端，此处保证本地派生一致，过滤重排不漂移）；
 * - filterTasks：状态 seg + 项目 seg（"all" = 不过滤；wire 状态值入参）；
 * - lifecycleActions：六态门控矩阵（pending=取消 / running=暂停+取消 /
 *   paused=继续+取消 / 三终态=删除 F3.6——运行中须先取消，无删除钮）；
 * - taskStatusDisplay：wire→展示映射（决策消解①：pending→装配中（planning
 *   语义色）/ done→已完成——映射仅展示层，wire 不出第二套词表，契约 §0）；
 * - taskElapsedMs / elapsedSpan：运行时长前端由 createdAt+status 计算
 *  （running/paused 走 realtime tick；终态定格 updatedAt-createdAt）。
 *
 * AG-15：连接私有读面页面 reducer，不进 session store（ProjectPage 先例）。
 * 数据面 = contracts/task-api.md 九命令族 + task.changed（协议类型单源
 * @helix/protocol/types/task.ts，AG-13 两端同源）。
 */
import type { TaskArtifactsDto, TaskDetailDto, TaskStatus, TaskSummaryDto } from "@helix/protocol";

// ── 纯函数（framework-free；vitest 断言面）────────────────────

/** 状态过滤器（"all" = 不过滤；六态取 wire 值）。 */
export type TaskStatusFilter = "all" | TaskStatus;

/** 列表排序（CL-3-T1）：running 置顶，其余创建时间倒序；running 之间同样倒序。 */
export function sortTasks(tasks: readonly TaskSummaryDto[]): TaskSummaryDto[] {
  return [...tasks].sort((a, b) => {
    const ar = a.status === "running" ? 0 : 1;
    const br = b.status === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

/** 过滤（CL-3-T2）：状态 seg + 项目 seg 可叠加（all/all = 全量）。 */
export function filterTasks(
  tasks: readonly TaskSummaryDto[],
  status: TaskStatusFilter,
  project: string,
): TaskSummaryDto[] {
  return tasks.filter(
    (t) =>
      (status === "all" || t.status === status) && (project === "all" || t.projects.includes(project)),
  );
}

/** 生命周期+删除门控矩阵（CL-3-T7/T12；F3.5/F3.6 机械定义）。 */
export type TaskLifecycleAction = "pause" | "resume" | "cancel" | "retry" | "delete";

export function lifecycleActions(status: TaskStatus): readonly TaskLifecycleAction[] {
  switch (status) {
    case "running":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "pending":
      return ["cancel"];
    case "failed":
      // failed：人工重试（task.retry 复活——批次预算归零留痕 + failed 阶段重开）+ 终态删除
      return ["retry", "delete"];
    default:
      // done / cancelled：仅终态删除（运行中须先取消，无删除钮）
      return ["delete"];
  }
}

/** wire→展示映射（决策消解①；展示层专用，零第二套 wire 词表）。 */
export interface TaskStatusView {
  /** 展示文案 i18n 键位（页面经 t() 解析；模型零硬编码 CJK）。 */
  labelKey: `tk.status.${TaskStatus}`;
  /** hud-badge st-* 语义修饰类（st-pending…st-cancelled，零新增 token）。 */
  badge: `st-${TaskStatus}`;
}

const STATUS_VIEW: Readonly<Record<TaskStatus, TaskStatusView>> = {
  pending: { labelKey: "tk.status.pending", badge: "st-pending" },
  running: { labelKey: "tk.status.running", badge: "st-running" },
  paused: { labelKey: "tk.status.paused", badge: "st-paused" },
  done: { labelKey: "tk.status.done", badge: "st-done" },
  failed: { labelKey: "tk.status.failed", badge: "st-failed" },
  cancelled: { labelKey: "tk.status.cancelled", badge: "st-cancelled" },
};

export function taskStatusDisplay(status: TaskStatus): TaskStatusView {
  return STATUS_VIEW[status];
}

/**
 * 运行时长（ms）：running/paused 由 createdAt 到 now 计算（realtime tick 消费）；
 * 终态定格 updatedAt - createdAt（brief 决策消解：duration 不传，前端计算）。
 */
export function taskElapsedMs(t: Pick<TaskSummaryDto, "status" | "createdAt" | "updatedAt">, nowMs: number): number {
  const from = Date.parse(t.createdAt);
  const to = t.status === "running" || t.status === "paused" ? nowMs : Date.parse(t.updatedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, to - from);
}

/** 时长分档（i18n 前结构化；页面经 t() 组装「已运行 N 分钟」等）。 */
export type ElapsedSpan =
  | { key: "sec"; n: number }
  | { key: "min"; n: number }
  | { key: "hourMin"; h: number; m: number };

export function elapsedSpan(ms: number): ElapsedSpan {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return { key: "sec", n: Math.floor(ms / 1000) };
  if (totalMin < 60) return { key: "min", n: totalMin };
  return { key: "hourMin", h: Math.floor(totalMin / 60), m: totalMin % 60 };
}

// ── 页面状态 ────────────────────────────────────────────────

export interface TasksPageState {
  /** task.list 回执（全量；视图行 = 过滤+排序派生）。 */
  tasks: TaskSummaryDto[];
  /** 首拉/重拉骨架（loading 视图态）。 */
  listLoading: boolean;
  /** 状态 seg（全部+六态，wire 值）。 */
  filterStatus: TaskStatusFilter;
  /** 项目 seg（"all" | 项目名；选项由 tasks projects 并集派生）。 */
  filterProject: string;
  /** 选中 jobId（null = 未选/空表——主区 empty）。 */
  selected: string | null;
  /** 详情双 tab（选任务重置为 progress）。 */
  tab: "progress" | "result";
  /** 当前详情（detail.result；迟到回执按 jobId 丢弃）。 */
  detail: TaskDetailDto | null;
  detailLoading: boolean;
  /** 任务结果（task.artifacts 回执；artifactsJob = 归属校验）。 */
  artifacts: TaskArtifactsDto | null;
  artifactsLoading: boolean;
  artifactsJob: string | null;
  /** 两步内联确认条（cancel / delete；选任务/操作启动时收起）。 */
  confirmBox: "none" | "cancel" | "delete";
  /** 批次实例 plan 展开台账（batchId → open；选任务重置）。 */
  planOpen: Record<string, boolean>;
  /** 生命周期命令在途单飞锁（错误回执清锁）。 */
  pendingLifecycle: TaskLifecycleAction | null;
}

export function createTasksPageState(): TasksPageState {
  return {
    tasks: [],
    listLoading: true,
    filterStatus: "all",
    filterProject: "all",
    selected: null,
    tab: "progress",
    detail: null,
    detailLoading: false,
    artifacts: null,
    artifactsLoading: false,
    artifactsJob: null,
    confirmBox: "none",
    planOpen: {},
    pendingLifecycle: null,
  };
}

export type TasksAction =
  | { type: "list-loading" }
  | { type: "list-result"; tasks: TaskSummaryDto[] }
  /** workspace_changed（W4 刷新链）：任务域随新工作空间整体作废（ProjectPage 先例）。 */
  | { type: "workspace-reset" }
  | { type: "filter-status"; value: TaskStatusFilter }
  | { type: "filter-project"; value: string }
  | { type: "clear-filters" }
  /** 选任务先重置三件套 + 清旧详情/产物（detailLoading 置位等首拉）。 */
  | { type: "select-task"; jobId: string }
  | { type: "detail-loading"; jobId: string }
  | { type: "detail-result"; task: TaskDetailDto }
  | { type: "artifacts-loading"; jobId: string }
  | { type: "artifacts-result"; jobId: string; artifacts: TaskArtifactsDto }
  | { type: "tab"; value: "progress" | "result" }
  | { type: "confirm-open"; box: "cancel" | "delete" }
  | { type: "confirm-close" }
  | { type: "lifecycle-started"; kind: TaskLifecycleAction }
  | { type: "lifecycle-result"; kind: TaskLifecycleAction; jobId: string; status?: TaskStatus }
  | { type: "delete-result"; jobId: string }
  | { type: "lifecycle-failed" }
  | { type: "plan-toggle"; batchId: string };

export function tasksReducer(state: TasksPageState, action: TasksAction): TasksPageState {
  switch (action.type) {
    case "list-loading":
      return state.listLoading ? state : { ...state, listLoading: true };
    case "list-result": {
      const tasks = sortTasks(action.tasks);
      // 空列表选中清空；已有选中不夺位（job 在新清单消失 → 回落首行）
      let selected = state.selected;
      if (tasks.length === 0) selected = null;
      else if (selected === null || !tasks.some((t) => t.jobId === selected)) selected = tasks[0]!.jobId;
      const detailGone = state.detail !== null && state.detail.jobId !== selected;
      return {
        ...state,
        tasks,
        listLoading: false,
        selected,
        detail: detailGone ? null : state.detail,
      };
    }
    case "workspace-reset":
      return createTasksPageState();
    case "filter-status":
      return { ...state, filterStatus: action.value };
    case "filter-project":
      return { ...state, filterProject: action.value };
    case "clear-filters":
      return { ...state, filterStatus: "all", filterProject: "all" };
    case "select-task": {
      if (state.selected === action.jobId && state.detail !== null) return state;
      return {
        ...state,
        selected: action.jobId,
        tab: "progress",
        detail: null,
        detailLoading: true,
        artifacts: null,
        artifactsLoading: false,
        artifactsJob: null,
        confirmBox: "none",
        planOpen: {},
      };
    }
    case "detail-loading":
      if (state.selected !== action.jobId) return state; // 迟到启动（已切任务）
      return state.detailLoading ? state : { ...state, detailLoading: true, detail: null };
    case "detail-result": {
      if (state.selected !== action.task.jobId) return state; // 迟到回执丢弃
      return { ...state, detail: action.task, detailLoading: false };
    }
    case "artifacts-loading":
      if (state.selected !== action.jobId) return state;
      return { ...state, artifactsLoading: true };
    case "artifacts-result": {
      if (state.selected !== action.jobId) return state;
      return { ...state, artifacts: action.artifacts, artifactsJob: action.jobId, artifactsLoading: false };
    }
    case "tab":
      return state.tab === action.value ? state : { ...state, tab: action.value };
    case "confirm-open":
      return { ...state, confirmBox: action.box };
    case "confirm-close":
      return state.confirmBox === "none" ? state : { ...state, confirmBox: "none" };
    case "lifecycle-started":
      return { ...state, pendingLifecycle: action.kind, confirmBox: "none" };
    case "lifecycle-result": {
      // pause/resume/cancel 回执（ok+status）：行 + 选中详情同步翻；changed 帧随后重拉收口
      const tasks = state.tasks.map((t) =>
        t.jobId === action.jobId && action.status !== undefined
          ? { ...t, status: action.status, updatedAt: new Date().toISOString() }
          : t,
      );
      const detail =
        state.detail !== null && state.detail.jobId === action.jobId && action.status !== undefined
          ? { ...state.detail, status: action.status }
          : state.detail;
      return { ...state, tasks, detail, pendingLifecycle: null };
    }
    case "delete-result": {
      // R-19：列表移除该行 + 选中回落首项 + 详情退出（删尽 → null + 空态）
      const tasks = state.tasks.filter((t) => t.jobId !== action.jobId);
      const selected =
        state.selected !== action.jobId ? state.selected : (sortTasks(tasks)[0]?.jobId ?? null);
      const detail = state.detail !== null && state.detail.jobId === action.jobId ? null : state.detail;
      return {
        ...state,
        tasks,
        selected,
        detail,
        pendingLifecycle: null,
        confirmBox: "none",
        artifacts: state.artifactsJob === action.jobId ? null : state.artifacts,
        artifactsJob: state.artifactsJob === action.jobId ? null : state.artifactsJob,
      };
    }
    case "lifecycle-failed":
      return state.pendingLifecycle === null ? state : { ...state, pendingLifecycle: null };
    case "plan-toggle": {
      const planOpen = { ...state.planOpen };
      if (planOpen[action.batchId] === true) delete planOpen[action.batchId];
      else planOpen[action.batchId] = true;
      return { ...state, planOpen };
    }
    default:
      return state;
  }
}

// ── 派生 selector ───────────────────────────────────────────

export interface TasksListView {
  /** loading | empty（零任务，指路宿主）| filter-empty（清除过滤出口）| success。 */
  mode: "loading" | "empty" | "filter-empty" | "success";
  /** 过滤+排序后的视图行。 */
  rows: TaskSummaryDto[];
}

/** 列表视图态派生（互斥四态恰一）。 */
export function selectListView(state: TasksPageState): TasksListView {
  if (state.listLoading) return { mode: "loading", rows: [] };
  if (state.tasks.length === 0) return { mode: "empty", rows: [] };
  const rows = sortTasks(filterTasks(state.tasks, state.filterStatus, state.filterProject));
  if (rows.length === 0) return { mode: "filter-empty", rows: [] };
  return { mode: "success", rows };
}

/** 项目 seg 选项（tasks projects 并集保序去重；数据驱动，无硬编码清单）。 */
export function projectOptions(state: TasksPageState): string[] {
  const seen = new Set<string>();
  for (const t of state.tasks) for (const p of t.projects) seen.add(p);
  return [...seen];
}

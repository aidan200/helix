/**
 * P-2 任务页页面私有 reducer / 纯函数测试（T3.1 TDD RED→GREEN）。
 *
 * 测试点映射（testing/test-design.md §1.1 / §二 CL-3）：
 * ① 排序：运行中置顶 + 创建时间倒序（CL-3-T1）；
 * ② 过滤：状态/项目过滤；无匹配 → empty（带清除过滤）；过滤切换先清旧态（CL-3-T2）；
 * ③ 生命周期+删除门控矩阵：六态 → 按钮集，终态=删除；删除后列表移除+选中回落首项（CL-3-T7/T12、R-19）；
 * ④ 选任务重置：tab=进度、确认条收起、plan 展开收起（CL-3-T10）；
 * ⑤ wire→展示映射：pending→装配中 / done→已完成 等六映射（brief 决策消解①；映射仅展示层）。
 *
 * 数据面 = contracts/task-api.md DTO 逐字段（wire 状态枚举 pending/running/
 * paused/done/failed/cancelled；展示映射不出第二套 wire 词表）。
 */
import { describe, expect, it } from "vitest";
import type { TaskDetailDto, TaskSummaryDto } from "@helix/protocol";
import { t } from "@/shared/i18n";
import { zhCN } from "@/shared/i18n/lang/zh-CN";
import {
  createTasksPageState,
  elapsedSpan,
  filterTasks,
  lifecycleActions,
  selectListView,
  sortTasks,
  taskElapsedMs,
  taskStatusDisplay,
  tasksReducer,
  type TasksPageState,
} from "./tasks-model";

// ── fixture（契约形状；时间基固定保证确定性）──────────────────

const T0 = "2026-08-29T09:00:00.000+08:00";

function row(o: {
  jobId: string;
  status: TaskSummaryDto["status"];
  createdAt: string;
  projects?: string[];
  title?: string;
}): TaskSummaryDto {
  return {
    jobId: o.jobId,
    type: "kg-bootstrap",
    title: o.title ?? `${o.jobId} 任务`,
    status: o.status,
    projects: o.projects ?? [],
    createdBy: "page",
    createdAt: o.createdAt,
    updatedAt: o.createdAt,
    progress: null,
    error: null,
  };
}

/** 混态六行：故意乱序投给排序器（服务端排序的客户端镜像断言）。 */
function mixedTasks(): TaskSummaryDto[] {
  return [
    row({ jobId: "j-done-old", status: "done", createdAt: "2026-08-28T10:00:00.000+08:00" }),
    row({ jobId: "j-run-2", status: "running", createdAt: "2026-08-29T08:00:00.000+08:00" }),
    row({ jobId: "j-failed", status: "failed", createdAt: "2026-08-29T07:30:00.000+08:00" }),
    row({ jobId: "j-run-1", status: "running", createdAt: "2026-08-29T09:12:00.000+08:00" }),
    row({ jobId: "j-done-new", status: "done", createdAt: "2026-08-29T06:00:00.000+08:00" }),
    row({ jobId: "j-paused", status: "paused", createdAt: "2026-08-29T09:40:00.000+08:00" }),
  ];
}

function detailOf(t: TaskSummaryDto): TaskDetailDto {
  return {
    ...t,
    stages: [
      { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层完成", nodeCount: 3 } },
      { seq: 2, name: "L1 领域层", status: "running", artifact: null },
    ],
    batches: [],
    currentNarrative: "批次进行中",
    params: {},
  };
}

// ── ① 排序（CL-3-T1）─────────────────────────────────────────

describe("① 列表排序：运行中置顶 + 创建时间倒序", () => {
  it("running 全部置顶，其余按 createdAt 倒序（混态乱序输入）", () => {
    const sorted = sortTasks(mixedTasks());
    expect(sorted.map((t) => t.jobId)).toEqual([
      "j-run-1", // running（09:12 最新创建的运行中最前）
      "j-run-2", // running（08:00）
      "j-paused", // 09:40（非运行中最新）
      "j-failed", // 07:30
      "j-done-new", // 06:00
      "j-done-old", // 08-28
    ]);
  });

  it("多个 running 之间同样按创建时间倒序", () => {
    const sorted = sortTasks(mixedTasks());
    const running = sorted.filter((t) => t.status === "running");
    expect(running.map((t) => t.createdAt)).toEqual([...running.map((t) => t.createdAt)].sort().reverse());
  });

  it("空列表与单元素恒等（不炸不重排异常）", () => {
    expect(sortTasks([])).toEqual([]);
    const one = mixedTasks().slice(0, 1)!;
    expect(sortTasks(one)).toHaveLength(1);
  });
});

// ── ② 过滤（CL-3-T2）────────────────────────────────────────

describe("② 状态/项目过滤 + 无匹配空态 + 清除过滤", () => {
  it("状态过滤：仅保留目标态（wire 值入参；保持输入序，排序归视图派生）", () => {
    const tasks = mixedTasks();
    expect(filterTasks(tasks, "running", "all").map((t) => t.jobId)).toEqual(["j-run-2", "j-run-1"]);
    expect(filterTasks(tasks, "done", "all").map((t) => t.jobId)).toEqual(["j-done-old", "j-done-new"]);
  });

  it("项目过滤 + 状态叠加过滤", () => {
    const tasks = [
      row({ jobId: "j-a", status: "running", createdAt: T0, projects: ["helix", "web-access"] }),
      row({ jobId: "j-b", status: "running", createdAt: "2026-08-29T09:01:00.000+08:00", projects: ["pi-src"] }),
      row({ jobId: "j-c", status: "done", createdAt: "2026-08-29T09:02:00.000+08:00", projects: ["helix"] }),
    ];
    expect(filterTasks(tasks, "all", "helix").map((t) => t.jobId)).toEqual(["j-a", "j-c"]);
    expect(filterTasks(tasks, "running", "helix").map((t) => t.jobId)).toEqual(["j-a"]);
    expect(filterTasks(tasks, "all", "all").map((t) => t.jobId)).toEqual(["j-a", "j-b", "j-c"]);
  });

  it("过滤无匹配 → list 视图 filter-empty（清除过滤出口）；清过滤恢复全列表", () => {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    expect(selectListView(s).mode).toBe("success");

    // 过滤切换先清旧态再渲染：切到无匹配态 → filter-empty（非 success 残留）
    s = tasksReducer(s, { type: "filter-status", value: "cancelled" });
    const view = selectListView(s);
    expect(view.mode).toBe("filter-empty");
    expect(view.rows).toHaveLength(0);

    // 清除过滤 action → 恢复全列表 success
    s = tasksReducer(s, { type: "clear-filters" });
    expect(selectListView(s).mode).toBe("success");
    expect(selectListView(s).rows).toHaveLength(6);
  });

  it("空列表（零任务）→ empty（指路宿主），与 filter-empty 区分", () => {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    expect(selectListView(s).mode).toBe("loading");
    s = tasksReducer(s, { type: "list-result", tasks: [] });
    expect(selectListView(s).mode).toBe("empty");
  });

  it("视图行序 = 过滤后再排序（运行中置顶在过滤结果内成立）", () => {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    s = tasksReducer(s, { type: "filter-status", value: "all" });
    s = tasksReducer(s, { type: "filter-project", value: "pi-src" });
    expect(selectListView(s).rows).toHaveLength(0);
    s = tasksReducer(s, { type: "clear-filters" });
    expect(selectListView(s).rows.map((t) => t.jobId)[0]).toBe("j-run-1");
  });
});

// ── ③ 生命周期 + 删除门控矩阵（CL-3-T7/T12、F3.6）────────────

describe("③ 六态门控矩阵（纯函数）+ 删除联动", () => {
  it("pending=取消 / running=暂停+取消 / paused=继续+取消", () => {
    expect(lifecycleActions("pending")).toEqual(["cancel"]);
    expect(lifecycleActions("running")).toEqual(["pause", "cancel"]);
    expect(lifecycleActions("paused")).toEqual(["resume", "cancel"]);
  });

  it("三终态（done/failed/cancelled）= 删除（运行中须先取消，无删除钮）", () => {
    expect(lifecycleActions("done")).toEqual(["delete"]);
    expect(lifecycleActions("failed")).toEqual(["delete"]);
    expect(lifecycleActions("cancelled")).toEqual(["delete"]);
    for (const st of ["pending", "running", "paused"] as const) {
      expect(lifecycleActions(st)).not.toContain("delete");
    }
  });

  it("删除回执 → 列表移除该行 + 选中回落首项；删尽 → 空态", () => {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    // list-result 自动选中首行（运行中置顶 j-run-1）
    expect(s.selected).toBe("j-run-1");
    s = tasksReducer(s, { type: "select-task", jobId: "j-done-new" });
    s = tasksReducer(s, { type: "delete-result", jobId: "j-done-new" });
    expect(s.tasks.map((t) => t.jobId)).not.toContain("j-done-new");
    expect(s.selected).toBe("j-run-1"); // 回落列表首项
    expect(s.detail).toBeNull(); // 旧详情不残留

    // 删尽 → selected null + empty 视图
    for (const id of [...s.tasks.map((t) => t.jobId)]) {
      s = tasksReducer(s, { type: "delete-result", jobId: id });
    }
    expect(s.selected).toBeNull();
    expect(selectListView(s).mode).toBe("empty");
  });

  it("取消回执 → 行与详情状态同步翻 cancelled（徽章/叙述句联动数据面）", () => {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    s = tasksReducer(s, { type: "select-task", jobId: "j-run-1" });
    s = tasksReducer(s, { type: "detail-result", task: detailOf(s.tasks.find((t) => t.jobId === "j-run-1")!) });
    s = tasksReducer(s, { type: "lifecycle-result", kind: "cancel", jobId: "j-run-1", status: "cancelled" });
    expect(s.tasks.find((t) => t.jobId === "j-run-1")?.status).toBe("cancelled");
    expect(s.detail?.status).toBe("cancelled");
    expect(s.pendingLifecycle).toBeNull();
  });

  it("生命周期在途锁：started 置 pending，failed 清（错误 toast 由页面听众发）", () => {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    s = tasksReducer(s, { type: "lifecycle-started", kind: "pause" });
    expect(s.pendingLifecycle).toBe("pause");
    s = tasksReducer(s, { type: "lifecycle-failed" });
    expect(s.pendingLifecycle).toBeNull();
  });
});

// ── ④ 选任务重置（CL-3-T10）─────────────────────────────────

describe("④ 选新任务先重置：tab=进度、确认条收起、plan 展开收起", () => {
  function seeded(): TasksPageState {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    s = tasksReducer(s, { type: "select-task", jobId: "j-run-1" });
    s = tasksReducer(s, { type: "tab", value: "result" });
    s = tasksReducer(s, { type: "confirm-open", box: "cancel" });
    s = tasksReducer(s, { type: "plan-toggle", batchId: "b1" });
    return s;
  }

  it("重置三件套 + 旧详情/产物清空（切任务先清旧态）", () => {
    const s = seeded();
    expect(s.tab).toBe("result");
    expect(s.confirmBox).toBe("cancel");
    expect(s.planOpen).toEqual({ b1: true });
    const next = tasksReducer(s, { type: "select-task", jobId: "j-paused" });
    expect(next.tab).toBe("progress");
    expect(next.confirmBox).toBe("none");
    expect(next.planOpen).toEqual({});
    expect(next.detail).toBeNull();
    expect(next.detailLoading).toBe(true);
    expect(next.selected).toBe("j-paused");
  });

  it("迟到 detail 回执（jobId ≠ 选中）被丢弃，不污染新选中", () => {
    let s = seeded();
    s = tasksReducer(s, { type: "select-task", jobId: "j-paused" });
    s = tasksReducer(s, {
      type: "detail-result",
      task: detailOf(mixedTasks().find((t) => t.jobId === "j-run-1")!),
    });
    expect(s.detail).toBeNull();
  });

  it("list-result 自动选中首行（运行中置顶位）且仅一次（已有选中不夺位）", () => {
    let s = tasksReducer(createTasksPageState(), { type: "list-loading" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    expect(s.selected).toBe("j-run-1");
    s = tasksReducer(s, { type: "select-task", jobId: "j-failed" });
    s = tasksReducer(s, { type: "list-result", tasks: mixedTasks() });
    expect(s.selected).toBe("j-failed");
  });
});

// ── ⑤ wire→展示映射（决策消解①；仅展示层，wire 不出第二套）────

describe("⑤ wire 状态 → 展示映射（六态徽章）", () => {
  it("pending→装配中 / running→运行中 / paused→已暂停 / done→已完成 / failed→失败 / cancelled→已取消", () => {
    const label = (s: TaskSummaryDto["status"]): string => t(zhCN, taskStatusDisplay(s).labelKey);
    expect(label("pending")).toBe("装配中");
    expect(label("running")).toBe("运行中");
    expect(label("paused")).toBe("已暂停");
    expect(label("done")).toBe("已完成");
    expect(label("failed")).toBe("失败");
    expect(label("cancelled")).toBe("已取消");
    // 键位与 zhCN 词条同源（AG-16：文案全部走 i18n，模型零硬编码 CJK）
    expect(taskStatusDisplay("pending").labelKey).toBe("tk.status.pending");
  });

  it("六态徽章语义色类：running=accent / paused=warning / done=success / failed=error / pending·cancelled=dim；六映射互异", () => {
    expect(taskStatusDisplay("running").badge).toBe("st-running");
    expect(taskStatusDisplay("paused").badge).toBe("st-paused");
    expect(taskStatusDisplay("done").badge).toBe("st-done");
    expect(taskStatusDisplay("failed").badge).toBe("st-failed");
    expect(taskStatusDisplay("pending").badge).toBe("st-pending");
    expect(taskStatusDisplay("cancelled").badge).toBe("st-cancelled");
    const labels = (["pending", "running", "paused", "done", "failed", "cancelled"] as const).map(
      (s) => t(zhCN, taskStatusDisplay(s).labelKey),
    );
    expect(new Set(labels).size).toBe(6);
  });

  it("运行时长：running/paused 由 createdAt+now 计算；终态定格 updatedAt-createdAt", () => {
    const now = Date.parse("2026-08-29T10:00:00.000+08:00");
    const running = row({ jobId: "j", status: "running", createdAt: "2026-08-29T09:00:00.000+08:00" });
    expect(taskElapsedMs(running, now)).toBe(60 * 60 * 1000);
    const done: TaskSummaryDto = {
      ...running,
      status: "done",
      updatedAt: "2026-08-29T09:30:00.000+08:00",
    };
    expect(taskElapsedMs(done, now)).toBe(30 * 60 * 1000);
  });

  it("时长分档结构（i18n 前结构化）：秒/分/时分", () => {
    expect(elapsedSpan(45_000)).toEqual({ key: "sec", n: 45 });
    expect(elapsedSpan(47 * 60_000)).toEqual({ key: "min", n: 47 });
    expect(elapsedSpan(((1 * 60 + 52) * 60) * 1000)).toEqual({ key: "hourMin", h: 1, m: 52 });
  });
});

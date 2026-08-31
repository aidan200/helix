// @vitest-environment jsdom
/**
 * P-2 TasksPage 组件测试（T3.1 GREEN 面之一）：六态列表渲染/过滤空态/
 * 生命周期+删除门控与两步确认/task.changed 驱动/零创建与裸 id 断言。
 *
 * vi.mock SessionContext 先例（ProjectPage.test.tsx）：九命令发送面捕获 +
 * subscribeTaskFrames 帧注入回放（页面私有链）。中文断言语言钉 zh-CN。
 * 数据面 = 契约 DTO 逐字段（contracts/task-api.md；wire 状态枚举原值）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  EventEnvelope,
  TaskArtifactsResultPayload,
  TaskDetailDto,
  TaskDetailResultPayload,
  TaskListResultPayload,
  TaskStatus,
  TaskSummaryDto,
} from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";

// ── SessionContext mock（页面域消费面）─────────────────────

interface Sent {
  list: number;
  subscribe: number;
  detail: { jobId: string }[];
  artifacts: { jobId: string }[];
  pause: string[];
  resume: string[];
  cancel: string[];
  delete: string[];
}

const sent: Sent = { list: 0, subscribe: 0, detail: [], artifacts: [], pause: [], resume: [], cancel: [], delete: [] };
let listeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { conn: "connected", sessionId: null },
      sendTaskList: () => {
        sent.list += 1;
        return true;
      },
      sendTaskSubscribe: () => {
        sent.subscribe += 1;
        return true;
      },
      sendTaskDetail: (payload: { jobId: string }) => {
        sent.detail.push(payload);
        return true;
      },
      sendTaskArtifacts: (payload: { jobId: string }) => {
        sent.artifacts.push(payload);
        return true;
      },
      sendTaskPause: (jobId: string) => {
        sent.pause.push(jobId);
        return true;
      },
      sendTaskResume: (jobId: string) => {
        sent.resume.push(jobId);
        return true;
      },
      sendTaskCancel: (jobId: string) => {
        sent.cancel.push(jobId);
        return true;
      },
      sendTaskDelete: (jobId: string) => {
        sent.delete.push(jobId);
        return true;
      },
      subscribeTaskFrames: (cb: (e: EventEnvelope) => void) => {
        listeners.push(cb);
        return () => {
          listeners = listeners.filter((l) => l !== cb);
        };
      },
      subscribeWorkspaceFrames: () => () => {},
    }),
  };
});

import TasksPage from "./ui/TasksPage";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <TasksPage path="/tasks" onOpenProject={() => {}} />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

/** querySelector 的 HTMLElement 收窄。 */
function qs(selector: string): HTMLElement {
  return document.querySelector(selector) as HTMLElement;
}

function feed(type: string, payload: unknown) {
  const frame = { v: "0.11", type, sessionId: "__system__", channel: "notification", payload } as EventEnvelope;
  act(() => {
    for (const l of [...listeners]) l(frame);
  });
}

/** 六态 fixture（服务端序：运行中置顶 + 创建时间倒序镜像）。 */
const NOW = Date.parse("2026-08-29T11:22:00.000+08:00");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

function row(jobId: string, status: TaskStatus, createdAt: string, projects: string[] = []): TaskSummaryDto {
  // 标题 = 服务端组装的人类可读文案（AD-4：不含裸 id）
  const title = `${projects[0] ?? "工作区"} 知识图谱创建`;
  return {
    jobId,
    type: "kg-bootstrap",
    title,
    status,
    projects,
    createdBy: "page",
    createdAt,
    updatedAt: createdAt,
    progress:
      status === "running"
        ? { stageName: "L1 领域层", batchesDone: 3, batchesTotal: 5, percent: 45 }
        : status === "done"
          ? { stageName: null, batchesDone: 9, batchesTotal: 9, percent: 100 }
          : null,
    error: null,
  };
}

const SIX: TaskSummaryDto[] = [
  row("job-run", "running", iso(-130), ["helix"]),
  row("job-paused", "paused", iso(-200), ["web-access"]),
  row("job-pending", "pending", iso(-3), ["pi-src"]),
  row("job-done", "done", iso(-1060), ["helix"]),
  row("job-failed", "failed", iso(-1470), ["sandpile"]),
  row("job-cancelled", "cancelled", iso(-2760), ["helix", "web-access"]),
];

function feedList(tasks: TaskSummaryDto[] = SIX) {
  feed("task.list.result", { tasks } satisfies TaskListResultPayload);
}

function detailOf(s: TaskSummaryDto, extra?: Partial<TaskDetailDto>): TaskDetailDto {
  return {
    ...s,
    stages: [
      { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层完成" } },
      { seq: 2, name: "L1 领域层", status: "running", artifact: null },
      { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
    ],
    batches: [],
    params: {},
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sent.list = 0;
  sent.subscribe = 0;
  sent.detail = [];
  sent.artifacts = [];
  sent.pause = [];
  sent.resume = [];
  sent.cancel = [];
  sent.delete = [];
});

// ── 用例 ───────────────────────────────────────────────────

describe("P-2 TasksPage：列表渲染 + 过滤 + 零创建", () => {
  it("六态行按服务端序渲染：running 置顶带脉冲点；pending→装配中 / done→已完成（wire→展示映射）", () => {
    ui();
    feedList();
    const rows = document.querySelectorAll(".tk-row");
    expect(rows.length).toBe(6);
    expect((rows[0] as HTMLElement).dataset.id).toBe("job-run");
    expect((rows[0] as HTMLElement).dataset.task).toBe("running");
    expect(qs('.tk-row[data-id="job-run"] .tk-dot-run')).toBeTruthy(); // running 脉冲点
    expect(qs('.tk-row[data-id="job-pending"] [data-task-status="pending"]').textContent).toBe("装配中");
    expect(qs('.tk-row[data-id="job-done"] [data-task-status="done"]').textContent).toBe("已完成");
    expect(qs('.tk-row[data-id="job-cancelled"] [data-task-status="cancelled"]').textContent).toBe("已取消");
    // 进度行：running = 阶段名 · 批次 x/y；done = 全部完成
    expect(qs('.tk-row[data-id="job-run"] .tk-row-prog-t').textContent).toBe("L1 领域层 · 批次 3/5");
    expect(qs('.tk-row[data-id="job-done"] .tk-row-prog-t').textContent).toBe("全部完成");
    // count line
    expect(qs("[data-tk-count]").textContent).toContain("共 6 个任务");
  });

  it("连接就绪自动订阅 + 拉清单；选中首行自动拉详情（叙述句块已拆除；非终态无前往项目页链接）", () => {
    ui();
    expect(sent.subscribe).toBe(1);
    expect(sent.list).toBe(1);
    feedList();
    expect(sent.detail.map((d) => d.jobId)).toEqual(["job-run"]);
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    expect(qs("[data-tk-detail]").dataset.id).toBe("job-run");
    // narrative-remove：叙述句块零残留
    expect(document.querySelector("[data-tk-narrative]")).toBeNull();
    // 前往项目页链接仅终态显示（running 非终态 → 不渲染）
    expect(document.querySelector("[data-tk-go-project]")).toBeNull();
  });

  it("状态过滤 + 项目过滤 + 无匹配空态（清除过滤恢复全列表）", () => {
    ui();
    feedList();
    // 项目 seg 数据驱动（projects 并集）：helix / web-access / pi-src / sandpile
    const projSeg = qs("[data-tk-filter-project]");
    expect(within(projSeg).getAllByRole("button").length).toBe(5); // 全部项目 + 4
    // 状态过滤：已取消
    fireEvent.click(within(qs("[data-tk-filter-status]")).getAllByRole("button")[6]!); // 全部/运行中/已暂停/装配中/已完成/失败/已取消
    expect(document.querySelectorAll(".tk-row").length).toBe(1);
    expect(qs(".tk-row").dataset.id).toBe("job-cancelled");
    // 叠加项目过滤 → 无匹配 → filter-empty + 清除过滤出口
    fireEvent.click(within(projSeg).getAllByRole("button").find((b) => b.dataset.v === "sandpile")!);
    expect(qs('[data-tk-empty="filter"]').textContent).toContain("没有匹配的任务");
    fireEvent.click(qs("[data-tk-clear-filters]"));
    expect(document.querySelectorAll(".tk-row").length).toBe(6);
  });

  it("空列表 → empty 指路宿主（CL-1.A7 零创建）；全页面无创建入口", () => {
    ui();
    feedList([]);
    expect(qs('[data-tk-empty="list"]').textContent).toContain("暂无任务");
    expect(qs("[data-tk-goto-project]").textContent).toContain("前往「项目」页");
    // demo-seg-remove：演示 seg 全链零残留
    expect(document.querySelector("[data-tk-demo]")).toBeNull();
    // 主区空态
    expect(qs('[data-tk-empty="detail-empty"]').textContent).toContain("没有可展示的任务");
    // 零创建（AD-2）：无任何创建语义按钮
    const createLike = [...document.querySelectorAll("button")].filter((b) =>
      /新建|创建任务|发起任务/.test(b.textContent ?? ""),
    );
    expect(createLike).toHaveLength(0);
  });

  it("裸 id 零界面（AD-4）：可见文本无 jobId；id 仅 data-id 属性", () => {
    ui();
    feedList();
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    const text = document.querySelector(".app-layout")!.textContent ?? "";
    for (const id of ["job-run", "job-paused", "job-pending", "job-done", "job-failed", "job-cancelled"]) {
      expect(text).not.toContain(id);
    }
    expect(qs(".tk-row").dataset.id).toBe("job-run"); // join 键在属性面
  });
});

describe("P-2 TasksPage：生命周期 + 删除门控（F3.5/F3.6）", () => {
  it("running 详情：暂停+取消无删除；取消两步确认（批次收口+产出保留+不可撤销）→ 命令 + 徽章联动", () => {
    ui();
    feedList();
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    const actions = qs("[data-tk-actions]");
    expect(within(actions).getAllByRole("button").length).toBe(2);
    expect(actions.querySelector("[data-act='pause']")).toBeTruthy();
    expect(actions.querySelector("[data-act='cancel']")).toBeTruthy();
    expect(actions.querySelector("[data-act='delete']")).toBeNull(); // 运行中无删除钮
    // 两步确认：先开框
    fireEvent.click(actions.querySelector("[data-act='cancel']")!);
    const box = qs('[data-tk-confirm="cancel"]');
    expect(box.textContent).toContain("进行中的批次会收口");
    expect(box.textContent).toContain("产出保留");
    expect(box.textContent).toContain("不可撤销");
    // 返回不删（框收起、零命令）
    fireEvent.click(box.querySelector("[data-tk-confirm-back]")!);
    expect(document.querySelector('[data-tk-confirm="cancel"]')).toBeNull();
    expect(sent.cancel).toHaveLength(0);
    // 再开 → 确认取消 → 命令发出 + 回执 → 徽章/行翻已取消 + toast
    fireEvent.click(actions.querySelector("[data-act='cancel']")!);
    fireEvent.click(qs("[data-tk-confirm-yes='cancel']"));
    expect(sent.cancel).toEqual(["job-run"]);
    feed("task.cancel.result", { ok: true, status: "cancelled" });
    expect(qs("[data-tk-detail] [data-task-status='cancelled']").textContent).toBe("已取消");
    // 行同步翻已取消（取消后不再是运行中置顶位——按序回到创建时间位）
    expect(qs('.tk-row[data-id="job-run"]').dataset.task).toBe("cancelled");
    expect(screen.getAllByText(/任务已取消/).length).toBeGreaterThan(0); // toast
  });

  it("终态详情：仅删除钮；删除两步确认（kg 产出不动）→ 行移除 + 选中回落 + toast", () => {
    ui();
    feedList();
    fireEvent.click(qs('.tk-row[data-id="job-done"]'));
    feed("task.detail.result", {
      task: detailOf(SIX[3]!, { status: "done" }),
    } satisfies TaskDetailResultPayload);
    const actions = qs("[data-tk-actions]");
    expect(actions.querySelector("[data-act='delete']")).toBeTruthy();
    expect(actions.querySelector("[data-act='pause']")).toBeNull();
    expect(actions.querySelector("[data-act='cancel']")).toBeNull();
    // 终态行动出口（R-8）：header 首行右端（accent 链接样式）
    const goLink = qs(".tk-head-top [data-tk-go-project]");
    expect(goLink.textContent).toContain("前往「项目」页");
    expect(goLink.className).toContain("tk-head-link");
    // 两步确认文案：清任务域记录 + kg 产出不动 + 不可撤销
    fireEvent.click(actions.querySelector("[data-act='delete']")!);
    const box = qs('[data-tk-confirm="delete"]');
    expect(box.textContent).toContain("任务域记录");
    expect(box.textContent).toContain("kg 产出");
    expect(box.textContent).toContain("不可撤销");
    fireEvent.click(box.querySelector("[data-tk-confirm-back]")!);
    expect(sent.delete).toHaveLength(0);
    fireEvent.click(actions.querySelector("[data-act='delete']")!);
    fireEvent.click(qs("[data-tk-confirm-yes='delete']"));
    expect(sent.delete).toEqual(["job-done"]);
    feed("task.delete.result", { ok: true });
    expect(document.querySelectorAll(".tk-row").length).toBe(5);
    expect(qs(".tk-row").dataset.id).toBe("job-run"); // 选中回落首项
    // 详情退出：旧详情不残留（新首项重拉中 → 骨架态互斥）
    expect(document.querySelector("[data-tk-detail]")).toBeNull();
    expect(qs("[data-tk-detail-loading]")).toBeTruthy();
    expect(screen.getAllByText(/kg 产出保留/).length).toBeGreaterThan(0); // toast 交代
  });

  it("paused 详情：继续+取消；继续命令回执 → 运行中", () => {
    ui();
    feedList();
    fireEvent.click(qs('.tk-row[data-id="job-paused"]'));
    feed("task.detail.result", { task: detailOf(SIX[1]!) } satisfies TaskDetailResultPayload);
    fireEvent.click(qs("[data-act='resume']"));
    expect(sent.resume).toEqual(["job-paused"]);
    feed("task.resume.result", { ok: true, status: "running" });
    expect(qs("[data-tk-detail] [data-task-status='running']").textContent).toBe("运行中");
  });
});

describe("P-2 TasksPage：artifacts 迟到帧竞态（T4.3 在途 ref 关联）", () => {
  /** 带专属标记的产物回执 fixture（tag 可辨识归属）。 */
  const art = (tag: string): TaskArtifactsResultPayload => ({
    artifacts: {
      stages: [
        {
          seq: 1,
          name: "L0 核心层",
          status: "done",
          artifact: { summary: `${tag} 摘要` },
        },
      ],
    },
  });

  it("A 在途切到 B：A 的迟到回执不以 B 的 jobId 落库（watcher 重拉 B）；B 的在途请求正常落库", () => {
    ui();
    feedList();
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    // A（job-run）结果 tab：请求发出在途
    fireEvent.click(qs('[data-tk-tab="result"]'));
    expect(sent.artifacts.map((a) => a.jobId)).toEqual(["job-run"]);
    // 产物在途时切到 B（job-paused；选任务重置 tab=progress）
    fireEvent.click(qs('.tk-row[data-id="job-paused"]'));
    feed("task.detail.result", { task: detailOf(SIX[1]!) } satisfies TaskDetailResultPayload);
    // A 的迟到回执到达
    feed("task.artifacts.result", art("A 的产物"));
    // 切到 B 的结果 tab：A 的回执不得以 B 落库 → artifactsJob≠selected → watcher 重拉 B
    fireEvent.click(qs('[data-tk-tab="result"]'));
    expect(sent.artifacts.map((a) => a.jobId)).toEqual(["job-run", "job-paused"]);
    expect(screen.queryByText("A 的产物 摘要")).toBeNull(); // A 的产物不在 B 视图
    // B 的在途请求回执正常落库
    feed("task.artifacts.result", art("B 的产物"));
    expect(qs("[data-tk-art] .tk-art-sum").textContent).toBe("B 的产物 摘要");
    expect(screen.queryByText("A 的产物 摘要")).toBeNull();
  });
});

describe("P-2 TasksPage：阶段条 + 批次 plan + 任务结果", () => {
  it("阶段条 stage 行驱动 + 批次节按 stageSeq 分组（运行中阶段高亮）；批次 retry>0 warning + 台账展开（abandoned 带理由）", () => {
    ui();
    feedList();
    feed("task.detail.result", {
      task: detailOf(SIX[0]!, {
        batches: [
          {
            batchId: "batch-1a",
            stageSeq: 1,
            seq: 1,
            scope: "daemon 任务引擎域",
            status: "done",
            retryCount: 0,
            retryNote: null,
            instanceId: "inst-a01",
            ledger: { total: 2, done: 2, inProgress: 0 },
            plan: [
              { seq: 1, content: "探查任务引擎三表", status: "done", note: null },
              { seq: 2, content: "自检", status: "done", note: null },
            ],
          },
          {
            batchId: "batch-1b",
            stageSeq: 2,
            seq: 2,
            scope: "shell 任务页面域",
            status: "done",
            retryCount: 1,
            retryNote: "首次执行 closure 中 plan 未全部 resolve，自动重试 1 次后通过。",
            instanceId: "inst-a02",
            ledger: { total: 2, done: 2, inProgress: 0 },
            plan: [
              { seq: 1, content: "探查 shell 页面域与路由", status: "done", note: null },
              { seq: 2, content: "产出任务页结构节点", status: "done", note: null },
            ],
          },
          {
            batchId: "batch-1c",
            stageSeq: 2,
            seq: 3,
            scope: "protocol 命令族扩展",
            status: "running",
            retryCount: 0,
            retryNote: null,
            instanceId: "inst-a03",
            ledger: { total: 4, done: 1, inProgress: 1 },
            plan: [
              { seq: 1, content: "划定 task.* 命令面", status: "done", note: null },
              { seq: 2, content: "写契约节点", status: "in_progress", note: null },
              { seq: 3, content: "写推送事件契约节点", status: "pending", note: null },
              { seq: 4, content: "产出实体节点", status: "abandoned", note: "放弃：上下文不足，执行实例终止" },
            ],
          },
          { batchId: "batch-1d", stageSeq: 2, seq: 4, scope: "daemon 编排器域", status: "pending", retryCount: 0, retryNote: null, instanceId: null, ledger: null, plan: null },
        ],
      }),
    } satisfies TaskDetailResultPayload);
    // 阶段条三行（✓ / ● / 序号）+ 子行文案（done 纯「已完成」——无产出计数）
    const stages = document.querySelectorAll("[data-tk-stage]");
    expect(stages.length).toBe(3);
    expect((stages[0] as HTMLElement).dataset.tkStage).toBe("done");
    expect(stages[0]!.querySelector(".tk-stage-sub")!.textContent).toBe("已完成");
    expect(qs("[data-tk-stagebar]").textContent).toContain("批次 3/5");
    // 批次节按 stageSeq 分组：每阶段一个小节头（名 + 徽章 + 子行），批次卡归位其下
    const groups = document.querySelectorAll("[data-tk-stage-group]");
    expect(groups.length).toBe(3);
    const g1 = qs('[data-tk-stage-group][data-stage-seq="1"]');
    const g2 = qs('[data-tk-stage-group][data-stage-seq="2"]');
    const g3 = qs('[data-tk-stage-group][data-stage-seq="3"]');
    expect(g1.querySelectorAll("[data-tk-batch]").length).toBe(1);
    expect(g2.querySelectorAll("[data-tk-batch]").length).toBe(3);
    expect(g3.querySelectorAll("[data-tk-batch]").length).toBe(0);
    expect(g1.querySelector("[data-tk-stage-group-h] .tk-stagegrp-name")!.textContent).toBe("L0 核心层");
    expect(g1.querySelector('[data-tk-stage-group-h] [data-phase="stage"]')).toBeTruthy();
    expect(g1.querySelector("[data-tk-stage-group-h] .tk-stagegrp-sub")!.textContent).toBe("已完成");
    // 运行中阶段小节高亮
    expect(g2.className).toContain("running");
    expect(g2.dataset.stageStatus).toBe("running");
    expect(g1.className).not.toContain("running");
    // 批次卡归位：stageSeq=2 的批次在阶段 2 小节下
    expect(g2.querySelector('[data-tk-batch][data-id="batch-1c"]')).toBeTruthy();
    expect(g1.querySelector('[data-tk-batch][data-id="batch-1a"]')).toBeTruthy();
    // 批次：retry>0 warning + note
    expect(qs("[data-tk-retry]").textContent).toBe("自动重试 1 次");
    expect(qs("[data-tk-retry-note]").textContent).toContain("自动重试 1 次后通过");
    // 待启动批次队列文案
    expect(qs('[data-tk-batch-queued]').textContent).toContain("队列中等待派发");
    const runningBatch = qs('[data-tk-batch][data-id="batch-1c"]');
    // plan 进度行（running 批次内）+ 正在
    expect(runningBatch.querySelector(".tk-b-plan-t")!.textContent).toBe("1/4 项完成");
    expect(qs("[data-tk-doing]").textContent).toContain("正在：");
    // 台账展开 → 四态 + abandoned 理由
    expect(runningBatch.querySelector("[data-tk-plan-items]")).toBeNull(); // 默认收起
    fireEvent.click(runningBatch.querySelector("[data-tk-plan-toggle]")!);
    expect(runningBatch.querySelectorAll("[data-tk-work]").length).toBe(4);
    expect(runningBatch.querySelector("[data-tk-work='abandoned']")!.textContent).toContain("放弃：上下文不足");
  });

  it("P1-⑥ 批次行实例徽标 + ledger 服务端计数摘要 + 无台账如实显示", () => {
    ui();
    feedList();
    feed("task.detail.result", {
      task: detailOf(SIX[0]!, {
        batches: [
          {
            batchId: "batch-2a",
            stageSeq: 1,
            seq: 1,
            scope: "daemon 任务引擎域",
            status: "running",
            retryCount: 0,
            retryNote: null,
            instanceId: "agent-3f9c2ab4d05e67890abcdef12345678",
            ledger: { total: 5, done: 3, inProgress: 1 },
            plan: [
              { seq: 1, content: "探查任务引擎三表", status: "done", note: null },
              { seq: 2, content: "探查编排器读面", status: "done", note: null },
              { seq: 3, content: "写台账摘要测试", status: "done", note: null },
              { seq: 4, content: "写实例徽标测试", status: "in_progress", note: null },
              { seq: 5, content: "自检收尾", status: "pending", note: null },
            ],
          },
          {
            batchId: "batch-2b",
            stageSeq: 2,
            seq: 2,
            scope: "shell 任务页面域",
            status: "done",
            retryCount: 0,
            retryNote: null,
            instanceId: "agent-9d81c44e2a7b05f3c6d8e1a2b3c4d5f",
            ledger: null,
            plan: null,
          },
          {
            batchId: "batch-2c",
            stageSeq: 3,
            seq: 3,
            scope: "protocol 协议面",
            status: "pending",
            retryCount: 0,
            retryNote: null,
            instanceId: null,
            ledger: null,
            plan: null,
          },
        ],
      }),
    } satisfies TaskDetailResultPayload);
    // 实例徽标：agent- 短形态（前 13 字符）+ title 持全 id（哪个 agent 在做哪个批次一眼可见）
    const badge = qs('[data-tk-batch][data-id="batch-2a"] [data-tk-instance]');
    expect(badge.textContent).toBe("agent-3f9c2ab");
    expect(badge.getAttribute("title")).toBe("agent-3f9c2ab4d05e67890abcdef12345678");
    // 未派发批次（pending，instanceId=null）无徽标
    expect(document.querySelector('[data-tk-batch][data-id="batch-2c"] [data-tk-instance]')).toBeNull();
    // 进度摘要：ledger 服务端计数直渲（3/5，前端零拼装）+ 正在 = 首个 in_progress content
    expect(qs('[data-tk-batch][data-id="batch-2a"] .tk-b-plan-t').textContent).toBe("3/5 项完成");
    expect(qs("[data-tk-doing]").textContent).toContain("写实例徽标测试");
    // 可展开看台账全清单（5 行四态）
    expect(qs('[data-tk-batch][data-id="batch-2a"]').querySelector("[data-tk-plan-items]")).toBeNull(); // 默认收起
    fireEvent.click(qs('[data-tk-batch][data-id="batch-2a"] [data-tk-plan-toggle]'));
    expect(qs('[data-tk-batch][data-id="batch-2a"]').querySelectorAll("[data-tk-work]").length).toBe(5);
    // 无台账批次：徽标仍在（实例可辨识）+ 如实显「无台账」，不虚构 0/0 进度行
    expect(qs('[data-tk-batch][data-id="batch-2b"] [data-tk-instance]').textContent).toBe("agent-9d81c44");
    expect(qs('[data-tk-batch][data-id="batch-2b"] [data-tk-plan-none]').textContent).toBe("该实例未建工作台账。");
    expect(document.querySelector('[data-tk-batch][data-id="batch-2b"] .tk-b-plan-t')).toBeNull();
    expect(document.querySelector('[data-tk-batch][data-id="batch-2b"] [data-tk-plan-toggle]')).toBeNull();
    // 待启动批次：队列文案（非「无台账」）
    expect(qs("[data-tk-batch-queued]").textContent).toContain("队列中等待派发");
  });

  it("结果 tab：阶段卡 = 阶段名 + 状态徽章 + summary 纯文字报告（零计数 chip/节点清单/链接/尾注）；tab 名「任务结果」", () => {
    ui();
    feedList();
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    // tab-rename：zh「任务结果」
    expect(qs('[data-tk-tab="result"]').textContent).toBe("任务结果");
    fireEvent.click(qs('[data-tk-tab="result"]'));
    expect(sent.artifacts.map((a) => a.jobId)).toEqual(["job-run"]);
    feed("task.artifacts.result", {
      artifacts: {
        stages: [
          {
            seq: 1,
            name: "L0 核心层",
            status: "done",
            artifact: { summary: "核心层完成：建立架构基线与全局写作规范。" },
          },
          { seq: 2, name: "L1 领域层", status: "running", artifact: null },
        ],
      },
    } satisfies TaskArtifactsResultPayload);
    const card = qs('[data-tk-art][data-stage-seq="1"]');
    expect(card.querySelector(".tk-art-name")!.textContent).toBe("L0 核心层");
    expect(card.querySelector('[data-phase="stage"][data-phase-status="done"]')).toBeTruthy();
    expect(card.querySelector(".tk-art-sum")!.textContent).toBe("核心层完成：建立架构基线与全局写作规范。");
    // result-tab-text-only：计数 chip / 节点清单 / 指路链接 / 尾注 零残留
    expect(document.querySelector("[data-tk-art-count]")).toBeNull();
    expect(document.querySelector("[data-tk-nodes]")).toBeNull();
    expect(document.querySelector("[data-tk-node]")).toBeNull();
    expect(document.querySelector("[data-tk-node-link]")).toBeNull();
    expect(document.querySelector("[data-tk-art-footnote]")).toBeNull();
    expect(document.querySelector("[data-node-kind]")).toBeNull();
  });

  it("无产物 → 结果 tab 空态", () => {
    ui();
    feedList();
    feed("task.detail.result", { task: detailOf(SIX[1]!) } satisfies TaskDetailResultPayload);
    fireEvent.click(qs('[data-tk-tab="result"]'));
    feed("task.artifacts.result", {
      artifacts: { stages: [{ seq: 1, name: "L0 核心层", status: "running", artifact: null }] },
    } satisfies TaskArtifactsResultPayload);
    expect(qs('[data-tk-empty="artifacts"]').textContent).toContain("尚无阶段产物");
  });

  it("task.changed 驱动：batch 变更仅选中时重拉 detail；job 变更重拉 list+detail", () => {
    ui();
    feedList();
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    const detailCalls = sent.detail.length;
    // 非选中 job 的 batch 变更：不重拉
    feed("task.changed", { jobId: "job-done", changed: "batch" });
    expect(sent.detail.length).toBe(detailCalls);
    // 选中 job 的 batch 变更：重拉 detail（不重拉 list）
    const listCalls = sent.list;
    feed("task.changed", { jobId: "job-run", changed: "batch" });
    expect(sent.detail.length).toBe(detailCalls + 1);
    expect(sent.list).toBe(listCalls);
    // job 级变更：重拉 list + 选中 detail
    feed("task.changed", { jobId: "job-run", changed: "job", status: "running" });
    expect(sent.list).toBe(listCalls + 1);
    expect(sent.detail.length).toBe(detailCalls + 2);
  });
});

// ── ⑤ 链 A：批次行实例徽标 parked 形态 ──────────────────────

describe("P-2 TasksPage：批次实例徽标 parked 形态（⑤ 链 A）", () => {
  it("instanceState=parked → 「agent-3 · 挂起(任务暂停)」+ data-parked=on + warning 类；非 parked 徽标不带尾缀", () => {
    ui();
    feedList();
    feed("task.detail.result", {
      task: detailOf(SIX[0]!, {
        batches: [
          {
            batchId: "batch-p1",
            stageSeq: 2,
            seq: 1,
            scope: "daemon 编排器域",
            status: "running",
            retryCount: 0,
            retryNote: null,
            instanceId: "agent-3",
            instanceState: "parked",
            ledger: null,
            plan: null,
          },
          {
            batchId: "batch-p2",
            stageSeq: 2,
            seq: 2,
            scope: "shell 任务页面域",
            status: "running",
            retryCount: 0,
            retryNote: null,
            instanceId: "agent-4",
            ledger: null,
            plan: null,
          },
        ],
      }),
    } satisfies TaskDetailResultPayload);
    const parkedBadge = qs('[data-tk-batch][data-id="batch-p1"] [data-tk-instance]');
    // parked 形态：实例短 id + 挂起尾缀（批次行状态保持 running——徽标即实例级态）
    expect(parkedBadge.textContent).toBe("agent-3 · 挂起(任务暂停)");
    expect(parkedBadge.dataset.parked).toBe("on");
    expect(parkedBadge.className).toContain("parked");
    // 非 parked 徽标不变：纯实例短形态
    const plainBadge = qs('[data-tk-batch][data-id="batch-p2"] [data-tk-instance]');
    expect(plainBadge.textContent).toBe("agent-4");
    expect(plainBadge.dataset.parked).toBeUndefined();
    expect(plainBadge.className).not.toContain("parked");
  });

  it("agent.parked 驱动的 task.changed(changed=batch) 重拉后徽标随 instanceState 更新（挂起→恢复切换）", () => {
    ui();
    feedList();
    feed("task.detail.result", {
      task: detailOf(SIX[0]!, {
        batches: [
          {
            batchId: "batch-p1",
            stageSeq: 2,
            seq: 1,
            scope: "daemon 编排器域",
            status: "running",
            retryCount: 0,
            retryNote: null,
            instanceId: "agent-3",
            instanceState: "parked",
            ledger: null,
            plan: null,
          },
        ],
      }),
    } satisfies TaskDetailResultPayload);
    expect(qs("[data-tk-instance]").textContent).toContain("挂起(任务暂停)");
    // 恢复：桥接的 task.changed 触发重拉 → instanceState 回 running → 尾缀消失
    feed("task.changed", { jobId: "job-run", changed: "batch" });
    feed("task.detail.result", {
      task: detailOf(SIX[0]!, {
        batches: [
          {
            batchId: "batch-p1",
            stageSeq: 2,
            seq: 1,
            scope: "daemon 编排器域",
            status: "running",
            retryCount: 0,
            retryNote: null,
            instanceId: "agent-3",
            instanceState: "running",
            ledger: null,
            plan: null,
          },
        ],
      }),
    } satisfies TaskDetailResultPayload);
    expect(qs("[data-tk-instance]").textContent).toBe("agent-3");
    expect(qs("[data-tk-instance]").dataset.parked).toBeUndefined();
  });
});

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
      { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层完成", nodeCount: 3 } },
      { seq: 2, name: "L1 领域层", status: "running", artifact: null },
      { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
    ],
    batches: [],
    currentNarrative: "批次进行中：12 项计划完成 7 项。",
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

  it("连接就绪自动订阅 + 拉清单；选中首行自动拉详情（叙述句贯穿）", () => {
    ui();
    expect(sent.subscribe).toBe(1);
    expect(sent.list).toBe(1);
    feedList();
    expect(sent.detail.map((d) => d.jobId)).toEqual(["job-run"]);
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    expect(qs("[data-tk-detail]").dataset.id).toBe("job-run");
    expect(qs("[data-tk-narrative]").textContent).toContain("当前：");
    expect(qs("[data-tk-narrative]").textContent).toContain("批次进行中：12 项计划完成 7 项。");
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
      task: detailOf(SIX[3]!, {
        status: "done",
        currentNarrative: "任务完成：3 个阶段共产出 23 个节点。",
      }),
    } satisfies TaskDetailResultPayload);
    const actions = qs("[data-tk-actions]");
    expect(actions.querySelector("[data-act='delete']")).toBeTruthy();
    expect(actions.querySelector("[data-act='pause']")).toBeNull();
    expect(actions.querySelector("[data-act='cancel']")).toBeNull();
    // 终态行动出口（R-8）
    expect(qs("[data-tk-go-project]").textContent).toContain("前往「项目」页");
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

describe("P-2 TasksPage：阶段条 + 批次 plan + 结果查询", () => {
  it("阶段条 stage 行驱动：done ✓ 产出 n 节点 / running ● 批次 x/y / 待启动；批次 retry>0 warning + 台账展开（abandoned 带理由）", () => {
    ui();
    feedList();
    feed("task.detail.result", {
      task: detailOf(SIX[0]!, {
        batches: [
          {
            batchId: "batch-1b",
            seq: 2,
            scope: "shell 任务页面域",
            status: "done",
            retryCount: 1,
            retryNote: "首次执行 closure 中 plan 未全部 resolve，自动重试 1 次后通过。",
            instanceId: "inst-a02",
            plan: [
              { seq: 1, content: "探查 shell 页面域与路由", status: "done", note: null },
              { seq: 2, content: "产出任务页结构节点", status: "done", note: null },
            ],
          },
          {
            batchId: "batch-1c",
            seq: 3,
            scope: "protocol 命令族扩展",
            status: "running",
            retryCount: 0,
            retryNote: null,
            instanceId: "inst-a03",
            plan: [
              { seq: 1, content: "划定 task.* 命令面", status: "done", note: null },
              { seq: 2, content: "写契约节点", status: "in_progress", note: null },
              { seq: 3, content: "写推送事件契约节点", status: "pending", note: null },
              { seq: 4, content: "产出实体节点", status: "abandoned", note: "放弃：上下文不足，执行实例终止" },
            ],
          },
          { batchId: "batch-1d", seq: 4, scope: "daemon 编排器域", status: "pending", retryCount: 0, retryNote: null, instanceId: null, plan: null },
        ],
      }),
    } satisfies TaskDetailResultPayload);
    // 阶段条三行（✓ / ● / 序号）+ 子行文案
    const stages = document.querySelectorAll("[data-tk-stage]");
    expect(stages.length).toBe(3);
    expect((stages[0] as HTMLElement).dataset.tkStage).toBe("done");
    expect(qs("[data-tk-stagebar]").textContent).toContain("产出 3 节点");
    expect(qs("[data-tk-stagebar]").textContent).toContain("批次 3/5");
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

  it("结果查询 tab：产物卡 + 节点条目（粗体 name + kind 徽章 + digest 首行 + 指路链接；裸 id 仅 data-id）+ 尾注 confirmed", () => {
    ui();
    feedList();
    feed("task.detail.result", { task: detailOf(SIX[0]!) } satisfies TaskDetailResultPayload);
    fireEvent.click(qs('[data-tk-tab="result"]'));
    expect(sent.artifacts.map((a) => a.jobId)).toEqual(["job-run"]);
    feed("task.artifacts.result", {
      artifacts: {
        stages: [
          {
            seq: 1,
            name: "L0 核心层",
            status: "done",
            artifact: {
              summary: "核心层完成：建立架构基线与全局写作规范。",
              nodes: [
                { nodeId: "kg-n-101", name: "daemon 四层架构基线", kind: "rule", digestFirstLine: "daemon 按四层分层，依赖只允许向内。", status: "confirmed" },
                { nodeId: "kg-n-205", name: "固定四段模板", kind: "rule", digestFirstLine: "每份报告固定四段。", status: "superseded" },
              ],
            },
          },
          { seq: 2, name: "L1 领域层", status: "running", artifact: null },
        ],
      },
    } satisfies TaskArtifactsResultPayload);
    expect(qs("[data-tk-art-count]").textContent).toBe("产出 2 节点");
    const nodeRow = qs('[data-tk-node][data-id="kg-n-101"]');
    expect(within(nodeRow).getByText("daemon 四层架构基线")).toBeTruthy();
    expect(nodeRow.querySelector("[data-node-kind='rule']")).toBeTruthy();
    expect(nodeRow.textContent).toContain("daemon 按四层分层，依赖只允许向内。");
    expect(nodeRow.querySelector("[data-tk-node-link]")!.textContent).toContain("在「项目」页查看");
    // 裸 id 零界面
    const text = document.querySelector(".app-layout")!.textContent ?? "";
    expect(text).not.toContain("kg-n-101");
    // 尾注 confirmed 语义
    expect(qs("[data-tk-art-footnote]").textContent).toContain("confirmed");
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

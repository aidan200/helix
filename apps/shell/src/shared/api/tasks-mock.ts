/**
 * task 族 mock daemon 镜像（F 层 mock mode；T3.1，P-2 任务页数据面）。
 *
 * 先例 = kg-mock.ts：真实 daemon 恒应答 task.* 命令（点对点结果帧 /
 * 校验失败 connection.error），fake 实例对九命令自动回放确定性场景。
 * 数据面 = 原型 P-2-task.html MOCK 区 TASKS 六任务逐字段转契约形状
 * （contracts/task-api.md DTO：TaskSummaryDto/TaskDetailDto/TaskBatchDto/
 * WorkItemDto/TaskArtifactsDto——AD-4 人类面规范在 mock 数据层同样强制：
 * 标题/范围/摘要为人类可读文案，jobId/batchId 仅 data-id 语义）；批次为
 * 跨阶段全量返回，stageSeq 为前端分组键（t1/t2 覆盖多阶段多批次样例）。
 *
 * 与 kg-mock 的差异：reply 返回帧数组（结果帧 + 生命周期成功伴发的
 * task.changed 广播——O-7 逐迁移轻负载，daemon handlers/task.ts 同构：
 * 生命周期命令成功即广播 {jobId, changed:"job", status}）。生命周期命令
 * 为 mock 内可变写（状态翻转），delete 清任务域记录（kg 产出不动——
 * mock 同构语义：artifacts 查询在 delete 后回 task.not_found）。
 */
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type {
  EventEnvelope,
  WorkItemDto,
  TaskArtifactsDto,
  TaskBatchDto,
  TaskChangedPayload,
  TaskDetailDto,
  TaskStatus,
  TaskSummaryDto,
} from "@helix/protocol";

/** 确定性时间零点（createdAt 相对值派生，重放可比）。 */
const MOCK_NOW = Date.parse("2026-08-29T11:22:00.000+08:00");
/** 响应延迟（loading 态触发面；kg 同款量级）。 */
export const TASKS_MOCK_LATENCY_MS = 60;

const iso = (offsetMin: number): string => new Date(MOCK_NOW + offsetMin * 60_000).toISOString();

// ── 原型实况采样：六任务覆盖六态 + 多项目徽章 + 开放阶段类型（t6）──────

function detailOf(
  s: TaskSummaryDto,
  o: {
    stages: TaskDetailDto["stages"];
    batches?: TaskBatchDto[];
    error?: string | null;
  },
): TaskDetailDto {
  return {
    ...s,
    stages: o.stages,
    batches: o.batches ?? [],
    params: {},
    ...(o.error != null ? { error: o.error } : {}),
  };
}

/** 六任务的 detail / artifacts 数据（summary 见 initialTasks）。 */
function buildStore(): { summaries: TaskSummaryDto[]; details: Map<string, TaskDetailDto>; artifacts: Map<string, TaskArtifactsDto> } {
  const t1: TaskSummaryDto = {
    jobId: "job-8f21",
    type: "kg-bootstrap",
    title: "helix 知识图谱创建",
    status: "running",
    projects: ["helix"],
    createdBy: "page",
    createdAt: iso(-130),
    updatedAt: iso(-2),
    progress: { stageName: "L1 领域层", batchesDone: 3, batchesTotal: 5, percent: 45 },
    error: null,
  };
  const t2: TaskSummaryDto = {
    jobId: "job-71c4",
    type: "kg-bootstrap",
    title: "web-access 知识图谱创建",
    status: "paused",
    projects: ["web-access"],
    createdBy: "page",
    createdAt: iso(-200),
    updatedAt: iso(-48),
    progress: { stageName: "L1 领域层", batchesDone: 2, batchesTotal: 4, percent: 30 },
    error: null,
  };
  const t3: TaskSummaryDto = {
    jobId: "job-b90d",
    type: "kg-bootstrap",
    title: "pi-src 知识图谱创建",
    status: "pending",
    projects: ["pi-src"],
    createdBy: "chat",
    createdAt: iso(-3),
    updatedAt: iso(-3),
    progress: null,
    error: null,
  };
  const t4: TaskSummaryDto = {
    jobId: "job-3ad6",
    type: "kg-bootstrap",
    title: "helix L2 实体层补全",
    status: "done",
    projects: ["helix"],
    createdBy: "page",
    createdAt: iso(-1180),
    updatedAt: iso(-1060),
    progress: { stageName: null, batchesDone: 9, batchesTotal: 9, percent: 100 },
    error: null,
  };
  const t5: TaskSummaryDto = {
    jobId: "job-e55a",
    type: "kg-bootstrap",
    title: "sandpile 知识图谱创建",
    status: "failed",
    projects: ["sandpile"],
    createdBy: "page",
    createdAt: iso(-1500),
    updatedAt: iso(-1470),
    progress: { stageName: "L0 核心层", batchesDone: 1, batchesTotal: 3, percent: 15 },
    error: "批次「构建系统与产物链」两次自动重试均失败（SubAgent 超时无 closure 产出）",
  };
  const t6: TaskSummaryDto = {
    jobId: "job-04f7",
    type: "批量审查",
    title: "依赖许可证合规扫描",
    status: "cancelled",
    projects: ["helix", "web-access"],
    createdBy: "chat",
    createdAt: iso(-2880),
    updatedAt: iso(-2760),
    progress: { stageName: null, batchesDone: 1, batchesTotal: 3, percent: 33 },
    error: null,
  };

  const b = (
    batchId: string,
    stageSeq: number,
    seq: number,
    scope: string,
    status: TaskBatchDto["status"],
    retryCount = 0,
    retryNote: string | null = null,
    instanceId: string | null = null,
    plan: TaskBatchDto["plan"] = null,
  ): TaskBatchDto => {
    // 台账计数摘要（P1-⑥）：daemon batchDtoOf 同构——服务端从 plan 行组装，
    // 未派发或零行 → 双 null
    const ledger =
      plan !== null && plan.length > 0
        ? {
            total: plan.length,
            done: plan.filter((w) => w.status === "done").length,
            inProgress: plan.filter((w) => w.status === "in_progress").length,
          }
        : null;
    return { batchId, stageSeq, seq, scope, status, retryCount, retryNote, instanceId, plan, ledger };
  };

  const wi = (
    seq: number,
    content: string,
    status: "pending" | "in_progress" | "done" | "abandoned",
    note: string | null = null,
  ): WorkItemDto => ({
    seq,
    content,
    status,
    note,
  });

  const details = new Map<string, TaskDetailDto>([
    detailOf(t1, {
      stages: [
        { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层完成：建立架构基线与全局写作规范，为 L1/L2 提供探索锚点。" } },
        { seq: 2, name: "L1 领域层", status: "running", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
      batches: [
        b("batch-1a", 1, 1, "daemon 任务引擎域", "done", 0, null, "inst-a01", [
          wi(1, "探查任务引擎 job / stage / batch 三表", "done"),
          wi(2, "产出任务引擎持久化域实体节点", "done"),
          wi(3, "产出状态机转换规则节点", "done"),
          wi(4, "自检：只看正文能否理解", "done"),
        ]),
        b("batch-1b", 1, 2, "shell 任务页面域", "done", 1, "首次执行 closure 中 plan 未全部 resolve，按编排规则自动重试 1 次后通过。", "inst-a02", [
          wi(1, "探查 shell 页面域与路由", "done"),
          wi(2, "产出任务页 master-detail 结构节点", "done"),
        ]),
        b("batch-1c", 2, 3, "protocol 命令族扩展", "running", 0, null, "inst-a03", [
          wi(1, "探查 protocol 既有命令与 additive 扩展先例", "done", "产物指针：P1 六命令族为先例"),
          wi(2, "划定 task.* 命令面", "done"),
          wi(3, "写 task.create / task.list 契约节点", "done"),
          wi(4, "写 task.detail / task.artifacts 契约节点", "in_progress"),
          wi(5, "写 WS 推送事件契约节点", "pending"),
          wi(6, "自检：只看正文能否理解", "pending"),
        ]),
        b("batch-1d", 2, 4, "daemon 编排器域", "pending"),
        b("batch-1e", 2, 5, "kg 消费面（附着 / 注入）", "pending"),
      ],
    }),
    detailOf(t2, {
      stages: [
        { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层完成：建立 fetch / browse 双通道的架构基线。" } },
        { seq: 2, name: "L1 领域层", status: "running", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
      batches: [
        b("batch-2a", 1, 1, "全局规范与架构基线", "done", 0, null, "inst-b01", [wi(1, "产出架构基线节点", "done")]),
        b("batch-2b", 2, 2, "内容抓取管线", "done", 0, null, "inst-b02", [wi(1, "产出抓取管线实体节点", "done")]),
        b("batch-2c", 2, 3, "渲染与脚本执行域", "pending"),
        b("batch-2d", 2, 4, "结果投影与封存", "pending"),
      ],
    }),
    detailOf(t3, {
      stages: [
        { seq: 1, name: "L0 核心层", status: "pending", artifact: null },
        { seq: 2, name: "L1 领域层", status: "pending", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
    }),
    detailOf(t4, {
      stages: [
        { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "复用既有核心层，补充 2 个缺失规范节点。" } },
        { seq: 2, name: "L1 领域层", status: "done", artifact: { summary: "领域层完成：6 个领域节点，覆盖 sync 管道、附着、注入、消费面。" } },
        {
          seq: 3,
          name: "L2 实体层",
          status: "done",
          artifact: {
            summary: "实体层完成：15 个实体 / 契约节点，全部带符号域锚（path#symbol）。",
            body: "## 实体清单\n\n- 会话聚合（domain/session/Session.ts#Session）\n- 快照映射（SnapshotMapper.ts#toSnapshotDto）\n- 写通道（WriteQueue.ts#WriteQueue）\n\n## 已知缺口\n\n- usage 域实体待下一轮补充。",
          },
        },
      ],
    }),
    detailOf(t5, {
      error: t5.error,
      stages: [
        { seq: 1, name: "L0 核心层", status: "failed", artifact: null },
        { seq: 2, name: "L1 领域层", status: "pending", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
      batches: [
        b("batch-5a", 1, 1, "全局规范与架构基线", "done", 0, null, "inst-c01", [wi(1, "产出架构基线节点", "done")]),
        b("batch-5b", 1, 2, "构建系统与产物链", "failed", 2, "第 1 次：SubAgent 超时无 closure。第 2 次：closure 缺失 plan，判失败。已达自动重试上限。", "inst-c02", [
          wi(1, "探查构建配置与产物链", "done", "产物指针：构建链草图"),
          wi(2, "产出构建系统实体节点", "abandoned", "放弃：上下文不足，执行实例终止"),
        ]),
      ],
    }),
    detailOf(t6, {
      stages: [
        { seq: 1, name: "依赖盘点", status: "done", artifact: { summary: "盘点完成：两项目共 148 个直接依赖，清单已产出。" } },
        { seq: 2, name: "许可证归类", status: "pending", artifact: null },
        { seq: 3, name: "风险汇总", status: "pending", artifact: null },
      ],
    }),
  ].map((d) => [d.jobId, d] as const));

  const artifacts = new Map<string, TaskArtifactsDto>([
    [
      t1.jobId,
      {
        stages: [
          {
            seq: 1,
            name: "L0 核心层",
            status: "done",
            artifact: {
              summary: "核心层完成：建立架构基线与全局写作规范，为 L1/L2 提供探索锚点。",
            },
          },
          { seq: 2, name: "L1 领域层", status: "running", artifact: null },
          { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
        ],
      },
    ],
    [
      t4.jobId,
      {
        stages: [
          {
            seq: 1,
            name: "L0 核心层",
            status: "done",
            artifact: {
              summary: "复用既有核心层，补充 2 个缺失规范节点。",
            },
          },
          {
            seq: 2,
            name: "L1 领域层",
            status: "done",
            artifact: {
              summary: "领域层完成：6 个领域节点。",
            },
          },
          {
            seq: 3,
            name: "L2 实体层",
            status: "done",
            artifact: {
              summary: "实体层完成：15 个实体 / 契约节点，全部带符号域锚。",
            },
          },
        ],
      },
    ],
    [
      t6.jobId,
      {
        stages: [
          {
            seq: 1,
            name: "依赖盘点",
            status: "done",
            artifact: {
              summary: "盘点完成：两项目共 148 个直接依赖，清单已产出。",
            },
          },
          { seq: 2, name: "许可证归类", status: "pending", artifact: null },
          { seq: 3, name: "风险汇总", status: "pending", artifact: null },
        ],
      },
    ],
    [
      t2.jobId,
      {
        stages: [
          {
            seq: 1,
            name: "L0 核心层",
            status: "done",
            artifact: {
              summary: "核心层完成：建立 fetch / browse 双通道的架构基线。",
            },
          },
          { seq: 2, name: "L1 领域层", status: "running", artifact: null },
          { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
        ],
      },
    ],
    // R-6 无产物空态覆盖（T-verification 扩面；契约同构：job 存在 →
    // task.artifacts 恒回 DTO，阶段 artifact 全 null 即空态——task.not_found
    // 仅 job 不存在；与 detail 阶段行逐字段镜像）
    [
      t3.jobId,
      {
        stages: [
          { seq: 1, name: "L0 核心层", status: "pending", artifact: null },
          { seq: 2, name: "L1 领域层", status: "pending", artifact: null },
          { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
        ],
      },
    ],
    [
      t5.jobId,
      {
        stages: [
          { seq: 1, name: "L0 核心层", status: "failed", artifact: null },
          { seq: 2, name: "L1 领域层", status: "pending", artifact: null },
          { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
        ],
      },
    ],
  ]);

  return { summaries: [t1, t2, t3, t4, t5, t6], details, artifacts };
}

// ── mock store（连接内可变：生命周期写 + delete 清任务域）──────

/** 终态集合（delete 准入判定，契约 §2）。 */
const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);

export class TasksMockStore {
  private summaries: TaskSummaryDto[];
  private details: Map<string, TaskDetailDto>;
  private artifacts: Map<string, TaskArtifactsDto>;

  constructor() {
    const s = buildStore();
    this.summaries = s.summaries;
    this.details = s.details;
    this.artifacts = s.artifacts;
  }

  /**
   * task 命令应答（契约镜像；返回帧数组：结果帧 + 生命周期成功伴发的
   * task.changed 广播；错误走 connection.error 点对点回执——handlers/task.ts
   * 词表同构）。
   */
  reply(type: string, payload: unknown): EventEnvelope[] {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (type) {
      case "task.list":
        return [this.frame("task.list.result", { tasks: this.listRows(p) })];
      case "task.detail": {
        const d = this.details.get(String(p.jobId));
        if (d === undefined) return [this.errorFrame("task.not_found", `任务 ${String(p.jobId)} 不存在`)];
        return [this.frame("task.detail.result", { task: this.syncedDetail(d) })];
      }
      case "task.artifacts": {
        const a = this.artifacts.get(String(p.jobId));
        if (a === undefined) return [this.errorFrame("task.not_found", `任务 ${String(p.jobId)} 不存在`)];
        return [this.frame("task.artifacts.result", { artifacts: a })];
      }
      // 订阅簿记（连接级订阅表 + changed 过滤投递，契约 §3）在
      // fake-transport.ts send 钩子承载（sessionTiers 同轨；本 store 为
      // 跨连接共享单例，不持连接级状态）——此处仅点对点回执。
      case "task.subscribe":
      case "task.unsubscribe":
        return [this.frame(`${type}.result`, { ok: true })];
      case "task.pause":
        return this.lifecycle(String(p.jobId), "pause", "paused", ["running"]);
      case "task.resume":
        return this.lifecycle(String(p.jobId), "resume", "running", ["paused"]);
      case "task.cancel":
        return this.lifecycle(String(p.jobId), "cancel", "cancelled", ["pending", "running", "paused"]);
      case "task.delete": {
        const jobId = String(p.jobId);
        const row = this.summaries.find((t) => t.jobId === jobId);
        if (row === undefined) return [this.errorFrame("task.not_found", `任务 ${jobId} 不存在`)];
        if (!TERMINAL.has(row.status)) {
          return [this.errorFrame("task.invalid_state", "仅终态任务可删除，运行中须先取消")];
        }
        // F3.6：清任务域全部记录（job/stage/batch + work_item 台账）；kg 产出不动
        this.summaries = this.summaries.filter((t) => t.jobId !== jobId);
        this.details.delete(jobId);
        this.artifacts.delete(jobId);
        return [this.frame("task.delete.result", { ok: true })];
      }
      default:
        return [this.errorFrame("command.invalid_payload", `未知命令 ${type}`)];
    }
  }

  /** 生命周期命令：状态门控（非法态 → task.invalid_state）+ 成功伴发 changed 广播。 */
  private lifecycle(
    jobId: string,
    cmd: "pause" | "resume" | "cancel",
    next: TaskStatus,
    allowedFrom: readonly TaskStatus[],
  ): EventEnvelope[] {
    const row = this.summaries.find((t) => t.jobId === jobId);
    if (row === undefined) return [this.errorFrame("task.not_found", `任务 ${jobId} 不存在`)];
    if (!allowedFrom.includes(row.status)) {
      return [this.errorFrame("task.invalid_state", `任务当前状态 ${row.status} 不允许 ${cmd}`)];
    }
    row.status = next;
    row.updatedAt = new Date().toISOString();
    const d = this.details.get(jobId);
    if (d !== undefined) d.status = next;
    const changed: TaskChangedPayload = { jobId, changed: "job", status: next };
    return [this.frame(`task.${cmd}.result`, { ok: true, status: next }), this.event("task.changed", changed)];
  }

  /** task.list 行（服务端排序 = 运行中置顶 + 创建时间倒序，契约 §2 镜像）。 */
  private listRows(p: Record<string, unknown>): TaskSummaryDto[] {
    const status = typeof p.status === "string" ? (p.status as TaskStatus) : undefined;
    const project = typeof p.project === "string" ? p.project : undefined;
    const matched = this.summaries.filter(
      (t) => (status === undefined || t.status === status) && (project === undefined || t.projects.includes(project)),
    );
    const sorted = [...matched].sort((a, b) => {
      const ar = a.status === "running" ? 0 : 1;
      const br = b.status === "running" ? 0 : 1;
      if (ar !== br) return ar - br;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    return sorted.map((t) => ({ ...t }));
  }

  /** detail 输出（progress 与 status 同步镜像——paused/pending 叙述一致）。 */
  private syncedDetail(d: TaskDetailDto): TaskDetailDto {
    return { ...d, projects: [...d.projects] };
  }

  private frame(type: string, payload: unknown): EventEnvelope {
    return {
      v: PROTOCOL_VERSION,
      type,
      sessionId: SYSTEM_SESSION_ID,
      channel: "notification",
      payload,
    } as EventEnvelope;
  }

  private event(type: string, payload: unknown): EventEnvelope {
    return this.frame(type, payload);
  }

  private errorFrame(code: string, message: string): EventEnvelope {
    return {
      v: PROTOCOL_VERSION,
      type: "connection.error",
      sessionId: SYSTEM_SESSION_ID,
      channel: "notification",
      payload: { code, message },
    } as EventEnvelope;
  }
}

/** 模块级单例（同页多连接共享 mock 状态——生命周期写跨连接可见）。 */
export const tasksMockStore = new TasksMockStore();

/** task 族命令判定（fake-transport send 钩子用）。 */
export function isTaskCommand(type: string): boolean {
  return (
    type === "task.list" ||
    type === "task.detail" ||
    type === "task.artifacts" ||
    type === "task.subscribe" ||
    type === "task.unsubscribe" ||
    type === "task.pause" ||
    type === "task.resume" ||
    type === "task.cancel" ||
    type === "task.delete"
  );
}

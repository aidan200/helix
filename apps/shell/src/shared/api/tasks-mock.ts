/**
 * task 族 mock daemon 镜像（F 层 mock mode；T3.1，P-2 任务页数据面）。
 *
 * 先例 = kg-mock.ts：真实 daemon 恒应答 task.* 命令（点对点结果帧 /
 * 校验失败 connection.error），fake 实例对九命令自动回放确定性场景。
 * 数据面 = 原型 P-2-task.html MOCK 区 TASKS 六任务逐字段转契约形状
 * （contracts/task-api.md DTO：TaskSummaryDto/TaskDetailDto/TaskBatchDto/
 * WorkItemDto/TaskArtifactsDto/NodeRefDto——AD-4 人类面规范在 mock 数据层
 * 同样强制：标题/范围/叙述句为人类可读文案，jobId/batchId/nodeId 仅
 * data-id 语义）。
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
    narrative: string;
    stages: TaskDetailDto["stages"];
    batches?: TaskBatchDto[];
    error?: string | null;
  },
): TaskDetailDto {
  return {
    ...s,
    currentNarrative: o.narrative,
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
    seq: number,
    scope: string,
    status: TaskBatchDto["status"],
    retryCount = 0,
    retryNote: string | null = null,
    instanceId: string | null = null,
    plan: TaskBatchDto["plan"] = null,
  ): TaskBatchDto => ({ batchId, seq, scope, status, retryCount, retryNote, instanceId, plan });

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
      narrative:
        "批次「protocol 命令族扩展」进行中：12 项计划完成 7 项，正在写 task 命令族契约节点；下一批为「daemon 编排器域」。",
      stages: [
        { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层完成：建立架构基线与全局写作规范，为 L1/L2 提供探索锚点。", nodeCount: 3 } },
        { seq: 2, name: "L1 领域层", status: "running", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
      batches: [
        b("batch-1a", 1, "daemon 任务引擎域", "done", 0, null, "inst-a01", [
          wi(1, "探查任务引擎 job / stage / batch 三表", "done"),
          wi(2, "产出任务引擎持久化域实体节点", "done"),
          wi(3, "产出状态机转换规则节点", "done"),
          wi(4, "自检：只看正文能否理解", "done"),
        ]),
        b("batch-1b", 2, "shell 任务页面域", "done", 1, "首次执行 closure 中 plan 未全部 resolve，按编排规则自动重试 1 次后通过。", "inst-a02", [
          wi(1, "探查 shell 页面域与路由", "done"),
          wi(2, "产出任务页 master-detail 结构节点", "done"),
        ]),
        b("batch-1c", 3, "protocol 命令族扩展", "running", 0, null, "inst-a03", [
          wi(1, "探查 protocol 既有命令与 additive 扩展先例", "done", "产物指针：P1 六命令族为先例"),
          wi(2, "划定 task.* 命令面", "done"),
          wi(3, "写 task.create / task.list 契约节点", "done"),
          wi(4, "写 task.detail / task.artifacts 契约节点", "in_progress"),
          wi(5, "写 WS 推送事件契约节点", "pending"),
          wi(6, "自检：只看正文能否理解", "pending"),
        ]),
        b("batch-1d", 4, "daemon 编排器域", "pending"),
        b("batch-1e", 5, "kg 消费面（附着 / 注入）", "pending"),
      ],
    }),
    detailOf(t2, {
      narrative: "已于 10:02 暂停：批次「内容抓取管线」收口后挂起，未派新批次。继续后从批次「渲染与脚本执行域」恢复。",
      stages: [
        { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层完成：建立 fetch / browse 双通道的架构基线。", nodeCount: 1 } },
        { seq: 2, name: "L1 领域层", status: "running", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
      batches: [
        b("batch-2a", 1, "全局规范与架构基线", "done", 0, null, "inst-b01", [wi(1, "产出架构基线节点", "done")]),
        b("batch-2b", 2, "内容抓取管线", "done", 0, null, "inst-b02", [wi(1, "产出抓取管线实体节点", "done")]),
        b("batch-2c", 3, "渲染与脚本执行域", "pending"),
        b("batch-2d", 4, "结果投影与封存", "pending"),
      ],
    }),
    detailOf(t3, {
      narrative: "任务已创建：skill 校验通过，三阶段计划已冻结，编排器正在装配会话。",
      stages: [
        { seq: 1, name: "L0 核心层", status: "pending", artifact: null },
        { seq: 2, name: "L1 领域层", status: "pending", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
    }),
    detailOf(t4, {
      narrative: "任务完成：3 个阶段共产出 23 个节点，落盘即 confirmed（正式知识），可在「项目」页查看与修正。",
      stages: [
        { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "复用既有核心层，补充 2 个缺失规范节点。", nodeCount: 1 } },
        { seq: 2, name: "L1 领域层", status: "done", artifact: { summary: "领域层完成：6 个领域节点，覆盖 sync 管道、附着、注入、消费面。", nodeCount: 1 } },
        { seq: 3, name: "L2 实体层", status: "done", artifact: { summary: "实体层完成：15 个实体 / 契约节点，全部带符号域锚（path#symbol）。", nodeCount: 2 } },
      ],
    }),
    detailOf(t5, {
      narrative: "批次「构建系统与产物链」两次自动重试均失败（SubAgent 超时无 closure 产出）；阶段 L0 标记失败，任务收口。可在「项目」页确认索引状态后发起新任务。",
      error: t5.error,
      stages: [
        { seq: 1, name: "L0 核心层", status: "failed", artifact: null },
        { seq: 2, name: "L1 领域层", status: "pending", artifact: null },
        { seq: 3, name: "L2 实体层", status: "pending", artifact: null },
      ],
      batches: [
        b("batch-5a", 1, "全局规范与架构基线", "done", 0, null, "inst-c01", [wi(1, "产出架构基线节点", "done")]),
        b("batch-5b", 2, "构建系统与产物链", "failed", 2, "第 1 次：SubAgent 超时无 closure。第 2 次：closure 缺失 plan，判失败。已达自动重试上限。", "inst-c02", [
          wi(1, "探查构建配置与产物链", "done", "产物指针：构建链草图"),
          wi(2, "产出构建系统实体节点", "abandoned", "放弃：上下文不足，执行实例终止"),
        ]),
      ],
    }),
    detailOf(t6, {
      narrative: "已于 08-27 17:24 取消：「依赖盘点」阶段产物保留，未启动的批次不再执行。",
      stages: [
        { seq: 1, name: "依赖盘点", status: "done", artifact: { summary: "盘点完成：两项目共 148 个直接依赖，清单已产出。", nodeCount: 1 } },
        { seq: 2, name: "许可证归类", status: "pending", artifact: null },
        { seq: 3, name: "风险汇总", status: "pending", artifact: null },
      ],
    }),
  ].map((d) => [d.jobId, d] as const));

  const nref = (nodeId: string, name: string, kind: string, digestFirstLine: string, status: "confirmed" | "superseded" = "confirmed") => ({
    nodeId,
    name,
    kind,
    digestFirstLine,
    status,
  });

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
              nodes: [
                nref("kg-n-101", "daemon 四层架构基线", "rule", "daemon 按 adapters / application / domain / infrastructure 分层，依赖只允许向内。"),
                nref("kg-n-102", "kg 写面唯一入口", "rule", "知识层全部写操作必须经 KgWriteService.write 单 op 单事务进入。"),
                nref("kg-n-103", "知识写作规范五条", "rule", "正文完整自然语言、digest 叙述式不超过两行、每条知识带为什么存在。"),
              ],
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
              nodes: [nref("kg-n-201", "锚点声明作用域规则", "rule", "锚点声明分全局 / 领域 / 实体三级作用域，scope_kind 决定物化范围。")],
            },
          },
          {
            seq: 2,
            name: "L1 领域层",
            status: "done",
            artifact: {
              summary: "领域层完成：6 个领域节点。",
              nodes: [nref("kg-n-202", "sync 双源汇队列", "entity", "文件源与符号源汇入同一去抖队列，单飞管道串行处理，重启后从水位线续跑。")],
            },
          },
          {
            seq: 3,
            name: "L2 实体层",
            status: "done",
            artifact: {
              summary: "实体层完成：15 个实体 / 契约节点，全部带符号域锚。",
              nodes: [
                nref("kg-n-203", "KgWriteService", "entity", "知识层唯一写入口，五 op 联合，单 op 单事务。"),
                nref("kg-n-204", "kg.search 命令契约", "contract", "按 name / digest 关键字检索节点，硬顶 20 条按 id 排序，只读。"),
                nref("kg-n-205", "固定四段模板", "rule", "每份知识变化报告固定渲染背景、检出、影响、结论四段。", "superseded"),
              ],
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
              nodes: [nref("kg-n-301", "helix 直接依赖清单", "entity", "helix 直接依赖 92 个，其中 11 个许可证类型需人工确认归类。")],
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
              nodes: [nref("kg-n-401", "web-access 双通道架构", "rule", "内容获取分 fetch 与 browse 双通道，按页面动态程度由调用方选择。")],
            },
          },
          { seq: 2, name: "L1 领域层", status: "running", artifact: null },
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
    return [this.frame(`${cmd}.result`, { ok: true, status: next }), this.event("task.changed", changed)];
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

import type { ClockPort } from "../../ports/outbound/ClockPort";
import { TaskError } from "./TaskError";
import type { TaskStorePort, BatchData, JobData, StageData } from "../../ports/outbound/TaskStorePort";
import type { WorkLedgerPort } from "../../ports/outbound/WorkLedgerPort";
import type { TaskSkillRegistryPort } from "../../ports/outbound/TaskSkillRegistryPort";
import type { JobStatus } from "../../../domain/task/types";

/**
 * TaskQueryService —— P-2 任务页读面（AD-4② 人类可读投影服务端收口）：
 * title/progress 全部在此组装，前端不拼文案、裸 id 只做
 * join 键/data-id。DTO 逐字段按 development/contracts/task-api.md §1
 * （T1.5 协议面 types/task.ts 同源展开）。
 *
 * 只读服务：零写面；listTasks 服务端排序 = 运行中置顶 + 创建时间倒序，
 * 过滤器（status/project）服务端生效。
 */

// ── DTO（contracts/task-api.md §1；T1.5 协议面同源） ────────

export interface TaskProgress {
  readonly stageName: string | null;
  readonly batchesDone: number;
  readonly batchesTotal: number;
  readonly percent: number;
}

export interface TaskSummaryDto {
  readonly jobId: string;
  readonly type: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly projects: readonly string[];
  readonly createdBy: "page" | "chat";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress: TaskProgress | null;
  readonly error: string | null;
}

export interface WorkItemDto {
  readonly seq: number;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "done" | "abandoned";
  readonly note: string | null;
}

export interface TaskBatchDto {
  readonly batchId: string;
  /** 所属阶段序号（前端按阶段分组键；批次列表为全量跨阶段收集）。 */
  readonly stageSeq: number;
  readonly seq: number;
  readonly scope: string;
  readonly status: BatchData["status"];
  readonly retryCount: number;
  readonly retryNote: string | null;
  readonly instanceId: string | null;
  readonly plan: readonly WorkItemDto[] | null;
}

export interface TaskStageDto {
  readonly seq: number;
  readonly name: string;
  readonly status: StageData["status"];
  readonly artifact: { readonly summary: string } | null;
}

export interface TaskDetailDto extends TaskSummaryDto {
  readonly stages: readonly TaskStageDto[];
  readonly batches: readonly TaskBatchDto[];
  readonly params: Record<string, unknown>;
}

export interface TaskArtifactsDto {
  readonly stages: readonly {
    readonly seq: number;
    readonly name: string;
    readonly status: StageData["status"];
    readonly artifact: { readonly summary: string } | null;
  }[];
}

export interface TaskListFilter {
  readonly status?: JobStatus;
  readonly project?: string;
}

export interface TaskQueryServiceDeps {
  readonly store: TaskStorePort;
  readonly workLedger: Pick<WorkLedgerPort, "getItems">;
  readonly skills: TaskSkillRegistryPort;
  readonly clock: ClockPort;
}

export class TaskQueryService {
  constructor(private readonly deps: TaskQueryServiceDeps) {}

  /** 任务列表（全局平铺；服务端排序 = 运行中置顶 + 创建时间倒序；过滤服务端生效）。 */
  listTasks(filter: TaskListFilter): readonly TaskSummaryDto[] {
    const jobs =
      filter.status === undefined
        ? this.deps.store.listJobs()
        : this.deps.store.listJobs({ status: filter.status });
    const visible = filter.project === undefined ? jobs : jobs.filter((j) => j.projects.includes(filter.project!));
    return visible
      .slice()
      .sort((a, b) => {
        const rank = (j: JobData): number => (j.status === "running" ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
      })
      .map((job) => this.summaryOf(job));
  }

  /** 任务详情（阶段条 + 全量批次（跨阶段收集，stageSeq 分组键）+ 实例 plan）。 */
  getTaskDetail(jobId: string): TaskDetailDto {
    const job = this.mustJob(jobId);
    const stages = this.deps.store.getStages(jobId);
    // 全量批次（裁决 ①：不再只回当前阶段——done 任务末阶段之外的批次
    // 也要可见）；序 = stage seq 升序 + 阶段内批次 seq 升序（落库序）。
    const batches = stages.flatMap((s) => this.deps.store.getBatches(jobId, s.seq));
    return {
      ...this.summaryOf(job),
      stages: stages.map((s) => stageDtoOf(s)),
      batches: batches.map((b) => this.batchDtoOf(b)),
      params: job.params,
    };
  }

  /** 结果查询（F3.4 只读）：stage.artifact 文字报告（与 kg 零耦合）。 */
  getTaskArtifacts(jobId: string): TaskArtifactsDto {
    const job = this.mustJob(jobId);
    return {
      stages: this.deps.store.getStages(job.id).map((s) => ({
        seq: s.seq,
        name: s.name,
        status: s.status,
        artifact: s.artifact === null ? null : { summary: s.artifact.summary },
      })),
    };
  }

  // ── 组装 ──────────────────────────────────────────────────

  private mustJob(jobId: string): JobData {
    const job = this.deps.store.getJob(jobId);
    if (job === undefined) throw new TaskError("task.not_found", `任务 ${jobId} 不存在`);
    return job;
  }

  private summaryOf(job: JobData): TaskSummaryDto {
    const stages = this.deps.store.getStages(job.id);
    return {
      jobId: job.id,
      type: job.type,
      title: titleOf(job, this.deps.skills),
      status: job.status,
      projects: [...job.projects],
      createdBy: job.createdBy,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: progressOf(job, stages, (seq) => this.deps.store.getBatches(job.id, seq)),
      error: job.error,
    };
  }

  private batchDtoOf(batch: BatchData): TaskBatchDto {
    return {
      batchId: batch.id,
      stageSeq: batch.stageSeq,
      seq: batch.seq,
      scope: batch.scope,
      status: batch.status,
      retryCount: batch.retryCount,
      retryNote: batch.retryNote,
      instanceId: batch.instanceId,
      plan:
        batch.instanceId === null
          ? null
          : this.deps.workLedger.getItems(batch.instanceId).map((item) => ({
              seq: item.seq,
              content: item.content,
              status: item.status,
              note: item.note,
            })),
    };
  }
}

// ── 纯组装函数（人类可读收口，AD-4②） ────────────────────────

/** 当前阶段 = 第一个未 done 的 stage；全 done = 收口态（阶段条高亮末段）。 */
function currentStageOf(stages: readonly StageData[]): StageData | null {
  return stages.find((s) => s.status !== "done") ?? stages[stages.length - 1] ?? null;
}

function stageDtoOf(stage: StageData): TaskStageDto {
  return {
    seq: stage.seq,
    name: stage.name,
    status: stage.status,
    artifact: stage.artifact === null ? null : { summary: stage.artifact.summary },
  };
}

/** 标题：skill 任务说明首段 + 项目语境（服务端组装，前端不拼文案）。 */
function titleOf(job: JobData, skills: TaskSkillRegistryPort): string {
  const description = skills.listTaskTypes().find((t) => t.type === job.type)?.description;
  const base = description === undefined ? `${job.type} 任务` : (description.split(/[；;\n]/)[0] ?? description);
  return job.projects.length > 0 ? `${base}（${job.projects.join("、")}）` : base;
}

/**
 * 进度：null = 未启动（全部 stage pending 且零批次且 job 非运行中）；
 * 否则按「已完成阶段 + 当前阶段批次完成比」折算百分比（0-100）。
 */
function progressOf(
  job: JobData,
  stages: readonly StageData[],
  batchesOf: (stageSeq: number) => readonly BatchData[],
): TaskProgress | null {
  const totalStages = stages.length;
  if (totalStages === 0) return null;
  const totalBatches = stages.reduce((sum, s) => sum + batchesOf(s.seq).length, 0);
  const started = stages.some((s) => s.status !== "pending") || totalBatches > 0 || job.status === "running";
  if (!started) return null;
  const current = currentStageOf(stages)!;
  const batches = batchesOf(current.seq);
  const batchesDone = batches.filter((b) => b.status === "done").length;
  const doneStages = stages.filter((s) => s.status === "done").length;
  const frac = batches.length > 0 ? batchesDone / batches.length : 0;
  const percent = Math.min(100, Math.round((100 * (doneStages + frac)) / totalStages));
  return {
    stageName: job.status === "done" ? null : current.name,
    batchesDone,
    batchesTotal: batches.length,
    percent,
  };
}

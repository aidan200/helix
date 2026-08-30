import { DomainError } from "../../../domain/DomainError";
import type { Database } from "bun:sqlite";
import { assertJobTransition, assertStageTransition } from "../../../domain/task/job";
import type { JobStatus, StageStatus } from "../../../domain/task/types";
import type { WriteQueue } from "./WriteQueue";
import { rowToBatch, rowToJob, rowToStage } from "./rows/TaskRowMapper";
import type { BatchRow, JobRow, StageRow } from "./rows/TaskRows";
import type {
  BatchData,
  JobData,
  JobListFilter,
  StageArtifact,
  StageData,
  TaskDeleteCounts,
  TaskStorePort,
} from "../../../application/ports/outbound/TaskStorePort";

/**
 * TaskStore —— job/stage/batch 三表存取（TaskStorePort 实现，O-1 表分域）。
 *
 * - 写面全部经 WriteQueue 单写通道（不出现第二种父进程写路径）：任务无
 *   会话维 → 全局链 FIFO；读面共用 WriteQueue.database（write-through：
 *   await 的写 promise 落盘完成才 resolve，随后的同步读必见新行）。
 * - 表分域判据（O-1）：本类无任何 work_item 方法（WorkLedgerPort 侧；
 *   T2.1 arch-guard 断言兜底）。
 * - 状态守卫（与 T1.1 domain 联用）：updateJobStatus/updateStageStatus
 *   入队前读当前行经 domain 断言（assert*Transition）——非法迁移在写路径
 *   上被拒（DomainError，行未被污染）；updateBatch 为整行替换不设守卫
 *   （重试复跑语义在引擎 T1.3：failed 批次经 retryCount 递增的新行值复跑，
 *   domain batch 机 failed 即终态——复跑不经状态迁移断言，见
 *   development/architecture-feedback.md）。
 */

const JOB_COLUMNS =
  "id, type, params, projects, status, created_by, created_at, updated_at, error";
const STAGE_COLUMNS = "job_id, seq, name, status, artifact, updated_at";
const BATCH_COLUMNS =
  "id, job_id, stage_seq, seq, scope, status, retry_count, retry_note, instance_id, created_at, updated_at";

export class TaskStore implements TaskStorePort {
  constructor(private readonly writeQueue: WriteQueue) {}

  insertJob(job: JobData): Promise<void> {
    return this.writeQueue.saveTaskJob(job);
  }

  insertStage(stage: StageData): Promise<void> {
    return this.writeQueue.saveTaskStage(stage);
  }

  async updateJobStatus(id: string, status: JobStatus, error: string | null = null): Promise<void> {
    const current = this.getJob(id);
    if (current === undefined) {
      throw new DomainError(`job 不存在：${id}（状态迁移无从判定）`);
    }
    assertJobTransition(current.status, status);
    await this.writeQueue.saveTaskJobStatus(id, status, error);
  }

  async updateStageStatus(
    jobId: string,
    seq: number,
    status: StageStatus,
    artifact?: StageArtifact,
  ): Promise<void> {
    const current = this.getStages(jobId).find((s) => s.seq === seq);
    if (current === undefined) {
      throw new DomainError(`stage 不存在：${jobId}#${seq}（状态迁移无从判定）`);
    }
    assertStageTransition(current.status, status);
    await this.writeQueue.saveTaskStageStatus(jobId, seq, status, artifact);
  }

  /** batch 行插入（seq 由 WriteQueue 单写线程内原子赋予，调用方不预算）。 */
  insertBatch(batch: Omit<BatchData, "seq">): Promise<void> {
    return this.writeQueue.saveTaskBatch(batch);
  }

  updateBatch(batch: BatchData): Promise<void> {
    return this.writeQueue.updateTaskBatch(batch);
  }

  getJob(id: string): JobData | undefined {
    const row = this.writeQueue.database
      .prepare(`SELECT ${JOB_COLUMNS} FROM job WHERE id = ?`)
      .get(id) as JobRow | null;
    return row === null ? undefined : rowToJob(row);
  }

  getBatch(id: string): BatchData | undefined {
    const row = this.writeQueue.database
      .prepare(`SELECT ${BATCH_COLUMNS} FROM batch WHERE id = ?`)
      .get(id) as BatchRow | null;
    return row === null ? undefined : rowToBatch(row);
  }

  listJobs(filter?: JobListFilter): readonly JobData[] {
    const rows =
      filter?.status === undefined
        ? (this.writeQueue.database
            .prepare(`SELECT ${JOB_COLUMNS} FROM job ORDER BY created_at DESC, id`)
            .all() as JobRow[])
        : (this.writeQueue.database
            .prepare(`SELECT ${JOB_COLUMNS} FROM job WHERE status = ? ORDER BY created_at DESC, id`)
            .all(filter.status) as JobRow[]);
    return rows.map(rowToJob);
  }

  getStages(jobId: string): readonly StageData[] {
    const rows = this.writeQueue.database
      .prepare(`SELECT ${STAGE_COLUMNS} FROM stage WHERE job_id = ? ORDER BY seq`)
      .all(jobId) as StageRow[];
    return rows.map(rowToStage);
  }

  getBatches(jobId: string, stageSeq: number): readonly BatchData[] {
    const rows = this.writeQueue.database
      .prepare(
        `SELECT ${BATCH_COLUMNS} FROM batch WHERE job_id = ? AND stage_seq = ? ORDER BY seq`,
      )
      .all(jobId, stageSeq) as BatchRow[];
    return rows.map(rowToBatch);
  }

  deleteJobCascade(jobId: string): Promise<TaskDeleteCounts> {
    return this.writeQueue.deleteTaskJobCascade(jobId);
  }
}

/**
 * 批次归属读（T4.2 机械注入源，AD-10）：instance_id → 批次归属
 * { jobId, batchId }。子进程接线层（ChildMain）经 openTaskLedgerDatabase
 * 直连连接调用——spawn 时刻父进程尚不可知批次归属（insertBatch→spawn→
 * dispatchBatch 序：batch.instance_id 在 dispatchBatch 才落章），故由
 * 子进程在 kg-update 执行时惰性解析（届时 instance_id 早已落章）。
 * 纯 SELECT（AG-06 读面自由）；无命中 = 非任务上下文（chat 子进程等）。
 */
export function readTaskContextByInstance(
  db: Database,
  instanceId: string,
): { readonly jobId: string; readonly batchId: string } | undefined {
  const row = db
    .prepare("SELECT id, job_id FROM batch WHERE instance_id = ?")
    .get(instanceId) as { id: string; job_id: string } | null;
  return row === null ? undefined : { jobId: row.job_id, batchId: row.id };
}

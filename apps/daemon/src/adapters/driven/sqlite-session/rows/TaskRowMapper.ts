import type {
  BatchData,
  JobData,
  StageArtifact,
  StageData,
} from "../../../../application/ports/outbound/TaskStorePort";
import type {
  WorkItemData,
  WorkItemInput,
} from "../../../../application/ports/outbound/WorkLedgerPort";
import type {
  BatchStatus,
  JobStatus,
  StageStatus,
  WorkItemStatus,
} from "../../../../domain/task/types";
import type { BatchRow, JobRow, StageRow, WorkItemRow } from "./TaskRows";

/**
 * TaskRowMapper —— 任务域数据形状 ↔ 贫血行模型转换（TR-AD-14，RowMapper.ts
 * 同构）：domain 不见行模型、行模型不见行为；序列化（JSON）在此收口。
 * 状态列读回直接 cast（行模型哑——写入侧经 domain 守卫，读取侧信任落库值）。
 */

// ── job ↔ job 行 ───────────────────────────────────────────

export function jobToRow(job: JobData): JobRow {
  return {
    id: job.id,
    type: job.type,
    params: JSON.stringify(job.params),
    // projects 空数组合法（AD-8）：序列化保 "[]"，读回 JSON.parse 还原 []
    projects: JSON.stringify([...job.projects]),
    status: job.status,
    created_by: job.createdBy,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    error: job.error,
  };
}

export function rowToJob(row: JobRow): JobData {
  return {
    id: row.id,
    type: row.type,
    params: JSON.parse(row.params) as Record<string, unknown>,
    projects: JSON.parse(row.projects) as string[],
    status: row.status as JobStatus,
    createdBy: row.created_by as JobData["createdBy"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

// ── stage ↔ stage 行 ───────────────────────────────────────

export function stageToRow(stage: StageData): StageRow {
  return {
    job_id: stage.jobId,
    seq: stage.seq,
    name: stage.name,
    status: stage.status,
    artifact: stageArtifactToText(stage.artifact),
    updated_at: stage.updatedAt,
  };
}

export function rowToStage(row: StageRow): StageData {
  return {
    jobId: row.job_id,
    seq: row.seq,
    name: row.name,
    status: row.status as StageStatus,
    artifact: row.artifact === null ? null : (JSON.parse(row.artifact) as StageArtifact),
    updatedAt: row.updated_at,
  };
}

/** artifact 聚合落库文本化（undefined/null → SQL NULL；updateStageStatus 复用）。 */
export function stageArtifactToText(artifact: StageArtifact | null | undefined): string | null {
  return artifact === null || artifact === undefined ? null : JSON.stringify(artifact);
}

// ── batch ↔ batch 行 ───────────────────────────────────────

export function batchToRow(batch: BatchData): BatchRow {
  return {
    id: batch.id,
    job_id: batch.jobId,
    stage_seq: batch.stageSeq,
    seq: batch.seq,
    scope: batch.scope,
    status: batch.status,
    retry_count: batch.retryCount,
    retry_note: batch.retryNote,
    instance_id: batch.instanceId,
    created_at: batch.createdAt,
    updated_at: batch.updatedAt,
  };
}

export function rowToBatch(row: BatchRow): BatchData {
  return {
    id: row.id,
    jobId: row.job_id,
    stageSeq: row.stage_seq,
    seq: row.seq,
    scope: row.scope,
    status: row.status as BatchStatus,
    retryCount: row.retry_count,
    retryNote: row.retry_note,
    instanceId: row.instance_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── work_item ↔ work_item 行 ───────────────────────────────

/** insertItems 输入 → 初始行（状态机入口恒 pending、note 空；updated_at 取映射时刻墙钟）。 */
export function workItemInputsToRows(
  instanceId: string,
  items: readonly WorkItemInput[],
  now: string,
): WorkItemRow[] {
  return items.map((item) => ({
    instance_id: instanceId,
    seq: item.seq,
    content: item.content,
    status: "pending" as WorkItemStatus,
    note: null,
    updated_at: now,
  }));
}

export function rowsToWorkItems(rows: readonly WorkItemRow[]): WorkItemData[] {
  return rows.map((row) => ({
    instanceId: row.instance_id,
    seq: row.seq,
    content: row.content,
    status: row.status as WorkItemStatus,
    note: row.note,
    updatedAt: row.updated_at,
  }));
}

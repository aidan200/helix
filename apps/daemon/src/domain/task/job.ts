import { DomainError } from "../DomainError";
import type { BatchStatus, JobStatus, StageStatus } from "./types";

/**
 * job/stage/batch 状态机迁移规则收口（architecture.md §3.3，通用零任务类型语义）。
 * Turn.ts 先例：字面量联合 + 守卫抛 DomainError。
 *
 * 注意（AD-9③）：domain 层不提供任何增删 stage 的函数——阶段冻结由「无 API」机械保证，
 * 此处只有状态迁移守卫。
 */

/** job 合法迁移集（§3.3）：pending→running/cancelled；running→paused/done/failed/cancelled；paused→running/cancelled；failed→running 仅人工重试复活口（task.retry，batch failed→running 先例同构）；done/cancelled 无出边。 */
const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  pending: ["running", "cancelled"],
  running: ["paused", "done", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  done: [],
  failed: ["running"],
  cancelled: [],
};

/** stage 合法迁移集（§3.3）：pending→running→done/failed；failed→running 仅人工重试重开阶段口（task.retry 引擎面，编排 LLM 无此通道）。 */
const STAGE_TRANSITIONS: Readonly<Record<StageStatus, readonly StageStatus[]>> = {
  pending: ["running"],
  running: ["done", "failed"],
  done: [],
  failed: ["running"],
};

/**
 * batch 合法迁移集（§3.3 + AF-1.3 增补）：pending→running；running→done/failed；
 * **failed→running 仅自动重派路径**（§4.5「failed 由自动重试接管」——重试复跑由引擎
 * 携带 retryCount 递增的新行值把 failed 批次带回 running；MainAgent 裁决 2026-08-29，
 * job/stage 状态机不动）。
 */
const BATCH_TRANSITIONS: Readonly<Record<BatchStatus, readonly BatchStatus[]>> = {
  pending: ["running"],
  running: ["done", "failed"],
  done: [],
  failed: ["running"],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** 非法迁移抛 DomainError（message 含 from→to）。 */
export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new DomainError(
      `非法 job 状态迁移：${from}→${to}（${from} 的合法目标：${JOB_TRANSITIONS[from].join("/") || "无（终态）"}）`,
    );
  }
}

/**
 * job 终态判定（终态三值：done/failed/cancelled）——显式集合，不从出边推导：
 * failed 虽有人工重试复活出边（task.retry），对收口/删除/清扫/活跃判定仍是终态
 * （复活前 deleteTask 可删、reapIfTerminal 清扫、hasActiveJob 不计活跃）。
 */
export function isTerminalJob(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function canTransitionStage(from: StageStatus, to: StageStatus): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

/** 非法迁移抛 DomainError（message 含 from→to）。 */
export function assertStageTransition(from: StageStatus, to: StageStatus): void {
  if (!canTransitionStage(from, to)) {
    throw new DomainError(
      `非法 stage 状态迁移：${from}→${to}（${from} 的合法目标：${STAGE_TRANSITIONS[from].join("/") || "无（终态）"}）`,
    );
  }
}

/**
 * stage 终态判定（done/failed）——显式集合同 isTerminalJob：failed 有人工重试
 * 重开出边，但对阶段收口语义仍是终态。
 */
export function isTerminalStage(status: StageStatus): boolean {
  return status === "done" || status === "failed";
}

export function canTransitionBatch(from: BatchStatus, to: BatchStatus): boolean {
  return BATCH_TRANSITIONS[from].includes(to);
}

/** 非法迁移抛 DomainError（message 含 from→to）。 */
export function assertBatchTransition(from: BatchStatus, to: BatchStatus): void {
  if (!canTransitionBatch(from, to)) {
    throw new DomainError(
      `非法 batch 状态迁移：${from}→${to}（${from} 的合法目标：${BATCH_TRANSITIONS[from].join("/") || "无（终态）"}）`,
    );
  }
}

/**
 * batch 终态判定（AF-1.3）：仅 done 为终态——failed 对 batch 非终态（可重入，
 * 自动重派路径 failed→running，§4.5）；与 stage（done/failed 皆终态）不同形。
 */
export function isTerminalBatch(status: BatchStatus): boolean {
  return BATCH_TRANSITIONS[status].length === 0;
}

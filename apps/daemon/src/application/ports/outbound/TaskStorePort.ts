/**
 * 任务三表（job/stage/batch）持久化出口端口（outbound，O-1：helix.db 新表域）。
 * 实现体 = driven sqlite-session/TaskStore.ts——写面全部经 WriteQueue 单写
 * 通道（AG-06：任务链写语句宿主在 WriteQueue；任务无会话维 → 全局链 FIFO，
 * 勿入 sessionTails 分仓），读面共用 WriteQueue 暴露的 database 连接
 * （write-through：await 的写 promise 落盘完成才 resolve）。
 *
 * 表分域（O-1 机械判据）：本端口不出现任何 work_item 方法（WorkLedgerPort
 * 侧）；stage 冻结（AD-9①/③）：只有 insertStage（createTask 定格）与
 * updateStageStatus（状态迁移 + artifact 聚合落库），无运行期增删 stage 方法。
 */

import type { BatchStatus, JobStatus, StageStatus } from "../../../domain/task/types";

/** job 行数据形状（params/projects 为 JSON 列的域侧形状；projects 空数组合法，AD-8）。 */
export interface JobData {
  readonly id: string;
  /** 任务类型 = skill 名（如 kg-bootstrap）。 */
  readonly type: string;
  /** 经 paramsSchema 校验后定格的参数对象（JSON 列）。 */
  readonly params: Record<string, unknown>;
  /** 项目标签集（JSON 数组列；0..n 类型空数组合法，AD-8）。 */
  readonly projects: readonly string[];
  readonly status: JobStatus;
  /** 创建宿主（AD-7：page | chat）。 */
  readonly createdBy: "page" | "chat";
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 失败理由（终态 failed 携带；运行中 null）。 */
  readonly error: string | null;
}

/** stage 产物（阶段摘要文字报告，阶段完成时聚合落库；与 kg 零耦合——节点反查链已拆除）。 */
export interface StageArtifact {
  readonly summary: string;
  /** 阶段产物全文（D2 additive：markdown 发现清单；summary 保持一句话。缺席 = 历史行/未携带）。 */
  readonly body?: string;
}

export interface StageData {
  readonly jobId: string;
  readonly seq: number;
  readonly name: string;
  readonly status: StageStatus;
  /** 阶段产物（未聚合 null）。 */
  readonly artifact: StageArtifact | null;
  readonly updatedAt: string;
}

export interface BatchData {
  readonly id: string;
  readonly jobId: string;
  readonly stageSeq: number;
  readonly seq: number;
  /** 批次范围描述（人类可读）。 */
  readonly scope: string;
  readonly status: BatchStatus;
  /** 自动重试计数（如实呈现，F3.3/O-3）。 */
  readonly retryCount: number;
  readonly retryNote: string | null;
  /** 当前/最近执行 SubAgent 实例 id（未派发 null）。 */
  readonly instanceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 列表过滤（任务页 P-2 读面）。 */
export interface JobListFilter {
  readonly status?: JobStatus;
}

/** deleteJobCascade 各表删除行数（F3.6 清理面查证）。 */
export interface TaskDeleteCounts {
  readonly jobs: number;
  readonly stages: number;
  readonly batches: number;
  /** 任务会话 domain_events 行（trace 会话详情级联）。 */
  readonly events: number;
  /** 任务会话 agent_lifecycle 行。 */
  readonly lifecycleRows: number;
  /** 任务会话 closure_records 行（批次收口档案）。 */
  readonly closures: number;
  /** 任务会话 steer_queue / tool_calls / pending_sync 行（防御性清零，常态 0）。 */
  readonly steerRows: number;
  readonly toolCallRows: number;
  readonly pendingSyncs: number;
}

export interface TaskStorePort {
  /** job 行插入（createTask）。 */
  insertJob(job: JobData): Promise<void>;
  /** stage 行插入（createTask 定格阶段计划，AD-9①；此后无增删——冻结）。 */
  insertStage(stage: StageData): Promise<void>;
  /**
   * job 状态迁移落库（domain 守卫先行：非法迁移抛 DomainError，与 T1.1 联用；
   * error 覆盖语义——传值落列，缺省 null 清空）。
   */
  updateJobStatus(id: string, status: JobStatus, error?: string | null): Promise<void>;
  /**
   * stage 状态迁移 + 可选 artifact 聚合落库（domain 守卫先行；
   * artifact undefined = 不动既有值）。
   */
  updateStageStatus(
    jobId: string,
    seq: number,
    status: StageStatus,
    artifact?: StageArtifact,
  ): Promise<void>;
  /**
   * batch 行插入（编排 agent 阶段内展开批次）。seq 由写通道原子赋予
   * （WriteQueue 单写线程内 SELECT count + 1）——调用方不预算（并发
   * 插入下同预算必重号）。
   */
  insertBatch(batch: Omit<BatchData, "seq">): Promise<void>;
  /**
   * batch 行整体替换（无状态守卫——重试复跑语义在引擎 T1.3：failed 批次经
   * retryCount 递增的新行值复跑，domain batch 机 failed 即终态，复跑不经
   * 状态迁移断言；见 development/architecture-feedback.md）。
   */
  updateBatch(batch: BatchData): Promise<void>;
  /** 单 job 读（无行 → undefined）。 */
  getJob(id: string): JobData | undefined;
  /** 单 batch 读（引擎回口按 batchId 寻行；无行 → undefined；T1.3 增补读面）。 */
  getBatch(id: string): BatchData | undefined;
  /** job 列表（created_at 倒序；可按状态过滤）。 */
  listJobs(filter?: JobListFilter): readonly JobData[];
  /** job 的 stage 行（seq 升序）。 */
  getStages(jobId: string): readonly StageData[];
  /** 某 stage 的 batch 行（seq 升序；stage 物理键 = (job_id, stage_seq)）。 */
  getBatches(jobId: string, stageSeq: number): readonly BatchData[];
  /**
   * 级联删除 job/stage/batch 三表该 job 全部行（F3.6 任务删除；返回各表
   * 删除计数）。work_item 清理不在本端口——引擎收集 batch.instanceId 后经
   * WorkLedgerPort.deleteByInstanceIds 清孤儿台账。
   */
  deleteJobCascade(jobId: string, sessionId: string): Promise<TaskDeleteCounts>;
}

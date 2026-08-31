/**
 * 任务引擎入口端口（inbound，architecture §4/§5.2）：
 * 编排 agent（T2.2，批次循环回口）与双宿主创建面（/project 入口 + chat
 * task_create 工具，AD-7）共用的任务生命周期 API。
 *
 * 职责面（实现 = application/services/task/TaskEngineService）：
 * - createTask 四步（类型合法性 → manifest 校验 → 阶段计划求值 → job+stage
 *   行插入冻结，§4.1）+ 编排启动；
 * - 生命周期 pause/resume/cancel/deleteTask（§4.2/F3.6）；
 * - 编排回口（批次派发/收口/重试申报、阶段推进、产物聚合、job 收口）；
 * - 启动恢复扫描（§4.4）。
 *
 * 全部 job/stage/batch 状态迁移经 TaskStorePort 单写通道落库（domain 守卫
 * 先行）；批次行插入先于 spawn 的顺序保证由调用方（T2.2）承诺，引擎侧
 * failBatch 重试调度只做 retryCount 判定与状态落库（O-3）。
 *
 * 本文件只有接口定义（AG-01）。
 */

import type { StageArtifact, TaskDeleteCounts } from "../outbound/TaskStorePort";

/** createTask 入参（双宿主同构：createdBy 区分 page/chat，AD-7）。 */
export interface CreateTaskInput {
  /** 任务类型 = skill 名（TaskSkillRegistryPort 收录才合法）。 */
  readonly type: string;
  /** 项目标签集（0..n 合法，AD-8；基数按 manifest projects 声明校验）。 */
  readonly projects: readonly string[];
  /** 任务参数（manifest paramsSchema 逐字段校验后定格）。 */
  readonly params: Record<string, unknown>;
  /** free 策略阶段的发起者确认列表（fixed 策略忽略；缺则拒绝）。 */
  readonly confirmedStages?: readonly string[];
  /** 创建宿主（AD-7：page | chat）。 */
  readonly createdBy: "page" | "chat";
}

export interface TaskEnginePort {
  /**
   * 创建任务（§4.1 四步 + 编排启动）：
   * ① 注册表查 type（无 → task.type_unknown）→ ② manifest 校验
   * （违例 → task.validation_failed，不产 job 行）→ ③ resolveStagePlan
   * （fixed 按 manifest.list；free 取 confirmedStages）→ ④ job+stage 行
   * 插入（同一 WriteQueue 链，stage 冻结）→ startOrchestrator。
   */
  createTask(input: CreateTaskInput): Promise<{ jobId: string }>;
  /**
   * 暂停（O-2：立即 running→paused 落库 + 停派新批次；链 A ⑤：落库后
   * starter.parkAll——编排 loop 挂起（wake 暂存）+ 在跑批次实例全部挂起
   * reason=taskPause，与自然收口竞态终态赢；resume 原样续跑）。
   */
  pause(jobId: string): Promise<void>;
  /**
   * 恢复（paused→running + starter.resumeAll 先复活实例/解冻 loop +
   * startOrchestrator 重开编排——与断点恢复同路径；sweepRetries 补派
   * 暂停期失败批次）。
   */
  resume(jobId: string): Promise<void>;
  /** 取消（pending/running/paused → cancelled 终态；停编排 + 批次行收口 failed 不重试）。 */
  cancel(jobId: string): Promise<void>;
  /**
   * 删除（F3.6：仅终态 done/failed/cancelled 可删，否则 task.invalid_state）；
   * 清 job/stage/batch + 各批次实例 work_item（经 batch.instanceId 收集）；
   * 不触任何 kg 写面（import 面机械可审）。
   */
  deleteTask(jobId: string): Promise<{ deletedCounts: TaskDeleteCounts }>;

  // ── 编排回口（T2.2 消费；「下一阶段/新批次」推进动作前查 job.status==running） ──

  /** 插入批次行（阶段内 seq 递增；status=pending 待派发；job 派发闸非 running 拒绝）。 */
  insertBatch(input: {
    readonly jobId: string;
    readonly stageSeq: number;
    readonly scope: string;
  }): Promise<{ batchId: string }>;
  /**
   * 派发批次（行已插入、spawn 已回 instanceId 后落章）：pending/failed →
   * running + instanceId 落列（failed→running = 自动重派路径，AF-1.3/§4.5）。
   */
  dispatchBatch(batchId: string, instanceId: string): Promise<void>;
  /** 批次收口成功（running→done；pause 下照常落库，不触发推进）。 */
  completeBatch(batchId: string): Promise<void>;
  /**
   * 批次收口失败（running→failed + retryCount+1 + retryNote）：
   * job.status==running 且 retryCount<3 → retryScheduled=true（待编排重派）；
   * retryCount+1≥3 → 上浮 stage failed + job failed（error 含批次 scope 与
   * retryCount，O-3）；job cancelled → 不重试不上浮。
   */
  failBatch(batchId: string, note: string): Promise<{ retryScheduled: boolean }>;
  /** 阶段推进（stage pending→running；推进门 job.status==running）。 */
  advanceStage(jobId: string, stageSeq: number): Promise<void>;
  /** 阶段产物聚合落库（stage running→done + artifact，§4.6；推进门同上）。 */
  writeStageArtifact(
    jobId: string,
    stageSeq: number,
    artifact: StageArtifact,
  ): Promise<void>;
  /** job 收口成功（引擎机械复核全部 stage 行 done 后 running→done）。 */
  completeJob(jobId: string): Promise<void>;
  /** job 收口失败（running→failed + error）。 */
  failJob(jobId: string, error: string): Promise<void>;

  // ── 恢复 ──

  /**
   * 启动恢复扫描（§4.4）：running/pending job 逐个处理——in-flight batch
   * （status=running）标 failed 走自动重试判定（超限上浮 stage/job failed）；
   * 已 done stage 不动；非终态 job 逐个 startOrchestrator。幂等（重复调用
   * 不重复起编排，jobId 种子集合收口）。
   */
  recoverOnStartup(): Promise<{ resumedJobIds: readonly string[] }>;
}

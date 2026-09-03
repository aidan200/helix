import { DomainError } from "../../../domain/DomainError";
import { isTerminalJob } from "../../../domain/task/job";
import { resolveStagePlan, validateTaskParams } from "../../../domain/task/manifest";
import { MAX_BATCH_RETRY, nextRetryCount, shouldRetryBatch } from "../../../domain/task/retry";
import type { StagePlan } from "../../../domain/task/types";
import type { TaskEnginePort, CreateTaskInput } from "../../ports/inbound/TaskEnginePort";
import { TaskError } from "./TaskError";
import { taskSessionIdOf } from "./TaskOrchestratorService";
import type { TaskStorePort, BatchData, JobData, StageArtifact, TaskDeleteCounts } from "../../ports/outbound/TaskStorePort";
import type { WorkLedgerPort } from "../../ports/outbound/WorkLedgerPort";
import type { TaskSkillRegistryPort } from "../../ports/outbound/TaskSkillRegistryPort";
import type { TaskOrchestratorStarterPort } from "../../ports/outbound/TaskOrchestratorStarterPort";
import type { ClockPort } from "../../ports/outbound/ClockPort";

/**
 * TaskEngineService —— 任务引擎（architecture §4，实现 TaskEnginePort）。
 *
 * 【职责】createTask 四步（类型合法性 → manifest 校验 → 阶段计划 → 行插入
 * 冻结）+ 编排启动；生命周期 pause/resume/cancel/deleteTask；编排回口
 * （批次派发/收口/重试申报、阶段推进、产物聚合、job 收口）；启动恢复扫描。
 *
 * 【写纪律】job/stage/batch 全部状态迁移经 TaskStorePort 单写通道（domain
 * 守卫先行）；本服务 import 面**无任何 kg 依赖**（F3.6 删除不触 kg 产出，
 * 机械可审——deleteTask 清任务四表 + 实例 plan 台账 + 任务会话六表
 * （trace 事件/收口档案/生命周期投影等）+ 报告目录，kg 面零调用）。
 *
 * 【事件钩子（T1.5 接线位）】每次 job/stage/batch 状态迁移后的 task.changed
 * 推送不在此实现——T1.5 在 handler/context 层以最小接线注入（EventStream
 * 回调），不改引擎状态机语义。
 *
 * 【批次重试（O-3/AF-1.3）】failBatch 只做 retryCount 判定与状态落库：
 * running 且预算内 → retryScheduled=true（重派动作归 T2.2：dispatchBatch
 * 携新实例把 failed 批次带回 running——domain failed→running 合法迁移）；
 * retryCount+1 ≥ MAX_BATCH_RETRY → 上浮 stage/job failed（error 含批次
 * scope 与 retryCount）。批次行插入先于 spawn 的顺序保证由调用方承诺。
 */

export interface TaskEngineServiceDeps {
  readonly store: TaskStorePort;
  readonly skills: TaskSkillRegistryPort;
  readonly starter: TaskOrchestratorStarterPort;
  /** 父进程面（getItems 读 + deleteByInstanceIds 清理；F3.6 唯一例外写点）。 */
  readonly workLedger: Pick<WorkLedgerPort, "deleteByInstanceIds">;
  readonly clock: ClockPort;
  /**
   * task.changed 出站钩子（AF-T1.5.2，O-7）：引擎驱动的行插入/状态迁移
   * （createTask 落行 + 编排回口八方法）成功后逐帧回调——组合根接
   * EventStream.broadcastTaskChanged 同一广播单点（不升第二通路）。
   * 生命周期三命令（pause/resume/cancel）**不经本钩子**（handler 层已接
   * 同一单点，避免双发）；deleteTask 不广播（非状态迁移，AF-T1.5.2 裁决）。
   */
  readonly onTaskChanged?: (frame: { jobId: string; changed: "job" | "stage" | "batch"; status?: string }) => void;
  /**
   * 任务报告目录清理（F3.6 级联扩展）：~<home>/reports/task:<jobId>/ 整目录
   * 删除（批次报告 md/findings 旁路/summary.md 随任务同灭）。组合根注入 fs
   * 实现（rm -rf 同构）；缺省跳过（纯引擎测试形态零 fs）。删除失败只 warn
   * 不阻断（目录缺失/权限问题不反转已完成的库级联）。
   */
  readonly removeTaskReportDir?: (jobId: string) => Promise<void> | void;
  /** 可观测 warn（报告目录删除失败上报；缺省静默）。 */
  readonly warn?: (message: string) => void;
}

export class TaskEngineService implements TaskEnginePort {
  /** 恢复扫描种子集合（幂等双防护：重复 recoverOnStartup 不重复起编排）。 */
  private readonly recoveredJobIds = new Set<string>();

  constructor(private readonly deps: TaskEngineServiceDeps) {}

  /** task.changed 帧回调（迁移成功后；钩子异常不阻断引擎主流程）。 */
  private notify(frame: { jobId: string; changed: "job" | "stage" | "batch"; status?: string }): void {
    try {
      this.deps.onTaskChanged?.(frame);
    } catch {
      // 广播面异常静默（引擎状态机是事实源，推送是增强）
    }
  }

  // ── 创建（§4.1 四步 + §5.2 编排启动） ──────────────────────

  async createTask(input: CreateTaskInput): Promise<{ jobId: string }> {
    // ① 类型合法性（无 skill → task.type_unknown，不产行）
    const manifest = this.deps.skills.getTaskType(input.type);
    if (manifest === null) {
      throw new TaskError("task.type_unknown", `任务类型 "${input.type}" 无对应任务 skill（任务类型注册表未收录）`);
    }
    // ②③ manifest 校验 + 阶段计划求值（违例 → task.validation_failed，不产行）
    let stagePlan: readonly StagePlan[];
    try {
      const projects = [...input.projects];
      validateTaskParams(manifest, input.params, projects);
      stagePlan = resolveStagePlan(manifest, input.confirmedStages ? [...input.confirmedStages] : undefined);
    } catch (error) {
      throw new TaskError("task.validation_failed", (error as DomainError).message);
    }
    // ④ job + stage 行插入（同一 WriteQueue 链 FIFO，stage 冻结）+ 编排启动
    const now = this.deps.clock.now();
    // id 口径（§3.2）：job/batch id = 带前缀的系统 join 键（不进人类界面）
    const jobId = `task-${crypto.randomUUID()}`;
    await this.deps.store.insertJob({
      id: jobId,
      type: input.type,
      params: input.params,
      projects: [...input.projects],
      status: "pending",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      error: null,
    });
    this.notify({ jobId, changed: "job", status: "pending" }); // 创建帧（双宿主同源：/project 与 chat 工具面）
    for (const stage of stagePlan) {
      await this.deps.store.insertStage({
        jobId,
        seq: stage.seq,
        name: stage.name,
        status: "pending",
        artifact: null,
        updatedAt: now,
      });
      this.notify({ jobId, changed: "stage", status: "pending" });
    }
    await this.deps.starter.startOrchestrator(jobId);
    return { jobId };
  }

  // ── 生命周期（§4.2，AD-2：零内容干预） ──────────────────────

  async pause(jobId: string): Promise<void> {
    const job = this.mustJob(jobId);
    // O-2 机械定义：立即 running→paused 落库；停派新批次（派发闸）。
    // 链 A（⑤）语义升级：落库后编排层挂起——loop wake 队列冻结（挂起期
    // 收到的批次 closure 唤醒暂存）+ 在跑批次实例全部 park（协作式，
    // reason=taskPause；与自然收口竞态 = 终态赢）。resume 全部原样续跑。
    if (job.status !== "running") {
      throw new TaskError("task.invalid_state", `任务 ${jobId} 当前状态 ${job.status}，仅 running 可暂停`);
    }
    await this.transitionJob(jobId, "paused");
    await this.deps.starter.parkAll(jobId);
  }

  async resume(jobId: string): Promise<void> {
    const job = this.mustJob(jobId);
    if (job.status !== "paused") {
      throw new TaskError("task.invalid_state", `任务 ${jobId} 当前状态 ${job.status}，仅 paused 可恢复`);
    }
    await this.transitionJob(jobId, "running");
    // H1 暂停期重试耗尽补上浮：failBatch 仅在 job=running 时上浮，暂停期收口
    // 的超限批次（retryCount>=MAX_BATCH_RETRY 且 status=failed）会滞留 failed
    // ——sweepRetries 也不再捞（TaskOrchestratorService 同口径跳过）。resume 刚把
    // job 置 running，在此补判：该阶段其他批次全终态时执行与 failBatch 超限
    // 分支相同的上浮（stage failed → job failed + haltJob 清场），不再续跑。
    for (const batch of this.allBatches(jobId)) {
      if (batch.status !== "failed" || batch.retryCount < MAX_BATCH_RETRY) continue;
      const stageBatches = this.deps.store.getBatches(jobId, batch.stageSeq);
      const othersTerminal = stageBatches.every(
        (b) => b.id === batch.id || b.status === "done" || b.status === "failed",
      );
      if (!othersTerminal) continue; // 同阶段仍有在跑批次（parked 待复活）→ 正常续跑
      await this.deps.store
        .updateStageStatus(jobId, batch.stageSeq, "failed")
        .catch((error) => this.mapDomainError(error));
      this.notify({ jobId, changed: "stage", status: "failed" });
      await this.transitionJob(
        jobId,
        "failed",
        `重试耗尽：批次「${batch.scope}」失败 ${batch.retryCount} 次（上限 ${MAX_BATCH_RETRY}）——暂停期收口，恢复时上浮${batch.retryNote !== null ? `——${batch.retryNote}` : ""}`,
      );
      this.notify({ jobId, changed: "job", status: "failed" });
      this.deps.starter.haltJob(jobId);
      return;
    }
    // 链 A（⑤）：先复活 parked 批次实例 + 解冻编排 loop（暂存唤醒回放），
    // 再 kick 编排——避免编排看到批次「仍在跑」（实例未复活）误判。
    await this.deps.starter.resumeAll(jobId);
    // 与断点恢复同路径：重开编排（§4.2/§4.4；sweepRetries 补派暂停期失败批次）
    await this.deps.starter.startOrchestrator(jobId);
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.mustJob(jobId);
    if (isTerminalJob(job.status)) {
      throw new TaskError("task.invalid_state", `任务 ${jobId} 已终态 ${job.status}，不可取消`);
    }
    // 停编排 loop + 在跑批次 SIGTERM（kill 通路收口在 starter 实现侧）
    await this.deps.starter.stopOrchestrator(jobId);
    // 批次行收口：非终态批次标 failed（retry_note=cancelled，不触发自动重试）
    const now = this.deps.clock.now();
    for (const batch of this.allBatches(jobId)) {
      if (batch.status === "done" || batch.status === "failed") continue;
      await this.deps.store.updateBatch({
        ...batch,
        status: "failed",
        retryNote: "cancelled：任务已取消（不触发自动重试）",
        updatedAt: now,
      });
    }
    await this.transitionJob(jobId, "cancelled");
  }

  /**
   * 人工重试（方案 A，failed 任务复活——token 耗尽换 key 后续跑，不浪费已耗 token）。
   * 序：① stopOrchestrator 杀在跑残留实例（终态 loop 已 reap，幂等）→ ② 残留
   * running 批次 failBatch 收口（job 尚 failed：只落库不调度不上浮）→ ③ failed
   * 批次 retryCount 归零 + 留痕（此前失败次数与原 note 入新 retryNote）→
   * ④ failed stage 重开 running（done/pending 不动）→ ⑤ job failed→running
   *（清 error）→ ⑥ startOrchestrator 重开编排（sweepRetries 补派归零批次）。
   */
  async retry(jobId: string): Promise<void> {
    const job = this.mustJob(jobId);
    if (job.status !== "failed") {
      throw new TaskError("task.invalid_state", `任务 ${jobId} 当前状态 ${job.status}，仅 failed 可人工重试`);
    }
    await this.deps.starter.stopOrchestrator(jobId);
    for (const batch of this.allBatches(jobId)) {
      if (batch.status !== "running") continue;
      await this.failBatch(batch.id, "人工重试：任务 failed 时残留的 in-flight 批次收口");
    }
    const now = this.deps.clock.now();
    for (const batch of this.allBatches(jobId)) {
      if (batch.status !== "failed" || batch.retryCount === 0) continue;
      await this.deps.store.updateBatch({
        ...batch,
        retryCount: 0,
        retryNote: `人工重试：重试预算重置（此前失败 ${batch.retryCount} 次${batch.retryNote !== null ? `——${batch.retryNote}` : ""}）`,
        updatedAt: now,
      });
    }
    for (const stage of this.deps.store.getStages(jobId)) {
      if (stage.status !== "failed") continue;
      await this.deps.store
        .updateStageStatus(jobId, stage.seq, "running")
        .catch((error) => this.mapDomainError(error));
      this.notify({ jobId, changed: "stage", status: "running" });
    }
    await this.transitionJob(jobId, "running"); // error=null 清失败理由
    this.notify({ jobId, changed: "job", status: "running" });
    // 与断点恢复同路径：重开编排（sweepRetries 补派归零的失败批次）
    await this.deps.starter.startOrchestrator(jobId);
  }

  async deleteTask(jobId: string): Promise<{ deletedCounts: TaskDeleteCounts }> {
    const job = this.mustJob(jobId);
    // F3.6：仅终态可删（done/failed/cancelled）
    if (!isTerminalJob(job.status)) {
      throw new TaskError(
        "task.invalid_state",
        `任务 ${jobId} 当前状态 ${job.status}，仅终态（done/failed/cancelled）可删除——请先取消`,
      );
    }
    // 实例 plan 台账清理（经 batch.instanceId 收集；空集 no-op）
    const instanceIds = this.allBatches(jobId)
      .map((b) => b.instanceId)
      .filter((id): id is string => id !== null);
    await this.deps.workLedger.deleteByInstanceIds(instanceIds);
    // job/stage/batch 级联清 + 任务会话六表（trace 事件/收口档案等同灭——
    // 不触任何 kg 产出：删任务≠删知识，AD-10）
    const deletedCounts = await this.deps.store.deleteJobCascade(jobId, taskSessionIdOf(jobId));
    // 报告目录级联（库删除成功后；失败只 warn 不反转）
    if (this.deps.removeTaskReportDir !== undefined) {
      try {
        await this.deps.removeTaskReportDir(jobId);
      } catch (err) {
        this.deps.warn?.(`任务 ${jobId} 报告目录删除失败（库级联已完成）：${(err as Error).message}`);
      }
    }
    return { deletedCounts };
  }

  // ── 编排回口（T2.2 消费；推进动作前查 job.status==running） ──

  async insertBatch(input: { jobId: string; stageSeq: number; scope: string }): Promise<{ batchId: string }> {
    const job = this.mustJob(input.jobId);
    // 派发闸（引擎面）：paused/终态不产新批次行（T2.2 编排循环派发前同语义重读）
    if (job.status !== "running" && job.status !== "pending") {
      throw new TaskError(
        "task.invalid_state",
        `任务 ${input.jobId} 当前状态 ${job.status}，不派发新批次（pause=停派新批次，O-2）`,
      );
    }
    const stage = this.deps.store.getStages(input.jobId).find((s) => s.seq === input.stageSeq);
    if (stage === undefined) {
      throw new TaskError("task.invalid_state", `stage 不存在：${input.jobId}#${input.stageSeq}（阶段行已冻结，AD-9③）`);
    }
    // pending → running：编排接管时刻（§3.3「pending→running: 编排 agent 接管」=
    // 第一个批次行落库；此后派发闸只认 running）
    if (job.status === "pending") {
      await this.transitionJob(input.jobId, "running");
      this.notify({ jobId: input.jobId, changed: "job", status: "running" });
    }
    // T4.2（AF-T4.1.5 裂口修复）：stage pending→running 机械推进——该 stage
    // 首个批次落行即推进（与 job 接管同构），不再依赖编排 LLM 调 advanceStage
    // （真机实测批次 done 而 stage 滞留 pending 的倒挂）；advanceStage 保留
    // 幂等兼容（已是 running 时 no-op），编排冗余调用不炸。
    if (stage.status === "pending") {
      await this.deps.store
        .updateStageStatus(input.jobId, input.stageSeq, "running")
        .catch((error) => this.mapDomainError(error));
      this.notify({ jobId: input.jobId, changed: "stage", status: "running" });
    }
    const now = this.deps.clock.now();
    const batchId = `batch-${crypto.randomUUID()}`;
    // seq 不预算：并发 insertBatch 下同阶段全读到 count=0 → seq 全 1（helix.db
    // 实证）；seq 由 WriteQueue 单写线程内 SELECT count + 1 原子赋予（AG-06
    // 唯一写通道串行化保证）。
    await this.deps.store.insertBatch({
      id: batchId,
      jobId: input.jobId,
      stageSeq: input.stageSeq,
      scope: input.scope,
      status: "pending",
      retryCount: 0,
      retryNote: null,
      instanceId: null,
      createdAt: now,
      updatedAt: now,
    });
    this.notify({ jobId: input.jobId, changed: "batch", status: "pending" });
    return { batchId };
  }

  async dispatchBatch(batchId: string, instanceId: string): Promise<void> {
    const batch = this.mustBatch(batchId);
    const job = this.mustJob(batch.jobId);
    if (job.status !== "running") {
      throw new TaskError("task.invalid_state", `任务 ${batch.jobId} 当前状态 ${job.status}，不派发批次`);
    }
    // pending→running 首派 / failed→running 自动重派（AF-1.3/§4.5）；domain 守卫
    // 经整行替换前判定（updateBatch 无守卫，此处显式断言迁移合法性）
    assertBatchRunnable(batch);
    await this.deps.store.updateBatch({
      ...batch,
      status: "running",
      instanceId,
      updatedAt: this.deps.clock.now(),
    });
    this.notify({ jobId: batch.jobId, changed: "batch", status: "running" });
  }

  async completeBatch(batchId: string): Promise<void> {
    const batch = this.mustBatch(batchId);
    // 照常落库（O-2：pause 下在跑批次自然收口，不触发任何推进动作）
    if (batch.status !== "running") {
      throw new TaskError("task.invalid_state", `批次 ${batchId} 当前状态 ${batch.status}，仅 running 可收口 done`);
    }
    await this.deps.store.updateBatch({ ...batch, status: "done", updatedAt: this.deps.clock.now() });
    this.notify({ jobId: batch.jobId, changed: "batch", status: "done" });
  }

  async failBatch(batchId: string, note: string): Promise<{ retryScheduled: boolean }> {
    const batch = this.mustBatch(batchId);
    const job = this.mustJob(batch.jobId);
    // 已收口批次（cancel 已标 failed）+ job 终态：迟到失败幂等收口，不重试不上浮
    if (job.status === "cancelled" || isTerminalJob(job.status)) {
      if (batch.status === "failed") return { retryScheduled: false };
      if (batch.status === "done") {
        throw new TaskError("task.invalid_state", `批次 ${batchId} 已 done，不可改判 failed`);
      }
    }
    if (batch.status !== "running") {
      throw new TaskError("task.invalid_state", `批次 ${batchId} 当前状态 ${batch.status}，仅 running 可收口 failed`);
    }
    const retryCount = nextRetryCount(batch.retryCount);
    await this.deps.store.updateBatch({
      ...batch,
      status: "failed",
      retryCount,
      retryNote: note,
      updatedAt: this.deps.clock.now(),
    });
    this.notify({ jobId: batch.jobId, changed: "batch", status: "failed" });
    // O-3 重试调度：只做判定与落库（重派动作归 T2.2；cancelled 不重试）。
    // 判定用递增后计数：retryCount ≥ 上限 → 不再排期，转入超限上浮。
    const retryScheduled = job.status === "running" && shouldRetryBatch(retryCount);
    if (!retryScheduled && job.status === "running" && retryCount >= MAX_BATCH_RETRY) {
      // 超限上浮：batch failed → stage failed → job failed（error 含 scope 与 retryCount）
      await this.deps.store
        .updateStageStatus(batch.jobId, batch.stageSeq, "failed")
        .catch((error) => this.mapDomainError(error));
      this.notify({ jobId: batch.jobId, changed: "stage", status: "failed" });
      await this.transitionJob(
        batch.jobId,
        "failed",
        `重试耗尽：批次「${batch.scope}」失败 ${retryCount} 次（上限 ${MAX_BATCH_RETRY}）——${note}`,
      );
      this.notify({ jobId: batch.jobId, changed: "job", status: "failed" });
      // B2 fail-stop：停编排驱动 + 摘队排队实例（在跑自然收口落库）——历史
      // 事故：上浮后无停摆，编排 LLM 回合内继续 spawn + 队列实例逐个放行
      this.deps.starter.haltJob(batch.jobId);
    }
    return { retryScheduled };
  }

  async advanceStage(jobId: string, stageSeq: number): Promise<void> {
    this.assertDispatchable(jobId);
    const stage = this.deps.store.getStages(jobId).find((s) => s.seq === stageSeq);
    if (stage === undefined) {
      throw new TaskError("task.invalid_state", `stage 不存在：${jobId}#${stageSeq}（阶段行已冻结，AD-9③）`);
    }
    // T4.2 幂等兼容：insertBatch 已机械推进 running 后，编排 LLM 的冗余
    // 调用为 no-op 成功（不删工具，双通道收口同一状态）
    if (stage.status === "running") return;
    await this.deps.store.updateStageStatus(jobId, stageSeq, "running").catch((error) => this.mapDomainError(error));
    this.notify({ jobId, changed: "stage", status: "running" });
  }

  async writeStageArtifact(jobId: string, stageSeq: number, artifact: StageArtifact): Promise<void> {
    this.assertDispatchable(jobId);
    // 阶段产物聚合 + stage 收口 done（§4.6：artifact 随 done 一次落库）
    await this.deps.store
      .updateStageStatus(jobId, stageSeq, "done", artifact)
      .catch((error) => this.mapDomainError(error));
    this.notify({ jobId, changed: "stage", status: "done" });
  }

  async completeJob(jobId: string): Promise<void> {
    const job = this.mustJob(jobId);
    if (job.status !== "running") {
      throw new TaskError("task.invalid_state", `任务 ${jobId} 当前状态 ${job.status}，仅 running 可收口 done`);
    }
    // 机械复核（T2.2 完成判定）：全部 stage 行 done 才收口
    const stages = this.deps.store.getStages(jobId);
    if (stages.length === 0 || stages.some((s) => s.status !== "done")) {
      const undone = stages.filter((s) => s.status !== "done").map((s) => `#${s.seq}（${s.status}）`);
      throw new TaskError(
        "task.invalid_state",
        `任务 ${jobId} 存在未完成阶段：${undone.join("、")}——全部阶段 done 才可收口`,
      );
    }
    await this.transitionJob(jobId, "done");
    this.notify({ jobId, changed: "job", status: "done" });
  }

  async failJob(jobId: string, error: string): Promise<void> {
    const job = this.mustJob(jobId);
    if (job.status !== "running") {
      throw new TaskError("task.invalid_state", `任务 ${jobId} 当前状态 ${job.status}，仅 running 可收口 failed`);
    }
    await this.transitionJob(jobId, "failed", error);
    this.notify({ jobId, changed: "job", status: "failed" });
  }

  // ── 启动恢复扫描（§4.4，F2.3） ────────────────────────────

  async recoverOnStartup(): Promise<{ resumedJobIds: readonly string[] }> {
    const resumed: string[] = [];
    // running 一并扫（pending 视为待接管；paused 不自动续）
    for (const status of ["running", "pending"] as const) {
      for (const job of this.deps.store.listJobs({ status })) {
        if (this.recoveredJobIds.has(job.id)) continue;
        await this.recoverJob(job);
        if (this.recoveredJobIds.has(job.id)) resumed.push(job.id);
      }
    }
    return { resumedJobIds: resumed };
  }

  /** 单 job 恢复：in-flight 批次 failed 收口（走自动重试判定/超限上浮）→ 重开编排。 */
  private async recoverJob(job: JobData): Promise<void> {
    for (const batch of this.allBatches(job.id)) {
      if (batch.status !== "running") continue; // 已 done stage 的批次不动
      await this.failBatch(batch.id, "daemon 重启：in-flight 批次收口走自动重试");
      const after = this.deps.store.getJob(job.id);
      if (after !== undefined && isTerminalJob(after.status)) break; // 超限上浮已终态化
    }
    const now = this.deps.store.getJob(job.id);
    if (now === undefined || isTerminalJob(now.status)) return;
    await this.deps.starter.startOrchestrator(job.id);
    this.recoveredJobIds.add(job.id); // 种子集合收口（幂等双防护）
  }

  // ── 内部工具 ──────────────────────────────────────────────

  private mustJob(jobId: string): JobData {
    const job = this.deps.store.getJob(jobId);
    if (job === undefined) {
      throw new TaskError("task.not_found", `任务 ${jobId} 不存在`);
    }
    return job;
  }

  private mustBatch(batchId: string): BatchData {
    const batch = this.deps.store.getBatch(batchId);
    if (batch === undefined) {
      throw new TaskError("task.not_found", `批次 ${batchId} 不存在`);
    }
    return batch;
  }

  /** job 的全部批次行（跨 stage 收集：cancel 收口/删除清理面）。 */
  private allBatches(jobId: string): readonly BatchData[] {
    return this.deps.store.getStages(jobId).flatMap((stage) => this.deps.store.getBatches(jobId, stage.seq));
  }

  /** 推进门（「下一阶段/新批次」推进动作前查 job.status==running，O-2）。 */
  private assertDispatchable(jobId: string): void {
    const job = this.mustJob(jobId);
    if (job.status !== "running") {
      throw new TaskError(
        "task.invalid_state",
        `任务 ${jobId} 当前状态 ${job.status}（暂停/终态不执行推进动作，O-2）`,
      );
    }
  }

  /** job 状态迁移（domain 守卫先行；DomainError → task.invalid_state 收口）。 */
  private async transitionJob(jobId: string, status: JobData["status"], error: string | null = null): Promise<void> {
    await this.deps.store.updateJobStatus(jobId, status, error).catch((e) => {
      throw this.mapDomainError(e);
    });
  }

  private mapDomainError(error: unknown): TaskError {
    if (error instanceof DomainError) {
      return new TaskError("task.invalid_state", error.message);
    }
    throw error;
  }
}

/** 批次可派发态判定：pending（首派）或 failed（自动重派，AF-1.3/§4.5）。 */
function assertBatchRunnable(batch: BatchData): void {
  if (batch.status !== "pending" && batch.status !== "failed") {
    throw new TaskError(
      "task.invalid_state",
      `批次 ${batch.id} 当前状态 ${batch.status}，仅 pending/failed 可派发（failed→running 为自动重派路径）`,
    );
  }
}

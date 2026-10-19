import { DomainError } from "../../../domain/DomainError";
import { isTerminalJob, isTerminalStage, assertBatchTransition } from "../../../domain/task/job";
import { resolveStagePlan, stageKindOfManifest, validateTaskParams } from "../../../domain/task/manifest";
import { MAX_BATCH_RETRY, nextRetryCount, shouldRetryBatch } from "../../../domain/task/retry";
import type { StageKind, StagePlan } from "../../../domain/task/types";
import type { TaskEnginePort, CreateTaskInput, DispatchBatchOutcome } from "../../ports/inbound/TaskEnginePort";
import { TaskError } from "./TaskError";
import { taskSessionIdOf } from "./TaskOrchestratorService";
import type { TaskStorePort, BatchData, JobData, StageData, StageArtifact, TaskDeleteCounts } from "../../ports/outbound/TaskStorePort";
import type { WorkLedgerPort } from "../../ports/outbound/WorkLedgerPort";
import type { TaskSkillRegistryPort } from "../../ports/outbound/TaskSkillRegistryPort";
import type { TaskOrchestratorStarterPort } from "../../ports/outbound/TaskOrchestratorStarterPort";
import type { ClockPort } from "../../ports/outbound/ClockPort";
import type { AgentProjectionStore } from "../../ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../../ports/outbound/EventPublisherPort";
import type { AgentFailedPayload } from "../../../domain/events/DomainEvent";

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
  /**
   * 装配完成唤醒钩子（A 批第四 wake 点）：assemblyDone 机械校验通过后回调
   * （组合根接编排服务驱动派发轮）；缺省不唤醒（隔离测试形态）。并回行状态
   * 零迁移——阶段已随首批次机械推 running，本钩子只驱动轮次边界。
   */
  readonly onAssemblyDone?: (jobId: string, stageSeq: number, batchCount: number) => void;
  /**
   * 实例调度态读面（迟到接线守卫，task-efd68911 事故收敛）：agentId →
   * queued/running/parked/终态（done/failed/killed/cancelled）或 undefined
   * （查无）。组合根接 scheduler.status 映射；缺省不守卫（纯引擎测试形态——
   * 现有测试以假实例 id 直落章，零破坏过渡）。
   */
  readonly instanceStateOf?: (agentId: string) => string | undefined;
  /**
   * 实例生命周期投影族（恢复链幽灵收口；组合根接 persistence.repository，
   * 缺省不装配——纯引擎测试形态零依赖）。
   */
  readonly agentProjections?: Pick<AgentProjectionStore, "queryOrphanInstanceLifecycles" | "saveAgentLifecycle">;
  /** 领域事件出口（幽灵收口补发 agent.failed；缺省不发——纯引擎测试形态）。 */
  readonly events?: Pick<EventPublisherPort, "publish">;
  /**
   * 本代 daemon 启动时刻（ms；幽灵判据：行 updated_at 早于此 = 上代遗留）。
   * 缺省不收口（与 agentProjections 二选一缺省即零行为，双注入才启用）。
   */
  readonly bootedAtMs?: number;
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
    try {
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
    } catch (err) {
      // stage 插入中途失败回补（评审 F1）：job 行已落而阶段计划残缺——既不满足
      // TR-72「创建时一次定格」，也不是终态（只能靠重启恢复扫描捞，残缺行会
      // 错判阶段完成度）。与下方 starter 失败同口径就地收口为 cancelled 后再上抛。
      await this.abortPendingTask(jobId, `阶段计划写入失败：${(err as Error).message}`);
      throw err;
    }
    try {
      await this.deps.starter.startOrchestrator(jobId);
    } catch (err) {
      // starter 失败回补（清单 #2.5）：job/stage 行已产而编排未起——不回补会
      // 滞留 pending 仅重启恢复扫描可捞。就地按 cancel 语义收口，再上抛原错给发起方。
      await this.abortPendingTask(jobId, `编排启动失败：${(err as Error).message}`);
      throw err;
    }
    return { jobId };
  }

  /** 创建期失败回补（stage 插入中途失败 / 编排启动失败共用）：非终态 stage 标
   *  failed（无批次可收，cancel 显性出边先例）+ job pending→cancelled（合法迁移）
   *  ——残留行是「终态可见」而非滞留在飞面。回补本身失败静默：不掩盖原错
   *  （原错由调用方上抛），与既有 starter 回补同姿态。 */
  private async abortPendingTask(jobId: string, reason: string): Promise<void> {
    for (const stage of this.deps.store.getStages(jobId)) {
      if (isTerminalStage(stage.status)) continue;
      await this.deps.store.updateStageStatus(jobId, stage.seq, "failed").catch(() => undefined);
    }
    await this.deps.store.updateJobStatus(jobId, "cancelled", reason).catch(() => undefined);
    this.notify({ jobId, changed: "job", status: "cancelled" });
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
      // （兄弟批次此后全部终态时的延迟上浮由 completeBatch 补判收口，F3）
      await this.escalateRetryExhausted(
        batch,
        `暂停期收口，恢复时上浮${batch.retryNote !== null ? `——${batch.retryNote}` : ""}`,
      );
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
    // 批次行收口：非终态批次标 failed（retry_note=cancelled，不触发自动重试）——
    // pending→failed 是 cancel 语义显性出边（domain BATCH_TRANSITIONS 已补，
    // M6 #2.5：原经无守卫 updateBatch 知情绕过；迁移前显式断言与 store 守卫同口径）
    const now = this.deps.clock.now();
    for (const batch of this.allBatches(jobId)) {
      if (batch.status === "done" || batch.status === "failed") continue;
      assertBatchTransition(batch.status, "failed");
      await this.deps.store.updateBatch({
        ...batch,
        status: "failed",
        retryNote: "cancelled：任务已取消（不触发自动重试）",
        updatedAt: now,
      });
    }
    // stage 行收口（M6 #2.5）：非终态 stage 一并标 failed——否则 cancelled
    // 任务下 running/pending stage 永久滞留（引擎推进门全部被批次终态拦截，
    // stage 状态机再无可走出边），任务页阶段条与库内事实背离。done stage
    // 保留（已完成工作不丢）。pending→failed 同为 cancel 语义显性出边。
    // （cancel 属生命周期三命令——不经 onTaskChanged 钩子，handler 层统一广播）
    for (const stage of this.deps.store.getStages(jobId)) {
      if (isTerminalStage(stage.status)) continue;
      await this.deps.store
        .updateStageStatus(jobId, stage.seq, "failed")
        .catch((e) => { throw this.mapDomainError(e); })
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
        .catch((e) => { throw this.mapDomainError(e); })
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
    // 阶段顺序守卫（B 批）：前序阶段全部 done 才可插批——阶段序由 skill 冻结，
    // 机械防跳段（此前 LLM 可先插 stage3 批次而 stage1 仍 pending，序正确性全押 SOP 纪律）
    this.assertPriorStagesDone(input.jobId, input.stageSeq);
    // 阶段角色门（A 批）：批次只能进 execute 阶段——plan/aggregate 是编排直执
    // 角色，不接收批次（机械禁止探针批次混入盘点/汇总阶段，7466ce9e 实证）
    const insertKind = this.stageKindOf(job.type, input.stageSeq);
    if (insertKind !== "execute") {
      throw new TaskError(
        "task.invalid_state",
        `阶段角色违例：#${input.stageSeq} 是 ${insertKind} 角色（编排直执，不接收批次）——批次只能插入 execute 阶段（机械门）`,
      );
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
      // T4.2 幂等兼容的显性化（review B4 吞错修复）：同轮并发 insertBatch 下
      // 后到者读到滞后 pending 前态、落库时 stage 已被先到者推 running——
      // running→running 守卫拒绝是同目标幂等 no-op（此前靠吞错侥幸幂等）；
      // 其余守卫拒绝（done→running / failed→running 等）照常上抛。
      try {
        await this.deps.store.updateStageStatus(input.jobId, input.stageSeq, "running");
      } catch (e) {
        const current = this.deps.store.getStages(input.jobId).find((s) => s.seq === input.stageSeq);
        if (!(e instanceof DomainError && current?.status === "running")) {
          throw this.mapDomainError(e);
        }
      }
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

  async dispatchBatch(batchId: string, instanceId: string): Promise<DispatchBatchOutcome> {
    const batch = this.mustBatch(batchId);
    // 幂等接线（派发原子化）：同实例重复落章为 no-op——spawn 自动接线后
    // LLM 可能仍按旧三步补调 task_dispatch_batch，不误伤；换实例仍受下方
    // assertBatchRunnable 状态机守卫拒绝（不可把 running 批次重接到另一实例）
    if (batch.status === "running" && batch.instanceId === instanceId) {
      return { status: "dispatched" };
    }
    const job = this.mustJob(batch.jobId);
    if (job.status !== "running") {
      throw new TaskError("task.invalid_state", `任务 ${batch.jobId} 当前状态 ${job.status}，不派发批次`);
    }
    // 迟到接线守卫（task-efd68911）：spawn 与 dispatch 是两个独立事件，网络故障
    // 可在窗口内打死实例——收口先到被判游离丢弃后，迟到 dispatch 若照常落章
    // 会把 running 批次接到终态实例上（永无人再收口 → 批次/job 永久滞留）。
    // 装配 instanceStateOf 时机械拦截：终态 → 转失败收口；查无 → 拒绝。
    const stateOf = this.deps.instanceStateOf;
    if (stateOf !== undefined) {
      const state = stateOf(instanceId);
      if (state === undefined) {
        throw new TaskError(
          "task.invalid_state",
          `实例 ${instanceId} 查无调度态（不存在或已清理）——不可接线；请核实实例 id，或对新批次重新 spawn 派发`,
        );
      }
      if (state !== "queued" && state !== "running" && state !== "parked") {
        // 终态转化只对**可派发态**（pending/failed）——评审 F1：转化路径原无态
        // 限定，会把已 done 批次回退 running→failed（把「已完成」倒灌成失败），
        // 或把别的实例正在跑的 running 批次 instanceId 置 null 后 failBatch
        //（真实在飞实例的收口随后被判游离丢弃）。非可派发态一律经
        // assertBatchRunnable 状机守卫拒绝（invalid_state，行状态零迁移）。
        assertBatchRunnable(batch);
        // 桥接 running（failBatch 断言要求 + 状态机 pending→failed 仅 cancel 出边）：
        // 同一调用内落定 failed，观察者只见终值；instanceId 保持 null（不接线死实例）
        await this.deps.store.updateBatch({
          ...batch,
          status: "running",
          instanceId: null,
          updatedAt: this.deps.clock.now(),
        });
        const note = `迟到接线转化：实例 ${instanceId} 已终态（${state}）——接线前实例已收口，批次转失败收口`;
        const { retryScheduled } = await this.failBatch(batchId, note);
        if (retryScheduled) {
          // 重派归编排（spawn 通路在编排器）：starter 幂等唤醒——existing loop
          // → sweepRetries 补派本批次；无 loop（恢复期）→ kickoff 全现场重建
          await this.deps.starter.startOrchestrator(batch.jobId);
        }
        return { status: "converted-failed", retryScheduled };
      }
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
    return { status: "dispatched" };
  }

  async completeBatch(batchId: string): Promise<void> {
    const batch = this.mustBatch(batchId);
    // 照常落库（O-2：pause 下在跑批次自然收口，不触发任何推进动作）
    if (batch.status !== "running") {
      throw new TaskError("task.invalid_state", `批次 ${batchId} 当前状态 ${batch.status}，仅 running 可收口 done`);
    }
    await this.deps.store.updateBatch({ ...batch, status: "done", updatedAt: this.deps.clock.now() });
    this.notify({ jobId: batch.jobId, changed: "batch", status: "done" });
    // H1 延迟判定补面（F3 修复）：暂停期耗尽的 failed 批次在 resume 时因兄弟
    // 批次仍在跑被 othersTerminal 守卫跳过（正确——不杀在跑工作）；但兄弟此后
    // 陆续收口 done 时若无人补判，耗尽批次滞留 failed——stage 永远收不了口
    //（done 闸要求全批次 done），job 永久卡 running。故在批次收口 done 后补检：
    // 同阶段存在耗尽 failed 批次且其余批次全终态（done/failed）→ 同 failBatch
    // 超限分支上浮清场。迟到成功保留不破：done 行已先落库。paused 下不判
    //（O-2 不推进），resume 路径的既有补判会收同类场景。
    const job = this.mustJob(batch.jobId);
    if (job.status !== "running") return;
    const stageBatches = this.deps.store.getBatches(batch.jobId, batch.stageSeq);
    const exhausted = stageBatches.find((b) => b.status === "failed" && b.retryCount >= MAX_BATCH_RETRY);
    if (exhausted === undefined) return;
    const othersTerminal = stageBatches.every(
      (b) => b.id === exhausted.id || b.status === "done" || b.status === "failed",
    );
    if (!othersTerminal) return; // 仍有在跑/待派兄弟批次 → 正常续跑，耗尽批次等下次补判
    await this.escalateRetryExhausted(
      exhausted,
      `同阶段其余批次已全部终态，耗尽批次延迟上浮${exhausted.retryNote !== null ? `——${exhausted.retryNote}` : ""}`,
    );
  }

  async failBatch(batchId: string, note: string): Promise<{ retryScheduled: boolean }> {
    const batch = this.mustBatch(batchId);
    const job = this.mustJob(batch.jobId);
    // 已收口批次（cancel 已标 failed）+ job 终态：迟到失败幂等收口，不重试不上浮
    //（isTerminalJob 已含 cancelled——domain/task/job.ts 终态三值显式集）
    if (isTerminalJob(job.status)) {
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
      await this.escalateRetryExhausted({ ...batch, retryCount }, note);
    }
    return { retryScheduled };
  }

  /**
   * 重试耗尽超限上浮单点（batch failed → stage failed → job failed → haltJob
   * 清场）：failBatch 超限分支 / resume 暂停期耗尽补上浮（H1）/ completeBatch
   * 延迟判定（F3）三触发面共用。error 含批次 scope 与 retryCount；haltJob 与
   * 上浮同一同步链（B2 fail-stop：停编排驱动 + 摘队排队实例，在跑自然收口）。
   */
  private async escalateRetryExhausted(batch: BatchData, detail: string): Promise<void> {
    await this.deps.store
      .updateStageStatus(batch.jobId, batch.stageSeq, "failed")
      .catch((e) => { throw this.mapDomainError(e); })
    this.notify({ jobId: batch.jobId, changed: "stage", status: "failed" });
    await this.transitionJob(
      batch.jobId,
      "failed",
      `重试耗尽：批次「${batch.scope}」失败 ${batch.retryCount} 次（上限 ${MAX_BATCH_RETRY}）——${detail}`,
    );
    this.notify({ jobId: batch.jobId, changed: "job", status: "failed" });
    // B2 fail-stop：停编排驱动 + 摘队排队实例（在跑自然收口落库）——历史
    // 事故：上浮后无停摆，编排 LLM 回合内继续 spawn + 队列实例逐个放行
    this.deps.starter.haltJob(batch.jobId);
  }

  async advanceStage(jobId: string, stageSeq: number): Promise<void> {
    // B 批激活对称：pending 是编排接管前态——推进动作即接管（与 insertBatch 首批次
    // 激活同构；2026-09-06 8213de82 实证：advance 首调被拒→编排脑补「人审门」停摆）
    await this.ensureActiveForAdvance(jobId);
    const stages = this.deps.store.getStages(jobId);
    const stage = stages.find((s) => s.seq === stageSeq);
    if (stage === undefined) {
      throw new TaskError("task.invalid_state", `stage 不存在：${jobId}#${stageSeq}（阶段行已冻结，AD-9③）`);
    }
    this.assertPriorStagesDone(jobId, stageSeq, stages);
    // T4.2 幂等兼容：insertBatch 已机械推进 running 后，编排 LLM 的冗余
    // 调用为 no-op 成功（不删工具，双通道收口同一状态）；done 同理幂等不炸
    if (stage.status === "running" || stage.status === "done") return;
    await this.deps.store.updateStageStatus(jobId, stageSeq, "running").catch((e) => { throw this.mapDomainError(e); })
    this.notify({ jobId, changed: "stage", status: "running" });
  }

  async writeStageArtifact(jobId: string, stageSeq: number, artifact: StageArtifact): Promise<void> {
    // B 批激活对称：直执阶段（无批次）首个动作常是产物聚合——同样接管激活
    const job = await this.ensureActiveForAdvance(jobId);
    const stages = this.deps.store.getStages(jobId);
    const stage = stages.find((s) => s.seq === stageSeq);
    if (stage === undefined) {
      throw new TaskError("task.invalid_state", `stage 不存在：${jobId}#${stageSeq}（阶段行已冻结，AD-9③）`);
    }
    this.assertPriorStagesDone(jobId, stageSeq, stages);
    // 阶段角色门（A 批）：execute 阶段产物聚合须本阶段批次全收口 done——
    // plan/aggregate 是编排直执角色，产物即判据无批次要求
    const kind = this.stageKindOf(job.type, stageSeq);
    if (kind === "execute") {
      const batches = this.deps.store.getBatches(jobId, stageSeq);
      if (batches.length === 0) {
        throw new TaskError(
          "task.invalid_state",
          `阶段产物违例：#${stageSeq} 是 execute 角色但本阶段零批次——先装配（insertBatch）并收口全部批次再聚合（机械门）`,
        );
      }
      const open = batches.filter((b) => b.status !== "done");
      if (open.length > 0) {
        throw new TaskError(
          "task.invalid_state",
          `阶段产物违例：#${stageSeq} 是 execute 角色，尚有 ${open.length} 个批次未收口 done（${open.map((b) => `#${b.seq}(${b.status})`).join("、")}）——全部收口后再聚合（机械门）`,
        );
      }
    }
    // 直执阶段免两步（B 批）：pending 阶段引擎自动走 running 再落 done——domain
    // 迁移集不动（pending→done 仍非法），LLM 无需「先 advance 再 artifact」两步走
    if (stage.status === "pending") {
      await this.deps.store.updateStageStatus(jobId, stageSeq, "running").catch((e) => { throw this.mapDomainError(e); })
      this.notify({ jobId, changed: "stage", status: "running" });
    }
    // 阶段产物聚合 + stage 收口 done（§4.6：artifact 随 done 一次落库）
    await this.deps.store
      .updateStageStatus(jobId, stageSeq, "done", artifact)
      .catch((e) => { throw this.mapDomainError(e); })
    this.notify({ jobId, changed: "stage", status: "done" });
  }

  /**
   * 装配完成申报（A 批第四 wake 点）：LLM 声明 + 机械结构校验——execute 角色 +
   * 前序阶段全 done + 本阶段 ≥1 批次行。通过即触发 onAssemblyDone 钩子（组合根
   * 接编排服务驱动派发轮）；不迁移任何行状态（阶段已随首批次机械推 running）。
   * 红线：这是机械驱动的轮次边界，不是人审门（AD-5 无中途审阅态）。
   */
  async assemblyDone(jobId: string, stageSeq: number): Promise<{ batchCount: number }> {
    const job = await this.ensureActiveForAdvance(jobId);
    const stages = this.deps.store.getStages(jobId);
    const stage = stages.find((s) => s.seq === stageSeq);
    if (stage === undefined) {
      throw new TaskError("task.invalid_state", `stage 不存在：${jobId}#${stageSeq}（阶段行已冻结，AD-9③）`);
    }
    this.assertPriorStagesDone(jobId, stageSeq, stages);
    const kind = this.stageKindOf(job.type, stageSeq);
    if (kind !== "execute") {
      throw new TaskError(
        "task.invalid_state",
        `装配完成申报仅适用 execute 阶段：#${stageSeq} 是 ${kind} 角色（无装配物，直接聚合产物即可）`,
      );
    }
    const batches = this.deps.store.getBatches(jobId, stageSeq);
    if (batches.length === 0) {
      throw new TaskError(
        "task.invalid_state",
        `装配完成申报须至少一个批次行（零批次=未装配）——先 insertBatch 再申报`,
      );
    }
    try {
      this.deps.onAssemblyDone?.(jobId, stageSeq, batches.length);
    } catch {
      // 唤醒面异常静默（申报本身成功；行状态是事实源，派发轮可由收口通知补偿驱动）
    }
    return { batchCount: batches.length };
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
    // 装配期死局桥接（pending→running→failed 两段落定）：推进检查覆盖装配期
    // 后，kickoff 持续无法驱动的 pending 任务（零批次 = 零 closure 事件 = 零
    // 唤醒源）由本口收口 failed——不再滞留 pending（前端「装配中」永久卡）。
    // domain pending 出边仅 running/cancelled，与 dispatchBatch 迟到接线守卫
    // 同构桥接：同一同步链两段落定，观察者只见终值（非 pending→failed 第二出边）。
    if (job.status === "pending") {
      await this.transitionJob(jobId, "running");
    } else if (job.status !== "running") {
      throw new TaskError("task.invalid_state", `任务 ${jobId} 当前状态 ${job.status}，仅 pending/running 可收口 failed`);
    }
    await this.transitionJob(jobId, "failed", error);
    this.notify({ jobId, changed: "job", status: "failed" });
  }

  // ── 启动恢复扫描（§4.4，F2.3） ────────────────────────────

  async recoverOnStartup(): Promise<{ resumedJobIds: readonly string[] }> {
    await this.settleOrphanInstances(); // 幽灵实例收口先于任何重派 spawn（task-efd68911 事故）
    const resumed: string[] = [];
    // running 一并扫（pending 视为待接管；paused 不自动续）
    for (const status of ["running", "pending"] as const) {
      for (const job of this.deps.store.listJobs({ status })) {
        if (this.recoveredJobIds.has(job.id)) continue;
        // 行级隔离（code-review H2）：单个毒 job 的恢复异常不得中断全量扫描
        // ——否则后续 running/pending 无人接管且重启确定性复现卡死（同文件
        // settleOrphanInstances 行级隔离同构）；warn 续扫，毒 job 留待人工/
        // 下轮重启重试
        try {
          await this.recoverJob(job);
        } catch (err) {
          this.deps.warn?.(`task 恢复失败（job=${job.id}）：${(err as Error).message}`);
          continue;
        }
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

  /**
   * 幽灵实例收口（task-efd68911 事故）：daemon 非优雅退出后，任务 SubAgent
   * 的 agent_lifecycle 投影行停留非终态——批次层已被 recoverJob 对账重派，
   * 实例行无人收口，trace/观测面永远显示活跃。本代内存不可能持有上代实例
   * （行 updated_at < bootedAt 即证），按 TR-35 分态收口：running/parked →
   * failed + 补发 agent.failed（daemon_restarted，新收口事实非重放）；
   * queued → cancelled（无 closure 记录不发事件，与重启清队语义一致）。
   * 幂等：行终态后不再命中。行级隔离：单行失败不断恢复主流程。
   */
  private async settleOrphanInstances(): Promise<void> {
    const { agentProjections, events, bootedAtMs, clock } = this.deps;
    if (agentProjections === undefined || bootedAtMs === undefined) return; // 缺省零行为（纯引擎测试形态）
    const bootedAtIso = new Date(bootedAtMs).toISOString();
    let orphans: readonly { sessionId: string; instanceId: string; state: string }[];
    try {
      orphans = await agentProjections.queryOrphanInstanceLifecycles(bootedAtIso);
    } catch (error) {
      this.deps.warn?.(`[recover] 幽灵实例扫描失败（跳过收口）：${(error as Error).message}`);
      return;
    }
    let settled = 0;
    for (const row of orphans) {
      const isQueued = row.state === "queued";
      try {
        await agentProjections.saveAgentLifecycle(row.sessionId, row.instanceId, isQueued ? "cancelled" : "failed");
        settled += 1;
      } catch (error) {
        this.deps.warn?.(`[recover] 幽灵实例 ${row.instanceId} 行收口失败（跳过）：${(error as Error).message}`);
        continue; // 行级隔离：单行失败不断恢复主流程
      }
      if (isQueued) continue; // cancelled 无 closure 记录不发事件（TR-35）
      try {
        events?.publish({
          type: "agent.failed",
          sessionId: row.sessionId, // 事件归属 = 实例归属会话（多会话口径，同 ClosureRecorder）
          instanceId: row.instanceId,
          payload: {
            agentId: row.instanceId,
            error: "daemon 重启：实例无优雅收口（daemon_restarted）",
            closure: { status: "failed", summary: "daemon_restarted：上代实例随进程消失，恢复扫描统一收口" },
          } satisfies AgentFailedPayload,
          occurredAt: clock.now(),
        });
      } catch {
        // 事件面异常静默（投影行收口是事实源，事件是可观测增强）
      }
    }
    if (settled > 0) {
      this.deps.warn?.(`[recover] 幽灵实例收口 ${settled} 行（上代遗留非终态投影行 → failed/cancelled）`);
    }
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

  /** 推进门（B 批激活对称）：pending 是编排接管前态——任一推进动作即接管激活
   * （与 insertBatch 首批次落行激活同构）；已暂停/终态拒绝并给出准确指引（O-2 文案
   * 修正：不再把 pending 误标为「暂停/终态」——误导性文案曾致编排 LLM 编造门语义）。
   * 返回 job（调用方只消费 type 等静态字段；激活后状态以行现值为准）。 */
  private async ensureActiveForAdvance(jobId: string): Promise<JobData> {
    const job = this.mustJob(jobId);
    if (job.status === "pending") {
      await this.transitionJob(jobId, "running");
      this.notify({ jobId, changed: "job", status: "running" });
      return job;
    }
    if (job.status !== "running") {
      throw new TaskError(
        "task.invalid_state",
        `任务 ${jobId} 当前状态 ${job.status}（已暂停或终态：不执行推进动作——paused 经 resume 恢复后续跑，终态任务不可推进，O-2）`,
      );
    }
    return job;
  }

  /** 阶段角色派生（A 批机械约束）：kind 仅存 manifest（行结构零迁移）——按任务
   * 类型 + 阶段序派生；free 策略/无声明/序越界缺省 execute。 */
  private stageKindOf(jobType: string, stageSeq: number): StageKind {
    // 单源 domain/task/manifest.ts#stageKindOfManifest（清单 #2.5 上收；引擎面 fallback "execute"）
    return stageKindOfManifest(this.deps.skills.getTaskType(jobType), stageSeq, "execute");
  }

  /** 阶段顺序守卫（B 批）：目标阶段之前的全部 stage 须 done——机械防跳段。 */
  private assertPriorStagesDone(jobId: string, stageSeq: number, stages?: readonly StageData[]): void {
    const all = stages ?? this.deps.store.getStages(jobId);
    const undone = all.filter((s) => s.seq < stageSeq && s.status !== "done");
    if (undone.length > 0) {
      const list = undone.map((s) => `#${s.seq}「${s.name}」（${s.status}）`).join("、");
      throw new TaskError(
        "task.invalid_state",
        `阶段顺序违例：#${stageSeq} 之前存在未完成阶段 ${list}——前序阶段全部 done 后才可插批/推进/聚合（机械守卫）`,
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

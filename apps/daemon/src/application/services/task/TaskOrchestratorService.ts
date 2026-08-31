import type { TaskStorePort, BatchData, JobData } from "../../ports/outbound/TaskStorePort";
import type { TaskEnginePort } from "../../ports/inbound/TaskEnginePort";
import type { TaskOrchestratorStarterPort } from "../../ports/outbound/TaskOrchestratorStarterPort";
import type { TaskSkillRegistryPort } from "../../ports/outbound/TaskSkillRegistryPort";
import type {
  AgentOrchestrationPort,
  SpawnOutcome,
} from "../../ports/inbound/AgentOrchestrationPort";
import type { WorkItemData } from "../../ports/outbound/WorkLedgerPort";
import { isTerminalJob } from "../../../domain/task/job";
import { MAX_BATCH_RETRY } from "../../../domain/task/retry";
import type { WorkLedgerService } from "./WorkLedgerService";

/**
 * TaskOrchestratorService —— 编排主 agent 运行时（architecture.md §5，T2.2；
 * 实现 TaskOrchestratorStarterPort，替换 T1.3 的 no-op starter）。
 *
 * 【职责】装配编排会话（skill 全文 + job.params + 冻结 stage 行 + 恢复现场
 * 摘要）→ 驱动批次循环（§5.2）：LLM 判断面（划批次/推进选择——经编排会话
 * 的工具调用）+ 机械判定面（closure 缺失/失败 ①、closure 成功但台账未全
 * resolve ② → failBatch；双过 → completeBatch ③——代码执行，不进 LLM）→
 * 失败批次自动重派（接力 brief 含前序 plan 摘要 + supersede 指令）→
 * 阶段产物聚合/任务收口由 LLM 经引擎回口工具申报（引擎机械复核）。
 *
 * 【预算语义】编排 loop 是轻量循环，**不经 SchedulerService spawn**（不消耗
 * maxConcurrent=3 计数）——只有批次 SubAgent spawn 走预算（rawSpawn 绑定
 * task:* 会话归属同一调度器，与 chat 共享预算池）。
 *
 * 【编排会话可丢弃】全部权威状态 = skill + 任务四表行 + 实例台账；会话
 * 上下文是派生物。断点重开（resume/恢复扫描）注入状态摘要（当前
 * stage/batch 现场 + 已完成批次清单）从行状态重建。
 *
 * 【收口通知路由】批次实例 closure 经 SchedulerService 收口链的注入回调
 * 路由到 handleInstanceClosure（组合根按 task:* 会话前缀接线——
 * buildSessionStack taskClosureSink；不升第二通路）。
 */

/** 任务批次实例的调度归属会话前缀（编排批次实例非 chat 会话实体）。 */
export const TASK_SESSION_PREFIX = "task:";

/** jobId → 批次实例归属会话 id（spawn 绑定 + closure 路由判别）。 */
export function taskSessionIdOf(jobId: string): string {
  return TASK_SESSION_PREFIX + jobId;
}

/** 会话 id 是否任务批次归属（buildSessionStack 注入回调路由判别用）。 */
export function isTaskSessionId(sessionId: string): boolean {
  return sessionId.startsWith(TASK_SESSION_PREFIX);
}

/** 图谱产出型任务类型集合（D8 W-R5/W-R6）：不开 worktree 主树执行 + 批次实例走 subagent-kg-writer profile。 */
const KG_PRODUCING_TASK_TYPES = new Set(["kg-bootstrap", "kg-review"]);

/**
 * 批次实例 profileKind 分流（D8 W-R6 编排层单点）：图谱产出型
 * （kg-bootstrap/kg-review）→ "subagent-kg-writer"（通用 worker 工具集
 * + kg-update）；其余 → "subagent-worker"（缺省不变）。spawn 链：
 * spawnBatch → rawSpawn → scheduler.spawn 登记 AgentInstance.profileKind
 * → 组合根组装快照按 kind 派发生效集（buildSessionStack 单点）。
 */
export function dispatchProfileKindOf(jobType: string): "subagent-worker" | "subagent-kg-writer" {
  return KG_PRODUCING_TASK_TYPES.has(jobType) ? "subagent-kg-writer" : "subagent-worker";
}

/** 编排会话驱动面（编排服务消费的最小接缝；生产实现 = pi 引擎装配，组合根注入）。 */
export interface OrchestratorSessionFace {
  /** 驱动一轮 run（含工具轮与注入 drain 轮；run 结束 resolve）。 */
  drive(prompt: string): Promise<void>;
  /** 运行中注入（turn 边界 drain；闲时注入由调用方改为 drive）。 */
  inject(text: string): void;
  /** 中断当前 run（stop 通路）。 */
  abort(): void;
}

/** 实例终态读面（closure 判据：state done=收口成功，failed/killed=收口失败）。 */
export type InstanceOutcomeFace = { readonly state: string; readonly summary?: string } | undefined;

export interface TaskOrchestratorServiceDeps {
  readonly store: TaskStorePort;
  readonly taskEngine: TaskEnginePort;
  /** 台账读面（isFullyResolved 硬判据 + 前序 plan 摘要装配）。 */
  readonly ledger: WorkLedgerService;
  readonly skills: TaskSkillRegistryPort;
  /** 任务 skill 全文取数（kickoff 装配；组合根/测试注入）。 */
  readonly skillTextOf: (type: string) => Promise<string | undefined>;
  /**
   * 批次 SubAgent spawn 原面（调度器绑定：task:* 会话归属；占预算）。
   * 第三参 profileKind（D8 W-R6 分流产物：kg-bootstrap/kg-review →
   * subagent-kg-writer，其余 subagent-worker）透传 scheduler.spawn 登记。
   */
  readonly rawSpawn: (sessionId: string, task: string, profileKind?: string) => SpawnOutcome;
  /** 实例终态读面（调度器 status 映射）。 */
  readonly instanceOutcome: (agentId: string) => InstanceOutcomeFace;
  /** 在跑批次 SIGTERM（cancel 通路收口在调度器 kill）。 */
  readonly killInstance: (agentId: string) => void;
  /** 编排会话工厂（每任务一个；ports = 派批次 SubAgent 的任务绑定编排口）。 */
  readonly createSession: (jobId: string, orchestration: AgentOrchestrationPort) => OrchestratorSessionFace;
  /** plan 硬约束段全文（模板层硬约束——plan=enforced 任务派发面机械追加；段库 catalog 同源注入）。 */
  readonly planHardConstraint: string;
  /**
   * job 终态提示面（W2-D R13：reap 终态任务时回调——组合根接 pending_sync
   * 扫描 + 用户提示广播；编排层挂点不进引擎，守 AD-10）。仅在循环被 reap
   * 时触发一次（cancel 走 stopOrchestrator 用户主动路径，不触发）；缺省不提示。
   */
  readonly onJobTerminal?: (jobId: string, status: JobData["status"]) => void;
  readonly logger?: { warn(message: string): void };
}

/** 单任务编排循环态（会话 + 派发 brief 登记簿 + 驱动中标记）。 */
interface LoopState {
  readonly jobId: string;
  readonly session: OrchestratorSessionFace;
  /** instanceId → 派发 brief（重派接力源；会话可丢弃，此簿随会话同寿）。 */
  readonly briefs: Map<string, string>;
  running: boolean;
  stopped: boolean;
}

const RESUME_NOTICE = "【恢复通知】任务已恢复（running）——按现场摘要与任务 skill SOP 续跑。";

export class TaskOrchestratorService implements TaskOrchestratorStarterPort {
  private readonly loops = new Map<string, LoopState>();

  constructor(private readonly deps: TaskOrchestratorServiceDeps) {}

  // ── TaskOrchestratorStarterPort ──────────────────────────

  /**
   * 装配编排会话并启动批次循环（resolve 时机 = 装配完成 + 循环已启动，
   * 不等任务完成）；重复 start 同一 jobId 幂等（既有循环 → 唤醒续跑，
   * 恢复与 resume 同路径）。
   */
  async startOrchestrator(jobId: string): Promise<void> {
    const job = this.deps.store.getJob(jobId);
    if (job === undefined || (job.status !== "pending" && job.status !== "running")) {
      return; // paused 不自动续（恢复归显式 resume）；终态不驱动
    }
    const existing = this.loops.get(jobId);
    if (existing !== undefined && !existing.stopped) {
      this.wake(existing, RESUME_NOTICE); // resume/重复 start：唤醒续跑
      void this.sweepRetries(jobId);
      return;
    }
    const loop: LoopState = {
      jobId,
      session: this.deps.createSession(jobId, this.taskOrchestrationPort(jobId)),
      briefs: new Map(),
      running: false,
      stopped: false,
    };
    this.loops.set(jobId, loop);
    void this.sweepRetries(jobId); // 暂停期失败未重派的批次补派（§4.5）
    this.wake(loop, await this.kickoffPrompt(job)); // fire-and-forget：循环已启动即 resolve
  }

  /** 停 loop + 在跑批次 SIGTERM（cancel 通路；引擎已先停批行迁移前的调用序）。 */
  async stopOrchestrator(jobId: string): Promise<void> {
    const loop = this.loops.get(jobId);
    if (loop !== undefined) {
      loop.stopped = true;
      loop.session.abort();
      this.loops.delete(jobId);
    }
    for (const batch of this.allBatches(jobId)) {
      if (batch.status === "running" && batch.instanceId !== null) {
        this.deps.killInstance(batch.instanceId); // kill 收口链回调被 stopped 循环吞（幂等）
      }
    }
  }

  // ── 收口通知路由（SchedulerService 注入回调 → 机械判定面） ──

  /**
   * 批次实例收口处理入口（组合根按 task:* 会话前缀接调度器注入回调；
   * 进展报告不入本面）。机械判据优先级：① closure 缺失/失败 → failBatch；
   * ② closure 成功但台账未全 resolve → failBatch（retry_note 含未决项数）；
   * ③ 双过 → completeBatch。判定后重派/通知驱动编排会话下一轮。
   */
  handleInstanceClosure(agentId: string): void {
    void this.settleInstance(agentId);
  }

  // ── 内部：会话驱动（唤醒/注入路由） ──────────────────────

  /** 唤醒编排会话：运行中 → 注入（turn 边界 drain）；闲时 → 新驱动轮。 */
  private wake(loop: LoopState, prompt: string): void {
    if (loop.stopped) return;
    if (loop.running) {
      loop.session.inject(prompt);
      return;
    }
    loop.running = true;
    void (async () => {
      try {
        await loop.session.drive(prompt);
      } catch (err) {
        this.warn(`编排会话驱动异常（任务 ${loop.jobId}）：${(err as Error).message}`);
      } finally {
        loop.running = false;
        this.reapIfTerminal(loop.jobId); // run 收口后顺带清扫终态任务
      }
    })();
  }

  /** 任务终态 → 丢弃循环（会话可丢弃；权威状态全在行）。 */
  private reapIfTerminal(jobId: string): void {
    const job = this.deps.store.getJob(jobId);
    if (job !== undefined && isTerminalJob(job.status)) {
      const loop = this.loops.get(jobId);
      if (loop !== undefined) {
        loop.stopped = true;
        this.loops.delete(jobId);
        // W2-D R13 job 完成提示点：扫描 pending_sync 归组合根（本层只报终态事实）
        this.deps.onJobTerminal?.(jobId, job.status);
      }
    }
  }

  // ── 内部：机械判定面（closure + plan 硬约束） ──────────────

  /** 实例收口机械判读 + 引擎落库 + 重派/通知。 */
  private async settleInstance(agentId: string): Promise<void> {
    const hit = this.locate(agentId);
    if (hit === undefined) return; // 非本编排在册实例 / 已停循环 / 已收口批次
    const { loop, batch } = hit;
    if (batch.status !== "running") return; // 迟到收口幂等（cancel 已标 failed 等）
    const outcome = this.deps.instanceOutcome(agentId);
    const summary = outcome?.summary ?? "（无 closure 摘要）";
    const resolution = this.deps.ledger.isFullyResolved(agentId);
    let verdict: string;
    let redispatched: string | null = null;
    try {
      if (outcome === undefined || outcome.state !== "done") {
        // ① closure 缺失/失败（killed 同判失败——单一终态语义）
        const note = `closure ${outcome === undefined ? "缺失" : outcome.state}：${summary}`;
        const { retryScheduled } = await this.deps.taskEngine.failBatch(batch.id, note);
        verdict = `失败（${note}）`;
        if (retryScheduled) redispatched = await this.reDispatch(loop, batch);
      } else if (!resolution.resolved) {
        // ② closure 成功但台账未全 resolve（硬约束优先于 LLM 判读）
        const pending = resolution.unresolved.map((u) => `#${u.seq}(${u.status})`).join("、");
        const note = `closure 成功但实例台账未全 resolve（未决 ${resolution.unresolved.length} 项：${pending}）`;
        const { retryScheduled } = await this.deps.taskEngine.failBatch(batch.id, note);
        verdict = `失败（${note}）`;
        if (retryScheduled) redispatched = await this.reDispatch(loop, batch);
      } else {
        // ③ 双过 → completeBatch（O-2：pause 下照常落库，不触发推进）
        await this.deps.taskEngine.completeBatch(batch.id);
        verdict = "成功（closure done + 台账全 resolve）";
      }
    } catch (err) {
      verdict = `收口处理异常（引擎拒绝：${(err as Error).message}）`;
      this.warn(`批次收口引擎调用异常（任务 ${loop.jobId} 批次 ${batch.id}）：${(err as Error).message}`);
    }
    this.wake(loop, this.closureNotice(agentId, batch, verdict, redispatched));
  }

  /** agentId → 在册循环 + 批次行（按 brief 登记簿定位 jobId 再查行）。 */
  private locate(agentId: string): { loop: LoopState; batch: BatchData } | undefined {
    for (const loop of this.loops.values()) {
      if (loop.stopped || !loop.briefs.has(agentId)) continue;
      const batch = this.allBatches(loop.jobId).find((b) => b.instanceId === agentId);
      if (batch !== undefined) return { loop, batch };
    }
    return undefined;
  }

  /** job 的全部批次行（跨 stage）。 */
  private allBatches(jobId: string): BatchData[] {
    return this.deps.store.getStages(jobId).flatMap((stage) => this.deps.store.getBatches(jobId, stage.seq));
  }

  // ── 内部：自动重派（§4.5 死批次接力） ─────────────────────

  /** 重派失败批次：接力 brief（原 brief + 前序台账摘要 + supersede 指令）→ spawn → 派发落章。 */
  private async reDispatch(loop: LoopState, batch: BatchData): Promise<string | null> {
    const job = this.deps.store.getJob(loop.jobId);
    if (job === undefined || job.status !== "running") return null; // 派发闸（pause/终态不重派）
    const prevId = batch.instanceId ?? "";
    const brief = assembleRetryBrief(
      batch,
      loop.briefs.get(prevId),
      prevId === "" ? [] : this.deps.ledger.getPlan(prevId),
    );
    const outcome = this.spawnBatch(loop.jobId, brief);
    if (outcome.status === "rejected") {
      this.warn(`重派被拒（任务 ${loop.jobId} 批次 ${batch.id}）：${outcome.error}`);
      return null;
    }
    try {
      await this.deps.taskEngine.dispatchBatch(batch.id, outcome.agentId);
      return outcome.agentId;
    } catch (err) {
      this.warn(`重派落章失败（任务 ${loop.jobId} 批次 ${batch.id}）：${(err as Error).message}`);
      return null;
    }
  }

  /** 恢复扫描面重派补漏：暂停期/停循环期失败的批次（retry 有余量）在唤醒时补派。 */
  private async sweepRetries(jobId: string): Promise<void> {
    const loop = this.loops.get(jobId);
    if (loop === undefined || loop.stopped) return;
    const job = this.deps.store.getJob(jobId);
    if (job === undefined || job.status !== "running") return;
    for (const batch of this.allBatches(jobId)) {
      if (batch.status !== "failed" || batch.retryCount <= 0 || batch.retryCount >= MAX_BATCH_RETRY) continue;
      const current = this.deps.store.getBatch(batch.id);
      if (current === undefined || current.status !== "failed") continue; // 并发迁移守卫
      const agentId = await this.reDispatch(loop, current);
      if (agentId !== null) {
        this.wake(loop, `【重派补漏】批次 #${batch.stageSeq}.${batch.seq}「${batch.scope}」已补派新实例 ${agentId}（前序失败 ${batch.retryCount} 次）。`);
      }
    }
  }

  // ── 内部：批次 spawn 通路（brief 硬约束追加 + 登记簿） ──────

  /**
   * 派批次 SubAgent：plan=enforced 任务机械追加硬约束段（LLM 装配不可裁）→
   * 调度器 spawn（占预算；D8 W-R6：profileKind 按任务类型分流——图谱产出型
   * kg-bootstrap/kg-review 走 subagent-kg-writer，其余缺省 subagent-worker）。
   */
  private spawnBatch(jobId: string, brief: string): SpawnOutcome {
    const job = this.deps.store.getJob(jobId);
    if (job === undefined) return { status: "rejected", error: `任务 ${jobId} 不存在` };
    const enforced = this.deps.skills.getTaskType(job.type)?.plan === "enforced";
    const effective = enforced && this.deps.planHardConstraint !== "" ? `${brief}\n\n${this.deps.planHardConstraint}` : brief;
    const outcome = this.deps.rawSpawn(taskSessionIdOf(jobId), effective, dispatchProfileKindOf(job.type));
    if (outcome.status !== "rejected") {
      this.loops.get(jobId)?.briefs.set(outcome.agentId, effective); // 重派接力源
    }
    return outcome;
  }

  /** 任务绑定编排口（编排会话 executor 的 spawn 工具面；send/status/inspect 不进编排生效集）。 */
  private taskOrchestrationPort(jobId: string): AgentOrchestrationPort {
    const job = this.deps.store.getJob(jobId);
    // D8 W-R6：观测面同源分流结果（批次实例 profileKind 按任务类型路由）
    const profileKind = job !== undefined ? dispatchProfileKindOf(job.type) : "subagent-worker";
    return {
      spawn: (task: string) => this.spawnBatch(jobId, task),
      send: () => ({ delivered: false, detail: "任务批次实例不支持编排会话消息注入" }),
      status: (agentId) => {
        if (agentId === undefined) return [];
        const outcome = this.deps.instanceOutcome(agentId);
        if (outcome === undefined) return [];
        const state = ["queued", "running", "done", "failed", "cancelled"].includes(outcome.state)
          ? (outcome.state as "queued" | "running" | "done" | "failed" | "cancelled")
          : "running";
        return [
          {
            agentId,
            state,
            profileKind,
            ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
          },
        ];
      },
      kill: (agentId) => {
        this.deps.killInstance(agentId);
        return { killed: true };
      },
      inspect: () => null,
    };
  }

  // ── 内部：kickoff 装配 + 收口通知文案 ─────────────────────

  /** 起跑 prompt：skill 全文 + 任务参数 + 冻结阶段行 + 恢复现场摘要。 */
  private async kickoffPrompt(job: JobData): Promise<string> {
    const stages = this.deps.store.getStages(job.id);
    const batches = this.allBatches(job.id);
    const skillText = await this.deps.skillTextOf(job.type);
    const stageLines = stages.map((s) => `#${s.seq} ${s.name} — ${s.status}`);
    const batchLines =
      batches.length === 0
        ? ["（尚无批次行——从第一阶段开始划批次。）"]
        : batches.map(
            (b) =>
              `#${b.stageSeq}.${b.seq}「${b.scope}」${b.status}${b.retryCount > 0 ? `（重试 ${b.retryCount} 次：${b.retryNote ?? ""}）` : ""}${b.instanceId !== null ? `，实例 ${b.instanceId}` : ""}`,
          );
    const doneBatches = batches.filter((b) => b.status === "done").map((b) => `#${b.stageSeq}.${b.seq}「${b.scope}」`);
    return [
      "【任务起跑】你是本任务的编排主 agent。以下是任务参数、冻结阶段行、恢复现场与任务 skill 全文——按 skill SOP 执行编排循环。",
      "",
      `任务类型：${job.type}`,
      `参数：${JSON.stringify(job.params)}`,
      `项目标签：${JSON.stringify(job.projects)}`,
      "",
      "【阶段计划（已冻结，不重议不增删）】",
      ...stageLines,
      "",
      "【恢复现场（批次行状态——权威状态，从这续跑）】",
      ...batchLines,
      ...(doneBatches.length > 0 ? ["已完成批次：" + doneBatches.join("、")] : []),
      "",
      "【任务 skill 全文】",
      skillText ?? `（skill "${job.type}" 全文不可得——按任务类型名与阶段行自行组织批次划分，或申报任务失败。）`,
    ].join("\n");
  }

  /** 收口注入文案（判定结论 + 阶段现场 + 推进提示——驱动编排会话下一轮）。 */
  private closureNotice(agentId: string, batch: BatchData, verdict: string, redispatched: string | null): string {
    const job = this.deps.store.getJob(batch.jobId);
    const stages = job === undefined ? [] : this.deps.store.getStages(batch.jobId);
    const batches = this.deps.store.getBatches(batch.jobId, batch.stageSeq);
    const stageName = stages.find((s) => s.seq === batch.stageSeq)?.name ?? `#${batch.stageSeq}`;
    const lines = [
      `【批次收口】实例 ${agentId}（批次 #${batch.stageSeq}.${batch.seq}「${batch.scope}」）`,
      `系统判定：${verdict}`,
      ...(redispatched !== null ? [`已自动重派新实例 ${redispatched}（接力 brief 含前序台账摘要与 supersede 指令）——等待其收口即可，不要为同范围另派新批。`] : []),
      `阶段 #${batch.stageSeq}「${stageName}」批次现场：${batches.map((b) => `#${b.seq} ${b.status}`).join("、") || "（无）"}`,
    ];
    if (batches.length > 0 && batches.every((b) => b.status === "done")) {
      lines.push("本阶段批次已全部收口成功——按 skill SOP 聚合阶段产物（摘要给人类读）并推进下一阶段或收口任务。");
    }
    if (stages.length > 0 && stages.every((s) => s.status === "done") && job?.status === "running") {
      lines.push("全部阶段已完成——复核 skill 完成判节后申报任务完成（系统机械复核全部阶段行）。");
    }
    if (job !== undefined && job.status !== "running") {
      lines.push(`（任务当前状态 ${job.status}——派发与推进会被拒绝，等待恢复注入。）`);
    }
    return lines.join("\n");
  }

  private warn(message: string): void {
    this.deps.logger?.warn(`[orchestrator] ${message}`);
  }
}

// ── 接力 brief 装配（纯函数，测试直测） ─────────────────────

/**
 * 重派 brief = 原 brief（不可得则按 scope 重建）+ 前序 plan 摘要段
 * （已完成项 + note 事实/产物指针——AD-6④ 接力恢复）+ supersede 指令段
 * （origin_batchId 重跑幂等，§4.5/T2.1 元数据指令面）。
 */
export function assembleRetryBrief(
  batch: BatchData,
  originalBrief: string | undefined,
  prevPlan: readonly WorkItemData[],
): string {
  const head =
    originalBrief ??
    [
      "## 任务目标",
      `重跑批次 #${batch.stageSeq}.${batch.seq}「${batch.scope}」（前次 brief 不可得——按范围描述与前序台账摘要重建工作面）。`,
    ].join("\n");
  const relayLines =
    prevPlan.length === 0
      ? []
      : [
          "## 前序 plan 摘要（接力恢复——从断点继续，不重做已完成探索）",
          ...prevPlan.map(
            (item) => `- #${item.seq} [${item.status}] ${item.content}${item.note !== null ? `——note：${item.note}` : ""}`,
          ),
        ];
  const supersedeLines = [
    `## 重跑幂等（批次 #${batch.stageSeq}.${batch.seq}）`,
    `本批为重派批次（前次失败 ${batch.retryCount} 次：${batch.retryNote ?? "未记录"}）：先按 origin_batchId=${batch.id} 检出旧产出逐个 supersede（理由如实记录），再产新节点；前序台账 note 标明的产物指针对应步骤已完成的可跳过不重做。`,
  ];
  return [head, ...relayLines, ...supersedeLines].join("\n\n");
}

import type { TaskStorePort, BatchData, JobData } from "../../ports/outbound/TaskStorePort";
import { displayStateOf } from "../../../domain/agent/ObservabilityState";
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
import { DEFAULT_PROFILE_KIND } from "../../ports/outbound/ResourceStatePort"; // profileKind 缺省单源（与 SchedulerService.spawn 缺省同值）
import type { ParkReason } from "../../../domain/events/DomainEvent";
import type { WorkLedgerService } from "./WorkLedgerService";
import { titleOf } from "./TaskQueryService";

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

/**
 * 任务类型 → 批次实例 profileKind 映射（D8 W-R6 起；D5 扩第三支；task-worker
 * 已撤——任务派生 worker 回归 chat 子代理同 kind 同配置面）：
 * - kg-bootstrap / kg-review → "subagent-kg-writer"（图谱产出型：通用 worker 工具集 + kg-update 豁免）；
 * - code-review → "subagent-code-reviewer"（D5 只读评审：worker 生效集 − write/edit + 评审纪律后缀）；
 * - 其余 → "subagent-worker"（与手动 agent_spawn 缺省同 kind 同配置面，零双轨）。
 */
const DISPATCH_PROFILE_KINDS: Readonly<Record<string, DispatchProfileKind>> = {
  "kg-bootstrap": "subagent-kg-writer",
  "kg-review": "subagent-kg-writer",
  "kg-triage": "subagent-kg-writer", // 图谱写面任务（裁决落地）；2026-09-29 triage 首跑暴露缺口：未映射回落 worker 工具集，编排层临时显式传参兑底
  "code-review": "subagent-code-reviewer",
};

type DispatchProfileKind = "subagent-worker" | "subagent-kg-writer" | "subagent-code-reviewer";

/**
 * 批次实例 profileKind 分流（编排层单点）：类型→kind 映射（缺省
 * subagent-worker——与手动 agent_spawn 缺省同轨；SchedulerService
 * DEFAULT_PROFILE_KIND 同值单源）。
 * spawn 链：spawnBatch → rawSpawn → scheduler.spawn 登记 AgentInstance.profileKind
 * → 组合根组装快照按 kind 派发生效集（buildSessionStack 单点）。
 */
export function dispatchProfileKindOf(jobType: string): DispatchProfileKind {
  return DISPATCH_PROFILE_KINDS[jobType] ?? DEFAULT_PROFILE_KIND;
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

/** 批次实例挂起请求结果（SchedulerService.park 结构面；拒绝附中文原因）。 */
export type BatchParkOutcome = { readonly parked: boolean; readonly error?: string };

/** 批次实例恢复结果（SchedulerService.resume 结构面；queued=true = 预算满排队恢复）。 */
export type BatchResumeOutcome = { readonly resumed: boolean; readonly queued?: boolean; readonly error?: string };

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
  /**
   * kg-bootstrap 硬闸（D2，批1）：默认 embedding 端点在场判据（全消费面
   *  resolveDefault 单点的窄投影；false = 向量面不可用）——kg-bootstrap
   *  任务开工前检查，缺席即任务失败并提示去配置（构建知识库必须有向量
   *  端点：节点向量化是基建单点依赖）。可选——测试/非 kg 场景不注入零影响。
   */
  readonly hasDefaultEmbeddingEndpoint?: () => boolean;
  /** 实例终态读面（调度器 status 映射）。 */
  readonly instanceOutcome: (agentId: string) => InstanceOutcomeFace;
  /** 在跑批次 SIGTERM（cancel 通路收口在调度器 kill）。 */
  readonly killInstance: (agentId: string) => void;
  /**
   * 批次实例挂起原语（⑤ 链 A：组合根接 scheduler.park——parkAll 消费，
   * reason=taskPause；协作式：指令经 steer 通道注入，PARK 确认上行后
   * 实例转 parked 释放预算）。
   */
  readonly parkInstance: (agentId: string, reason: ParkReason) => BatchParkOutcome;
  /**
   * parked 批次实例复活原语（⑤ 链 A：组合根接 scheduler.resume——resumeAll
   * 消费；同实例同会话续跑，预算满与重派同队排队恢复）。未挂起/终态实例
   * 拒绝（resumed=false）为良性——resumeAll 按批次行全量调用。
   */
  readonly resumeInstance: (agentId: string) => BatchResumeOutcome;
  /** 编排会话工厂（每任务一个；ports = 派批次 SubAgent 的任务绑定编排口）。 */
  readonly createSession: (jobId: string, orchestration: AgentOrchestrationPort) => OrchestratorSessionFace;
  /** plan 硬约束段全文（模板层硬约束——plan=enforced 任务派发面机械追加；段库 catalog 同源注入）。 */
  readonly planHardConstraint: string;
  /**
   * 任务报告目录解析（D6：kickoff 起跑信息携带——任务级汇总报告固定落点
   * <home>/reports/task:<jobId>，orchestrator 持 write 自己写不绕道汇总批次）；
   * 与 SubagentLauncher reportDirFor / ClosureRecorder reportsDirFor 同源同式
   * （paths.home/reports/<sessionId>，组合根注入）。
   */
  readonly reportsDirFor: (sessionId: string) => string;
  /**
   * job 终态提示面（W2-D R13：reap 终态任务时回调——组合根接 pending_sync
   * 扫描 + 用户提示广播；编排层挂点不进引擎，守 AD-10）。仅在循环被 reap
   * 时触发一次（cancel 走 stopOrchestrator 用户主动路径，不触发）；缺省不提示。
   * title = 任务标题机械字段（titleOf 同源；管家 notify title 用，非 UUID）。
   */
  readonly onJobTerminal?: (jobId: string, status: JobData["status"], title?: string) => void;
  /** 卡装配修复：info 面（驱动开始/完成可观测）+ warn 面（异常/重试链）。 */
  readonly logger?: { info(message: string): void; warn(message: string): void };
  /**
   * 推进检查延迟窗（毫秒，缺省 30s）：驱动收场后静置此刻仍无事件驱动才判
   * 死局（重驱/failJob）。测试注入短窗（50ms）确定性触发；生产缺省长窗——
   * 插行收场/装配轮间隙等合法短暂收场不被误杀。
   */
  readonly progressCheckDelayMs?: number;
}

/** 单任务编排循环态（会话 + 派发 brief 登记簿 + 驱动中标记）。 */
interface LoopState {
  readonly jobId: string;
  readonly session: OrchestratorSessionFace;
  /** instanceId → 派发 brief（重派接力源；会话可丢弃，此簿随会话同寿）。 */
  readonly briefs: Map<string, string>;
  running: boolean;
  stopped: boolean;
  /**
   * 退避窗位（清单 #2.5：drive 异常 5s 重试等待期）：窗内会话实际空闲，
   * wake 走 inject 会注入非运行会话丢失（OrchestratorSessionFace 契约
   * ：81-83 声明闲时注入由调用方改为 drive）——置位期间 wake 暂存
   * stashedWakes，重试轮收口后回放（resume 回放同构）。
   */
  backingOff: boolean;
  /**
   * 链 A 挂起位（任务 pause 置位 / resume 清位）：置位期间 wake 只入
   * stashedWakes 暂存队列，不驱动编排器回合。编排器自身是 daemon 内会话
   * ——不需要子进程 PARK 协议（pause 时它通常在等批次 closure，无「回合中」
   * 挂起问题；恰逢回合中则当前 drive 自然收口后挂起生效）。
   */
  parked: boolean;
  /** 挂起期间暂存的唤醒（resume 时回放驱动编排器）。 */
  readonly stashedWakes: string[];
  /**
   * 失败停摆位（haltJob：failBatch 超限上浮 → job failed）：置位后不再
   * 驱动任何编排回合（wake 全丢）但保留收口落库（locate 放行）——在跑
   * 实例自然收口、排队实例已摘队，全部 in-flight 收口后循环自清
   * （reapDrained）。区别于 stopped 单用：stopped 循环收口被丢弃，drain
   * 循环收口照常落库（done 行保留，人工重试不重跑）。
   */
  drain: boolean;
  /**
   * 对账扫描防重入位（task-efd68911）：startOrchestrator/resume 与驱动回合
   * 结束点都触发 sweepBatches，异步并发双扫会双派——置位期间后续触发跳过
   * （failBatch running 断言兜底竞态，此处前置消解）。
   */
  sweeping: boolean;
  /**
   * 推进检查重驱位（task-efd68911 第二重事故）：编排会话收场且无在跑实例
   * 但任务存在未完批次/阶段 → 重驱一次提示推进；置位后再次检测仍此态 →
   * failJob 收口（有界：防网络持续断/LLM 持续不推进时永久 running）。界 =
   * 单次静置死局非全生命周期一次：批次收口（settleInstance 尾）复位——
   * 长任务每次实质推进后重获一次重驱机会。
   */
  progressRedriven: boolean;
  /** 推进检查定时器（收场后延迟窗；新收场重置，循环满退/停摆清理）。 */
  progressTimer?: ReturnType<typeof setTimeout>;
}

const RESUME_NOTICE = "【恢复通知】任务已恢复（running）——按现场摘要与任务 skill SOP 续跑。";

/** 推进检查重驱文案（收场后无在跑实例 + 未完批次/阶段：提示 LLM 推进或收口——涵盖装配期零批次死局）。 */
const PROGRESS_CHECK_NOTICE = [
  "【推进检查】驱动收场后系统检测：无在跑实例但任务存在未完批次/阶段。",
  "请按任务 skill SOP 与批次行现场继续推进：尚未划批的先划分批次并 task_insert_batch 落行；已划批的派发 pending 批次（spawn 后立即 task_dispatch_batch 接线）；聚合已收口阶段产物；或申报任务完成/失败。",
  "若无实质推进动作，系统将把任务失败收口（failJob）。",
].join("\n");

/** 推进检查延迟窗缺省（毫秒）：收场后静置此刻仍无事件驱动才判死局——插行收场/装配轮间隙等合法短暂收场不被误杀。 */
const PROGRESS_CHECK_DELAY_MS = 30_000;

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
    // D2 kg-bootstrap 硬闸（批1）：任务开工检查默认 embedding 端点——
    // null（未设/悬空）→ 任务失败并提示配置（与记忆同理：构建知识库
    // 必须有向量端点）；不装配编排会话、不进 kickoff。
    if (
      job.type === "kg-bootstrap" &&
      this.deps.hasDefaultEmbeddingEndpoint !== undefined &&
      !this.deps.hasDefaultEmbeddingEndpoint()
    ) {
      await this.deps.taskEngine.failJob(jobId, "请先配置默认 embedding 端点（设置 → 模型配置 → 向量模型：连通验证后「设为默认」，再发起知识创建任务）");
      this.info(`kg-bootstrap 任务开工被硬闸拒绝（任务 ${jobId}）：未配置默认 embedding 端点，任务已失败收口`);
      return;
    }
    const existing = this.loops.get(jobId);
    if (existing !== undefined && !existing.stopped) {
      // B3：补派先落行再唤醒——RESUME_NOTICE 与补派注入的现场一致（LLM 不重复派）
      await this.sweepBatches(jobId);
      this.wake(existing, RESUME_NOTICE);
      return;
    }
    const loop: LoopState = {
      jobId,
      session: this.deps.createSession(jobId, this.taskOrchestrationPort(jobId)),
      briefs: new Map(),
      running: false,
      stopped: false,
      backingOff: false,
      parked: false,
      drain: false,
      sweeping: false,
      progressRedriven: false,
      stashedWakes: [],
    };
    this.loops.set(jobId, loop);
    // B3（resume 双派竞态）：补派先落行——kickoff 快照含已补派批次的新实例号，
    // 编排 LLM 看到 running+实例号即不自行重派（历史 void 异步曾致 LLM 快照读旧
    // failed 态后自派重复实例，产物无法接线全部丢弃）
    await this.sweepBatches(jobId); // 暂停期失败未重派的批次补派（§4.5）
    this.wake(loop, await this.kickoffPrompt(job)); // fire-and-forget：循环已启动即 resolve
  }

  /** 停 loop + 在跑批次 SIGTERM（cancel 通路；引擎已先停批行迁移前的调用序）。 */
  async stopOrchestrator(jobId: string): Promise<void> {
    const loop = this.loops.get(jobId);
    const spawned = loop !== undefined ? [...loop.briefs.keys()] : [];
    if (loop !== undefined) {
      loop.stopped = true;
      this.clearProgressTimer(loop); // 推进检查定时器随停循环清理
      loop.stashedWakes.length = 0; // 终止丢弃暂存唤醒（cancel 语义：无回放）
      loop.session.abort();
      this.loops.delete(jobId);
    }
    // 本循环 spawn 过的全部实例（含游离/排队）+ 在跑批次的接线实例（跨循环
    // 残留）——cancel 清场：排队摘队、在跑终止；kill 任意状态幂等（已终态 no-op）
    const linked = this.allBatches(jobId)
      .filter((b) => b.status === "running" && b.instanceId !== null)
      .map((b) => b.instanceId as string);
    for (const agentId of new Set([...spawned, ...linked])) {
      this.deps.killInstance(agentId); // kill 收口链回调被 stopped 循环吞（幂等）
    }
  }

  /**
   * 任务失败停摆（B2 fail-stop：failBatch 超限上浮 → 引擎调用）：停驱动
   * （abort + 丢弃暂存唤醒）+ 摘队排队实例；在跑实例不杀——drain 态自然
   * 收口照常落库，全部 in-flight 收口后循环自清（reapDrained）。
   */
  haltJob(jobId: string): void {
    const loop = this.loops.get(jobId);
    if (loop === undefined || loop.drain) return; // 幂等：无循环（未开编排/已收口）或已停摆
    loop.stopped = true; // wake 全丢（closureNotice 不再驱动编排回合）
    loop.drain = true; // locate 放行：收口继续落库
    this.clearProgressTimer(loop); // 推进检查定时器随停摆清理
    loop.stashedWakes.length = 0;
    loop.session.abort(); // 中断当前 LLM 回合（防停摆后回合内继续 spawn）
    for (const agentId of loop.briefs.keys()) {
      if (this.deps.instanceOutcome(agentId)?.state === "queued") {
        this.deps.killInstance(agentId); // 排队未起跑：摘队（零 token 浪费；收口落 failed 行）
      }
    }
    this.info(`任务失败停摆（任务 ${jobId}）：驱动中止 + 排队实例摘队；在跑实例自然收口（drain）`);
    this.deps.onJobTerminal?.(jobId, "failed", this.jobTitleOf(jobId)); // 终态提示前移到停摆点（不等回合结束）
    this.reapDrained(loop); // 无在飞时立即自清
  }

  // ── 任务域挂起/恢复（⑤ 链 A：park/resume 原语的任务级接线） ──

  /**
   * 任务暂停挂起：编排 loop 冻结（wake 暂存）+ 全部 running 批次实例发
   * park(reason=taskPause)。序：先置挂起位再逐实例 park——park 确认在途
   * 期间自然收口的 closure 唤醒即落入暂存（机械判定照常落库，终态赢）。
   * 批次行状态保持 running（实例级 parked 态经可见性面展示）。
   */
  async parkAll(jobId: string): Promise<void> {
    const loop = this.loops.get(jobId);
    if (loop !== undefined && !loop.stopped) loop.parked = true;
    for (const batch of this.allBatches(jobId)) {
      if (batch.status !== "running" || batch.instanceId === null) continue;
      const outcome = this.deps.parkInstance(batch.instanceId, "taskPause");
      if (!outcome.parked) {
        this.warn(`批次实例挂起请求被拒（任务 ${jobId} 批次 ${batch.id} 实例 ${batch.instanceId}）：${outcome.error ?? "未知原因"}`);
      }
    }
  }

  /**
   * 任务恢复复活：逐个 resume parked 批次实例（同会话续跑；未挂起/终态
   * 拒绝为良性——挂起期自然收口的批次行已终态，被 status 过滤）+ loop
   * 解冻并回放暂存唤醒。引擎调用序保证先于 startOrchestrator（kick）。
   */
  async resumeAll(jobId: string): Promise<void> {
    for (const batch of this.allBatches(jobId)) {
      if (batch.status !== "running" || batch.instanceId === null) continue;
      const outcome = this.deps.resumeInstance(batch.instanceId);
      if (!outcome.resumed) {
        // 未挂起（park 确认在途竞态/早已复活）或终态：不阻断其余实例复活
        this.warn(`批次实例复活被拒（任务 ${jobId} 批次 ${batch.id} 实例 ${batch.instanceId}）：${outcome.error ?? "未知原因"}`);
      }
    }
    const loop = this.loops.get(jobId);
    if (loop !== undefined && !loop.stopped && loop.parked) {
      loop.parked = false;
      const stashed = loop.stashedWakes.splice(0);
      for (const prompt of stashed) this.wake(loop, prompt); // 回放（循环内 round-robin：闲时逐条 drive/运行中注入同 wake 语义）
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

  /**
   * 装配完成唤醒（A 批第四 wake 点，引擎 onAssemblyDone 钩子接线）：机械校验
   * 已在引擎面通过（execute 角色 + 前序 done + 非零批次），此处只驱动派发轮——
   * LLM 判断面收窄为「逐批 spawn + 接线」。无循环/已停（恢复前申报等）静默：
   * 批次行已在，kickoff/恢复现场可见，不丢状态。
   */
  notifyAssemblyDone(jobId: string, stageSeq: number, batchCount: number): void {
    const loop = this.loops.get(jobId);
    if (loop === undefined || loop.stopped) return;
    const stages = this.deps.store.getStages(jobId);
    const name = stages.find((s) => s.seq === stageSeq)?.name ?? `#${stageSeq}`;
    this.wake(
      loop,
      `【装配完成】阶段 #${stageSeq}「${name}」装配 ${batchCount} 批已就绪（机械校验通过：前序阶段 done + 非零批次）。进入派发轮：逐批 agent_spawn + task_dispatch_batch 接线；不要新增或改动批次行，失败重派由引擎自动负责。`,
    );
  }

  // ── 内部：会话驱动（唤醒/注入路由） ──────────────────────

  /** 唤醒编排会话：运行中 → 注入（turn 边界 drain）；闲时 → 新驱动轮；挂起中 → 暂存（链 A）。
   * 卡装配修复（task-8659b320）：drive 全程日志可观测（六分钟静默无从判别死活）
   * + 首轮抛错后单次重试（原先只 warn 无重试——job 滞留 pending 等外部事件）。 */
  private wake(loop: LoopState, prompt: string): void {
    if (loop.stopped) return;
    if (loop.parked) {
      loop.stashedWakes.push(prompt); // 链 A：挂起期间唤醒只暂存不驱动回合（resume 回放）
      return;
    }
    if (loop.running) {
      if (loop.backingOff) {
        // 退避窗（drive 异常 5s 重试等待）：会话实际空闲，inject 会静默丢失——
        // 暂存，重试轮收口后回放（清单 #2.5；resume 回放同构）
        loop.stashedWakes.push(prompt);
        return;
      }
      loop.session.inject(prompt);
      return;
    }
    loop.running = true;
    void (async () => {
      const t0 = Date.now();
      this.info(`编排会话驱动开始（任务 ${loop.jobId}）：${prompt.slice(0, 80)}`);
      try {
        await loop.session.drive(prompt);
        this.info(`编排会话驱动完成（任务 ${loop.jobId}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      } catch (err) {
        const message = (err as Error).message;
        this.warn(`编排会话驱动异常（任务 ${loop.jobId}）：${message}——5s 后单次重试`);
        loop.backingOff = true; // 窗内 wake 只暂存（见 LoopState.backingOff 注释）
        await new Promise((r) => setTimeout(r, 5000));
        if (!loop.stopped) {
          try {
            await loop.session.drive(prompt);
            this.warn(`编排会话重试驱动成功（任务 ${loop.jobId}）`);
          } catch (err2) {
            this.warn(
              `编排会话重试仍失败（任务 ${loop.jobId}）：${(err2 as Error).message}——放弃本轮；推进检查将在延迟窗后兜底（重驱一次，仍无进展则 failJob 收口，不再滞留 pending）`,
            );
          }
        }
      } finally {
        loop.running = false;
        loop.backingOff = false;
        this.reapIfTerminal(loop.jobId); // run 收口后顺带清扫终态任务
        // 迟到接线/断链对账兑底（task-efd68911）：任何驱动回合结束点扫一遍挂死
        // 批次（running 挂终态实例）——failBatch 补收口 + 按余量重派/上浮
        if (!loop.stopped && !loop.parked && !loop.drain) {
          await this.sweepBatches(loop.jobId).catch((err) =>
            this.warn(`驱动结束对账异常（任务 ${loop.jobId}）：${(err as Error).message}`),
          );
          // 推进检查（第二重事故兑底，延迟窗）：对账后仍无在跑实例 + 任务存在
          // 未完批次/阶段 + 无暂存唤醒（事件驱动不在场）→ 静置一个延迟窗仍此态
          // 才判死局（重驱一次/再不推进 failJob）——插行收场等合法间隙零误杀
          this.scheduleProgressCheck(loop);
        }
        // 退避窗/挂起期暂存唤醒回放：未挂起未停摆则驱动（resume 回放同构）；
        // 仍挂起 → 留给 resume；stopped/drain → 丢弃（cancel/halt 语义）
        const stashed = loop.stashedWakes.splice(0);
        if (!loop.stopped && !loop.parked && !loop.drain) {
          for (const p of stashed) this.wake(loop, p);
        } else if (loop.parked) {
          loop.stashedWakes.push(...stashed);
        }
      }
    })();
  }

  /** 任务标题机械字段读面（titleOf 同源；行缺书（jobId 异常形态）→ undefined，
   *  调用侧回退终态词）。 */
  private jobTitleOf(jobId: string): string | undefined {
    const job = this.deps.store.getJob(jobId);
    return job === undefined ? undefined : titleOf(job, this.deps.skills);
  }

  /** 任务终态 → 丢弃循环（会话可丢弃；权威状态全在行）。drain 态例外——haltJob 已提示且收口未完，归 reapDrained 自清。 */
  private reapIfTerminal(jobId: string): void {
    const job = this.deps.store.getJob(jobId);
    if (job !== undefined && isTerminalJob(job.status)) {
      const loop = this.loops.get(jobId);
      if (loop !== undefined && !loop.drain) {
        loop.stopped = true;
        this.clearProgressTimer(loop); // 推进检查定时器随循环退场清理
        this.loops.delete(jobId);
        // W2-D R13 job 完成提示点：扫描 pending_sync 归组合根（本层只报终态事实）
        this.deps.onJobTerminal?.(jobId, job.status, titleOf(job, this.deps.skills));
      }
    }
  }

  // ── 内部：机械判定面（closure + plan 硬约束） ──────────────

  /** 实例收口机械判读 + 引擎落库 + 重派/通知。 */
  private async settleInstance(agentId: string): Promise<void> {
    const hit = this.locate(agentId);
    if (hit === undefined) {
      this.noticeUnlinked(agentId); // B1 可观测：本循环 spawn 但未接线批次行的游离收口
      return; // 非本编排在册实例 / 已停循环 / 已收口批次
    }
    const { loop, batch } = hit;
    if (batch.status !== "running") return; // 迟到收口幂等（cancel 已标 failed 等）
    let verdict: string;
    let redispatched: string | null = null;
    try {
      // code-review M：判据读面（instanceOutcome/isFullyResolved 含 DB 读）并入
      // try——try 外抛错逃逸为 unhandled rejection（入口 void 调用），下方兜底
      // failBatch 链不触发，批次滞留 running（恰是该兜底要防的事故形态）。
      const outcome = this.deps.instanceOutcome(agentId);
      const summary = outcome?.summary ?? "（无 closure 摘要）";
      const resolution = this.deps.ledger.isFullyResolved(agentId);
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
      // 兜底（code-review M5，D4 口径）：引擎调用异常时实例已终态、不再有任何
      // 事件驱动——批次行滞留 running 即永久卡死。退避重试一次兜底 failBatch；
      // 仍失败则如实标记滞留（人工 task.retry/cancel 介入面）。
      this.warn(
        `批次收口引擎调用异常（任务 ${loop.jobId} 批次 ${batch.id}）：${(err as Error).message}——5s 后兜底重试一次 failBatch`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      try {
        // M6 #2.5：兜底 failBatch 成功后仍须按 retryScheduled 补派——批次有
        // 余量却不重派则滞留 failed（sweepRetries 仅在 startOrchestrator
        // 触发，存活 loop 内再无补派机会，直至重启/人工介入）
        const { retryScheduled } = await this.deps.taskEngine.failBatch(
          batch.id,
          `收口引擎异常兜底：${(err as Error).message}`,
        );
        verdict = `失败（收口引擎异常，兜底 failBatch 成功：${(err as Error).message}）`;
        if (retryScheduled) redispatched = await this.reDispatch(loop, batch);
      } catch (retryErr) {
        verdict = `收口处理异常且兜底 failBatch 仍失败（批次滞留 running，需人工介入：${(retryErr as Error).message}）`;
        this.warn(
          `兜底 failBatch 仍失败（任务 ${loop.jobId} 批次 ${batch.id}）：${(retryErr as Error).message}——批次滞留 running，需人工介入（task.retry / cancel）`,
        );
      }
    }
    // 批次收口 = 实质推进事件：推进检查重驱机会复位（有界语义的界针对单次
    // 静置死局，非任务全生命周期一次——长任务多次静置各获一次重驱；收口后
    // 新死局再次重驱，持续不推进仍会 failJob，无无限循环面）。
    loop.progressRedriven = false;
    this.wake(loop, this.closureNotice(agentId, batch, verdict, redispatched));
    this.reapDrained(loop); // drain 态（haltJob 后）收口清扫
  }

  /**
   * B1 可观测：游离实例收口（本循环 spawn 过但未接线任何批次行——spawn 后
   * 未 task_dispatch_batch）：产物丢弃不进任务台账，warn + 纠偏注入编排
   * 会话（失败重派由引擎负责，勿自行另派）。
   */
  private noticeUnlinked(agentId: string): void {
    for (const loop of this.loops.values()) {
      if (loop.stopped || !loop.briefs.has(agentId)) continue;
      this.warn(
        `游离实例收口被丢弃（任务 ${loop.jobId} 实例 ${agentId}）：spawn 未接线任何批次行（insertBatch 后未 task_dispatch_batch）——产物不进任务台账`,
      );
      this.wake(
        loop,
        `【派发纠偏】实例 ${agentId} 已收口但未接线任何批次行，产物已丢弃。若你正准备对该实例 task_dispatch_batch：机械面会拦截终态实例接线并把批次自动转失败收口、由引擎重派新实例——不要再对该实例操作；后续新批次请 spawn 后立即 task_dispatch_batch 接线。`,
      );
      return;
    }
  }

  /** drain（haltJob 后）收口清扫：全部实例终态且无 running 批次 → 丢弃循环。 */
  private reapDrained(loop: LoopState): void {
    if (!loop.drain) return;
    const inFlight = [...loop.briefs.keys()].some(
      (id) =>
        this.deps.instanceOutcome(id)?.state === "queued" || this.deps.instanceOutcome(id)?.state === "running",
    );
    if (inFlight) return;
    if (this.allBatches(loop.jobId).some((b) => b.status === "running")) return;
    loop.stopped = true;
    this.loops.delete(loop.jobId);
    this.info(`drain 完成，编排循环自清（任务 ${loop.jobId}）`);
  }

  /** agentId → 在册循环 + 批次行（按 brief 登记簿定位 jobId 再查行）。drain 态循环放行（收口照常落库）。 */
  private locate(agentId: string): { loop: LoopState; batch: BatchData } | undefined {
    for (const loop of this.loops.values()) {
      if ((loop.stopped && !loop.drain) || !loop.briefs.has(agentId)) continue;
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

  /**
   * 恢复扫描面（原 sweepRetries，task-efd68911 扩为对账面）双类扫描：
   * ① failed 批次预算内补派（原语义）：暂停期/停循环期失败的批次在唤醒时
   * 补派；人工重试（task.retry）归零的 failed 批次同口补派。
   * ② running 挂终态实例补收口（对账兜底）：收口链断链（注入回调断/迟到
   * 接线漏网）时批次永无人收口——failBatch 补收口 + 按余量重派/上浮。
   * 触发点：startOrchestrator（启动/幂等唤醒）+ resume（经 startOrchestrator）
   * + 驱动回合结束点（driveLoop finally——编排任何一次收场即对账）。
   * sweeping 防重入（异步并发双扫会双派）；failBatch running 断言兜底竞态。
   */
  private async sweepBatches(jobId: string): Promise<void> {
    const loop = this.loops.get(jobId);
    if (loop === undefined || loop.stopped || loop.sweeping) return;
    const job = this.deps.store.getJob(jobId);
    if (job === undefined || job.status !== "running") return;
    loop.sweeping = true;
    try {
      for (const batch of this.allBatches(jobId)) {
        if (batch.status === "failed") {
          if (batch.retryCount >= MAX_BATCH_RETRY) continue;
          const current = this.deps.store.getBatch(batch.id);
          if (current === undefined || current.status !== "failed") continue; // 并发迁移守卫
          const agentId = await this.reDispatch(loop, current);
          if (agentId !== null) {
            this.wake(
              loop,
              `【重派补漏】批次 #${current.stageSeq}.${current.seq}「${current.scope}」已补派新实例 ${agentId}（前序失败 ${current.retryCount} 次）。`,
            );
          }
          continue;
        }
        // ② running 挂终态实例（对账兜底，task-efd68911）：实例已终态但批次滞留
        // running——收口链断链（closure 注入未达/迟到接线漏网），永无人再收口
        if (batch.status === "running" && batch.instanceId !== null) {
          const outcome = this.deps.instanceOutcome(batch.instanceId);
          const state = outcome?.state;
          if (this.isLiveInstanceState(state)) continue; // 活实例在跑/排队/挂起：非挂死
          try {
            const { retryScheduled } = await this.deps.taskEngine.failBatch(
              batch.id,
              `对账补收口：running 批次实例 ${batch.instanceId} 已终态（${state}${outcome?.summary !== undefined ? `：${outcome.summary}` : ""}）——收口链断链兑底`,
            );
            // failBatch 后重读批次行：retryCount/retryNote 已更新（迭代前快照为 running 旧行）
            // ——重派 brief（前次失败次数/原因）与 wake 文案按现值装配（①分支 current 同构）
            const current = this.deps.store.getBatch(batch.id) ?? batch;
            let redispatched: string | null = null;
            if (retryScheduled) redispatched = await this.reDispatch(loop, current);
            this.wake(
              loop,
              `【批次对账】批次 #${current.stageSeq}.${current.seq}「${current.scope}」实例 ${batch.instanceId} 已终态但批次滞留 running——已机械补收口${
                redispatched !== null ? `并自动重派新实例 ${redispatched}` : "（重试耗尽已上浮任务失败）"
              }。`,
            );
          } catch (err) {
            // 竞态（对账与他路收口并发）：failBatch running 断言拒——warn 可观测不阻断其余批次
            this.warn(`对账补收口异常（任务 ${jobId} 批次 ${batch.id}）：${(err as Error).message}`);
          }
        }
      }
    } finally {
      loop.sweeping = false;
    }
  }

  // ── 内部：推进检查（收场点兑底，task-efd68911 第二重事故）──

  /** 实例调度态是否仍在推进（queued/running/parked——非终态且未查无）。 */
  private isLiveInstanceState(state: string | undefined): boolean {
    return state === "queued" || state === "running" || state === "parked";
  }

  /**
   * 推进检查排程（延迟窗）：每次驱动收场重置定时器——窗内出现新事件驱动
   * （收口/生命周期/新回合）则到点检查自然跳过（状态判定现拍）；窗到点仍
   * 无事件驱动才判死局。循环退场/停摆时清理（clearProgressTimer）。
   */
  private scheduleProgressCheck(loop: LoopState): void {
    if (loop.stopped || loop.parked || loop.drain || loop.running) return;
    if (loop.stashedWakes.length > 0) return; // 待回放唤醒在场：事件驱动优先
    this.clearProgressTimer(loop);
    const timer = setTimeout(() => {
      loop.progressTimer = undefined;
      void this.checkProgressAfterDrive(loop).catch((err) =>
        this.warn(`推进检查异常（任务 ${loop.jobId}）：${(err as Error).message}`),
      );
    }, this.deps.progressCheckDelayMs ?? PROGRESS_CHECK_DELAY_MS);
    timer.unref?.(); // 不挂住进程退出（测试 dispose 后触发也不阻退场）
    loop.progressTimer = timer;
  }

  private clearProgressTimer(loop: LoopState): void {
    if (loop.progressTimer !== undefined) {
      clearTimeout(loop.progressTimer);
      loop.progressTimer = undefined;
    }
  }

  /**
   * 推进检查（延迟窗到点，sweepBatches 之后）：无在跑实例 + 任务存在
   * 未完批次/阶段 + 无暂存唤醒（事件驱动不在场）→ 有界重驱一次；已重驱
   * 仍此态 → failJob。事故形态：编排会话收场（如网络错误收场）后无任何
   * wake 源（无在跑实例 = 无 closure 通知），剩余 pending 批次/stage 永无人
   * 推进，job 永久 running。有界 = progressRedriven 单次位（网络持续断时
   * 重驱轮同样收场 → 再静置一窗 → failJob 快速失败，不无限循环；批次收口
   * 时复位——界针对单次静置死局非任务全生命周期）。
   *
   * 覆盖面含装配期（pending 任务零批次死局，前端「装配中」永久卡）：
   * kickoff 持续失败/收场零动作时零批次 = 零 closure 事件 = 零外部唤醒源，
   * 滞留 pending 无人接管——pending 同入推进检查（收口经 failJob 桥接
   * pending→running→failed 两段落定，观察者只见终值）。
   */
  private async checkProgressAfterDrive(loop: LoopState): Promise<void> {
    if (loop.stopped || loop.parked || loop.drain || loop.running) return;
    if (loop.stashedWakes.length > 0) return; // 待回放唤醒在场：事件驱动优先，不接管
    // 到点先对账：延迟窗内死亡的实例（收场后才终态且收口链断链）在此补收口
    // ——sweep 内的收口/重派 wake 会驱动新轮，后续推进判定自然跳过
    await this.sweepBatches(loop.jobId);
    if (loop.stopped || loop.parked || loop.drain || loop.running) return; // 对账后重验（wake 可能已开新轮）
    if (loop.stashedWakes.length > 0) return;
    const job = this.deps.store.getJob(loop.jobId);
    // 装配期覆盖（pending 同入）：pending 任务 stages 全 pending → 未完面恒真，
    // 死局判定走同一重驱/收口链（failJob 引擎面桥接 pending）；paused 不自动
    // 推进（resume 归显式命令）、终态无未完面可接管。
    if (job === undefined || (job.status !== "running" && job.status !== "pending")) return;
    const stages = this.deps.store.getStages(loop.jobId);
    const batches = this.allBatches(loop.jobId);
    const unfinished =
      batches.some((b) => b.status !== "done") || stages.some((s) => s.status !== "done");
    if (!unfinished) return; // 全部完成：收口归收口通知轮（无未完面）
    const inFlight = [...loop.briefs.keys()].some((id) =>
      this.isLiveInstanceState(this.deps.instanceOutcome(id)?.state),
    );
    if (inFlight) return; // 有在跑/排队实例：等收口事件驱动
    if (!loop.progressRedriven) {
      loop.progressRedriven = true;
      this.warn(
        `推进检查（任务 ${loop.jobId}）：驱动收场后无在跑实例但存在未完批次/阶段——重驱一次提示推进（再不推进将 failJob）`,
      );
      this.wake(loop, PROGRESS_CHECK_NOTICE);
      return;
    }
    // 已重驱过仍此态：failJob 收口（引擎面 pending 桥接/running 两态可收；
    // 停摆复用 haltJob 语义——无在跑实例无可摘，幂等安全）
    try {
      await this.deps.taskEngine.failJob(
        loop.jobId,
        job.status === "pending"
          ? "装配期死局：编排会话持续无法驱动/零推进（零批次零实例，推进检查重驱一次后仍无进展）——failJob 收口"
          : "编排会话收场且无在跑实例，任务无法推进（推进检查重驱一次后仍未推进）——failJob 收口",
      );
      this.warn(`推进检查（任务 ${loop.jobId}）：重驱后仍无法推进——任务已失败收口`);
      this.haltJob(loop.jobId);
    } catch (err) {
      this.warn(`推进检查 failJob 异常（任务 ${loop.jobId}）：${(err as Error).message}`);
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
    // B1 派发闸：非 pending/running（paused/failed/cancelled/done）拒绝——停摆/
    // 终态后编排 LLM 不得再 spawn（历史事故：job failed 后 LLM 回合内继续
    // agent_spawn，产物无法接线全部丢弃）
    if (job.status !== "pending" && job.status !== "running") {
      return { status: "rejected", error: `任务 ${jobId} 状态 ${job.status}——不可派发批次实例（失败重派由引擎自动重试/人工重试负责）` };
    }
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
    // D8 W-R6：观测面同源分流结果（批次实例 profileKind 按任务类型路由；
    // 缺省与 dispatch 缺省一致——task-worker 已撤，单源 DEFAULT_PROFILE_KIND）
    const profileKind = job !== undefined ? dispatchProfileKindOf(job.type) : DEFAULT_PROFILE_KIND;
    return {
      spawn: (task: string) => this.spawnBatch(jobId, task),
      send: () => ({ delivered: false, detail: "任务批次实例不支持编排会话消息注入" }),
      status: (agentId) => {
        if (agentId === undefined) return [];
        const outcome = this.deps.instanceOutcome(agentId);
        if (outcome === undefined) return [];
        const state = ["queued", "running", "done", "failed", "cancelled"].includes(outcome.state)
          ? (outcome.state as "queued" | "running" | "done" | "failed" | "cancelled")
          : "running"; // 未知态兑底 running（清单 #2.5：不再静默——warn 可观测，防异常态被观测面掩盖）
        if (state === "running" && !["queued", "running"].includes(outcome.state)) {
          this.warn?.(`任务 ${jobId} 实例 ${agentId} 状态未知（${String(outcome.state)}）——观测面兑底 running`);
        }
        return [
          {
            agentId,
            state,
            // U2 观测态：批次实例均 subagent（窗口态直译；parked 不在批次
            // 词汇——兑底窗口原值）
            displayState: displayStateOf({ kind: "subagent", window: state === "queued" ? "queued" : state === "running" ? "running" : state }),
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
      // ⑤ 链 C：编排会话不声明 agent_park/agent_resume（P1 仅 Main）——
      // 任务域批量挂起归 TaskEngine 接线（reason=taskPause），不经编排会话 LLM 面
      park: () => ({ parked: false, error: "任务批次实例不支持编排会话挂起" }),
      resume: () => ({ resumed: false, error: "任务批次实例不支持编排会话恢复" }),
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
              `#${b.stageSeq}.${b.seq}「${b.scope}」${b.status}${b.retryNote !== null ? `（重试 ${b.retryCount} 次：${b.retryNote}）` : ""}${b.instanceId !== null ? `，实例 ${b.instanceId}` : ""}`,
          );
    const doneBatches = batches.filter((b) => b.status === "done").map((b) => `#${b.stageSeq}.${b.seq}「${b.scope}」`);
    return [
      "【任务起跑】你是本任务的编排主 agent。以下是任务参数、冻结阶段行、恢复现场与任务 skill 全文——按 skill SOP 执行编排循环。",
      "",
      `任务类型：${job.type}`,
      `参数：${JSON.stringify(job.params)}`,
      `项目标签：${JSON.stringify(job.projects)}`,
      `任务报告目录：${this.deps.reportsDirFor(taskSessionIdOf(job.id))}（任务级汇总报告固定落点：该目录下 summary.md；各批次报告同目录——write 仅用于该目录内产物落盘，项目代码零写）`,
      "",
      "【阶段计划（已冻结，不重议不增删）】",
      ...stageLines,
      "",
      "【恢复现场（批次行状态——权威状态，从这续跑）】",
      ...batchLines,
      ...(doneBatches.length > 0 ? ["已完成批次：" + doneBatches.join("、")] : []),
      "",
      "【接管与推进说明】本任务当前 pending=待接管：task_insert_batch / task_advance_stage / task_stage_artifact 任一动作即接管激活（pending→running）——不存在人审门；skill 的 confirm 字段是「开启前对话确认」语义（发起侧已完成），不是执行中的门。阶段按冻结序推进：前序阶段全部 done 后才可对后续阶段插批/推进/聚合（机械守卫，越序会被拒）。",
      "",
      "【派发纪律】running/failed 批次已由引擎派发或自动重派（上表实例号即证据）——不要对它们自行另派实例；新批次须 insertBatch 落行、spawn 后立即 task_dispatch_batch 接线，未接线实例的产物会被丢弃；接线已终态实例会被机械转失败收口并由引擎重派，无需你另派。",
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

  private info(message: string): void {
    this.deps.logger?.info(`[orchestrator] ${message}`);
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
          "## 前序 todo 摘要（接力恢复——从断点继续，不重做已完成探索）",
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

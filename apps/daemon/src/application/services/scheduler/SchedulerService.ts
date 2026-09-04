import { AgentInstance, newInstanceId, type AgentInstanceData } from "../../../domain/agent/AgentInstance";
import { AgentLifecycle } from "../../../domain/agent/AgentLifecycle";
import type { SchedulingPolicy } from "../../../domain/agent/SchedulingPolicy";
import type {
  AgentInstantiatedPayload,
  AgentParkedPayload,
  AgentQueuedPayload,
  AgentResumedPayload,
  AgentSpawnedPayload,
  AgentStartedPayload,
  AgentStalledPayload,
  DomainEvent,
  InstanceClosurePayload,
  ParkReason,
} from "../../../domain/events/DomainEvent";
import { PARK_INSTRUCTION_TEXT, RESUME_INSTRUCTION_TEXT } from "./parkProtocol";
import type { EventPublisherPort } from "../../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../ports/outbound/ClockPort";
import type { SessionRepositoryPort } from "../../ports/outbound/SessionRepositoryPort";
import type { AgentEngineEvent } from "../../ports/outbound/AgentEnginePort";
import type {
  AgentInspection,
  AgentInstanceStatus,
  AgentOrchestrationPort,
  KillOutcome,
  ParkOutcome,
  ResumeOutcome,
  SendOutcome,
  SpawnOutcome,
} from "../../ports/inbound/AgentOrchestrationPort";
import type { InstanceClosureOutcome, InstanceRunner } from "../InstanceRunner";
import type { InstanceSnapshotEntry } from "../../ports/inbound/SessionPort";
import type { RestoredInstance } from "../RestoreService";
import { SubagentEventTranslator } from "./SubagentEventTranslator";
import { ClosureRecorder, type ClosureFindingsSink } from "./ClosureRecorder";

/**
 * SchedulerService —— SubAgent 调度编排门面（architecture.md §4，AD-7）。
 * （守护式三拆：门面 + SubagentEventTranslator + ClosureRecorder）
 *
 * 【业务流转总览】
 *
 *   spawn(task, profileKind?)（编排入口：agent_spawn 工具/WS 命令 → 本服务）
 *     ├─ SchedulingPolicy.decideSpawn 预算判定
 *     │   ├─ run     → 建 AgentInstance（注册表登记）→ agent.spawned 出卡
 *     │   │            → markRunning → agent.started → runner.launch（异步执行）
 *     │   ├─ enqueue → agent.spawned + 入 FIFO 队列（内存，AD-10 不落盘）
 *     │   │            → agent.queued{position}（1 起）
 *     │   └─ reject  → 返回错误字符串（预算真实耗尽，调用方回 LLM）
 * ├─ send(agentId, message)（AD-7⑤）→ runner.send → transport →
 *     │   子进程 stdin → Agent.steer()（turn 边界 drain 生效）
 *     ├─ 实例收口回调（done/failed/killed）→ 状态机迁移 + closure 收口链：
 *     │   ①WriteQueue 落盘（closure_records 记录行 + reportPath 报告文件，
 *     │     O-5 双产物，抗重启）②SteerQueue 注入主线（`agent-N closure:
 *     │     <status> — <summary>`，与用户 steer 同队列 FIFO——MainAgent
 *     │     idle 则立即新 turn / running 则下轮 turn 边界 drain，AD-8 双通道）
 *     │   ③agent.completed/failed/killed 领域事件（closure 归一：可选字段
 *     │     显式 null）+ agent_lifecycle 投影落盘（单写通道）
 *     │   → 空位释放 → FIFO 出队 → 队首 agent.started + launch；
 *     │     剩余位次整体递减并重发 agent.queued
 *     ├─ stalled 监视（定时器轮询 per-instance lastEventAt）
 *     │   → agent.stalled{idleMs} 警示可重复推，不自动杀（状态仍 running）
 * └─ kill(agentId)（用户终止， kill 通道）→ 先 runner.kill
 *         （O-6 终止信号，迟到自然收口被幂等吞）→ killed 收口路径
 *
 * 【拆分（TR-AD-25④ 守护式）】编排门面保留注册表/FIFO 队列力学/
 * stalled 监视/观测面读方法（12 public API 面零变化）；引擎事件翻译状态机
 * （6 个 per-instance Map 写侧 + entry id 分配 + onClosureCleanup 清理序列
 * 单点）→ SubagentEventTranslator；closure 收口链（归一/双产物/投影/终态
 * 事件/SteerQueue 注入）→ ClosureRecorder。依赖注入方向：本门面 →
 * translator + recorder → ports。runner 回调契约零变化：setCallbacks 恰
 * 2 回调（onInstanceEvent/onInstanceClosure），回调体一行转发。
 *
 * 【非线性红线】实例创建/销毁一等 API；不假设按序推进——queued 可直接
 * 收口 failed（摘队+位次递减）、kill 可落在任意状态、终态幂等（迟到收口被
 * 吞）、重派 = 新 instanceId 新实例。状态权威在 AgentInstance 状态机，
 * 本服务只编排不改写规则。
 *
 * 【id 分配】agent-<唯一字符串>（T10a 方案 A：生成单点 newInstanceId()，
 * agent- + crypto.randomUUID() 去横线——主实例与 SubAgent 同一生成逻辑；
 * 无序号基线概念：连续 spawn 天然互异，重启后无撞号）。
 */

export type { SpawnOutcome };

// ParkOutcome/ResumeOutcome 单源在 AgentOrchestrationPort（⑤ 链 C 工具面
// 接入；结构同前——本地双源消除）
export type { ParkOutcome, ResumeOutcome };

/** profileKind 缺省值（Q-6=A：单一通用 worker）。 */
const DEFAULT_PROFILE_KIND = "subagent-worker";

export interface SchedulerServiceDeps {
  /** 调度策略（纯判定；maxConcurrent/maxQueued/stalled 阈值由此携带）。 */
  readonly policy: SchedulingPolicy;
  /** 实例运行器（SubagentLauncher 真体；替身跑 integration）。 */
  readonly runner: InstanceRunner;
  /** 事件流发布（领域事件 → fan-out：stdout/WS 落盘目标）。 */
  readonly events: EventPublisherPort;
  /** 持久化（closure 记录行/报告文件/agent_lifecycle 投影，经 WriteQueue 单写通道）。 */
  readonly repository: SessionRepositoryPort;
  /** 时间源（领域事件 occurredAt / 实例 createdAt / stalled 毫秒判定，测试可控）。 */
  readonly clock: ClockPort;
  /**
   * 任务报告目录（O-5：<home>/reports/<session>；**多会话**：调度器
   * daemon 全局一份，报告目录按实例归属会话解析——注入 (sessionId) => dir；
   * 缺省不产报告文件（closure.reportPath 为 null——既有测试口径）。
   */
  readonly reportsDirFor?: (sessionId: string) => string;
  /**
   * findings 旁路文件读（task-778eb18a 截断兜底）：透传 ClosureRecorder；
   * 组合根接 fs 只读实现（application 零 IO）；缺省不兜底（测试形态）。
   */
  readonly readFindingsFile?: (path: string) => string | null;
  /**
   * closure 注入主线回调（AD-8 双通道之一；组合根接 ChatService.injectClosure）。
   * 可选——无主线编排场景（纯调度 integration）不注入。
   * source（T11a）：closure=收口注入（ClosureRecorder 链）；progress=周期进展报告。
   */
  readonly injectClosure?: (agentId: string, message: string, source?: "closure" | "progress") => void;
  /** stalled 轮询间隔 ms（缺省 阈值/2；测试注入小值）。 */
  readonly stalledPollMs?: number;
  /**
   * spawn 锚计算（契约 v0.3 §1 规则②，AD-5）：spawn 时刻聚合内最后一条
   * main/compaction entry 的 id（无 → null 流首）。组合根注入（会话聚合视图
   * 读面）；spawn 处理点计算一次，随实例视图内存携带（派生值不落盘，无第二
   * 事实源——E-AgentInstance 禁忌）；缺省 = 纯调度测试形态（锚点面缺席）。
   */
  readonly spawnAnchorFor?: (sessionId: string) => string | null;
  /**
   * Sub 实例化快照供给（AD-5，契约 v0.4 §2）：spawn 时与
   * agent.spawned 同批发布 agent.instantiated 的快照数据源——profile 常量
   * （systemPrompt 全文/工具集/hooks 名）与模型两级链解析（profile 槽位 ??
   *   全局兜底，AD-3 联动；T12 砍 spawn 会话快照级）均归组合根装配（driven
   *   常量不进 application）；缺省 = 纯调度测试形态，不发布 instantiated。
   * 入参 profileKind（D8 W-R6）：实例 kind 派发（subagent-kg-writer 领
   * 豁免面快照——组合根组装缓存按 kind 拼生效集）。
   */
  readonly subagentSnapshotFor?: (profileKind?: string) => {
    readonly profileSnapshot: AgentInstantiatedPayload["profileSnapshot"];
    /** spawn 解析的 thinkingLevel 快照（AD-4④；与 launcher resolveThinkingFor 同源同时点；无配置 → undefined = 默认关）。 */
    readonly thinkingLevel: string | undefined;
  };
  /**
   * 任务文本切片注入器（T3.3，CL-1 F1.3）：spawn 派发时任务文本 → 图
   * 查询 → digest+指针切片拼入 task 约束区（组合根接 KgQueryService.
   * injectTaskSlice——sessionId 即跨通道去重键）。返回值 = 子进程实际收到
   * 的 task；注入器抛错/缺席 → 原文透传（注入是增强，绝不阻断 spawn）。
   */
  readonly taskInjector?: (sessionId: string, task: string) => string;
  /**
   * 实例终态钩子（CDP 地基）：done/failed/killed 收口链完成后回调——
   * 组合根接 `browserPort.reclaimOwner`（回收该 owner 全部 managed tabs，
   * 浏览器侧资源随 agent 终态释放；idle sweep 兼底）。可选——纯调度测试
   * 形态不注入；迟到/重复收口被门面幂等吞，钩子恰好触发一次。
   */
  readonly onInstanceTerminal?: (agentId: string) => void;
  /** 日志（容器接 file logger——kill 终止信号失败/findings 落账跳过可观测；缺省静默）。 */
  readonly logger?: { warn: (message: string) => void };
  /**
   * findings 落账管道（F3.0③，透传 ClosureRecorder）：closure findings
   * 非空时映射 kg 写 op 落账（组合根接 kg 栈 KgWriteService 唯一写入口）。
   * 缺省不落账（纯调度测试形态）。
   */
  readonly findingsSink?: ClosureFindingsSink;
  /**
   * pending_sync job 归属解析（W2-D R13，透传 ClosureRecorder）：task:*
   * 会话 → jobId、chat 会话 → null；缺省恒 null（job_id 可空列）。
   */
  readonly pendingSyncJobIdOf?: (sessionId: string) => string | null;
}

/**
 * implements 注记（T3-A）：spawn 为 sessionId 前置的「绑定前」形态
 * （组合根门面闭包注入 sessionId 后才是 Port 形状）；Port.spawn 第三参
 * reportIntervalMs 与本方法第三参 profileKind 类型错位，结构性 implements
 * 不再成立——退为 Omit 实现（send/status/kill/inspect 仍受编译期守卫），
 * spawn 的类型安全由组合根门面字面量（: AgentOrchestrationPort）承担。
 */
export class SchedulerService implements Omit<AgentOrchestrationPort, "spawn"> {
  /** 会话内实例注册表（AgentLifecycle 的注册表面；会话运行态不在此管）。 */
  private readonly registry = new AgentLifecycle();
  /** FIFO 队列（instanceId 有序；内存队列不落盘，AD-10——重启清队归恢复链）。 */
  private readonly queue: string[] = [];
  /** 实例 → task（出队时 launch 入参；报告/观测面留档）。 */
  private readonly tasks = new Map<string, string>();
  /** spawn 时刻的透传模型 id（组合根两级链解析产物——AgentInstanceDto.model 空槽位填充链——出卡即知；T12 起不进 launcher 解析链）。 */
  private readonly spawnModels = new Map<string, string>();
  /** 实例 → 收口 closure（agent_status 摘要/观测面留档；终态后保留）。 */
  private readonly closures = new Map<string, InstanceClosurePayload>();
  /** 实例 → spawn 时刻锚（规则②内存携带；含 null 流首——has 判定区分未装配）。 */
  private readonly spawnAnchors = new Map<string, string | null>();
  private monitor: ReturnType<typeof setInterval> | undefined;
  // ── T3-A 周期进展报告（per-instance 定时器；系统只送达信息，永不自动终止） ──
  /** 实例 → 报告间隔 ms（spawn 入参校验后 >0 才登记；缺省/0/负数/NaN 不报告）。 */
  private readonly reportIntervals = new Map<string, number>();
  /** 实例 → 报告定时器（startInstance 建立；终态/stop/cancelSession 清理）。 */
  private readonly reportTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** 实例 → 报告序号（信封 #k，1 起）。 */
  private readonly reportSeqs = new Map<string, number>();
  /** 实例 → 上次报告计数器快照（Δ = 现值 − 快照）。 */
  private readonly lastReportedMetrics = new Map<string, { toolCalls: number; assistantChars: number; turns: number }>();
  /** 引擎事件翻译状态机（拆分：6 per-instance Map 写侧 + entry id 分配 + 清理序列单点）。 */
  private readonly translator: SubagentEventTranslator;
  /** closure 收口链（拆分：归一/双产物/投影/终态事件/SteerQueue 注入）。 */
  private readonly recorder: ClosureRecorder;
  // ── park/resume 批（设计稿 §2.1/§4）：挂起语义 per-instance 登记面 ──
  /** 实例 → park 请求已注入待确认（running 期；parked 上行时消费——原因随行）。 */
  private readonly pendingParks = new Map<string, ParkReason>();
  /** 实例 → 挂起观测字段（agent_status parkedReason/parkedAt；resume/终态清理）。 */
  private readonly parkedInfos = new Map<string, { reason: ParkReason; parkedAt: string }>();
  /** 队列内待恢复实例（resume 预算满入队；出队时 RESUME 恢复而非 launch——执行载体还活着）。 */
  private readonly resumePending = new Set<string>();

  constructor(private readonly deps: SchedulerServiceDeps) {
    this.translator = new SubagentEventTranslator({ events: deps.events, clock: deps.clock });
    this.recorder = new ClosureRecorder({
      repository: deps.repository,
      events: deps.events,
      clock: deps.clock,
      reportsDirFor: deps.reportsDirFor,
      readFindingsFile: deps.readFindingsFile,
      injectClosure: deps.injectClosure,
      logger: deps.logger,
      ...(deps.findingsSink !== undefined ? { findingsSink: deps.findingsSink } : {}),
      ...(deps.pendingSyncJobIdOf !== undefined ? { pendingSyncJobIdOf: deps.pendingSyncJobIdOf } : {}),
    });
    // 契约（park/resume 批起：3 回调——新增 onInstanceParked 转发，回调体一行转发）
    this.deps.runner.setCallbacks({
      onInstanceEvent: (instanceId, event) => this.onInstanceEvent(instanceId, event),
      onInstanceClosure: (instanceId, outcome) => this.onInstanceClosure(instanceId, outcome),
      onInstanceParked: (instanceId, summary) => this.onInstanceParked(instanceId, summary),
    });
    const poll = deps.stalledPollMs ?? Math.max(1, Math.floor(deps.policy.stalledThresholdMs / 2));
    this.monitor = setInterval(() => this.checkStalled(), poll);
  }

  /** 停 stalled 监视定时器 + 全部进展报告定时器（daemon shutdown / 测试收尾；幂等）。stop 同段清报告面三 Map（与 clearProgressReporting 全清语义一致——终态无可投递对象，不残留登记）。 */
  stop(): void {
    if (this.monitor !== undefined) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
    for (const timer of this.reportTimers.values()) clearInterval(timer); // T3-A
    this.reportTimers.clear();
    this.reportIntervals.clear();
    this.reportSeqs.clear();
    this.lastReportedMetrics.clear();
  }

  // ── 观测面（agent_status 工具取数） ───────────────────────

  /** 按 id 查实例值形状（不存在/已销毁窗口返回 undefined）。 */
  instance(agentId: string): AgentInstanceData | undefined {
    return this.registry.findInstance(agentId)?.toData();
  }

  /** AgentOrchestrationPort.status：无参全量（状态/位次/摘要）/有参单实例。 */
  status(agentId?: string): AgentInstanceStatus[] {
    if (agentId !== undefined) {
      const one = this.registry.findInstance(agentId);
      return one ? [this.toStatus(one)] : [];
    }
    return this.registry.listInstances().map((i) => this.toStatus(i));
  }

  /**
   * AgentOrchestrationPort.inspect（T3-B）：执行核实视图——状态/任务/起止/
   * idleMs/累计工具数/最近 20 条轨迹；不存在 → null（与 status 空值同族）。
   * 终态实例：lastEventAt/idleMs 不再观测（null）——轨迹/计数已随清理序列清空。
   */
  inspect(agentId: string): AgentInspection | null {
    const instance = this.registry.findInstance(agentId);
    if (!instance) return null;
    const last = instance.isTerminal ? undefined : this.translator.lastEventAtOf(agentId);
    const task = this.tasks.get(agentId);
    return {
      instanceId: agentId,
      state: instance.current,
      ...(task !== undefined ? { task } : {}),
      startedAt: instance.createdAt,
      lastEventAt: last ?? null,
      idleMs: last === undefined ? null : Math.max(0, this.deps.clock.nowMs() - last),
      toolCalls: this.translator.metricsOf(agentId).toolCalls,
      trace: this.translator.traceOf(agentId),
    };
  }

  /** 快照观测面：instances[] 装配载荷（注册表 + task + closure；DtoMapper 转协议）。
   * （AD-4 多会话）：可选 sessionId 过滤——只取归属会话的实例（快照按会话组装）。 */
  snapshotInstances(sessionId?: string): InstanceSnapshotEntry[] {
    return this.registry
      .listInstances()
      .filter((instance) => sessionId === undefined || instance.sessionId === sessionId)
      .map((instance) => {
        const task = this.tasks.get(instance.instanceId);
        const closure = this.closures.get(instance.instanceId);
        const model = this.spawnModels.get(instance.instanceId);
        return {
          ...instance.toData(),
          ...(task !== undefined ? { task } : {}),
          ...(closure !== undefined ? { closure } : {}),
          ...(model !== undefined ? { model } : {}),
          // 契约 v0.3 §1 规则②：spawn 时值随实例视图携带（含 null 流首；
          // 恢复实例无此值 → 组装面退化尾部推导，契约记录在案边界）
          ...(this.spawnAnchors.has(instance.instanceId)
            ? { spawnAnchorEntryId: this.spawnAnchors.get(instance.instanceId)! }
            : {}),
        };
      });
  }

  /** spawn 时刻锚观测面（agent.spawned 增量帧 enrichment 读面；未登记 undefined）。 */
  spawnAnchorOf(instanceId: string): string | null | undefined {
    return this.spawnAnchors.get(instanceId);
  }

  /** 会话是否有活跃实例（运行态观测/空闲卸载判定——queued/running/parked 均算活跃：parked 窗口未销毁、进程驻留）。 */
  hasActiveInstances(sessionId: string): boolean {
    return this.registry
      .listInstances()
      .some(
        (i) =>
          i.sessionId === sessionId &&
          (i.current === "running" || i.current === "queued" || i.current === "parked"),
      );
  }

  /**
   * 会话级取消（AD-4 删除收口链第①步）：该会话全部实例收口终态——
   * queued → cancelled（摘队位次递减，无 closure 行——与重启清队同口径）；
   * running → kill（终止信号先行 + killed 收口，单一终态语义）。
   * 同步完成（收口链内联）；终态实例跳过（幂等）。
   */
  cancelSession(sessionId: string): void {
    for (const instance of this.registry.listInstances()) {
      if (instance.sessionId !== sessionId || instance.isTerminal) continue;
      if (instance.current === "queued") {
        const idx = this.queue.indexOf(instance.instanceId);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          this.republishPositions();
        }
        instance.cancel();
        this.translator.forgetLastEventAt(instance.instanceId);
        this.clearProgressReporting(instance.instanceId); // T3-A：queued 取消不走收口链，定点清定时器
        this.persistLifecycle(instance);
      } else {
        this.kill(instance.instanceId);
      }
    }
  }

  // ── 重启恢复（AD-10：注册表/闭包/任务/序号基线重建） ─────

  /**
   * 恢复产物注入（组合根装配后调用； 多会话下懒加载会话逐个注入）：
   * RestoreService 收口后的实例清单登记进注册表（终态/快照态原样）、
   * closure/task 回填观测面。实例 id 无序号基线（T10a：newInstanceId 唯一串，
   * 重启后新 spawn 天然不撞号——恢复侧零基线重建）。
   * 恢复不重放：不发布事件、不落盘（RestoreService 已收口落盘）、不触发
   * launch（不自动续跑）。
   *
   * 幂等注记：卸载后重载的会话实例仍在注册表（终态实例不出册）——
   * 已登记的 instanceId 跳过重注册（task/closure/序号仍刷新）。
   */
  restoreInstances(instances: readonly RestoredInstance[]): void {
    for (const item of instances) {
      if (this.registry.findInstance(item.instanceId) === undefined) {
        this.registry.registerInstance(
          AgentInstance.restore({
            instanceId: item.instanceId,
            kind: item.kind,
            profileKind: item.profileKind,
            sessionId: item.sessionId,
            state: item.state,
            createdAt: item.createdAt,
          }),
        );
      }
      if (item.task !== undefined) this.tasks.set(item.instanceId, item.task);
      if (item.closure !== undefined) this.closures.set(item.instanceId, item.closure);
      // spawnModels 回填——重启后恢复实例 model 字段不缺失
      //（快照 instances[] 组装面透出；数据源 = agent.spawned 载荷 model）
      if (item.model !== undefined) this.spawnModels.set(item.instanceId, item.model);
    }
  }

  // ── 编排入口 ──────────────────────────────────────────────

  /**
   * spawn：预算判定 → 直跑/入队/拒绝。同步秒回（不等执行收口，AD-8 异步交付）。
   * rejected 时调用方（agent_spawn 工具/WS）把错误字符串回 LLM/前端。
   *
   * sessionId 显式入参（AD-4 多会话：实例归属会话；组合根经当前会话
   * 门面/会话绑定工具注入，全局预算不随会话数分裂——TR-AD-11/16）。
   */
  spawn(sessionId: string, task: string, profileKind?: string, model?: string, reportIntervalMs?: number): SpawnOutcome {
    const decision = this.deps.policy.decideSpawn(this.runningCount(), this.queue.length);
    if (decision.action === "reject") {
      return {
        status: "rejected",
        error:
          `调度预算已耗尽：${this.runningCount()} 个实例运行中（maxConcurrent=` +
          `${this.deps.policy.maxConcurrent}）且队列已满（maxQueued=${this.deps.policy.maxQueued}），` +
          `请稍后重试或先结束现有实例`,
      };
    }

    const agentId = newInstanceId();
    const instance = AgentInstance.create({
      instanceId: agentId,
      kind: "subagent",
      profileKind: profileKind ?? DEFAULT_PROFILE_KIND,
      sessionId,
      createdAt: this.deps.clock.now(),
    });
    this.registry.registerInstance(instance);
    // 任务文本切片注入（F1.3）：task 文本成形后、传给 launcher 前单点挂接
    // ——预算判定通过才注入（reject 不注入）；注入失败原文透传（不阻断）
    let effectiveTask = task;
    if (this.deps.taskInjector !== undefined) {
      try {
        effectiveTask = this.deps.taskInjector(sessionId, task);
      } catch {
        // 注入器异常：原文透传（增强面静默降级——调度语义不受 kg 状态影响）
      }
    }
    this.tasks.set(agentId, effectiveTask);
    if (model !== undefined) this.spawnModels.set(agentId, model); // spawn 时透传解析后模型 id（DTO 填充）
    // T3-A：报告间隔校验（>0 且有限才启用；负数/NaN/0 视为不报告）
    if (typeof reportIntervalMs === "number" && Number.isFinite(reportIntervalMs) && reportIntervalMs > 0) {
      this.reportIntervals.set(agentId, Math.floor(reportIntervalMs));
    }
    // 契约 v0.3 §1 规则②：spawn 时刻锚计算一次（聚合内最后一条
    // main/compaction entry；无 → null 流首），内存携带——后续快照组装不按
    // 当前尾部重算；不落盘（派生值，重启后按规则①重建/尾部推导边界）
    if (this.deps.spawnAnchorFor !== undefined) {
      this.spawnAnchors.set(agentId, this.deps.spawnAnchorFor(sessionId));
    }
    // 出卡事件：预算内直跑也会先发 spawned（卡片进入），再由 started 转 running
    this.publish(instance, "agent.spawned", {
      agentId,
      task: effectiveTask,
      profileKind: instance.profileKind,
      ...(model !== undefined ? { model } : {}),
    } satisfies AgentSpawnedPayload);
    // 同批发布实例化快照（紧随其后）——（AD-5，契约 v0.4 §2）
    // 快照 model = 两级链解析结果（spawn 时刻求值，与该实例 launch 实际使用
    // 模型同源）；只落盘不广播（DtoMapper 无 case）。
    if (this.deps.subagentSnapshotFor !== undefined) {
      const snapshot = this.deps.subagentSnapshotFor(instance.profileKind);
      this.publish(instance, "agent.instantiated", {
        instanceId: agentId,
        profileKind: instance.profileKind,
        thinkingLevel: snapshot.thinkingLevel, // spawn 解析快照（AD-4④；只落盘不广播）
        profileSnapshot: snapshot.profileSnapshot,
      } satisfies AgentInstantiatedPayload);
    }

    if (decision.action === "run") {
      this.startInstance(instance);
      return { status: "run", agentId };
    }

    const position = this.deps.policy.nextPosition(this.queue.length);
    this.queue.push(agentId);
    this.persistLifecycle(instance); // queued 投影（重启 cancelled 收口语义的读面）
    this.publish(instance, "agent.queued", { agentId, position } satisfies AgentQueuedPayload);
    return { status: "queued", agentId, position };
  }

  /**
   * AgentOrchestrationPort.send：向运行中实例转投消息（AD-7⑤）。
   * 未知/排队/终态实例不可注入（排队实例尚无执行载体，等 started 后再发）。
   */
  send(agentId: string, message: string): SendOutcome {
    const instance = this.registry.findInstance(agentId);
    if (!instance) return { delivered: false, detail: `实例 ${agentId} 不存在` };
    if (instance.current === "queued") {
      return { delivered: false, detail: `实例 ${agentId} 排队中（尚未启动），消息未投递` };
    }
    if (instance.isTerminal) {
      return { delivered: false, detail: `实例 ${agentId} 已终态（${instance.current}），消息未投递` };
    }
    if (this.deps.runner.send === undefined) {
      return { delivered: false, detail: `实例 ${agentId} 的执行载体不支持注入（runner 未实现 send）` };
    }
    this.deps.runner.send(agentId, message);
    // park/resume 批：挂起期注入照常投递——子进程 steer 队列暂存，resume 驱动的新 run 一并送达
    if (instance.current === "parked") {
      return { delivered: true, detail: `已注入 ${agentId}（挂起中暂存，恢复后送达）` };
    }
    return { delivered: true, detail: `已注入 ${agentId}（turn 边界生效）` };
  }

  /**
   * 用户 kill（WS agent.kill → AgentOrchestrationPort.kill）：任意状态幂等——
   * 未知/已终态返回 killed=false（WS 侧回 connection.error）；queued 摘队
   * （位次递减重发），running 释放空位触发出队。kill 收口
   * closure.status="failed"（单一终态语义，契约 §8-2）。
   *
   * 修复：收口前先 runner.kill 通知执行载体终止子进程（O-6）——
   * 只收口不发信号时子进程跑到自然收口，迟到回调虽被幂等吞、进程仍耗资源。
   */
  kill(agentId: string): KillOutcome {
    const instance = this.registry.findInstance(agentId);
    if (!instance) return { killed: false, error: `实例 ${agentId} 不存在（无法 kill）` };
    if (instance.isTerminal) {
      return { killed: false, error: `实例 ${agentId} 已终态（${instance.current}），无需 kill` };
    }
    // 终止信号先行（异步；runner 异常不阻断收口——收口本身不依赖子进程退出。
    // 异步拒绝可观测化，不再静默吞）
    try {
      const stopping = this.deps.runner.kill?.(agentId);
      if (stopping !== undefined)
        void Promise.resolve(stopping).catch((err) => {
          this.deps.logger?.warn(
            `[scheduler] kill 终止信号失败（实例 ${agentId}）：${(err as Error).message}——继续收口（收口不依赖子进程退出）`,
          );
        });
    } catch {
      // runner.kill 同步抛错：继续收口（迟到自然收口仍会被幂等挡住）
    }
    this.onInstanceClosure(agentId, {
      result: "killed",
      closure: {
        status: "failed",
        summary: "已由用户终止（kill）",
        reportPath: null,
        findings: null,
        taskId: null,
      },
    });
    return { killed: true };
  }

  // ── park/resume（挂起/恢复原语，⑤ park/resume 批；通用层——任务域/chat 域
  //    接线归后续波次。仅 subagent kind 生效（P5：主会话不参与挂起）──

  /**
   * park：经既有 steer 通道（runner.send）注入带协议标记的挂起指令
   * （协作式第一层）；状态迁移**待子进程 PARK 确认上行**（onInstanceParked
   * ——回合边界生效，当前工具调用完成后才挂起）。指令注入后至确认前实例
   * 仍 running（占预算）。幂等：pending 期重复请求不重发；已 parked no-op；
   * 终态拒（park 与自然收口竞态 = 终态赢，park 迟到作废）。
   */
  park(agentId: string, reason: ParkReason = "user"): ParkOutcome {
    const instance = this.registry.findInstance(agentId);
    if (!instance) return { parked: false, error: `实例 ${agentId} 不存在（无法 park）` };
    if (instance.kind !== "subagent") {
      return { parked: false, error: `实例 ${agentId} 为主会话实例，不参与挂起（P5：主会话网络错误不致命，用户重发即续）` };
    }
    if (instance.isTerminal) {
      return { parked: false, error: `实例 ${agentId} 已终态（${instance.current}），park 作废（终态赢）` };
    }
    if (instance.current === "parked") return { parked: true }; // 已挂起幂等 no-op
    if (instance.current === "queued") {
      return { parked: false, error: `实例 ${agentId} 排队中（无执行载体），不可挂起——可先 kill 或等待出队` };
    }
    if (this.deps.runner.send === undefined) {
      return { parked: false, error: `实例 ${agentId} 的执行载体不支持注入（runner 未实现 send），无法挂起` };
    }
    if (!this.pendingParks.has(agentId)) {
      this.pendingParks.set(agentId, reason);
      this.deps.runner.send(agentId, PARK_INSTRUCTION_TEXT);
    }
    return { parked: true };
  }

  /**
   * resume：向 parked 实例注入恢复指令（同一实例同一会话从断点继续）。预算
   * 判定等价新派发（P3）：有空位立即恢复（RESUME 注入 + parked→running +
   * agent.resumed）；预算满则与重派同队排队（状态保持 parked，空位释放后
   * 出队恢复——**不重新 launch**，执行载体驻留未退出）。拒绝：未挂起/终态/未知。
   *
   * 在途竞态增补（链 A 上报边界）：park 指令已注入、确认未上行（当前工具
   * 调用收尾期）时调 resume → 取消等待（清除 pending，不再迁移 parked）
   * + 注入 RESUME 抵消（双保险：子进程 steer 队列中的 RESUME 使 run 继续
   * 走完——末条 assistant 不再是 PARK 标记即不进挂起等待；已入等待则唤醒）。
   * 实例全程 running（从未离开运行位，无预算判定）；极端路径子进程仍输出
   * 标记上行 → onInstanceParked 防御性受理照旧（状态保真，可再 resume）。
   */
  resume(agentId: string): ResumeOutcome {
    const instance = this.registry.findInstance(agentId);
    if (!instance) return { resumed: false, error: `实例 ${agentId} 不存在（无法 resume）` };
    if (instance.isTerminal) {
      return { resumed: false, error: `实例 ${agentId} 已终态（${instance.current}），终态不可复活（重派 = 新实例）` };
    }
    // 在途 pending park：取消等待 + RESUME 抵消（状态不迁移，继续 running）
    if (instance.current === "running" && this.pendingParks.has(agentId)) {
      this.pendingParks.delete(agentId);
      if (this.deps.runner.send !== undefined) this.deps.runner.send(agentId, RESUME_INSTRUCTION_TEXT);
      return { resumed: true, queued: false };
    }
    if (instance.current !== "parked") {
      return { resumed: false, error: `实例 ${agentId} 未挂起（当前 ${instance.current}），无需 resume` };
    }
    if (this.resumePending.has(agentId)) {
      return { resumed: true, queued: true, position: this.queue.indexOf(agentId) + 1 }; // 已在恢复队列幂等
    }
    const decision = this.deps.policy.decideSpawn(this.runningCount(), this.queue.length);
    if (decision.action === "reject") {
      return { resumed: false, error: `恢复预算已耗尽（运行位满且队列满），无法排队恢复实例 ${agentId}` };
    }
    if (decision.action === "run") {
      this.resumeInstance(instance);
      return { resumed: true, queued: false };
    }
    this.resumePending.add(agentId);
    this.queue.push(agentId);
    this.republishPositions();
    return { resumed: true, queued: true, position: this.queue.length };
  }

  // ── runner 回调（实例执行载体 → 编排；回调体一行转发） ──────

  /**
   * 引擎事件增量转发：未知/终态实例忽略（注册表归门面）；翻译归 translator。
   * （原 onInstanceEvent 守卫 + lastEventAt 刷新 + 事件分支——拆分：
   * 守卫留门面回调转发处，其余逐行迁 SubagentEventTranslator.onInstanceEvent）
   */
  private onInstanceEvent(instanceId: string, event?: AgentEngineEvent): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) return; // 迟到/乱序事件：不崩不计
    this.translator.onInstanceEvent(instance, event);
  }

  /**
   * 实例收口：幂等（终态后到者 no-op）；done/failed/killed 三路径统一处理。
   *
   * ★原序保持（唯一行为风险点）：清理 → 迁移 → 收口链，顺序不得重排——
   * 四 delete 先于状态机迁移与收口链执行（与拆分前 L565-568 → L571 →
   * L597-627 逐行对照，清理序列单点持有在 translator.onClosureCleanup）。
   */
  private onInstanceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) return; // kill 与自然收口竞态：后到者吞
    // park/resume 批：挂起登记面随终态清理（pendingParks 同时作废——park 请求未及确认即收口）
    this.pendingParks.delete(instanceId);
    this.parkedInfos.delete(instanceId);
    this.resumePending.delete(instanceId);

    // 流式/落树事件生产状态清理（终态后迟到引擎事件不再产条目事件）——
    // 四 delete 原序单点在 translator（streamEntryIds → entrySeqs →
    // thinkingStartsMs → pendingThinking），先于下述迁移与收口链
    this.translator.onClosureCleanup(instanceId);
    this.clearProgressReporting(instanceId); // T3-A：终态清报告定时器（与上同一清理序列位）

    // 状态机迁移（非法迁移不可达：queued/running 均可收口 failed/killed；
    // done 仅自 running——queued/parked 实例重外部已完成时补记 running 再收口，
    // 不因乱序到达而抛错（任意序列不崩、无非法半态；parked 后到达 done 为
    // 协议不可达的防御位——子进程挂起等待期不产自然收口）
    if (outcome.result === "done" && instance.current === "queued") {
      instance.markRunning(); // 补记：实际已执行完毕（迟到/乱序 done）
    }
    if (outcome.result === "done" && instance.current === "parked") {
      instance.resume(); // 补记：挂起确认后仍自然收口（防御，同 queued 口径）
    }
    switch (outcome.result) {
      case "done":
        instance.complete();
        break;
      case "failed":
      case "killed":
        instance.fail(); // kill 收口 failed（单一终态语义）
        break;
    }

    // 若实例仍在队列（乱序：queued 直接收口）→ 摘队 + 位次递减重发
    const idx = this.queue.indexOf(instanceId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.republishPositions();
    }

    // ── closure 收口链（AD-8 双通道 + O-5 双产物； 多会话：报告/记录行按实例归属会话路由）──
    // 归 ClosureRecorder（拆分）：①双产物前置段（归一 + reportPath 文件）→
    // 门面 closures.set 留档（观测面 Map 归门面，原序位）→ ②③④尾段
    // （记录行 + agent_lifecycle 投影 + 终态领域事件 + SteerQueue 注入）
    const closure = this.recorder.saveClosureArtifacts(instance, outcome, this.tasks.get(instanceId) ?? "");
    this.closures.set(instanceId, closure);
    this.recorder.finalizeClosure(instance, outcome, closure);

    // CDP 地基：实例终态钩子（组合根接 browserPort.reclaimOwner 回收
    // 该 owner 全部 managed tabs；位于收口链尾段之后、空位释放之前）
    this.deps.onInstanceTerminal?.(instanceId);

    // 空位释放 → FIFO 出队（queued 收口不释放运行位，maybeDequeue 自会按预算判定）
    this.maybeDequeue();
  }

  /**
   * 实例挂起确认（park/resume 批）：子进程检测 PARK 标记进入挂起等待。
   * 幂等/竞态守卫：仅 running 态受理（终态 = closure 先到 park 作废；已
   * parked 的重复上行忽略）。挂起非终态：不写 closure、不触发收口链、
   * 不注入主线；预算释放（P3：maxConcurrent 只数非 parked）→ 触发出队。
   */
  private onInstanceParked(instanceId: string, summary: { progress: string; next: string }): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal || instance.current !== "running") return; // park 迟到作废 / 重复上行幂等
    const reason = this.pendingParks.get(instanceId) ?? "user"; // 未登记 park 请求的意外上行（防卸性受理）
    this.pendingParks.delete(instanceId);
    instance.park();
    const parkedAt = this.deps.clock.now();
    this.parkedInfos.set(instanceId, { reason, parkedAt });
    this.persistLifecycle(instance); // parked 投影行（重启 parked→failed 收口的读面）
    this.publish(instance, "agent.parked", {
      agentId: instanceId,
      reason,
      parkedAt,
      summary,
    } satisfies AgentParkedPayload);
    this.maybeDequeue(); // 预算释放 → 队首出队
  }

  /** 恢复实例（预算内直恢复 / 出队恢复同路径）：RESUME 注入 + parked→running + agent.resumed。 */
  private resumeInstance(instance: AgentInstance): void {
    const instanceId = instance.instanceId;
    instance.resume();
    this.parkedInfos.delete(instanceId);
    this.translator.touchLastEventAt(instanceId); // 恢复起算 idle 计时（防瞬时 stalled 误报）
    this.persistLifecycle(instance); // running 投影行
    if (this.deps.runner.send !== undefined) this.deps.runner.send(instanceId, RESUME_INSTRUCTION_TEXT);
    this.publish(instance, "agent.resumed", {
      agentId: instanceId,
      startedAtMs: instance.startedAtMs!,
      elapsedMs: instance.elapsedMs(),
    } satisfies AgentResumedPayload);
  }

  // ── 内部：启动/出队/stalled ───────────────────────────────

  private startInstance(instance: AgentInstance): void {
    instance.markRunning();
    this.translator.touchLastEventAt(instance.instanceId);
    this.persistLifecycle(instance); // running 投影（重启 running→failed 收口的读面，AD-10）
    this.publish(instance, "agent.started", {
      agentId: instance.instanceId,
      startedAtMs: instance.startedAtMs!,
    } satisfies AgentStartedPayload);
    // T3-A：报告间隔已登记才建 per-instance 定时器（queued 期不报告——无执行载体无事件）
    const interval = this.reportIntervals.get(instance.instanceId);
    if (interval !== undefined) {
      this.reportSeqs.set(instance.instanceId, 0);
      this.lastReportedMetrics.set(instance.instanceId, { toolCalls: 0, assistantChars: 0, turns: 0 });
      this.reportTimers.set(
        instance.instanceId,
        setInterval(() => this.emitProgressReport(instance.instanceId), interval),
      );
    }
    this.deps.runner.launch(instance, this.tasks.get(instance.instanceId) ?? "");
  }

  // ── T3-A 周期进展报告（机械 Δ 信封；不指望 SubAgent 自觉汇报） ──────

  /**
   * 到点生成一行机械信封，经 injectClosure 同一通道（组合根接
   * ChatService.injectClosure，T2 已处理 aborting 缓冲）注入归属会话：
   * `[agent-N 进展报告 #k] 状态=running 静默=<idleMs>ms Δ工具调用=+x Δ输出=+y字符 Δ轮次=+z`。
   * 一行纯机械数据（行为建议在主会话系统提示词）；注入失败吞进 engine.error
   * 可观测，不影响调度器（定时器继续/随终态清理）。
   */
  private emitProgressReport(instanceId: string): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) {
      this.clearProgressReporting(instanceId); // 防御：实例已不在/终态（迟到 tick）
      return;
    }
    if (instance.current !== "running") return; // park/resume 批：parked 零消耗不报告（P4 无自动超时；定时器保留随 resume 复报）
    const metrics = this.translator.metricsOf(instanceId);
    const prev = this.lastReportedMetrics.get(instanceId) ?? { toolCalls: 0, assistantChars: 0, turns: 0 };
    this.lastReportedMetrics.set(instanceId, metrics);
    const seq = (this.reportSeqs.get(instanceId) ?? 0) + 1;
    this.reportSeqs.set(instanceId, seq);
    const last = this.translator.lastEventAtOf(instanceId);
    const idleMs = last === undefined ? 0 : Math.max(0, this.deps.clock.nowMs() - last);
    const envelope =
      `[${instanceId} 进展报告 #${seq}] 状态=${instance.current} 静默=${idleMs}ms ` +
      `Δ工具调用=+${metrics.toolCalls - prev.toolCalls} ` +
      `Δ输出=+${metrics.assistantChars - prev.assistantChars}字符 ` +
      `Δ轮次=+${metrics.turns - prev.turns}`;
    try {
      this.deps.injectClosure?.(instanceId, envelope, "progress");
    } catch (err) {
      // 注入失败（会话 stopped 等）不崩调度——engine.error 可观测化
      this.publish(instance, "engine.error", {
        message: `进展报告注入失败（实例 ${instanceId}）：${(err as Error).message}`,
      });
    }
  }

  /** T3-A 清理：清定时器 + 序号/快照/间隔登记（终态/stop/cancelSession 共用；幂等）。 */
  private clearProgressReporting(instanceId: string): void {
    const timer = this.reportTimers.get(instanceId);
    if (timer !== undefined) clearInterval(timer);
    this.reportTimers.delete(instanceId);
    this.reportSeqs.delete(instanceId);
    this.lastReportedMetrics.delete(instanceId);
    this.reportIntervals.delete(instanceId);
  }

  /** 出队：预算允许则队首启动（循环直至预算耗尽或队列空）。 */
  private maybeDequeue(): void {
    while (this.queue.length > 0) {
      const decision = this.deps.policy.decideSpawn(this.runningCount(), this.queue.length);
      if (decision.action !== "run") break;
      const agentId = this.queue.shift()!;
      this.republishPositions(); // 剩余位次整体递减重发（仅出队触发）
      const instance = this.registry.findInstance(agentId);
      if (!instance || instance.isTerminal) continue; // 排队期已收口：摘队即完毕
      // park/resume 批：排队中的待恢复实例 → RESUME 恢复（执行载体驻留，
      // 不重新 launch——与重派同队但派发动作不同）；普通排队 → launch
      if (this.resumePending.delete(agentId)) this.resumeInstance(instance);
      else this.startInstance(instance);
    }
  }

  /** 队列位次重发（队列序即位次序，1 起）。park/resume 批：排队中的待恢复
 *  实例不重发 agent.queued（状态仍 parked——它不是待启动的 spawn，位次经
 *  agent_status position 观测；避免前端卡被误投影为 queued）。 */
  private republishPositions(): void {
    this.queue.forEach((agentId, i) => {
      if (this.resumePending.has(agentId)) return;
      const instance = this.registry.findInstance(agentId);
      if (instance) {
        this.publish(instance, "agent.queued", { agentId, position: i + 1 } satisfies AgentQueuedPayload);
      }
    });
  }

  /** stalled 轮询：running 实例 idle 超阈值 → 警示事件可重复推，不改状态。 */
  private checkStalled(): void {
    const now = this.deps.clock.nowMs();
    for (const instance of this.registry.listInstances()) {
      if (instance.current !== "running") continue; // 终态不推（前端徽标仅 running）
      const last = this.translator.lastEventAtOf(instance.instanceId);
      if (last === undefined) continue;
      if (this.deps.policy.isStalled(last, now)) {
        this.publish(instance, "agent.stalled", {
          agentId: instance.instanceId,
          idleMs: now - last,
        } satisfies AgentStalledPayload);
      }
    }
  }

  private runningCount(): number {
    // 预算口径 = 运行中 SubAgent 数（AD-7①；主实例不计入）
    return this.registry.listInstances().filter((i) => i.kind === "subagent" && i.current === "running").length;
  }

  /** AgentInstance → agent_status 观测条目（位次/任务/终态摘要按态携带；park/resume 批：挂起原因/时刻）。 */
  private toStatus(instance: AgentInstance): AgentInstanceStatus {
    const agentId = instance.instanceId;
    const task = this.tasks.get(agentId);
    const position = this.queue.indexOf(agentId);
    const closure = this.closures.get(agentId);
    const parked = this.parkedInfos.get(agentId);
    return {
      agentId,
      state: instance.current,
      profileKind: instance.profileKind,
      ...(task !== undefined ? { task } : {}),
      ...(position >= 0 ? { position: position + 1 } : {}),
      ...(closure !== undefined ? { summary: closure.summary } : {}),
      ...(parked !== undefined ? { parkedReason: parked.reason, parkedAt: parked.parkedAt } : {}),
    };
  }

  /** agent_lifecycle 投影行落盘（单写通道；失败不崩——WriteQueue onError 上报）。 */
  private persistLifecycle(instance: AgentInstance): void {
    void this.deps.repository.saveAgentLifecycle(instance.sessionId, instance.instanceId, instance.current);
  }

  private publish<P>(instance: AgentInstance, type: DomainEvent["type"], payload: P): void {
    this.deps.events.publish({
      type,
      sessionId: instance.sessionId, // 多会话：事件归属 = 实例归属会话
      instanceId: instance.instanceId, // ≡ agentId（契约 §2）：落盘/路由四维用
      payload,
      occurredAt: this.deps.clock.now(),
    });
  }
}

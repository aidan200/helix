import { AgentInstance, agentSeqOf, type AgentInstanceData } from "../../../domain/agent/AgentInstance";
import { AgentLifecycle } from "../../../domain/agent/AgentLifecycle";
import type { SchedulingPolicy } from "../../../domain/agent/SchedulingPolicy";
import type {
  AgentInstantiatedPayload,
  AgentQueuedPayload,
  AgentSpawnedPayload,
  AgentStartedPayload,
  AgentStalledPayload,
  DomainEvent,
  InstanceClosurePayload,
} from "../../../domain/events/DomainEvent";
import type { EventPublisherPort } from "../../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../ports/outbound/ClockPort";
import type { SessionRepositoryPort } from "../../ports/outbound/SessionRepositoryPort";
import type { AgentEngineEvent } from "../../ports/outbound/AgentEnginePort";
import type {
  AgentInspection,
  AgentInstanceStatus,
  AgentOrchestrationPort,
  KillOutcome,
  SendOutcome,
  SpawnOutcome,
} from "../../ports/inbound/AgentOrchestrationPort";
import type { InstanceClosureOutcome, InstanceRunner } from "../InstanceRunner";
import type { InstanceSnapshotEntry } from "../../ports/inbound/SessionPort";
import type { RestoredInstance } from "../RestoreService";
import { SubagentEventTranslator } from "./SubagentEventTranslator";
import { ClosureRecorder } from "./ClosureRecorder";

/**
 * SchedulerService —— SubAgent 调度编排门面（architecture.md §4，AD-7）。
 * （拆分史见 docs/decisions/ADR-subagent-scheduler.md）
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
 * 【id 分配】agent-N（N = daemon 内递增序号）。序号仅内存维护——重启基线
 * （agent_lifecycle max(N)+1）与恢复语义归 RestoreService。
 */

export type { SpawnOutcome };

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
   * closure 注入主线回调（AD-8 双通道之一；组合根接 ChatService.injectClosure）。
   * 可选——无主线编排场景（纯调度 integration）不注入。
   */
  readonly injectClosure?: (agentId: string, message: string) => void;
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
   * （systemPrompt 全文/工具集/hooks 名）与模型三级链解析（profile 槽位 ??
   *   spawn 会话快照 ?? 全局兜底，AD-3 联动）均归组合根装配（driven 常量
   *   不进 application）；缺省 = 纯调度测试形态，不发布 instantiated。
   */
  readonly subagentSnapshotFor?: (spawnModel: string | undefined) => AgentInstantiatedPayload["profileSnapshot"];
  /**
   * 实例终态钩子（CDP 地基）：done/failed/killed 收口链完成后回调——
   * 组合根接 `browserPort.reclaimOwner`（回收该 owner 全部 managed tabs，
   * 浏览器侧资源随 agent 终态释放；idle sweep 兼底）。可选——纯调度测试
   * 形态不注入；迟到/重复收口被门面幂等吞，钩子恰好触发一次。
   */
  readonly onInstanceTerminal?: (agentId: string) => void;
  /** 日志（容器接 file logger——kill 终止信号失败可观测；缺省静默）。 */
  readonly logger?: { warn: (message: string) => void };
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
  /** spawn 时刻的会话当前模型（AgentInstanceDto.model 空槽位填充链——出卡即知）。 */
  private readonly spawnModels = new Map<string, string>();
  /** 实例 → 收口 closure（agent_status 摘要/观测面留档；终态后保留）。 */
  private readonly closures = new Map<string, InstanceClosurePayload>();
  /** agent-N 序号（daemon 内递增）。 */
  private seq = 0;
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

  constructor(private readonly deps: SchedulerServiceDeps) {
    this.translator = new SubagentEventTranslator({ events: deps.events, clock: deps.clock });
    this.recorder = new ClosureRecorder({
      repository: deps.repository,
      events: deps.events,
      clock: deps.clock,
      reportsDirFor: deps.reportsDirFor,
      injectClosure: deps.injectClosure,
    });
    // 契约零变化：恰 2 回调注册给 runner，回调体一行转发
    this.deps.runner.setCallbacks({
      onInstanceEvent: (instanceId, event) => this.onInstanceEvent(instanceId, event),
      onInstanceClosure: (instanceId, outcome) => this.onInstanceClosure(instanceId, outcome),
    });
    const poll = deps.stalledPollMs ?? Math.max(1, Math.floor(deps.policy.stalledThresholdMs / 2));
    this.monitor = setInterval(() => this.checkStalled(), poll);
  }

  /** 停 stalled 监视定时器 + 全部进展报告定时器（daemon shutdown / 测试收尾；幂等）。 */
  stop(): void {
    if (this.monitor !== undefined) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
    for (const timer of this.reportTimers.values()) clearInterval(timer); // T3-A
    this.reportTimers.clear();
  }

  // ── 观测面（agent_status 工具取数） ───────────────────────

  /** 按 id 查实例值形状（不存在/已销毁窗口返回 undefined）。 */
  instance(agentId: string): AgentInstanceData | undefined {
    return this.registry.findInstance(agentId)?.toData();
  }

  /**
   * spawn 时刻会话模型快照只读通道（AD-3 三级链第二级，TR-AD-24）：
   * SubagentLauncher 经 container 晚绑消费（launch 段唯一消费点）；
   * 只读——不改变 spawnModels Map 生命周期（恢复回填归恢复链）。
   */
  spawnModelOf(instanceId: string): string | undefined {
    return this.spawnModels.get(instanceId);
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

  /** 会话是否有活跃实例（运行态观测/空闲卸载判定——queued/running 均算活跃）。 */
  hasActiveInstances(sessionId: string): boolean {
    return this.registry
      .listInstances()
      .some((i) => i.sessionId === sessionId && (i.current === "running" || i.current === "queued"));
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
   * closure/task 回填观测面、agent-N 序号续基线（重启不重复分配）。
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
      const seq = agentSeqOf(item.instanceId);
      if (seq > this.seq) this.seq = seq;
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

    const agentId = `agent-${++this.seq}`;
    const instance = AgentInstance.create({
      instanceId: agentId,
      kind: "subagent",
      profileKind: profileKind ?? DEFAULT_PROFILE_KIND,
      sessionId,
      createdAt: this.deps.clock.now(),
    });
    this.registry.registerInstance(instance);
    this.tasks.set(agentId, task);
    if (model !== undefined) this.spawnModels.set(agentId, model); // spawn 时透传当前模型
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
      task,
      profileKind: instance.profileKind,
      ...(model !== undefined ? { model } : {}),
    } satisfies AgentSpawnedPayload);
    // 同批发布实例化快照（紧随其后）——（AD-5，契约 v0.4 §2）
    // 快照 model = 三级链解析结果（spawn 时刻求值，与该实例 launch 实际使用
    // 模型同源）；只落盘不广播（DtoMapper 无 case）。
    if (this.deps.subagentSnapshotFor !== undefined) {
      this.publish(instance, "agent.instantiated", {
        instanceId: agentId,
        profileKind: instance.profileKind,
        profileSnapshot: this.deps.subagentSnapshotFor(model),
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

    // 流式/落树事件生产状态清理（终态后迟到引擎事件不再产条目事件）——
    // 四 delete 原序单点在 translator（streamEntryIds → entrySeqs →
    // thinkingStartsMs → pendingThinking），先于下述迁移与收口链
    this.translator.onClosureCleanup(instanceId);
    this.clearProgressReporting(instanceId); // T3-A：终态清报告定时器（与上同一清理序列位）

    // 状态机迁移（非法迁移不可达：queued/running 均可收口 failed/killed；
    // done 仅自 running——queued 实例重外部已完成时补记 running 再收口，
    // 不因乱序到达而抛错（任意序列不崩、无非法半态）
    if (outcome.result === "done" && instance.current === "queued") {
      instance.markRunning(); // 补记：实际已执行完毕（迟到/乱序 done）
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

  // ── 内部：启动/出队/stalled ───────────────────────────────

  private startInstance(instance: AgentInstance): void {
    instance.markRunning();
    this.translator.touchLastEventAt(instance.instanceId);
    this.persistLifecycle(instance); // running 投影（重启 running→failed 收口的读面，AD-10）
    this.publish(instance, "agent.started", { agentId: instance.instanceId } satisfies AgentStartedPayload);
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
      this.deps.injectClosure?.(instanceId, envelope);
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
      if (instance && !instance.isTerminal) this.startInstance(instance);
    }
  }

  /** 队列位次重发（队列序即位次序，1 起）。 */
  private republishPositions(): void {
    this.queue.forEach((agentId, i) => {
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

  /** AgentInstance → agent_status 观测条目（位次/任务/终态摘要按态携带）。 */
  private toStatus(instance: AgentInstance): AgentInstanceStatus {
    const agentId = instance.instanceId;
    const task = this.tasks.get(agentId);
    const position = this.queue.indexOf(agentId);
    const closure = this.closures.get(agentId);
    return {
      agentId,
      state: instance.current,
      profileKind: instance.profileKind,
      ...(task !== undefined ? { task } : {}),
      ...(position >= 0 ? { position: position + 1 } : {}),
      ...(closure !== undefined ? { summary: closure.summary } : {}),
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

import { AgentInstance, type AgentInstanceData } from "../../domain/agent/AgentInstance";
import { AgentLifecycle } from "../../domain/agent/AgentLifecycle";
import type { SchedulingPolicy } from "../../domain/agent/SchedulingPolicy";
import type {
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
  AgentQueuedPayload,
  AgentSpawnedPayload,
  AgentStartedPayload,
  AgentStalledPayload,
  DomainEvent,
  InstanceClosurePayload,
} from "../../domain/events/DomainEvent";
import type { EventPublisherPort } from "../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import type { SessionRepositoryPort } from "../ports/outbound/SessionRepositoryPort";
import type { InstanceClosureOutcome, InstanceRunner } from "./InstanceRunner";

/**
 * SchedulerService —— SubAgent 调度编排（architecture.md §4，AD-7/C-7）。
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
 *     ├─ 实例收口回调（done/failed/killed）→ 状态机迁移 + agent.completed/
 *     │   failed/killed 事件（closure 归一：可选字段显式 null）+
 *     │   agent_lifecycle 投影落盘（经 repository → WriteQueue 单写通道）
 *     │   → 空位释放 → FIFO 出队 → 队首 agent.started + launch；
 *     │     剩余位次整体递减并重发 agent.queued
 *     ├─ stalled 监视（定时器轮询 per-instance lastEventAt）
 *     │   → agent.stalled{idleMs} 警示可重复推，不自动杀（状态仍 running）
 *     └─ kill(agentId)（用户终止）→ killed 收口路径（幂等：未知/已终态 no-op）
 *
 * 【F1.9 非线性红线】实例创建/销毁一等 API；不假设按序推进——queued 可直接
 * 收口 failed（摘队+位次递减）、kill 可落在任意状态、终态幂等（迟到收口被
 * 吞）、重派 = 新 instanceId 新实例。状态权威在 AgentInstance 状态机，
 * 本服务只编排不改写规则。
 *
 * 【id 分配】agent-N（N = daemon 内递增序号）。序号仅内存维护——重启基线
 * （agent_lifecycle max(N)+1）与恢复语义归 T2.4。
 */

/** spawn 结果：run=预算内直跑；queued=入队（含位次）；rejected=队列满错误回 LLM。 */
export type SpawnOutcome =
  | { readonly status: "run"; readonly agentId: string }
  | { readonly status: "queued"; readonly agentId: string; readonly position: number }
  | { readonly status: "rejected"; readonly error: string };

/** profileKind 缺省值（Q-6=A：单一通用 worker）。 */
const DEFAULT_PROFILE_KIND = "subagent-worker";

export interface SchedulerServiceDeps {
  /** 调度策略（纯判定；maxConcurrent/maxQueued/stalled 阈值由此携带）。 */
  readonly policy: SchedulingPolicy;
  /** 实例运行器（T2.2 SubagentLauncher 真体；T2.1 替身跑 integration）。 */
  readonly runner: InstanceRunner;
  /** 事件流发布（领域事件 → fan-out：stdout/WS 落盘目标）。 */
  readonly events: EventPublisherPort;
  /** 持久化（agent_lifecycle 投影行落盘，经 WriteQueue 单写通道）。 */
  readonly repository: SessionRepositoryPort;
  /** 时间源（领域事件 occurredAt / 实例 createdAt，测试可控）。 */
  readonly clock: ClockPort;
  /** 实例归属会话（领域事件挂 sessionId）。 */
  readonly sessionId: string;
  /** stalled 轮询间隔 ms（缺省 阈值/2；测试注入小值）。 */
  readonly stalledPollMs?: number;
}

export class SchedulerService {
  /** 会话内实例注册表（AgentLifecycle 的注册表面；会话运行态不在此管）。 */
  private readonly registry = new AgentLifecycle();
  /** FIFO 队列（instanceId 有序；内存队列不落盘，AD-10——重启清队归 T2.4）。 */
  private readonly queue: string[] = [];
  /** 实例 → task（出队时 launch 入参）。 */
  private readonly tasks = new Map<string, string>();
  /** 实例 → 最近引擎事件时间戳（epoch ms；stalled 判定输入）。 */
  private readonly lastEventAtMs = new Map<string, number>();
  /** agent-N 序号（daemon 内递增）。 */
  private seq = 0;
  private monitor: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: SchedulerServiceDeps) {
    this.deps.runner.setCallbacks({
      onInstanceEvent: (instanceId) => this.onInstanceEvent(instanceId),
      onInstanceClosure: (instanceId, outcome) => this.onInstanceClosure(instanceId, outcome),
    });
    const poll = deps.stalledPollMs ?? Math.max(1, Math.floor(deps.policy.stalledThresholdMs / 2));
    this.monitor = setInterval(() => this.checkStalled(), poll);
  }

  /** 停 stalled 监视定时器（daemon shutdown / 测试收尾；幂等）。 */
  stop(): void {
    if (this.monitor !== undefined) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
  }

  // ── 观测面（agent_status 接缝/T2.3 编排三工具取数） ─────────

  /** 按 id 查实例值形状（不存在/已销毁窗口返回 undefined）。 */
  instance(agentId: string): AgentInstanceData | undefined {
    return this.registry.findInstance(agentId)?.toData();
  }

  // ── 编排入口 ──────────────────────────────────────────────

  /**
   * spawn：预算判定 → 直跑/入队/拒绝。同步秒回（不等执行收口，AD-8 异步交付）。
   * rejected 时调用方（agent_spawn 工具/WS）把错误字符串回 LLM/前端。
   */
  spawn(task: string, profileKind?: string): SpawnOutcome {
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
      sessionId: this.deps.sessionId,
      createdAt: this.deps.clock.now(),
    });
    this.registry.registerInstance(instance);
    this.tasks.set(agentId, task);
    // 出卡事件：预算内直跑也会先发 spawned（卡片进入），再由 started 转 running
    this.publish(instance, "agent.spawned", {
      agentId,
      task,
      profileKind: instance.profileKind,
    } satisfies AgentSpawnedPayload);

    if (decision.action === "run") {
      this.startInstance(instance);
      return { status: "run", agentId };
    }

    const position = this.deps.policy.nextPosition(this.queue.length);
    this.queue.push(agentId);
    this.persistLifecycle(instance); // queued 投影（重启 cancelled 收口语义的读面，T2.4）
    this.publish(instance, "agent.queued", { agentId, position } satisfies AgentQueuedPayload);
    return { status: "queued", agentId, position };
  }

  /**
   * 用户 kill（WS agent.kill → T2.3 接线）：任意状态幂等——未知/已终态 no-op；
   * queued 摘队（位次递减重发），running 释放空位触发出队。kill 收口
   * closure.status="failed"（单一终态语义，契约 §8-2）。子进程终止信号由
   * T2.2 InstanceRunner 扩展承接（迟到的真体收口回调被幂等挡住）。
   */
  kill(agentId: string): void {
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
  }

  // ── runner 回调（实例执行载体 → 编排） ─────────────────────

  /** 引擎事件增量：刷新 lastEventAt（stalled 判定输入）；未知/终态实例忽略。 */
  private onInstanceEvent(instanceId: string): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) return; // 迟到/乱序事件：不崩不计
    this.lastEventAtMs.set(instanceId, Date.now());
  }

  /** 实例收口：幂等（终态后到者 no-op）；done/failed/killed 三路径统一处理。 */
  private onInstanceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) return; // kill 与自然收口竞态：后到者吞

    // 状态机迁移（非法迁移不可达：queued/running 均可收口 failed/killed；
    // done 仅自 running——queued 实例重外部已完成时补记 running 再收口，
    // 不因乱序到达而抛错（F1.9 任意序列不崩、无非法半态））
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

    const closure = normalizeClosure(outcome.closure);
    this.persistLifecycle(instance);
    if (outcome.result === "failed") {
      this.publish(instance, "agent.failed", {
        agentId: instanceId,
        error: outcome.error ?? closure.summary,
        closure,
      } satisfies AgentFailedPayload);
    } else if (outcome.result === "killed") {
      this.publish(instance, "agent.killed", { agentId: instanceId, closure } satisfies AgentKilledPayload);
    } else {
      this.publish(instance, "agent.completed", { agentId: instanceId, closure } satisfies AgentCompletedPayload);
    }

    // 空位释放 → FIFO 出队（queued 收口不释放运行位，maybeDequeue 自会按预算判定）
    this.maybeDequeue();
  }

  // ── 内部：启动/出队/stalled ───────────────────────────────

  private startInstance(instance: AgentInstance): void {
    instance.markRunning();
    this.lastEventAtMs.set(instance.instanceId, Date.now());
    this.persistLifecycle(instance); // running 投影（重启 running→failed 收口的读面，AD-10）
    this.publish(instance, "agent.started", { agentId: instance.instanceId } satisfies AgentStartedPayload);
    this.deps.runner.launch(instance, this.tasks.get(instance.instanceId) ?? "");
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
    const now = Date.now();
    for (const instance of this.registry.listInstances()) {
      if (instance.current !== "running") continue; // 终态不推（前端徽标仅 running）
      const last = this.lastEventAtMs.get(instance.instanceId);
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

  /** agent_lifecycle 投影行落盘（单写通道；失败不崩——WriteQueue onError 上报）。 */
  private persistLifecycle(instance: AgentInstance): void {
    void this.deps.repository.saveAgentLifecycle(instance.sessionId, instance.instanceId, instance.current);
  }

  private publish<P>(instance: AgentInstance, type: DomainEvent["type"], payload: P): void {
    this.deps.events.publish({
      type,
      sessionId: this.deps.sessionId,
      instanceId: instance.instanceId, // ≡ agentId（契约 §2）：落盘/路由四维用
      payload,
      occurredAt: this.deps.clock.now(),
    });
  }
}

/** closure 归一：可选字段缺失 → 显式 null（全字段必发纪律，test-design §4.3）。 */
function normalizeClosure(c: InstanceClosurePayload): InstanceClosurePayload {
  return {
    status: c.status,
    summary: c.summary,
    reportPath: c.reportPath ?? null,
    findings: c.findings ?? null,
    taskId: c.taskId ?? null,
  };
}

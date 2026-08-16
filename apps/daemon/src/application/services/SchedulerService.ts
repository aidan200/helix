import { join } from "node:path";
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
  ToolCallPayload,
  ToolResultPayload,
} from "../../domain/events/DomainEvent";
import type { EventPublisherPort } from "../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import type { SessionRepositoryPort } from "../ports/outbound/SessionRepositoryPort";
import type { AgentEngineEvent } from "../ports/outbound/AgentEnginePort";
import type {
  AgentInstanceStatus,
  AgentOrchestrationPort,
  KillOutcome,
  SendOutcome,
  SpawnOutcome,
} from "../ports/inbound/AgentOrchestrationPort";
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
 *     ├─ send(agentId, message)（T2.3，AD-7⑤）→ runner.send → transport →
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
 *     └─ kill(agentId)（用户终止，T2.3 kill 通道 FB-3）→ 先 runner.kill
 *         （O-6 终止信号，迟到自然收口被幂等吞）→ killed 收口路径
 *
 * 【F1.9 非线性红线】实例创建/销毁一等 API；不假设按序推进——queued 可直接
 * 收口 failed（摘队+位次递减）、kill 可落在任意状态、终态幂等（迟到收口被
 * 吞）、重派 = 新 instanceId 新实例。状态权威在 AgentInstance 状态机，
 * 本服务只编排不改写规则。
 *
 * 【SubAgent 内部工具事件】（AD-8 铁律）：runner 上行的 tool_execution_*
 * 引擎事件转 tool.call.* 领域事件（挂 instanceId 落盘+广播，per-instance
 * 事件流）——不进主线 Session/Entry 聚合、不进 MainAgent 上下文。
 *
 * 【id 分配】agent-N（N = daemon 内递增序号）。序号仅内存维护——重启基线
 * （agent_lifecycle max(N)+1）与恢复语义归 T2.4。
 */

export type { SpawnOutcome };

/** profileKind 缺省值（Q-6=A：单一通用 worker）。 */
const DEFAULT_PROFILE_KIND = "subagent-worker";

export interface SchedulerServiceDeps {
  /** 调度策略（纯判定；maxConcurrent/maxQueued/stalled 阈值由此携带）。 */
  readonly policy: SchedulingPolicy;
  /** 实例运行器（T2.2 SubagentLauncher 真体；T2.1 替身跑 integration）。 */
  readonly runner: InstanceRunner;
  /** 事件流发布（领域事件 → fan-out：stdout/WS 落盘目标）。 */
  readonly events: EventPublisherPort;
  /** 持久化（closure 记录行/报告文件/agent_lifecycle 投影，经 WriteQueue 单写通道）。 */
  readonly repository: SessionRepositoryPort;
  /** 时间源（领域事件 occurredAt / 实例 createdAt，测试可控）。 */
  readonly clock: ClockPort;
  /** 实例归属会话（领域事件挂 sessionId）。 */
  readonly sessionId: string;
  /**
   * 任务报告目录（O-5：<home>/reports/<session>；缺省不产报告文件，
   * closure.reportPath 为 null——T2.1 既有测试口径）。
   */
  readonly reportsDir?: string;
  /**
   * closure 注入主线回调（AD-8 双通道之一；组合根接 ChatService.injectClosure）。
   * 可选——无主线编排场景（纯调度 integration）不注入。
   */
  readonly injectClosure?: (agentId: string, message: string) => void;
  /** stalled 轮询间隔 ms（缺省 阈值/2；测试注入小值）。 */
  readonly stalledPollMs?: number;
}

export class SchedulerService implements AgentOrchestrationPort {
  /** 会话内实例注册表（AgentLifecycle 的注册表面；会话运行态不在此管）。 */
  private readonly registry = new AgentLifecycle();
  /** FIFO 队列（instanceId 有序；内存队列不落盘，AD-10——重启清队归 T2.4）。 */
  private readonly queue: string[] = [];
  /** 实例 → task（出队时 launch 入参；报告/观测面留档）。 */
  private readonly tasks = new Map<string, string>();
  /** 实例 → 最近引擎事件时间戳（epoch ms；stalled 判定输入）。 */
  private readonly lastEventAtMs = new Map<string, number>();
  /** 实例 → 收口 closure（agent_status 摘要/观测面留档；终态后保留）。 */
  private readonly closures = new Map<string, InstanceClosurePayload>();
  /** SubAgent 工具调用 → args（result 事件载荷回填；start→end 间短暂驻留）。 */
  private readonly subToolArgs = new Map<string, unknown>();
  /** agent-N 序号（daemon 内递增）。 */
  private seq = 0;
  private monitor: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: SchedulerServiceDeps) {
    this.deps.runner.setCallbacks({
      onInstanceEvent: (instanceId, event) => this.onInstanceEvent(instanceId, event),
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
   * FB-3 修复（T2.3）：收口前先 runner.kill 通知执行载体终止子进程（O-6）——
   * 只收口不发信号时子进程跑到自然收口，迟到回调虽被幂等吞、进程仍耗资源。
   */
  kill(agentId: string): KillOutcome {
    const instance = this.registry.findInstance(agentId);
    if (!instance) return { killed: false, error: `实例 ${agentId} 不存在（无法 kill）` };
    if (instance.isTerminal) {
      return { killed: false, error: `实例 ${agentId} 已终态（${instance.current}），无需 kill` };
    }
    // 终止信号先行（异步；runner 异常不阻断收口——收口本身不依赖子进程退出）
    try {
      const stopping = this.deps.runner.kill?.(agentId);
      if (stopping !== undefined) void Promise.resolve(stopping).catch(() => undefined);
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

  // ── runner 回调（实例执行载体 → 编排） ─────────────────────

  /**
   * 引擎事件增量：刷新 lastEventAt（stalled 判定输入）；未知/终态实例忽略。
   * T2.3：携事件本体时，SubAgent 内部工具调用转 per-instance 领域事件
   * （tool.call.*，挂 instanceId）——不进主线聚合（AD-8 铁律）。
   */
  private onInstanceEvent(instanceId: string, event?: AgentEngineEvent): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) return; // 迟到/乱序事件：不崩不计
    this.lastEventAtMs.set(instanceId, Date.now());
    if (event === undefined) return;

    if (event.type === "tool_execution_start") {
      this.subToolArgs.set(event.toolCallId, event.args);
      this.publish(instance, "tool.call.started", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      } satisfies ToolCallPayload);
      return;
    }
    if (event.type === "tool_execution_end") {
      const args = this.subToolArgs.get(event.toolCallId);
      this.subToolArgs.delete(event.toolCallId);
      this.publish(instance, "tool.call.result", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args,
        isError: event.isError,
        result: event.result,
      } satisfies ToolResultPayload);
      return;
    }
    // 其余引擎事件：观测面增量已计（lastEventAt 刷新），无 per-instance 领域动作
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

    // ── closure 收口链（T2.3，AD-8 双通道 + O-5 双产物） ──
    // ① 报告双产物：closure_records 记录行（SQLite，任务报告本体）+
    //    reportPath 文件（markdown 摘要+findings）——均经 WriteQueue 单写
    //    队列原子写（TR-AD-6/13），重启后报告完整可读
    const reportPath =
      this.deps.reportsDir !== undefined
        ? join(this.deps.reportsDir, `${instanceId}.md`)
        : (outcome.closure.reportPath ?? null);
    const closure = normalizeClosure(outcome.closure, reportPath);
    if (this.deps.reportsDir !== undefined && reportPath !== null) {
      void this.deps.repository.saveReportFile(
        reportPath,
        renderClosureReport(instanceId, this.tasks.get(instanceId) ?? "", closure),
      );
    }
    this.closures.set(instanceId, closure);
    void this.deps.repository.saveClosureRecord(this.deps.sessionId, instanceId, outcome.result, closure);

    // ② agent_lifecycle 投影 + ③ 终态领域事件（closure 归一后全字段必发）
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

    // ④ SteerQueue 注入主线（唯一入口进主线上下文）：`agent-N closure:
    //    <status> — <summary>`——MainAgent idle 立即新 turn / running 下轮
    //    turn 边界 drain（与用户 steer 同队列 FIFO，AD-8 双通道）
    this.deps.injectClosure?.(instanceId, `${instanceId} closure: ${closure.status} — ${closure.summary}`);

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
      sessionId: this.deps.sessionId,
      instanceId: instance.instanceId, // ≡ agentId（契约 §2）：落盘/路由四维用
      payload,
      occurredAt: this.deps.clock.now(),
    });
  }
}

/** closure 归一：可选字段缺失 → 显式 null（全字段必发纪律，test-design §4.3）；reportPath 为 O-5 报告文件落点。 */
function normalizeClosure(c: InstanceClosurePayload, reportPath: string | null): InstanceClosurePayload {
  return {
    status: c.status,
    summary: c.summary,
    reportPath,
    findings: c.findings ?? null,
    taskId: c.taskId ?? null,
  };
}

/**
 * O-5 报告文件渲染（markdown 摘要 + findings；<home>/reports/<session>/<agentId>.md）。
 * 纯函数——闭包字段直出，findings 以 JSON 行呈现（结构化本体在 SQLite 行）。
 */
function renderClosureReport(agentId: string, task: string, closure: InstanceClosurePayload): string {
  const findings = closure.findings ?? null;
  const lines = [
    `# SubAgent 任务报告：${agentId}`,
    "",
    `- 收口：${closure.status}`,
    `- 摘要：${closure.summary}`,
    `- 任务：${task || "（未记录）"}`,
    `- 关联任务号：${closure.taskId ?? "无"}`,
    "",
    "## Findings",
    "",
  ];
  if (findings === null || findings.length === 0) {
    lines.push(findings === null ? "（无 findings）" : "（空）");
  } else {
    for (const f of findings) lines.push(`- ${JSON.stringify(f)}`);
  }
  lines.push("");
  return lines.join("\n");
}

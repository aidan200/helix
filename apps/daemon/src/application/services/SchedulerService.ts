import { join } from "node:path";
import { AgentInstance, agentSeqOf, type AgentInstanceData } from "../../domain/agent/AgentInstance";
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
  MessageCompletedPayload,
  ThinkingCompletedPayload,
  ToolCallPayload,
  ToolResultPayload,
  UsageRecordedPayload,
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
import type { InstanceSnapshotEntry } from "../ports/inbound/SessionPort";
import type { RestoredInstance } from "./RestoreService";

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
 * 【SubAgent 实例事件】（AD-8 → AD-3 演进，T2.1）：runner 上行的引擎事件
 * 全部转领域事件/流式 delta（thinking 累积 / message 落树含 message_update
 * 流式 / tool 记录 / usage 入账）——本服务只产事件不写聚合（守护断言见
 * integration/session-projection）；会话投影消费者落 Session 聚合
 * （Entry.instanceId 归属 agent-N）；MainAgent 上下文仍零混入（closure
 * 注入 SteerQueue 是唯一入口，AD-8 铁律不变量部分）。
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
  /** 时间源（领域事件 occurredAt / 实例 createdAt / stalled 毫秒判定，测试可控）。 */
  readonly clock: ClockPort;
  /**
   * 任务报告目录（O-5：<home>/reports/<session>；**多会话（T2.2）**：调度器
   * daemon 全局一份，报告目录按实例归属会话解析——注入 (sessionId) => dir；
   * 缺省不产报告文件（closure.reportPath 为 null——T1.1 既有测试口径）。
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
   * spawn 锚计算（T2.1 契约 v0.3 §1 规则②，AD-5）：spawn 时刻聚合内最后一条
   * main/compaction entry 的 id（无 → null 流首）。组合根注入（会话聚合视图
   * 读面）；spawn 处理点计算一次，随实例视图内存携带（派生值不落盘，无第二
   * 事实源——E-AgentInstance 禁忌）；缺省 = 纯调度测试形态（锚点面缺席）。
   */
  readonly spawnAnchorFor?: (sessionId: string) => string | null;
}

export class SchedulerService implements AgentOrchestrationPort {
  /** 会话内实例注册表（AgentLifecycle 的注册表面；会话运行态不在此管）。 */
  private readonly registry = new AgentLifecycle();
  /** FIFO 队列（instanceId 有序；内存队列不落盘，AD-10——重启清队归 T2.4）。 */
  private readonly queue: string[] = [];
  /** 实例 → task（出队时 launch 入参；报告/观测面留档）。 */
  private readonly tasks = new Map<string, string>();
  /** spawn 时刻的会话当前模型（T2.3：AgentInstanceDto.model 空槽位填充链——出卡即知）。 */
  private readonly spawnModels = new Map<string, string>();
  /** 实例 → 最近引擎事件时间戳（epoch ms；stalled 判定输入）。 */
  private readonly lastEventAtMs = new Map<string, number>();
  /** 实例 → 收口 closure（agent_status 摘要/观测面留档；终态后保留）。 */
  private readonly closures = new Map<string, InstanceClosurePayload>();
  /** SubAgent 工具调用 → args（result 事件载荷回填；start→end 间短暂驻留）。 */
  private readonly subToolArgs = new Map<string, unknown>();
  // ── SubAgent 流式/落树事件生产状态（T2.1 AD-3：本服务只产事件，聚合写归会话投影） ──
  /** 实例 → 预分配 assistant 消息 entry id（流式 messageId 与最终 entry 同源，D-2 同构）。 */
  private readonly streamEntryIds = new Map<string, string>();
  /** 实例 → agent 作用域 entry 序号（id 形如 `${instanceId}#N`，不占会话主计数器）。 */
  private readonly entrySeqs = new Map<string, number>();
  /** 实例 → thinking 块开始时刻（epoch ms；durationMs = start→end）。 */
  private readonly thinkingStartsMs = new Map<string, Map<number, number>>();
  /** 实例 → 在途 thinking 块（message_end 时关联 reasoningTokens 后产事件）。 */
  private readonly pendingThinking = new Map<string, { contentIndex: number; text: string; startedMs: number }[]>();
  /** agent-N 序号（daemon 内递增）。 */
  private seq = 0;
  /** 实例 → spawn 时刻锚（规则②内存携带；含 null 流首——has 判定区分未装配）。 */
  private readonly spawnAnchors = new Map<string, string | null>();
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

  /**
   * spawn 时刻会话模型快照只读通道（AD-3 三级链第二级，TR-AD-24）：
   * SubagentLauncher 经 container 晚绑消费（launch 段唯一消费点）；
   * 只读——不改变 spawnModels Map 生命周期（恢复不回填归 T2.1/F5.8）。
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

  /** 快照观测面（T2.4）：instances[] 装配载荷（注册表 + task + closure；DtoMapper 转协议）。
   *  T2.2（AD-4 多会话）：可选 sessionId 过滤——只取归属会话的实例（快照按会话组装）。 */
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
          // T2.1 契约 v0.3 §1 规则②：spawn 时值随实例视图携带（含 null 流首；
          // 恢复实例无此值 → 组装面退化尾部推导，契约记录在案边界）
          ...(this.spawnAnchors.has(instance.instanceId)
            ? { spawnAnchorEntryId: this.spawnAnchors.get(instance.instanceId)! }
            : {}),
        };
      });
  }

  /** spawn 时刻锚观测面（T2.1：agent.spawned 增量帧 enrichment 读面；未登记 undefined）。 */
  spawnAnchorOf(instanceId: string): string | null | undefined {
    return this.spawnAnchors.get(instanceId);
  }

  /** 会话是否有活跃实例（T2.2：运行态观测/空闲卸载判定——queued/running 均算活跃）。 */
  hasActiveInstances(sessionId: string): boolean {
    return this.registry
      .listInstances()
      .some((i) => i.sessionId === sessionId && (i.current === "running" || i.current === "queued"));
  }

  /**
   * 会话级取消（T2.2 AD-4 删除收口链第①步）：该会话全部实例收口终态——
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
        this.lastEventAtMs.delete(instance.instanceId);
        this.persistLifecycle(instance);
      } else {
        this.kill(instance.instanceId);
      }
    }
  }

  // ── 重启恢复（T2.4，AD-10：注册表/闭包/任务/序号基线重建） ─────

  /**
   * 恢复产物注入（组合根装配后调用；T2.2 多会话下懒加载会话逐个注入）：
   * RestoreService 收口后的实例清单登记进注册表（终态/快照态原样）、
   * closure/task 回填观测面、agent-N 序号续基线（重启不重复分配，K5）。
   * 恢复不重放：不发布事件、不落盘（RestoreService 已收口落盘）、不触发
   * launch（不自动续跑）。
   *
   * T2.2 幂等注记：卸载后重载的会话实例仍在注册表（终态实例不出册）——
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
      const seq = agentSeqOf(item.instanceId);
      if (seq > this.seq) this.seq = seq;
    }
  }

  // ── 编排入口 ──────────────────────────────────────────────

  /**
   * spawn：预算判定 → 直跑/入队/拒绝。同步秒回（不等执行收口，AD-8 异步交付）。
   * rejected 时调用方（agent_spawn 工具/WS）把错误字符串回 LLM/前端。
   *
   * T2.2（AD-4 多会话）：sessionId 显式入参（实例归属会话；组合根经当前会话
   * 门面/会话绑定工具注入，全局预算不随会话数分裂——TR-AD-11/16）。
   */
  spawn(sessionId: string, task: string, profileKind?: string, model?: string): SpawnOutcome {
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
    if (model !== undefined) this.spawnModels.set(agentId, model); // T2.3：spawn 时透传当前模型
    // T2.1 契约 v0.3 §1 规则②：spawn 时刻锚计算一次（聚合内最后一条
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
   * T2.3：SubAgent 内部工具调用转 per-instance 领域事件（tool.call.*，挂
   * instanceId）——不进主线聚合（AD-8 铁律）。
   * T3.2：message_end(assistant, usage) 转 usage.recorded（source=turn）。
   *
   * T2.1（AD-3 职责回归）：**只产事件，不写聚合**——thinking 累积 / message
   * 落树（含 message_update 流式 delta 转发）/ tool 记录全部经事件总线发布；
   * 会话投影消费者（SessionProjection）消费事件后落 Session 聚合
   * （SubAgent Entry 进聚合，instanceId 归属；MainAgent 上下文零混入——
   * closure 注入仍是唯一入口）。事件载荷携完整条目数据（id 为 agent 作用域
   * `${instanceId}#N`，与流式 messageId 同源）。流序对齐主线：thinking 块先
   * 于消息完成（delta×N → thinking.completed → message.completed → usage）。
   */
  private onInstanceEvent(instanceId: string, event?: AgentEngineEvent): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) return; // 迟到/乱序事件：不崩不计
    this.lastEventAtMs.set(instanceId, this.deps.clock.nowMs());
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

    // ── T2.1（AD-3）：SubAgent 消息流 + thinking 块流（镜像主线时序） ──
    if (event.type === "message_start" && event.role === "assistant") {
      // 预分配 agent 作用域 entry id（流式 messageId = 最终 entry id，D-2 同构；
      // 投影落树沿用同一 id）——与主线不同：不触碰会话聚合计数器
      this.streamEntryIds.set(instanceId, this.nextEntryId(instanceId));
      this.thinkingStartsMs.set(instanceId, new Map());
      this.pendingThinking.set(instanceId, []);
      return;
    }
    if (event.type === "message_update") {
      const messageId = this.streamEntryIds.get(instanceId);
      if (messageId === undefined) return; // 未预留（乱序/非 assistant 流）：丢弃
      this.deps.events.publishDelta({
        messageId,
        delta: event.delta,
        sessionId: instance.sessionId, // 实例归属会话（T2.2 多会话）
        instanceId, // 帧实例维：前端路由至实例 channel（真供给线）
      });
      return;
    }
    if (event.type === "thinking_started") {
      const starts = this.thinkingStartsMs.get(instanceId) ?? new Map();
      starts.set(event.contentIndex, this.deps.clock.nowMs());
      this.thinkingStartsMs.set(instanceId, starts);
      return;
    }
    if (event.type === "thinking_delta") {
      this.deps.events.publishDelta({
        messageId: this.streamEntryIds.get(instanceId) ?? instanceId,
        delta: event.delta,
        channel: "thinking",
        sessionId: instance.sessionId, // 实例归属会话（T2.2 多会话）
        instanceId,
      });
      return;
    }
    if (event.type === "thinking_end") {
      const starts = this.thinkingStartsMs.get(instanceId);
      const startedMs = starts?.get(event.contentIndex) ?? this.deps.clock.nowMs();
      starts?.delete(event.contentIndex);
      const pending = this.pendingThinking.get(instanceId) ?? [];
      pending.push({ contentIndex: event.contentIndex, text: event.content, startedMs });
      this.pendingThinking.set(instanceId, pending);
      return;
    }
    if (event.type === "message_end" && event.role === "assistant") {
      // ① thinking 块先落（reasoningTokens 关联本消息 usage.reasoning 收口）
      const reasoning = event.usage?.reasoning ?? 0;
      for (const block of this.pendingThinking.get(instanceId) ?? []) {
        if (block.text.trim() === "") continue;
        this.publish(instance, "thinking.completed", {
          entry: {
            kind: "thinking",
            id: this.nextEntryId(instanceId),
            instanceId,
            text: block.text,
            durationMs: Math.max(0, this.deps.clock.nowMs() - block.startedMs),
            reasoningTokens: reasoning,
            createdAt: this.deps.clock.now(),
          },
        } satisfies ThinkingCompletedPayload);
      }
      this.pendingThinking.delete(instanceId);
      this.thinkingStartsMs.delete(instanceId);
      // ② 消息完成（空文本不落——空文本不是语义单元，与主线同口径）
      const reserved = this.streamEntryIds.get(instanceId);
      if (event.text.trim() !== "" && reserved !== undefined) {
        this.publish(instance, "message.completed", {
          entryId: reserved,
          role: "assistant",
          text: event.text,
          isSteer: false,
        } satisfies MessageCompletedPayload);
      }
      this.streamEntryIds.delete(instanceId);
      // ③ turn 入账（事件即账，AD-4——账本投影在 SessionProjection 单点接入；
      // 工具批中间 message_end(无 usage)/delta 不入账；error 轮零值 usage
      // 不入账（零成本不是真实计费调用，与主线终验热修同口径））
      if (event.usage !== undefined && event.stopReason !== "error") {
        this.publish(instance, "usage.recorded", {
          instanceId,
          usage: event.usage,
          source: "turn",
        } satisfies UsageRecordedPayload);
      }
      return;
    }
    if (event.type === "engine_error") {
      // F1.1（AD-1 事件数据面）：SubAgent 引擎错误不再静默——mirror 主线
      // ChatService engine_error（只发领域事件，不落 Entry、不动投影）；
      // WS 帧广播由 DtoMapper SubAgent 守卫抑制（AF-1，防错位弹主聊天流）。
      this.publishEngineError(instance, event.message);
      return;
    }
    // 其余引擎事件：观测面增量已计（lastEventAt 刷新），无 per-instance 领域动作
  }

  /** 实例收口：幂等（终态后到者 no-op）；done/failed/killed 三路径统一处理。 */
  private onInstanceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    const instance = this.registry.findInstance(instanceId);
    if (!instance || instance.isTerminal) return; // kill 与自然收口竞态：后到者吞

    // 流式/落树事件生产状态清理（T2.1：终态后迟到引擎事件不再产条目事件）
    this.streamEntryIds.delete(instanceId);
    this.entrySeqs.delete(instanceId);
    this.thinkingStartsMs.delete(instanceId);
    this.pendingThinking.delete(instanceId);

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

    // ── closure 收口链（T2.3，AD-8 双通道 + O-5 双产物；T2.2 多会话：报告/记录行按实例归属会话路由） ──
    // ① 报告双产物：closure_records 记录行（SQLite，任务报告本体）+
    //    reportPath 文件（markdown 摘要+findings）——均经 WriteQueue 单写
    //    队列原子写（TR-AD-6/13），重启后报告完整可读
    const reportsDir = this.deps.reportsDirFor?.(instance.sessionId);
    const reportPath =
      reportsDir !== undefined ? join(reportsDir, `${instanceId}.md`) : (outcome.closure.reportPath ?? null);
    const closure = normalizeClosure(outcome.closure, reportPath);
    if (reportsDir !== undefined && reportPath !== null) {
      void this.deps.repository.saveReportFile(
        reportPath,
        renderClosureReport(instanceId, this.tasks.get(instanceId) ?? "", closure),
      );
    }
    this.closures.set(instanceId, closure);
    void this.deps.repository.saveClosureRecord(instance.sessionId, instanceId, outcome.result, closure);

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
    this.lastEventAtMs.set(instance.instanceId, this.deps.clock.nowMs());
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
    const now = this.deps.clock.nowMs();
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

  /** agent 作用域 entry id 分配（`${instanceId}#N`；与流式 messageId 同源，不占会话主计数器）。 */
  private nextEntryId(instanceId: string): string {
    const n = (this.entrySeqs.get(instanceId) ?? 0) + 1;
    this.entrySeqs.set(instanceId, n);
    return `${instanceId}#${n}`;
  }

  /** F1.1：engine_error → 挂 instanceId 的领域事件（事件即数据面；payload 仅原文）。 */
  private publishEngineError(instance: AgentInstance, message: string): void {
    this.publish(instance, "engine.error", { message });
  }

  private publish<P>(instance: AgentInstance, type: DomainEvent["type"], payload: P): void {
    this.deps.events.publish({
      type,
      sessionId: instance.sessionId, // T2.2 多会话：事件归属 = 实例归属会话
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

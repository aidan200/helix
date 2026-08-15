import type { ChatPort, SendOutcome } from "../ports/inbound/ChatPort";
import type { AgentEngineEvent, AgentEnginePort } from "../ports/outbound/AgentEnginePort";
import type { SessionRepositoryPort } from "../ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import { AgentLifecycle, type AgentLifecycleState } from "../../domain/agent/AgentLifecycle";
import { Session } from "../../domain/session/Session";
import { ToolCallRecord } from "../../domain/tools/ToolCallRecord";
import type {
  AgentStateChangedPayload,
  DomainEvent,
  MessageCompletedPayload,
  SteerPayload,
  ToolCallPayload,
  ToolResultPayload,
  TurnCompletedPayload,
} from "../../domain/events/DomainEvent";

/**
 * ChatService —— 对话全流程编排（AD-17.1，architecture.md §3.4）。
 *
 * 【业务流转总览】（一条用户消息的完整生命周期）
 *
 *   用户输入（CLI/WS → ChatPort.sendMessage）
 *     ├─ 空闲（idle）：把消息落成 user Entry → 开新 Turn → 生命周期置 running
 *     │   → 驱动 AgentEnginePort（引擎事件经 onEngineEvent 回流）
 *     │   → assistant 流式 delta 直达 EventPublisherPort（不落盘）
 *     │   → 消息完成/工具调用/轮次收尾等里程碑 → 领域事件 → 发布 + 快照落盘
 *     └─ 生成中（running/steering）：转 steer 注入——入 domain SteerQueue
 *         （可观测：steer.queued 事件）+ 转发引擎 steer()；
 *         引擎在 turn 边界 drain（§5.3 时序契约），drain 回流时本服务
 *         收口当前 Turn（reason=steerDrained）并以注入消息开新 Turn。
 *
 *   abort（ChatPort.abort）→ 生命周期置 aborting → 引擎 abort()；
 *   引擎以 stop=error 空消息收尾（空文本不落 Entry），run 结束时
 *   Turn 置 interrupted、生命周期回 idle——**abort 非销毁**，后续
 *   sendMessage 正常开新轮（spike §2 场景 2 实测语义）。
 *
 * 【状态所有权】（AD-16）：Session/AgentLifecycle/SteerQueue/ToolCallRecord
 * 全部聚合在 domain，本服务只编排不改写规则；引擎侧状态（pi Agent.state）
 * 仅经事件回流投影到聚合。流式中间态（delta）不是领域事件、不落盘。
 *
 * 【持久化钩子】agent_end 后整体快照经 SessionRepositoryPort 落盘
 * （write-through，T1.8 接 SQLite 单写队列；当前 InMemory）。
 */
export interface ChatServiceDeps {
  /** agent 引擎（pi 防腐墙后的驱动出口）。 */
  readonly engine: AgentEnginePort;
  /** 领域状态持久化（write-through）。 */
  readonly repository: SessionRepositoryPort;
  /** 事件流发布（领域事件 + 流式 delta）。 */
  readonly events: EventPublisherPort;
  /** 时间源（领域事件/条目时间戳，测试可控）。 */
  readonly clock: ClockPort;
  /** 恢复场景传入重建聚合（T1.8 RestoreService）；默认新建会话。 */
  readonly session?: Session;
}

export class ChatService implements ChatPort {
  private readonly session: Session;
  private readonly lifecycle = new AgentLifecycle();
  /** 本会话的工具调用记录（id → 聚合；pending→running→completed/failed）。 */
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  /** 当前 run 的引擎事件监听器（start 时传入，run 内复用）。 */
  private listener: ((e: AgentEngineEvent) => void) | null = null;

  constructor(private readonly deps: ChatServiceDeps) {
    this.session = deps.session ?? Session.create();
  }

  // ── 观测面（SessionService/SystemPort 经组合根取，不走私有状态） ──

  get sessionId(): string {
    return this.session.id;
  }
  get agentState(): AgentLifecycleState {
    return this.lifecycle.current;
  }
  get sessionSnapshot() {
    return this.session.toSnapshot();
  }

  // ── ChatPort 实现 ────────────────────────────────────────

  /**
   * 发送用户消息：空闲时开新轮次并驱动引擎；生成中自动转 steer 注入。
   *
   * 返回值告诉 driving 侧消息去了哪里（新轮 or 注入队列）——
   * CLI 据此打印「已入 steer 队列」，WS 据此回执不同命令确认。
   */
  async sendMessage(text: string): Promise<SendOutcome> {
    if (text.trim() === "") {
      throw new Error("消息内容不能为空");
    }
    switch (this.lifecycle.current) {
      case "idle": {
        // ① 消息落聚合：user Entry（此刻起领域状态与引擎状态开始对齐）
        const entry = this.session.appendUserEntry(text, this.now());
        this.publishMessageCompleted(entry.toData().id, "user", text, false);
        // ② 开新轮次（Turn=generating）并广播开始
        const turn = this.session.beginTurn(entry.id, this.now());
        this.publish("turn.started", { turnId: turn.id });
        // ③ 生命周期 idle→running，驱动引擎（await 到整个 run 结束：
        //    含工具轮与 steer drain 轮——run 内的后续动作都由引擎事件回流驱动）
        this.setLifecycle("running");
        try {
          await this.deps.engine.start(text, (e) => this.onEngineEvent(e));
        } catch (err) {
          // 引擎异常不崩会话：可观测（engine.error 事件）+ 轮次收口为中断 + 回 idle
          this.publish("engine.error", { message: (err as Error).message });
          this.settleRunEnd("aborted");
        }
        return { mode: "turn", turnId: turn.id, entryId: entry.id };
      }
      case "running":
      case "steering": {
        // ④ 生成中的输入 = steer 注入（入 domain 队列可观测 + 引擎即时入队）
        const { entryId } = await this.steer(text);
        return { mode: "steered", entryId };
      }
      case "aborting":
        throw new Error("正在中断当前生成，请稍候再发送（abort 收尾后即恢复输入）");
      case "stopped":
        throw new Error("daemon 已停止，不再接受新消息");
    }
  }

  /**
   * 显式 steer 注入：要求正在运行中。
   * 领域侧先入队（applySteer 落 isSteer entry + SteerQueue.enqueue），
   * 再转发引擎——两队列各自独立可观测（domain SteerQueue 是权威，
   * 引擎队列是执行机制），drain 回流时以 domain 队列出账。
   */
  async steer(text: string): Promise<{ entryId: string }> {
    this.lifecycle.assertIn("running", "steering");
    const entry = this.session.applySteer(text, this.now());
    if (this.lifecycle.current === "running") {
      this.setLifecycle("steering"); // running→steering：有注入待 drain
    }
    this.publish<SteerPayload>("steer.queued", { entryId: entry.id, text });
    this.deps.engine.steer(text);
    return { entryId: entry.id };
  }

  /**
   * 中断当前生成：生命周期 running/steering→aborting + 引擎 abort()。
   * 空闲/已中断时幂等忽略（用户连按 Ctrl-C 不产生二次状态变更）。
   */
  abort(): void {
    if (this.lifecycle.current === "running" || this.lifecycle.current === "steering") {
      this.setLifecycle("aborting");
      this.deps.engine.abort();
    }
  }

  /** 系统停止（SystemPort.shutdown 经组合根调用）：终态，拒绝后续输入。 */
  stop(): void {
    if (this.lifecycle.current !== "stopped") {
      this.lifecycle.transition("stopped");
      this.publish<AgentStateChangedPayload>("agent.state.changed", { state: "stopped" });
    }
  }

  // ── 引擎事件回流 → 领域状态变更 + 领域事件（编排核心） ───────

  private onEngineEvent(e: AgentEngineEvent): void {
    switch (e.type) {
      // 流式增量：直达事件流（中间态，不落盘、不改聚合）
      case "message_update":
        this.deps.events.publishDelta({ messageId: this.currentTurnId(), delta: e.delta });
        break;

      // turn 边界的 steer drain（§5.3：turn_end 后、turn_start 前）：
      // 引擎把注入消息作为新 turn 首条 user 消息回放——此处收口旧 Turn
      //（reason=steerDrained）并以注入消息开新 Turn，同时 domain 队列出账。
      case "message_start":
        if (e.role === "user" && e.source === "steer-drain") {
          this.finishOpenTurn("steerDrained");
          const item = this.session.dequeueSteer();
          if (item) {
            this.publish<SteerPayload>("steer.drained", { entryId: item.entryId, text: item.text });
            const turn = this.session.beginTurn(item.entryId, this.now());
            this.publish("turn.started", { turnId: turn.id });
          }
          if (this.lifecycle.current === "steering") {
            this.setLifecycle("running"); // 注入已消费，回到 running 续跑
          }
        }
        break;

      // 消息完成：assistant 回复落聚合 + 广播（abort 的 stop=error 空消息不落——
      // 空文本不是语义单元；user/toolResult 消息已在注入/工具事件中落账，不重复）
      case "message_end":
        if (e.role === "assistant" && e.text.trim() !== "") {
          const entry = this.session.appendAssistantEntry(e.text, this.now());
          this.publishMessageCompleted(entry.id, "assistant", e.text, false);
        }
        break;

      // 工具调用开始：建记录（pending→running）、轮次切 toolRunning、广播
      case "tool_execution_start": {
        const record = ToolCallRecord.create(e.toolCallId, e.toolName, e.args);
        record.markRunning(this.now());
        this.toolCalls.set(e.toolCallId, record);
        if (this.session.openTurn?.status === "generating") {
          this.session.markTurnToolRunning();
        }
        this.publish<ToolCallPayload>("tool.call.started", {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        });
        break;
      }

      // 工具调用结束：记录收口（completed/failed）+ 广播结果
      case "tool_execution_end": {
        const record = this.toolCalls.get(e.toolCallId);
        if (record) {
          if (e.isError) record.fail(e.result, this.now());
          else record.complete(e.result, this.now());
        }
        this.publish<ToolResultPayload>("tool.call.result", {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          isError: e.isError,
          result: e.result,
        });
        break;
      }

      // pi 的 turn_end = 一次 assistant 生成 + 工具批收尾。带工具结果的
      // turn_end 意味着 assistant 将带着工具结果继续生成（新 pi turn）——
      // domain Turn 保持 open、状态回到 generating；无工具结果的 turn_end
      // 可能是 run 收尾（agent_end 兜底收口），此处不动。
      case "turn_end":
        if (e.toolResultCount > 0 && this.session.openTurn?.status === "toolRunning") {
          this.session.resumeTurnGenerating();
        }
        break;

      // run 结束：收口当前 Turn（abort→interrupted / 正常→completed）、
      // 生命周期回 idle、整体快照落盘（write-through 钩子点）
      case "agent_end":
        this.settleRunEnd(this.lifecycle.current === "aborting" ? "aborted" : "done");
        break;

      // 引擎侧错误（如 compaction 摘要失败——provider 约束，spike GO 附条件①）：
      // 不崩会话，只做事件可观测
      case "engine_error":
        this.publish("engine.error", { message: e.message });
        break;

      default:
        break; // agent_start/turn_start/message_start(assistant) 等无领域动作
    }
  }

  /** run 结束统一收口：Turn 终态 + 生命周期 idle + 快照落盘。 */
  private settleRunEnd(reason: TurnCompletedPayload["reason"]): void {
    if (this.session.openTurn) {
      if (reason === "aborted") {
        const t = this.session.interruptTurn(this.now());
        this.publish<TurnCompletedPayload>("turn.interrupted", { reason: "aborted", replyEntryId: undefined });
        void t;
      } else {
        const t = this.session.completeTurn(this.now());
        this.publish<TurnCompletedPayload>("turn.completed", { reason: "done", replyEntryId: undefined });
        void t;
      }
    }
    if (this.lifecycle.current !== "idle" && this.lifecycle.canTransition("idle")) {
      this.setLifecycle("idle");
    }
    // write-through：领域状态整体快照持久化（T1.8 前为 InMemory）
    void this.deps.repository.save(this.session.toSnapshot());
  }

  // ── 私有工具 ────────────────────────────────────────────

  private finishOpenTurn(reason: TurnCompletedPayload["reason"]): void {
    const open = this.session.openTurn;
    if (!open) return;
    if (reason === "aborted") {
      this.session.interruptTurn(this.now());
      this.publish<TurnCompletedPayload>("turn.interrupted", { reason });
    } else {
      this.session.completeTurn(this.now());
      this.publish<TurnCompletedPayload>("turn.completed", { reason });
    }
  }

  private currentTurnId(): string {
    return this.session.openTurn?.id ?? "idle";
  }

  private setLifecycle(to: AgentLifecycleState): void {
    this.lifecycle.transition(to);
    this.publish<AgentStateChangedPayload>("agent.state.changed", { state: to });
  }

  private publishMessageCompleted(
    entryId: string,
    role: MessageCompletedPayload["role"],
    text: string,
    isSteer: boolean,
  ): void {
    this.publish<MessageCompletedPayload>("message.completed", { entryId, role, text, isSteer });
  }

  private publish<P>(type: DomainEvent["type"], payload: P, turnId?: string): void {
    this.deps.events.publish({
      type,
      sessionId: this.session.id,
      turnId: turnId ?? this.session.openTurn?.id,
      payload,
      occurredAt: this.now(),
    });
  }

  private now(): string {
    return this.deps.clock.now();
  }
}

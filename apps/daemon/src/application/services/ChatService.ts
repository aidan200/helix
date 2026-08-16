import type { ChatPort, SendOutcome } from "../ports/inbound/ChatPort";
import type { AgentEngineEvent, AgentEnginePort } from "../ports/outbound/AgentEnginePort";
import type { SessionRepositoryPort } from "../ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import { AgentLifecycle, type AgentLifecycleState } from "../../domain/agent/AgentLifecycle";
import { Session } from "../../domain/session/Session";
import type { ThinkingEntryData } from "../../domain/session/ThinkingEntry";
import { MAIN_INSTANCE_ID } from "../../domain/agent/AgentInstance";
import type { UsageSummary } from "../../domain/session/SessionSnapshot";
import { ToolCallRecord, type ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import type {
  AgentStateChangedPayload,
  CompactionCompletedPayload,
  DomainEvent,
  MessageCompletedPayload,
  SteerPayload,
  ThinkingCompletedPayload,
  ToolCallPayload,
  ToolResultPayload,
  TurnCompletedPayload,
  UsageRecordedPayload,
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
 *   closure 注入（T2.3 injectClosure，AD-8 双通道之一；组合根接
 *   SchedulerService 收口回调）：SubAgent 收口消息与用户 steer 同队列
 *   同语义——idle 立即新 turn / running 下轮 turn 边界 drain（FIFO 保序）。
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
  /** 恢复场景传入历史工具调用记录（重启后工具历史随快照延续，避免整体替换写抹掉）。 */
  readonly restoredToolCalls?: readonly ToolCallRecordData[];
}

export class ChatService implements ChatPort {
  private readonly session: Session;
  private readonly lifecycle = new AgentLifecycle();
  /** 本会话的工具调用记录（id → 聚合；pending→running→completed/failed）。 */
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  /** 当前 run 的引擎事件监听器（start 时传入，run 内复用）。 */
  private listener: ((e: AgentEngineEvent) => void) | null = null;
  /** 流式期间预分配的 assistant entry id（D-2：delta.messageId 对齐最终 entry id）。 */
  private streamEntryId: string | null = null;
  /** 本 assistant 消息内在途的 thinking 块（contentIndex → 块序号计时；message_end 时落 Entry）。 */
  private readonly thinkingStarts = new Map<number, string>();
  private pendingThinking: { contentIndex: number; text: string; startedAt: string }[] = [];

  constructor(private readonly deps: ChatServiceDeps) {
    this.session = deps.session ?? Session.create();
    for (const data of deps.restoredToolCalls ?? []) {
      const record = ToolCallRecord.restore(data);
      // D-1 恢复收口：非终态（pending/running）记录重启后不可能继续跑，
      // 收口 failed（前端不再渲染永不完结的 spinner 卡；与 open turn 收口
      // interrupted 同构：恢复到最后一致里程碑）。pending 先经 markRunning
      // 保持迁移合法性，running 直接 fail。
      if (data.status === "pending") {
        record.markRunning();
        record.fail("daemon 重启，工具调用未完成（恢复时收口）");
      } else if (data.status === "running") {
        record.fail("daemon 重启，工具调用未完成（恢复时收口）");
      }
      this.toolCalls.set(data.id, record);
    }
  }

  // ── 观测面（SessionService/SystemPort 经组合根取，不走私有状态） ──

  get sessionId(): string {
    return this.session.id;
  }
  get agentState(): AgentLifecycleState {
    return this.lifecycle.current;
  }
  /** 聚合只读访问（SessionService 快照取数；组合根接线用）。 */
  get sessionView() {
    return this.session;
  }
  get sessionSnapshot() {
    return this.session.toSnapshot();
  }
  /** 领域状态整体（持久化载荷，F(8).1 标准 1）：会话聚合 + 生命周期 + 工具记录。 */
  get persistedState() {
    return {
      session: this.session.toSnapshot(),
      agentState: this.lifecycle.current,
      toolCalls: [...this.toolCalls.values()].map((r) => r.toData()),
    };
  }
  /** 工具调用记录只读观测面（D-1：SessionService 快照取数经组合根接线）。 */
  get toolCallData(): readonly ToolCallRecordData[] {
    return [...this.toolCalls.values()].map((r) => r.toData());
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

  /**
   * closure 注入主线（T2.3，AD-8 双通道之一；组合根接 SchedulerService
   * 的 injectClosure 回调，非 ChatPort 成员——不面向 driving 侧）：
   * - idle：立即触发新 turn（注入消息作为新 turn 输入，等价即刻 drain）；
   * - running/steering：与用户 steer 同队列同语义入队（source=closure，
   *   FIFO 保序，下轮 turn 边界 drain）；
   * - aborting/stopped：无法注入（abort 收尾窗口/已停机），可观测丢弃。
   *
   * 同步方法（调度侧收口回调链不 await）；新 turn 驱动异步火灾不管（fire-
   * and-forget），异常经 engine.error 可观测不崩会话。
   */
  injectClosure(text: string): void {
    switch (this.lifecycle.current) {
      case "idle":
        void this.sendMessage(text).catch((err) => {
          this.publish("engine.error", { message: `closure 注入失败：${(err as Error).message}` });
        });
        return;
      case "running":
      case "steering": {
        try {
          const entry = this.session.applySteer(text, this.now(), "closure");
          if (this.lifecycle.current === "running") {
            this.setLifecycle("steering"); // 同用户 steer：有注入待 drain
          }
          this.publish<SteerPayload>("steer.queued", { entryId: entry.id, text });
          this.deps.engine.steer(text);
        } catch (err) {
          this.publish("engine.error", { message: `closure 注入失败：${(err as Error).message}` });
        }
        return;
      }
      case "aborting":
      case "stopped":
        this.publish("engine.error", {
          message: `closure 注入被丢弃（生命周期 ${this.lifecycle.current}）：${text.slice(0, 80)}`,
        });
        return;
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
      // 流式增量：直达事件流（中间态，不落盘、不改聚合）。messageId 用
      // message_start 时预分配的最终 assistant entry id（D-2：与契约 §5
      // 字段语义对齐；fallback 仅防御，正常路径必有预留）
      case "message_update":
        this.deps.events.publishDelta({ messageId: this.streamEntryId ?? this.currentTurnId(), delta: e.delta });
        break;

      // turn 边界的 steer drain（§5.3：turn_end 后、turn_start 前）：
      // 引擎把注入消息作为新 turn 首条 user 消息回放——此处收口旧 Turn
      //（reason=steerDrained）并以注入消息开新 Turn，同时 domain 队列出账。
      case "message_start":
        if (e.role === "assistant") {
          // D-2：assistant 流开始即预分配最终 entry id（放弃不回收——工具轮
          // 空消息的预留自然作废，计数器空洞无害）
          this.streamEntryId = this.session.reserveEntryId();
          // T3.1：新 assistant 消息开始，在途 thinking 块计时/累积重置
          this.thinkingStarts.clear();
          this.pendingThinking = [];
        }
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
      // 空文本不是语义单元；user/toolResult 消息已在注入/工具事件中落账，不重复）。
      // T3.1：本消息内的 thinking 块在此时落 Entry（reasoningTokens 取本
      // turn usage.reasoning——thinking_end 早于 message_end，关联在此收口）
      case "message_end":
        if (e.role === "assistant") {
          // T3.1：thinking 块先落（流序对齐契约 §5.2：delta×N → thinking.completed
          // → 消息完成；reasoningTokens 取本 turn usage.reasoning 收口）
          this.flushPendingThinking(e.usage?.reasoning ?? 0);
          if (e.text.trim() !== "") {
            const entry = this.session.appendAssistantEntry(e.text, this.now(), this.streamEntryId ?? undefined);
            this.publishMessageCompleted(entry.id, "assistant", e.text, false);
          }
          this.streamEntryId = null; // 预留消耗完毕（空文本/abort 轮同样清空）
        }
        break;

      // ── T3.1 通道族：thinking 三事件 + compaction ─────────────

      // thinking 块流：中间态不落盘（TR-AD-5）——delta 直达流式通道，
      // start 记墙钟起点（durationMs = start→end，ClockPort）；end 暂存
      // 完成块，待 message_end 关联本 turn reasoningTokens 后落 Entry
      case "thinking_started":
        this.thinkingStarts.set(e.contentIndex, this.now());
        break;

      case "thinking_delta":
        this.deps.events.publishDelta({
          messageId: this.streamEntryId ?? this.currentTurnId(),
          delta: e.delta,
          channel: "thinking",
          instanceId: MAIN_INSTANCE_ID,
        });
        break;

      case "thinking_end": {
        const startedAt = this.thinkingStarts.get(e.contentIndex);
        this.thinkingStarts.delete(e.contentIndex);
        this.pendingThinking.push({ contentIndex: e.contentIndex, text: e.content, startedAt: startedAt ?? this.now() });
        break;
      }

      // compaction 完成：CompactionEntry 落树 + 里程碑事件 + usage 入账
      //（source=compaction，AD-9③；provider 未报 usage 时零值占位仍入账——
      // 账目行完整，聚合本体归 T3.2）
      case "compaction_completed": {
        const entry = this.session.appendCompactionEntry({
          kind: "compaction",
          instanceId: MAIN_INSTANCE_ID,
          tokensBefore: e.tokensBefore,
          tokensAfter: e.tokensAfter,
          summary: e.summary,
          usage: e.usage ?? ZERO_USAGE,
          createdAt: this.now(),
        });
        this.publish<CompactionCompletedPayload>("compaction.completed", { entry: entry.toData() }, undefined, MAIN_INSTANCE_ID);
        this.publish<UsageRecordedPayload>(
          "usage.recorded",
          { instanceId: MAIN_INSTANCE_ID, usage: entry.toData().usage, source: "compaction" },
          undefined,
          MAIN_INSTANCE_ID,
        );
        break;
      }

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
          args: record?.args,
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

  /** run 结束统一收口：Turn 终态 + 生命周期 idle（每个里程碑事件在 publish 内已 write-through 落盘）。 */
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

  /** 落 pending 的 thinking 块：每块一条 ThinkingEntry + thinking.completed 事件
   *  （T3.1；reasoningTokens 为本 turn 关联值——块间共享，账目归 T3.2）。 */
  private flushPendingThinking(reasoningTokens: number): void {
    const blocks = this.pendingThinking;
    this.pendingThinking = [];
    for (const block of blocks) {
      const entry = this.session.appendThinkingEntry({
        kind: "thinking",
        instanceId: MAIN_INSTANCE_ID,
        text: block.text,
        durationMs: Math.max(0, Date.parse(this.now()) - Date.parse(block.startedAt)),
        reasoningTokens,
        createdAt: this.now(),
      });
      const data: ThinkingEntryData = entry.toData();
      this.publish<ThinkingCompletedPayload>("thinking.completed", { entry: data }, undefined, MAIN_INSTANCE_ID);
    }
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

  private publish<P>(
    type: DomainEvent["type"],
    payload: P,
    turnId?: string,
    instanceId?: string,
  ): void {
    this.deps.events.publish({
      type,
      sessionId: this.session.id,
      turnId: turnId ?? this.session.openTurn?.id,
      ...(instanceId !== undefined ? { instanceId } : {}),
      payload,
      occurredAt: this.now(),
    });
    // write-through（AD-16 §5.2）：每个里程碑领域事件后即落领域状态整体
    //（事件行经 fan-out 持久化目标入同一写队列，先事件后状态，全局 FIFO）。
    // 单次落盘失败不阻断会话（WriteQueue onError 上报）。
    void this.deps.repository.save(this.persistedState);
  }

  private now(): string {
    return this.deps.clock.now();
  }
}

/** provider 未报用量时的零值占位（七字段全 0；账目行保持完整，AD-9③）。 */
const ZERO_USAGE: UsageSummary = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: 0,
};

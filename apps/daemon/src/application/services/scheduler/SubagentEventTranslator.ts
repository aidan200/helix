import type { AgentInstance } from "../../../domain/agent/AgentInstance";
import type {
  DomainEvent,
  MessageCompletedPayload,
  ThinkingCompletedPayload,
  ToolCallPayload,
  ToolResultPayload,
  UsageRecordedPayload,
} from "../../../domain/events/DomainEvent";
import type { EventPublisherPort } from "../../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../ports/outbound/ClockPort";
import type { AgentEngineEvent } from "../../ports/outbound/AgentEnginePort";

/**
 * SubagentEventTranslator —— SubAgent 引擎事件翻译状态机（拆自
 * SchedulerService，architecture.md §2.4/§4，AD-3/TR-AD-25④）。
 *
 * 【职责】runner 上行的引擎事件 → 领域事件/流式 delta 翻译（thinking 累积 /
 * message 落树含 message_update 流式 / tool 记录 / usage 入账 / engine.error
 * 镜像），持有 **6 个 per-instance Map 写侧**（streamEntryIds / entrySeqs /
 * thinkingStartsMs / pendingThinking / subToolArgs / lastEventAtMs）与
 * entry id 分配（nextEntryId——entrySeqs 状态在此）。
 *
 * 【只产事件，不写聚合】（AD-3 职责回归）：thinking 累积 / message
 * 落树（含 message_update 流式 delta 转发）/ tool 记录全部经事件总线发布；
 * 会话投影消费者（SessionProjection）消费事件后落 Session 聚合（SubAgent
 * Entry 进聚合，instanceId 归属；MainAgent 上下文零混入——closure 注入仍是
 * 唯一入口）。事件载荷携完整条目数据（id 为 agent 作用域 `${instanceId}#N`，
 * 与流式 messageId 同源）。流序对齐主线：thinking 块先于消息完成
 * （delta×N → thinking.completed → message.completed → usage）。
 *
 * 【onInstanceClosure 清理序列单点持有】onClosureCleanup()：四个流式/落树
 * 状态 Map 的 delete 序列（streamEntryIds → entrySeqs → thinkingStartsMs →
 * pendingThinking），由门面 onInstanceClosure 回调转发链的**原序位**调用
 * （清理 → 翻译迁移 → 收口链），顺序不得重排（唯一行为风险点）。
 */
export interface SubagentEventTranslatorDeps {
  /** 事件流发布（领域事件 → fan-out；流式 delta → 前端实例 channel）。 */
  readonly events: EventPublisherPort;
  /** 时间源（lastEventAt 刷新 / thinking durationMs / 事件 occurredAt）。 */
  readonly clock: ClockPort;
}

export class SubagentEventTranslator {
  /** 实例 → 最近引擎事件时间戳（epoch ms；stalled 判定输入）。 */
  private readonly lastEventAtMs = new Map<string, number>();
  /** SubAgent 工具调用 → args（result 事件载荷回填；start→end 间短暂驻留）。 */
  private readonly subToolArgs = new Map<string, unknown>();
  // ── SubAgent 流式/落树事件生产状态（AD-3：只产事件，聚合写归会话投影） ──
  /** 实例 → 预分配 assistant 消息 entry id（流式 messageId 与最终 entry 同源，D-2 同构）。 */
  private readonly streamEntryIds = new Map<string, string>();
  /** 实例 → agent 作用域 entry 序号（id 形如 `${instanceId}#N`，不占会话主计数器）。 */
  private readonly entrySeqs = new Map<string, number>();
  /** 实例 → thinking 块开始时刻（epoch ms；durationMs = start→end）。 */
  private readonly thinkingStartsMs = new Map<string, Map<number, number>>();
  /** 实例 → 在途 thinking 块（message_end 时关联 reasoningTokens 后产事件）。 */
  private readonly pendingThinking = new Map<string, { contentIndex: number; text: string; startedMs: number }[]>();

  constructor(private readonly deps: SubagentEventTranslatorDeps) {}

  /**
   * 引擎事件增量翻译：刷新 lastEventAt（stalled 判定输入）；事件分支全翻译。
   * SubAgent 内部工具调用转 per-instance 领域事件（tool.call.*，挂
   * instanceId）——不进主线聚合（AD-8 铁律）。
   * message_end(assistant, usage) 转 usage.recorded（source=turn）。
   *
   * 未知/终态实例忽略（守卫在门面回调转发处——注册表归门面）。
   */
  onInstanceEvent(instance: AgentInstance, event?: AgentEngineEvent): void {
    const instanceId = instance.instanceId;
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

    // ──（AD-3）：SubAgent 消息流 + thinking 块流（镜像主线时序） ──
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
        sessionId: instance.sessionId, // 实例归属会话（多会话）
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
        sessionId: instance.sessionId, // 实例归属会话（多会话）
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
      // SubAgent 引擎错误不再静默——mirror 主线（AD-1 事件数据面）
      // ChatService engine_error（只发领域事件，不落 Entry、不动投影）；
      // WS 帧广播由 DtoMapper SubAgent 守卫抑制（防错位弹主聊天流）。
      this.publishEngineError(instance, event.message);
      return;
    }
    // 其余引擎事件：观测面增量已计（lastEventAt 刷新），无 per-instance 领域动作
  }

  /**
   * onInstanceClosure 清理序列（拆分单点持有，原序保持）：
   * 终态后迟到引擎事件不再产条目事件——四 delete 顺序与拆分前逐行对照
   * （原 SchedulerService L565-568）：streamEntryIds → entrySeqs →
   * thinkingStartsMs → pendingThinking。调用点次序不得重排（清理 →
   * 状态机迁移 → 收口链，见门面 onInstanceClosure）。
   */
  onClosureCleanup(instanceId: string): void {
    this.streamEntryIds.delete(instanceId);
    this.entrySeqs.delete(instanceId);
    this.thinkingStartsMs.delete(instanceId);
    this.pendingThinking.delete(instanceId);
  }

  // ── 门面读写面（stalled 判定 / 启动戳 / queued 取消清理） ──

  /** stalled 判定输入只读（门面 checkStalled 轮询取数）。 */
  lastEventAtOf(instanceId: string): number | undefined {
    return this.lastEventAtMs.get(instanceId);
  }

  /** 启动戳写入（门面 startInstance：running 起算 idle 计时）。 */
  touchLastEventAt(instanceId: string): void {
    this.lastEventAtMs.set(instanceId, this.deps.clock.nowMs());
  }

  /** queued 取消清理（门面 cancelSession：queued → cancelled 不走收口链的定点清键）。 */
  forgetLastEventAt(instanceId: string): void {
    this.lastEventAtMs.delete(instanceId);
  }

  /** agent 作用域 entry id 分配（`${instanceId}#N`；与流式 messageId 同源，不占会话主计数器）。 */
  private nextEntryId(instanceId: string): string {
    const n = (this.entrySeqs.get(instanceId) ?? 0) + 1;
    this.entrySeqs.set(instanceId, n);
    return `${instanceId}#${n}`;
  }

  /** engine_error → 挂 instanceId 的领域事件（事件即数据面；payload 仅原文）。 */
  private publishEngineError(instance: AgentInstance, message: string): void {
    this.publish(instance, "engine.error", { message });
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

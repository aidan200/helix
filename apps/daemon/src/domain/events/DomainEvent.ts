/**
 * 领域事件（architecture.md §3.3 / §5）：里程碑状态变更的值对象——
 * write-through 落盘与前端投影的统一事件源。
 *
 * 边界（AD-16）：流式中间态（token 级 delta）**不是**领域事件，
 * 不进本类型、不落盘（走 EventPublisherPort 的流式通道直达前端）。
 */
import type { ThinkingEntryData } from "../session/ThinkingEntry";
import type { CompactionEntryData } from "../session/CompactionEntry";
import type { UsageSummary } from "../session/SessionSnapshot";

export type DomainEventType =
  | "turn.started"
  | "turn.completed"
  | "turn.interrupted"
  | "message.completed"
  | "steer.queued"
  | "steer.drained"
  | "tool.call.started"
  | "tool.call.result"
  | "agent.state.changed"
  | "engine.error"
  // ── agent.* 编排生命周期族（iter-20260816-uzvg T2.1，契约 protocol-v0.1.md §5.1）──
  | "agent.spawned"
  | "agent.queued"
  | "agent.started"
  | "agent.stalled"
  | "agent.completed"
  | "agent.failed"
  | "agent.killed"
  // ── 通道族（iter-20260816-uzvg T3.1，契约 protocol-v0.1.md §5.2；AD-3/AD-9）──
  // thinking.stream.delta 是流式中间态不入本表（TR-AD-5，走流式通道）
  | "thinking.completed"
  | "compaction.completed"
  | "usage.recorded";

export interface DomainEvent<P = unknown> {
  readonly type: DomainEventType;
  readonly sessionId: string;
  /** 关联轮次（轮次级事件必填；会话级可空）。 */
  readonly turnId?: string;  /**
   * 实例归属（AD-3，iter-20260816-uzvg T1.2）：缺省 = 主实例（协议同语义，
   * 契约 §1）。SubAgent 实例事件携带 agent-N；发布侧挂 id 由 T2.3/T3.x 接。
   */
  readonly instanceId?: string;
  readonly payload: P;
  /** 发生时刻（ISO 8601，来自 ClockPort——测试可控）。 */
  readonly occurredAt: string;
}

// ── 常用载荷形状（纯数据，供 service 构造事件时复用） ─────────

export interface MessageCompletedPayload {
  readonly entryId: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly isSteer: boolean;
}

export interface SteerPayload {
  readonly entryId: string;
  readonly text: string;
}

export interface TurnCompletedPayload {
  readonly reason: "done" | "aborted" | "steerDrained";
  readonly replyEntryId?: string;
}

export interface ToolCallPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface ToolResultPayload extends ToolCallPayload {
  readonly isError: boolean;
  readonly result: string;
}

export interface AgentStateChangedPayload {
  readonly state: "idle" | "running" | "steering" | "aborting" | "stopped";
}

// ── agent.* 编排生命周期族载荷（T2.1，契约 §5.1/§5.3） ─────────────
// 字段名用 agentId（编排族视角；instanceId ≡ agentId 同一标识空间，契约 §2）；
// envelope.instanceId 由发布侧同值携带（domain_events 落列 trace 四维用）。

export interface AgentSpawnedPayload {
  readonly agentId: string;
  readonly task: string;
  readonly profileKind: string;
  /** "provider/model-id"；缺省继承当前模型（解析归 T2.2，此处可选）。 */
  readonly model?: string;
}

export interface AgentQueuedPayload {
  readonly agentId: string;
  /** FIFO 位次（1 起；仅出队触发递减重发）。 */
  readonly position: number;
}

export interface AgentStartedPayload {
  readonly agentId: string;
}

/** stalled 非状态迁移（实例仍 running），可随 idle 持续重复推送（契约 §8.3）。 */
export interface AgentStalledPayload {
  readonly agentId: string;
  readonly idleMs: number;
}

/**
 * 实例收口记录（结构承接 v1 / 协议 ClosureDto，AD-8）：kill 收口 status
 * 同为 "failed"（单一终态语义）。可选字段缺失时显式 null（全字段必发纪律，
 * test-design §4.3）——由 SchedulerService 收口入口统一归一。
 */
export interface InstanceClosurePayload {
  readonly status: "done" | "failed";
  readonly summary: string;
  readonly reportPath?: string | null;
  readonly findings?: unknown[] | null;
  readonly taskId?: string | null;
}

export interface AgentCompletedPayload {
  readonly agentId: string;
  readonly closure: InstanceClosurePayload;
}

export interface AgentFailedPayload {
  readonly agentId: string;
  readonly error: string;
  readonly closure: InstanceClosurePayload;
}

export interface AgentKilledPayload {
  readonly agentId: string;
  readonly closure: InstanceClosurePayload;
}

// ── 通道族载荷（T3.1，契约 §5.2/§6.1）────────────────────
// 字段名用 instanceId（通道族视角；instanceId ≡ agentId 同一标识空间，契约 §2）。

/** thinking 完成（一个 thinking 块 → 一条 ThinkingEntry；payload 携带全字段条目）。 */
export interface ThinkingCompletedPayload {
  readonly entry: ThinkingEntryData;
}

/** compaction 完成（tokensBefore/tokensAfter/summary/usage 全字段条目）。 */
export interface CompactionCompletedPayload {
  readonly entry: CompactionEntryData;
}

/** 用量入账（turn 完成 / compaction 摘要调用；流式中不发，AD-4）。 */
export interface UsageRecordedPayload {
  readonly instanceId: string;
  readonly usage: UsageSummary;
  readonly source: "turn" | "compaction";
}

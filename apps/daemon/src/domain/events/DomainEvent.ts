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
  | "engine.retrying"
  // ── agent.* 编排生命周期族（契约 protocol-v0.1.md §5.1）──
  | "agent.spawned"
  | "agent.queued"
  | "agent.started"
  | "agent.stalled"
  | "agent.completed"
  | "agent.failed"
  | "agent.killed"
  // ── park/resume 批（设计稿 park-resume §5；additive）──
  | "agent.parked"
  | "agent.resumed"
  // ── 通道族（契约 protocol-v0.1.md §5.2；AD-3/AD-9）──
  // thinking.stream.delta 是流式中间态不入本表（TR-AD-5，走流式通道）
  | "thinking.completed"
  | "compaction.completed"
  | "usage.recorded"
  // ── v0.4 执行上下文面（AD-5/AD-6；只落盘不广播）──
  | "agent.instantiated"
  | "agent.model.changed"
  // ── thinking 批（v0.11，AD-4①③；只落盘不广播，广播走 thinking.changed 链）──
  | "agent.thinking.changed";

export interface DomainEvent<P = unknown> {
  readonly type: DomainEventType;
  readonly sessionId: string;
  /** 关联轮次（轮次级事件必填；会话级可空）。 */
  readonly turnId?: string;  /**
   * 实例归属（AD-3）：缺省 = 主实例（协议同语义，
   * 契约 §1）。SubAgent 实例事件携带 agent-N；发布侧挂 id 由 / .x 接。
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
  /** steer 条目落盘时点的两态（additive）：drain 落盘 = "drained"（生效时序
   *  落盘后队列已出账）；缺省 = 旧路径回退（事件时点刚入队 = "queued"）。 */
  readonly steerState?: "queued" | "drained";
  /** 注入来源（T11b：user/closure/progress；idle closure 注入实时帧区分依据；缺省 = 用户输入）。 */
  readonly source?: "user" | "closure" | "progress";
  /** 图片附件（上行）：base64 data URL 数组；仅 user 消息携带，缺省 = 纯文本。 */
  readonly images?: readonly string[];
}

export interface SteerPayload {
  readonly entryId: string;
  readonly text: string;
  /** 注入来源（T11a：user/closure/progress；缺省 = 老事件按 user）。 */
  readonly source?: "user" | "closure" | "progress";
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
  /** 工具结果附带图片（下行）：base64 data URL 数组（如截图）；缺省 = 无图。 */
  readonly images?: readonly string[];
}

export interface AgentStateChangedPayload {
  readonly state: "idle" | "running" | "steering" | "aborting" | "stopped";
}

/** LLM 瞬时失败进入退避重试（P2 ⑦ 网络重试批）：等待期可观测——chat 状态行「网络重试中第 N/3 次」数据源；瞬态非里程碑（流恢复/轮终即过，不入账）。 */
export interface EngineRetryingPayload {
  /** 即将执行的重试序号（1 起，最大 = totalAttempts）。 */
  readonly attempt: number;
  /** 重试总次数（退避序列长度）。 */
  readonly totalAttempts: number;
  /** 本次重试前等待毫秒数。 */
  readonly waitMs: number;
  /** 触发重试的 provider 错误原文。 */
  readonly message: string;
}

// ── agent.* 编排生命周期族载荷（契约 §5.1/§5.3） ─────────────
// 字段名用 agentId（编排族视角；instanceId ≡ agentId 同一标识空间，契约 §2）；
// envelope.instanceId 由发布侧同值携带（domain_events 落列 trace 四维用）。

export interface AgentSpawnedPayload {
  readonly agentId: string;
  readonly task: string;
  readonly profileKind: string;
  /** "provider/model-id"；缺省继承当前模型（解析归，此处可选）。 */
  readonly model?: string;
}

export interface AgentQueuedPayload {
  readonly agentId: string;
  /** FIFO 位次（1 起；仅出队触发递减重发）。 */
  readonly position: number;
}

export interface AgentStartedPayload {
  readonly agentId: string;
  /** 当前 running 段起点（epoch ms；前端真实执行时长锚点）。 */
  readonly startedAtMs: number;
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

// ── park/resume 批载荷（设计稿 park-resume §2.1/§5；非终态事件） ────────

/**
 * 挂起原因枚举（设计稿 §5）：taskPause=任务暂停链（后续波次接线）；
 * user=用户/主 agent 主动挂起。本批 park API 留字段（链 B 网络自动挂起已裁删）。
 */
export type ParkReason = "user" | "taskPause";

/** agent.parked：实例挂起（非终态——不写 closure、不触发收口链、不注入主线）。 */
export interface AgentParkedPayload {
  readonly agentId: string;
  readonly reason: ParkReason;
  /** 挂起时刻（ISO 8601，ClockPort）。 */
  readonly parkedAt: string;
  /** PARK 标记摘要（子进程上报的 progress/next；缺席 = 未携带）。 */
  readonly summary?: { readonly progress: string; readonly next: string };
}

/** agent.resumed：挂起实例恢复（同一实例同一会话继续；预算满时排队中不发）。 */
export interface AgentResumedPayload {
  readonly agentId: string;
  /** 恢复后的新段起点（epoch ms）。 */
  readonly startedAtMs: number;
  /** 恢复时刻的累计执行基线（park 结算不含挂起期；毫秒）。 */
  readonly elapsedMs: number;
}

// ── 通道族载荷（契约 §5.2/§6.1）────────────────────
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
  /** 入账轮次 id（additive，轮末 token 用量显示面）：主线 turn 入账携带；compaction/SubAgent 入账不携带。 */
  readonly turnId?: string;
}

// ── v0.4 执行上下文面载荷（契约 v0.4 §2/§3；AD-5/AD-6）──
// 两事件只落盘不广播（DtoMapper 无 case → default → null；协议登记供
// trace.query 结果 payload 类型化与守护一致性）。

/**
 * profile 快照（装配结果全文，非 profileKind 引用——拼接时代回溯面，AD-5
 * 演进预留）；形状与协议 TraceProfileSnapshot 同构（compaction 声明原样携带）。
 */
export interface ProfileSnapshotData {
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  /** "provider/model-id"（与 agent.spawned payload.model 同形态）。 */
  readonly model: string;
  readonly compaction?: {
    readonly enabled: boolean;
    readonly reserveTokens: number;
    readonly keepRecentTokens: number;
  };
  readonly hooks?: readonly string[];
}

/** agent.instantiated：实例化时刻 profile 快照落盘（主=会话创建；Sub=spawn 同批）。 */
export interface AgentInstantiatedPayload {
  readonly instanceId: string;
  readonly profileKind: string;
  /**
   * SubAgent spawn 解析的 thinkingLevel 快照（thinking 批④，AD-4④/AD-6：
   * 自身 profile 槽位（无兜底——未配置 = 默认关）；字符串透传 AD-2）。
   * Sub 实例携带（协议契约面；未配置 → 缺席）；主实例不携带（AD-4④ 语义
   * 范围 = SubAgent spawn 快照，主实例无此契约要求——架构师终审 F-3 裁决
   * 维持可选不收窄）。
   */
  readonly thinkingLevel?: string;
  readonly profileSnapshot: ProfileSnapshotData;
}

/** agent.model.changed：运行期换模的模型时间线落盘（from/to 与 model.changed 广播帧同源）。 */
export interface AgentModelChangedPayload {
  readonly instanceId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * agent.thinking.changed：thinking.set 会话覆盖落盘（thinking 批①③，AD-4①③；
 * 只落盘不广播——广播走 thinking.changed 链，EnvelopeMapper default → null）。
 * 跨冷恢复数据源（RestoreService 回放末值重建覆盖，区别于 model.set 不恢复现状）。
 * level 字符串透传（AD-2：helix 不做档位校验，SoT 在 pi-ai）。
 */
export interface AgentThinkingChangedPayload {
  readonly instanceId: string;
  /** 会话覆盖档（pi-ai ThinkingLevel 字符串透传；无关闭态——无覆盖即无事件）。 */
  readonly level: string;
}

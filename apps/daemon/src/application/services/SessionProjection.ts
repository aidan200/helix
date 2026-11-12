import type { SessionRepositoryPort, PersistedDomainState } from "../ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../ports/outbound/EventPublisherPort";
import type { Session } from "../../domain/session/Session";
import type { AgentLifecycleState } from "../../domain/agent/AgentLifecycle";
import { ToolCallRecord, deriveToolCallKind, type ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import { isMainInstanceId } from "../../domain/agent/AgentInstance";
// 投影收敛：账目纯语义（applyUsage 族）单源 @helix/protocol
// projection（AG-02② application 白名单内）。
import {
  aggregateSession,
  applyCompaction,
  applyUsage,
  emptyUsageLedger,
  instanceUsageOf,
  type UsageLedgerData,
} from "@helix/protocol";
import type {
  CompactionCompletedPayload,
  MessageCompletedPayload,
  ThinkingCompletedPayload,
  ToolCallPayload,
  ToolResultPayload,
  UsageRecordedPayload,
  DomainEvent,
} from "../../domain/events/DomainEvent";
import type { SessionUsageSummary, UsageSummary } from "../../domain/session/SessionSnapshot";

/**
 * SessionProjection —— 会话投影消费者（AD-3 §3.2②；architecture.md §3.4）。
 *
 * 事件总线的 fan-out 目标之一（显式消费者，组合根装配）：消费领域事件 →
 * ① SubAgent 条目落 Session 聚合（Entry.instanceId 归属 agent-N——「SubAgent
 *    Entry 进聚合」；主线条目由 ChatService 编排内落聚合，本投影不重复）；
 * ② 会话账本入账（usage.recorded——原组合根内联投影闭包并入，AD-4 事件即账）；
 * ③ 触发 write-through（领域状态整体经 SessionRepositoryPort 单写通道落盘
 *    ——原 ChatService.publish 内的落盘点迁移至此，「ChatService 只产事件」）。
 *
 * 职责边界（AD-3 决策消解）：
 * - 流式 delta 不是领域事件、不落盘（publishDelta 空实现，AD-16 §5.3）；
 * - 只投影本会话事件（sessionId 归属判定——SessionRegistry 多会话分仓
 *   的前置语义；异会话事件忽略）；
 * - 幂等：同事件重放不重复落树（entryId / `instanceId:toolCallId` 复合键去重
 *   ——恢复重放与运行期重复投递双防护）；
 * - 投影经既有 SessionRepositoryPort 面（TR-AD-2 port 归属），不新增越层直引。
 */
export interface SessionProjectionDeps {
  /** 持久化（write-through 经 WriteQueue 单写通道）。 */
  readonly repository: SessionRepositoryPort;
  /** 会话聚合访问器（组合根注入 ChatService 持有的同一实例——共享聚合，只追加不重建）。 */
  readonly getSession: () => Session;
  /**
   * 主线侧持久化基线（ChatService 观测面）：agentState + 主线工具记录。
   * SubAgent 运行期工具记录由本投影持有（subToolCalls），两者在 persistedState
   * 合并——与重启后（全部经恢复载荷回 ChatService.toolCalls）的读面一致。
   */
  readonly getMainState: () => {
    readonly agentState: AgentLifecycleState;
    readonly toolCalls: readonly ToolCallRecordData[];
  };
  /** 账本基线（重启恢复：RestoreService 重放产物；首启 = 空账本）。 */
  readonly initialUsage?: UsageLedgerData;
}

export class SessionProjection implements EventPublisherPort {
  private usageLedger: UsageLedgerData;
  /** SubAgent 工具调用记录（`${instanceId}:${toolCallId}` 复合键 → 聚合；F3 修复：
   * 并发实例各自子进程 toolCallId 可重号，裸 id 键会误判幂等丢弃/结果错回填）。 */
  private readonly subToolCalls = new Map<string, ToolCallRecord>();
  /** 已落树条目 id（幂等判据：重放零追加；构造时以恢复态种子）。 */
  private readonly projectedEntryIds: Set<string>;

  constructor(private readonly deps: SessionProjectionDeps) {
    this.usageLedger = deps.initialUsage ?? emptyUsageLedger();
    this.projectedEntryIds = new Set(deps.getSession().entryList().map((e) => e.id));
  }

  // ── 观测面（组合根快照装配：账本聚合/实例小计/SubAgent 工具记录） ──

  /** 会话账目聚合（快照 usage 数据源）。 */
  usageSummary(): SessionUsageSummary {
    return aggregateSession(this.usageLedger);
  }

  /** 每实例账目小计（快照 instances[].usage 数据源）。 */
  instanceUsage(instanceId: string): UsageSummary {
    return instanceUsageOf(this.usageLedger, instanceId);
  }

  /** SubAgent 工具记录只读观测面（快照 toolCalls 合并源；主线记录在 ChatService）。 */
  subAgentToolCallData(): readonly ToolCallRecordData[] {
    return [...this.subToolCalls.values()].map((r) => r.toData());
  }

  // ── EventPublisherPort（fan-out 目标：消费事件 → 投影 + write-through） ──

  publish(event: DomainEvent): void {
    if (event.sessionId !== this.deps.getSession().id) return; // 会话归属（分仓前置语义）
    // （契约 v0.4 §2/§3）：agent.instantiated / agent.model.changed 只落盘
    //（domain_events 事件行经 fan-out WriteQueue 目标直写）——零投影且**不触发**
    // write-through 状态写（否则草稿会话被提前落库，破坏「首条消息才落库」语义）。
    // agent.thinking.changed（thinking 批①③）同构：只落盘不回投影不触发状态写。
    if (event.type === "agent.instantiated" || event.type === "agent.model.changed" || event.type === "agent.thinking.changed") return;
    this.project(event);
    // P1 写放大增量化（2026-11-11 087cc66e 事故）：高频事件不再触发全量
    // 状态重写（session_state 行 + steer 清空重插 + tool_calls 清空重插——
    // 风暴 4 分钟 7026 事件 × 全量 = 数百 GB 写放大，disk I/O error 直接
    // 推手），改走单行增量通道；持久化真相分派：工具行 = 事件载荷直落
    // tool_calls 表，账本 = 事件行重放（restoreUsageLedger），lifecycle =
    // 单行 upsert。未知事件类型保守回退全量（新增类型不误跳过）。
    if (this.writeIncremental(event)) return;
    // write-through（AD-3 §3.2②）：每个里程碑领域事件后落领域状态整体
    //（事件行经持久化目标先入同一 FIFO，先事件后状态，全局保序）。
    // 单次落盘失败不阻断（WriteQueue onError 上报）。
    void this.deps.repository.save(this.persistedState());
  }

  /**
   * 增量落盘分派（P1 写放大增量化）：返回 true = 已走增量通道（或无需
   * 落盘），跳过全量 saveState；false = 回退保守全量。四类高频事件的持久
   * 化真相均已单独闭合（同 FIFO 保序，崩溃一致性不降级）：
   * - tool.call.started/result：事件载荷直落 tool_calls 单行（恢复读面
   *   rowsToPersistedState 读表不变）；SubAgent 内存记录（subToolCalls）
   *   仍由 project() 维护作快照观测面；
   * - usage.recorded：账本内存入账（project()），持久化 = domain_events
   *   事件行（恢复链 restoreUsageLedger 重放——原本就不依赖 state 行）；
   * - agent.state.changed：agent_lifecycle 单行 upsert（恢复读 lifecycle
   *   行，不依赖 state 行）。turn.toolRunning 中间态变更（markTurnToolRunning）
   *   至下次全量事件捎带落盘——崩溃窗口丢失可接受（悬挂轮恢复收口兜底）。
   */
  private writeIncremental(event: DomainEvent): boolean {
    const sessionId = this.deps.getSession().id;
    switch (event.type) {
      case "tool.call.started": {
        const p = event.payload as ToolCallPayload;
        void this.deps.repository.recordToolCall(sessionId, {
          id: p.toolCallId,
          instanceId: event.instanceId ?? this.deps.getSession().mainInstanceId,
          kind: deriveToolCallKind(event.instanceId, this.deps.getSession().mainInstanceId),
          toolName: p.toolName,
          args: p.args,
          status: "running",
          startedAt: event.occurredAt,
        });
        return true;
      }
      case "tool.call.result": {
        const p = event.payload as ToolResultPayload;
        void this.deps.repository.recordToolCall(sessionId, {
          id: p.toolCallId,
          instanceId: event.instanceId ?? this.deps.getSession().mainInstanceId,
          kind: deriveToolCallKind(event.instanceId, this.deps.getSession().mainInstanceId),
          toolName: p.toolName,
          args: p.args,
          status: p.isError ? "failed" : "completed",
          result: p.isError ? undefined : p.result,
          error: p.isError ? p.result : undefined,
          ...(p.images !== undefined && p.images.length > 0 ? { images: [...p.images] } : {}),
          startedAt: event.occurredAt,
          endedAt: event.occurredAt,
        });
        return true;
      }
      case "usage.recorded":
        return true; // 账本入账在 project()；持久化真相 = 事件行（恢复重放）
      case "agent.state.changed": {
        const p = event.payload as { state: string };
        void this.deps.repository.saveAgentLifecycle(
          sessionId,
          event.instanceId ?? this.deps.getSession().mainInstanceId,
          p.state as never, // 词表混存现状：main 行存 AgentLifecycleState（state job 同款直写无校验）
        );
        return true;
      }
      default:
        return false; // 保守默认：未知/其余类型回退全量
    }
  }

  /** 流式中间态不是领域事件、不落盘、不改聚合（AD-16 §5.3）。 */
  publishDelta(): void {
    /* 故意空实现 */
  }

  // ── 内部：事件投影 ────────────────────────────────────────

  private project(event: DomainEvent): void {
    switch (event.type) {
      case "usage.recorded": {
        // 账本入账（AD-4 事件即账；原组合根内联投影闭包并入）
        const p = event.payload as UsageRecordedPayload;
        if (p.usage === undefined || p.source === undefined) return; // 损坏载荷防御
        this.usageLedger = applyUsage(
          this.usageLedger,
          p.instanceId,
          p.usage,
          p.source,
          // byTurn 挂载只认载荷 turnId（发布点单源显式填写——domain_events
          // 不落信封 turnId，恢复链重放同规则只能靠载荷）；compaction/
          // SubAgent 发布点不填即不进 byTurn
          p.turnId,
        );
        return;
      }
      case "compaction.completed": {
        // 水位重置（TR-59 观察面）：窗口被摘要替换为 tokensAfter。条目落树
        // 由 ChatService 直接完成（main-only），此处只动账本——不动账目面
        // （compaction 入账走独立的 usage.recorded(source=compaction) 事件）。
        const p = event.payload as CompactionCompletedPayload;
        if (p.entry?.tokensAfter === undefined || !Number.isFinite(p.entry.tokensAfter)) return; // 损坏载荷防御
        this.usageLedger = applyCompaction(this.usageLedger, event.instanceId ?? "main", p.entry.tokensAfter);
        return;
      }
      case "message.completed": {
        // SubAgent 消息落树（主线条目 ChatService 已落，不重复）
        if (!this.isSubAgent(event)) return;
        const p = event.payload as MessageCompletedPayload;
        if (
          p.entryId === undefined ||
          p.role !== "assistant" ||
          p.text.trim() === "" ||
          this.projectedEntryIds.has(p.entryId)
        ) {
          return;
        }
        this.deps
          .getSession()
          .appendInstanceMessage({ id: p.entryId, instanceId: event.instanceId!, text: p.text, createdAt: event.occurredAt });
        this.projectedEntryIds.add(p.entryId);
        return;
      }
      case "thinking.completed": {
        if (!this.isSubAgent(event)) return;
        const p = event.payload as ThinkingCompletedPayload;
        if (
          p.entry === undefined ||
          p.entry.text.trim() === "" ||
          this.projectedEntryIds.has(p.entry.id)
        ) {
          return;
        }
        this.deps.getSession().appendThinkingEntry(p.entry); // 显式 id（与事件载荷同源）
        this.projectedEntryIds.add(p.entry.id);
        return;
      }
      case "tool.call.started": {
        if (!this.isSubAgent(event)) return;
        const p = event.payload as ToolCallPayload;
        const key = `${event.instanceId}:${p.toolCallId}`; // 实例维复合键（并发实例 toolCallId 可重号）
        if (this.subToolCalls.has(key)) return; // 幂等
        const record = ToolCallRecord.create(p.toolCallId, p.toolName, p.args, event.instanceId!, "subagent");
        record.markRunning(event.occurredAt);
        this.subToolCalls.set(key, record);
        return;
      }
      case "tool.call.result": {
        if (!this.isSubAgent(event)) return;
        const p = event.payload as ToolResultPayload;
        const record = this.subToolCalls.get(`${event.instanceId}:${p.toolCallId}`); // 同复合键取本实例记录
        if (record === undefined || record.status !== "running") return; // 幂等/迟到收口
        if (p.isError) record.fail(p.result, event.occurredAt);
        else record.complete(p.result, event.occurredAt, p.images); // images 对齐主线（ChatService 同点三参）：SubAgent 工具截图随记录落盘
        return;
      }
      default:
        // 其余事件：无增量投影动作（turn/steer/agent.* 状态经快照整体落盘）
        return;
    }
  }

  /** SubAgent 实例事件判定（kind 判别单点：该会话主实例 id / legacy "main" /
   * 缺省均判 main——主实例事件不投影，主线由 ChatService 编排落账）。 */
  private isSubAgent(event: DomainEvent): boolean {
    return !isMainInstanceId(event.instanceId, this.deps.getSession().mainInstanceId);
  }

  /** 领域状态整体（write-through 载荷：聚合 + 主线基线 + SubAgent 工具记录合并）。 */
  private persistedState(): PersistedDomainState {
    const main = this.deps.getMainState();
    return {
      session: this.deps.getSession().toSnapshot(),
      agentState: main.agentState,
      toolCalls: [...main.toolCalls, ...this.subAgentToolCallData()],
    };
  }
}

import type { SessionRepositoryPort, PersistedDomainState } from "../ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../ports/outbound/EventPublisherPort";
import type { Session } from "../../domain/session/Session";
import type { AgentLifecycleState } from "../../domain/agent/AgentLifecycle";
import { ToolCallRecord, type ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import { isMainInstanceId } from "../../domain/agent/AgentInstance";
// 投影收敛：账目纯语义（applyUsage 族）单源 @helix/protocol
// projection（AG-02② application 白名单内）。
import {
  aggregateSession,
  applyUsage,
  emptyUsageLedger,
  instanceUsageOf,
  type UsageLedgerData,
} from "@helix/protocol";
import type {
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
 * - 幂等：同事件重放不重复落树（entryId/toolCallId 去重——恢复重放与运行期
 *   重复投递双防护）；
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
  /** SubAgent 工具调用记录（id → 聚合；投影消费 tool.call.* 事件维护）。 */
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
    // write-through（AD-3 §3.2②）：每个里程碑领域事件后落领域状态整体
    //（事件行经持久化目标先入同一 FIFO，先事件后状态，全局保序）。
    // 单次落盘失败不阻断（WriteQueue onError 上报）。
    void this.deps.repository.save(this.persistedState());
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
        this.usageLedger = applyUsage(this.usageLedger, p.instanceId, p.usage, p.source);
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
        if (this.subToolCalls.has(p.toolCallId)) return; // 幂等
        const record = ToolCallRecord.create(p.toolCallId, p.toolName, p.args, event.instanceId!);
        record.markRunning(event.occurredAt);
        this.subToolCalls.set(p.toolCallId, record);
        return;
      }
      case "tool.call.result": {
        if (!this.isSubAgent(event)) return;
        const p = event.payload as ToolResultPayload;
        const record = this.subToolCalls.get(p.toolCallId);
        if (record === undefined || record.status !== "running") return; // 幂等/迟到收口
        if (p.isError) record.fail(p.result, event.occurredAt);
        else record.complete(p.result, event.occurredAt);
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

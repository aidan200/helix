import type { SessionRepositoryPort, ClosureRecordData } from "../ports/outbound/SessionRepositoryPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import type { AgentLifecycleState } from "../../domain/agent/AgentLifecycle";
import type { ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import type {
  InstanceClosurePayload,
  DomainEvent,
  AgentSpawnedPayload,
  MessageCompletedPayload,
  ThinkingCompletedPayload,
  ToolCallPayload,
  ToolResultPayload,
  UsageRecordedPayload,
} from "../../domain/events/DomainEvent";
import { Session } from "../../domain/session/Session";
import { AgentInstance, agentSeqOf, type InstanceState } from "../../domain/agent/AgentInstance";
// MAIN_INSTANCE_ID 改引协议导出（v0.2 OI 收口，F-2⑬；domain 定义保留 AG-02 例外）
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import { applyUsage, emptyUsageLedger, type UsageLedgerData } from "../../domain/session/UsageLedger";

/**
 * RestoreService —— 重启恢复（architecture.md §3.4 / §5.4 / §8.2，F(8).2）。
 *
 * 【业务语义】daemon 重启后读盘（SessionRepositoryPort）重建领域聚合
 * （Session.restoreFrom），交组合根注入 ChatService；快照经 SessionPort
 * （SessionService.getSnapshot）可推前端——「重启 daemon 后重连同样成立」
 * 是迭代验收口径的最后一环（WS 通路 T1.6 并行接线，接口对齐即可）。
 *
 * 【悬挂收口】重启时不可能有引擎 run 在飞：快照中残留的 open turn
 * （generating/toolRunning）一律收口为 interrupted——崩溃丢当前流、
 * 恢复到最后一致里程碑（AD-16 §5.3：半截流式本就未落盘，已完成条目保留）。
 *
 * 【恢复语义边界】agent 生命周期不回注（进程重启自然从 idle 起，库内
 * 最后状态仅作观测/trace）；未消费 steer 随快照 pendingSteer 保留在
 * 队列中（不自动重放到引擎——v0 无回放触发点，数据面已完整）。
 *
 * 【实例注册表/closure 恢复（T2.4，AD-10 恢复语义树）】
 * - 数据源三合一：agent_lifecycle 每实例行（状态权威投影）+ closure_records
 *   记录行（终态实例 closure 本体）+ domain_events agent.spawned 载荷
 *   （task/profileKind/createdAt 事件流重建——快照 instances 字段 T3.2 前不
 *   落盘，事件流是双源核对的另一源）。
 * - running → failed 收口（D-1 同构）：closure{failed,"daemon 重启，任务未完成"}
 *   落 closure_records + agent_lifecycle 行更新 failed；closure 注入主线
 *   SteerQueue（source=closure，下轮 turn 消费）——**不自动续跑**：注入只
 *   入队不驱动引擎（零新事件流），恢复代码零 spawn。
 * - queued → cancelled（区别于 failed）：队列不落盘（T2.1）重启即清，
 *   agent_lifecycle 行收口 cancelled；**不产生 closure 记录**（未开跑）；
 *   不自动重派。
 * - done/failed/cancelled 终态：原样恢复（closure 从 closure_records 最新行
 *   读回）——重启幂等（上次收口行不再重复收口/注入）。
 *
 * 【账目恢复（T3.2，AD-4 事件即账）】session_state 快照不落账目（写面
 * 结构不动，无新列）——权威源 = domain_events 的 usage.recorded 行，
 * 重放 applyUsage 重建账本（合计 + per-instance 明细）；运行期快照聚合
 * 字段与事件流的一致性由 integration 双源核对（重启前后快照相等）保证。
 */
export interface RestoreServiceDeps {
  readonly repository: SessionRepositoryPort;
  readonly clock: ClockPort;
}

/** running 收口固定文案（brief 决策消解：与工具记录收口 D-1 同构）。 */
export const RESTART_CLOSURE_SUMMARY = "daemon 重启，任务未完成";

/** 恢复产物中的实例条目（收口后终态 + closure + task；调度器注册表重建载荷）。 */
export interface RestoredInstance {
  readonly instanceId: string;
  readonly kind: "subagent";
  readonly profileKind: string;
  readonly sessionId: string;
  /** 收口后状态（running→failed / queued→cancelled；终态原样）。 */
  readonly state: InstanceState;
  readonly createdAt: string;
  readonly task?: string;
  /** 终态实例（done/failed）closure；cancelled 不携带。 */
  readonly closure?: InstanceClosurePayload;
}

export interface RestoredDomainState {
  /** 重建后的会话聚合（open turn 已收口，可直接续对话）。 */
  readonly session: Session;
  /** 停机前最后持久化的生命周期状态（观测/trace 用，不回注进程）。 */
  readonly agentState: AgentLifecycleState;
  /** 历史工具调用记录（注入 ChatService 延续工具历史）。 */
  readonly toolCalls: readonly ToolCallRecordData[];
  /** SubAgent 实例清单（收口后终态；调度器注册表 + 快照 instances 重建源）。 */
  readonly instances: readonly RestoredInstance[];
  /** 已用最大 agent-N 序号（重启后 spawn 续基线不撞号，K5）。 */
  readonly maxAgentSeq: number;
  /** 会话账本（T3.2：usage.recorded 事件流重放重建；组合根快照聚合/实例小计源）。 */
  readonly usage: UsageLedgerData;
}

/** agent_lifecycle 行中 SubAgent 实例的可恢复状态集（main 行不在此列）。 */
const SUBAGENT_STATES: readonly string[] = ["queued", "running", "done", "failed", "cancelled"];

export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  /**
   * 恢复最近一次持久化的会话；无持久化（首启）返回 undefined，
   * 调用方（组合根）据此新建会话。
   */
  async restoreLatest(): Promise<RestoredDomainState | undefined> {
    const ids = await this.deps.repository.listSessionIds();
    const latest = ids.at(-1);
    if (!latest) return undefined;
    const state = await this.deps.repository.restore(latest);
    if (!state) return undefined;
    const session = Session.restoreFrom(state.session);
    if (session.openTurn) {
      session.interruptTurn(this.deps.clock.now()); // 悬挂收口：重启无 run 在飞
    }
    const instances = await this.restoreInstances(latest, session);
    // T2.1（AD-3）：SubAgent 历史重放——事件流 agent_kind=subagent 全量补齐
    //（投影落库前的旧库升级路径 + 事件行先于状态行的崩溃窗口自愈；
    // 快照已有的条目按 id 去重，零事件流零落盘——恢复不重放铁律保持）
    const toolCalls = this.replaySubAgentHistory(latest, session, state.toolCalls);
    return {
      session,
      agentState: state.agentState,
      toolCalls,
      instances: instances.list,
      maxAgentSeq: instances.maxSeq,
      usage: this.restoreUsageLedger(latest),
    };
  }

  // ── 账目重建（T3.2，AD-4 事件即账） ─────────────────────

  /**
   * usage.recorded 事件流重放 → 账本（合计 + per-instance 明细 + compaction
   * 小计）。事件即账：重放即重建，与停机前快照聚合双源一致（integration
   * 核对）；旧库无账目行 → 空账本（零值形状）。
   */
  private restoreUsageLedger(sessionId: string): UsageLedgerData {
    const events = this.deps.repository.queryEvents({ sessionId, type: "usage.recorded" });
    let ledger = emptyUsageLedger();
    for (const event of events) {
      const payload = event.payload as Partial<UsageRecordedPayload> | undefined;
      if (payload?.usage === undefined || payload.source === undefined) continue; // 损坏行防御：跳过不崩
      ledger = applyUsage(ledger, payload.instanceId ?? event.instanceId ?? MAIN_INSTANCE_ID, payload.usage, payload.source);
    }
    return ledger;
  }

  // ── SubAgent 历史重放（T2.1，AD-3） ─────────────────────

  /**
   * 事件流 agent_kind=subagent 全量重放 → 聚合条目/工具记录补齐：
   * - thinking.completed / message.completed（role=assistant）→ Session 聚合
   *   SubAgent Entry（幂等：快照已有条目按 id 去重）；
   * - tool.call.started/result → 工具记录（未收口→ running，交 ChatService
   *   恢复收口链收口 failed——与主线工具记录同构）；
   * - 其余事件（agent.族 / usage.recorded）不重放（实例注册表经 agent_lifecycle
   *   三源恢复、账本经 restoreUsageLedger 重放，各自单点）。
   *
   * 双源关系：session_state 快照是第一源（正常路径已含全部条目）；事件流
   * 重放是补齐源（旧库升级：投影落库前的历史只有事件行；崩溃窗口：事件
   * 行先于状态行落盘）。恢复不重放铁律保持：零新事件流、零落盘。
   */
  private replaySubAgentHistory(
    sessionId: string,
    session: Session,
    persistedToolCalls: readonly ToolCallRecordData[],
  ): readonly ToolCallRecordData[] {
    const subEvents = this.deps.repository.queryEvents({ sessionId, agentKind: "subagent" });
    if (subEvents.length === 0) return persistedToolCalls;

    const knownEntryIds = new Set(session.entryList().map((e) => e.id));
    const knownToolIds = new Set(persistedToolCalls.map((t) => t.id));
    /** 重放态工具记录（未配对 result = running，交恢复收口链收口 failed）。 */
    const replayedTools = new Map<string, ToolCallRecordData>();

    for (const event of subEvents) {
      const instanceId = event.instanceId ?? MAIN_INSTANCE_ID;
      if (instanceId === MAIN_INSTANCE_ID) continue; // 防御：agent_kind 误标行
      switch (event.type) {
        case "thinking.completed": {
          const p = event.payload as Partial<ThinkingCompletedPayload>;
          if (p?.entry?.id === undefined || knownEntryIds.has(p.entry.id)) break;
          if (p.entry.text?.trim() === "") break; // 空块防御
          // 显式 id：与事件载荷同源（Partial 载荷已逐字段校验，收窄交领域构造器）
          session.appendThinkingEntry({ ...p.entry, id: p.entry.id } as Parameters<
            typeof session.appendThinkingEntry
          >[0]);
          knownEntryIds.add(p.entry.id);
          break;
        }
        case "message.completed": {
          const p = event.payload as Partial<MessageCompletedPayload>;
          if (p?.entryId === undefined || p.role !== "assistant" || p.text?.trim() === "") break;
          if (knownEntryIds.has(p.entryId)) break;
          session.appendInstanceMessage({
            id: p.entryId,
            instanceId,
            text: p.text as string, // 上方非空校验收窄
            createdAt: event.occurredAt,
          });
          knownEntryIds.add(p.entryId);
          break;
        }
        case "tool.call.started": {
          const p = event.payload as Partial<ToolCallPayload>;
          if (p?.toolCallId === undefined || knownToolIds.has(p.toolCallId)) break;
          replayedTools.set(p.toolCallId, {
            id: p.toolCallId,
            toolName: p.toolName ?? "(unknown)",
            args: p.args,
            ...(instanceId !== MAIN_INSTANCE_ID ? { instanceId } : {}),
            status: "running",
            startedAt: event.occurredAt,
          });
          break;
        }
        case "tool.call.result": {
          const p = event.payload as Partial<ToolResultPayload>;
          if (p?.toolCallId === undefined || knownToolIds.has(p.toolCallId)) break;
          const started = replayedTools.get(p.toolCallId);
          replayedTools.set(p.toolCallId, {
            id: p.toolCallId,
            toolName: started?.toolName ?? p.toolName ?? "(unknown)",
            args: started?.args ?? p.args,
            ...(instanceId !== MAIN_INSTANCE_ID ? { instanceId } : {}),
            status: p.isError ? "failed" : "completed",
            ...(p.result !== undefined ? { result: p.result } : {}),
            ...(p.isError ? { error: p.result } : {}),
            startedAt: started?.startedAt,
            endedAt: event.occurredAt,
          });
          break;
        }
        default:
          break; // agent.族 / usage.recorded 等不走本重放面（各自单点）
      }
    }
    if (replayedTools.size === 0) return persistedToolCalls;
    return [...persistedToolCalls, ...replayedTools.values()];
  }

  // ── 实例注册表/closure 恢复（AD-10） ───────────────────────

  private async restoreInstances(
    sessionId: string,
    session: Session,
  ): Promise<{ list: RestoredInstance[]; maxSeq: number }> {
    const rows = (await this.deps.repository.queryAgentLifecycles(sessionId)).filter(
      (r) => r.instanceId !== MAIN_INSTANCE_ID && SUBAGENT_STATES.includes(r.state),
    );
    if (rows.length === 0) return { list: [], maxSeq: 0 };

    // 双源核对的事件流侧：agent.spawned 载荷（task/profileKind/createdAt 重建）
    const spawned = this.indexSpawned(sessionId);
    // closure_records 每实例最新行（终态实例 closure 本体；ORDER BY id 后行覆盖）
    const closures = new Map<string, ClosureRecordData>();
    for (const record of this.deps.repository.queryClosureRecords(sessionId)) {
      closures.set(record.agentId, record);
    }

    const list: RestoredInstance[] = [];
    let maxSeq = 0;
    for (const row of rows) {
      const seq = agentSeqOf(row.instanceId);
      if (seq > maxSeq) maxSeq = seq;
      const spawn = spawned.get(row.instanceId);
      const base = {
        instanceId: row.instanceId,
        kind: "subagent" as const,
        profileKind: spawn?.profileKind ?? "subagent-worker",
        sessionId,
        createdAt: spawn?.createdAt ?? row.updatedAt,
        ...(spawn?.task !== undefined ? { task: spawn.task } : {}),
      };
      if (row.state === "running") {
        // running → failed 收口（D-1 同构）：状态机迁移经 domain 权威校验
        // （非法行抛 DomainError 即暴露投影行损坏——恢复快速失败不带病启动）
        AgentInstance.restore({ ...base, state: "running" }).fail();
        const closure: InstanceClosurePayload = {
          status: "failed",
          summary: RESTART_CLOSURE_SUMMARY,
          reportPath: null,
          findings: null,
          taskId: null,
        };
        await this.deps.repository.saveAgentLifecycle(sessionId, row.instanceId, "failed");
        await this.deps.repository.saveClosureRecord(sessionId, row.instanceId, "failed", closure);
        // closure 注入主线（SteerQueue，下轮 turn 消费；不驱动引擎——零新事件流）
        session.restoreSteer(
          `${row.instanceId} closure: failed — ${RESTART_CLOSURE_SUMMARY}`,
          this.deps.clock.now(),
          "closure",
        );
        list.push({ ...base, state: "failed", closure });
      } else if (row.state === "queued") {
        // queued → cancelled：区别于 failed，无 closure 记录（未开跑），不重派
        AgentInstance.restore({ ...base, state: "queued" }).cancel();
        await this.deps.repository.saveAgentLifecycle(sessionId, row.instanceId, "cancelled");
        list.push({ ...base, state: "cancelled" });
      } else {
        // 终态原样恢复（重启幂等：上次收口行不重复收口/注入）
        const record = closures.get(row.instanceId);
        list.push({
          ...base,
          state: row.state as InstanceState,
          ...(record !== undefined
            ? {
                closure: {
                  status: record.status,
                  summary: record.summary,
                  reportPath: record.reportPath,
                  findings: record.findings,
                  taskId: record.taskId,
                } satisfies InstanceClosurePayload,
              }
            : {}),
        });
      }
    }
    return { list, maxSeq };
  }

  /** agent.spawned 事件流索引（instanceId → task/profileKind/createdAt）。 */
  private indexSpawned(sessionId: string): Map<string, { task?: string; profileKind?: string; createdAt: string }> {
    const map = new Map<string, { task?: string; profileKind?: string; createdAt: string }>();
    const events = this.deps.repository.queryEvents({ sessionId, type: "agent.spawned" }) as readonly DomainEvent[];
    for (const event of events) {
      const payload = event.payload as Partial<AgentSpawnedPayload> | undefined;
      if (payload?.agentId !== undefined) {
        map.set(payload.agentId, {
          ...(payload.task !== undefined ? { task: payload.task } : {}),
          ...(payload.profileKind !== undefined ? { profileKind: payload.profileKind } : {}),
          createdAt: event.occurredAt,
        });
      }
    }
    return map;
  }
}

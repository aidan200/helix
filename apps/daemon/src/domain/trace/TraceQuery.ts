import type { ProfileSnapshotData } from "../events/DomainEvent";

/**
 * TraceQuery —— trace 查询面纯语义（iter-20260819-erio T2.1，CL-5/F5.5~F5.7；
 * architecture.md §3.5b 伪代码级设计，用户审阅定稿；契约 v0.4 §1/§4）。
 *
 * domain 纯数据 + 纯函数（framework-free，零 import 外层，对照
 * SchedulingPolicy 惯例）。T3.1（M4 投资批）：normalizeTraceQuery /
 * hasMoreBefore / TRACE_PAGE_* 常量已迁 @helix/protocol projection/trace.ts
 * 单源（fake 镜像段同批退役；本文件保留 normalize 产物类型面
 * NormalizedTraceQuery——TraceQueryPort 签名在用，AG-02 禁 domain import
 * protocol，与协议侧形状同构对应是 TR-AD-3 既有模式）；本文件现存：
 * - assembleExecutionContext：单实例事件流 → 执行上下文视图（instantiated
 *   首条为基准快照；model.changed 按 ts 序 fold from→to，当前生效值 =
 *   末条 to；compaction.completed 里程碑序列；无 instantiated →
 *   snapshotMissing=true 降级不 throw）；
 * - assembleInstancePanel：会话级实例聚合行 + agent.* 生命周期事件 →
 *   实例面板记录（与原型 SESSIONS[].instances 同构）。
 *
 * 不建 Trace 聚合/独立表：domain_events 事件存储是唯一真实源——本模块
 * 的一切产物都是事件的纯投影（ExecutionContextView/InstanceRecord 均非
 * 新实体，持久化它们即第二事实源，§3.5b 禁令）。
 */

// ── 查询过滤归一产物类型面（normalize 实现已迁 protocol 单源） ────

/** 归一后的查询（= 结果帧 filterEcho 形态；缺省维归一 null；与
 *  @helix/protocol projection/trace.ts NormalizedTraceQuery 形状同构对应）。 */
export interface NormalizedTraceQuery {
  readonly sessionId: string;
  /** null = 全部实例（缺省）；空数组 = 空结果（显式语义）。 */
  readonly instanceIds: readonly string[] | null;
  readonly agentKind: "main" | "subagent" | null;
  /** null = 全部类型（缺省）；空数组 = 空结果。 */
  readonly types: readonly string[] | null;
  /** ISO 8601 含起含止（ts >= from && ts <= to）。 */
  readonly timeRange: { readonly from: string | null; readonly to: string | null } | null;
  readonly page: { readonly limit: number; readonly beforeId: number | null };
}

// ── 事件行（domain_events 行的 domain 侧形状） ─────────────

/** trace 事件行（domain_events 行；与协议 TraceEventRow 同构——WS 侧直出）。 */
export interface TraceEventRowData {
  readonly id: number;
  readonly ts: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly agentKind: "main" | "subagent";
  readonly type: string;
  readonly payload: unknown;
}

// ── 执行上下文 fold（F5.2 双段：基准快照 + 变更轨迹） ──────

export interface ModelChangeEntry {
  readonly from: string;
  readonly to: string;
  readonly at: string;
}

export interface CompactionMilestone {
  readonly at: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/** 执行上下文视图（纯投影非实体；上下文卡数据源）。 */
export interface ExecutionContextView {
  /** 基准快照（instantiated 首条；无 = undefined）。 */
  readonly snapshot: ProfileSnapshotData | undefined;
  /** 无 instantiated = true（页面降级标注「快照缺失」，不 throw）。 */
  readonly snapshotMissing: boolean;
  /** model.changed 按 ts 升序 fold（from→to）。 */
  readonly modelTimeline: readonly ModelChangeEntry[];
  /** 当前生效值 = 时间线末条 to；无时间线 = snapshot.model；皆无 = undefined。 */
  readonly currentModel: string | undefined;
  /** compaction.completed 里程碑（ts 升序）。 */
  readonly compactionMilestones: readonly CompactionMilestone[];
}

/** 单实例事件流 → 执行上下文视图（任意实例种类；输入无需有序，内部按 ts 排）。 */
export function assembleExecutionContext(events: readonly TraceEventRowData[]): ExecutionContextView {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
  let snapshot: ProfileSnapshotData | undefined;
  const modelTimeline: ModelChangeEntry[] = [];
  const compactionMilestones: CompactionMilestone[] = [];
  for (const event of sorted) {
    if (event.type === "agent.instantiated" && snapshot === undefined) {
      const p = event.payload as { profileSnapshot?: ProfileSnapshotData } | undefined;
      if (p?.profileSnapshot !== undefined) snapshot = p.profileSnapshot;
    } else if (event.type === "agent.model.changed") {
      const p = event.payload as { from?: string; to?: string } | undefined;
      if (typeof p?.from === "string" && typeof p?.to === "string") {
        modelTimeline.push({ from: p.from, to: p.to, at: event.ts });
      }
    } else if (event.type === "compaction.completed") {
      const p = event.payload as { entry?: { tokensBefore?: number; tokensAfter?: number } } | undefined;
      if (typeof p?.entry?.tokensBefore === "number" && typeof p.entry.tokensAfter === "number") {
        compactionMilestones.push({ at: event.ts, tokensBefore: p.entry.tokensBefore, tokensAfter: p.entry.tokensAfter });
      }
    }
  }
  return {
    snapshot,
    snapshotMissing: snapshot === undefined,
    modelTimeline,
    currentModel: modelTimeline.at(-1)?.to ?? snapshot?.model,
    compactionMilestones,
  };
}

// ── 实例面板 fold（F5.1；会话级，不受 events 过滤维影响） ──

/** 实例聚合行（COUNT/MIN/MAX GROUP BY agent_instance_id 查询产物）。 */
export interface InstanceAggregateRow {
  readonly instanceId: string;
  readonly agentKind: "main" | "subagent";
  /** 该实例首/末事件 ts（instantiated/spawned 缺席时的起止退化源）。 */
  readonly firstTs: string;
  readonly lastTs: string;
  /** 全会话事件计数（不过滤）。 */
  readonly eventCount: number;
}

/** 实例面板记录（与协议 TraceInstanceRecord 同构——WS 侧直出）。 */
export interface TraceInstanceRecord {
  readonly instanceId: string;
  readonly agentKind: "main" | "subagent";
  readonly profileKind: string;
  readonly model?: string;
  readonly status: "running" | "completed" | "failed" | "killed";
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly task?: string;
  readonly eventCount: number;
  readonly snapshot?: ProfileSnapshotData;
  readonly snapshotMissing: boolean;
  readonly modelTimeline?: readonly ModelChangeEntry[];
  /** 当前生效模型（时间线末条 to；无时间线 = snapshot.model ?? spawn 透传值；不可得缺省）。 */
  readonly currentModel?: string;
}

/** 终态事件 → 面板状态（无终态 = running）。 */
const TERMINAL_STATUS: Readonly<Record<string, TraceInstanceRecord["status"]>> = {
  "agent.completed": "completed",
  "agent.failed": "failed",
  "agent.killed": "killed",
};

/**
 * 会话实例聚合 + agent.* 生命周期事件 → 实例面板记录清单。
 * 排序：主实例优先，其余按启动 ts 升序（原型面板序）。折叠规则：
 * instantiated 首条为基准快照；spawned 载荷为 task/profileKind/model 退化源；
 * 终态事件（completed/failed/killed）决定 status/endedAt；startedAt =
 * instantiated ?? spawned ?? 首事件 ts；model 时间线经 assembleExecutionContext。
 */
export function assembleInstancePanel(
  aggregates: readonly InstanceAggregateRow[],
  lifecycleEvents: readonly TraceEventRowData[],
): TraceInstanceRecord[] {
  const byInstance = new Map<string, TraceEventRowData[]>();
  for (const event of lifecycleEvents) {
    const list = byInstance.get(event.instanceId) ?? [];
    list.push(event);
    byInstance.set(event.instanceId, list);
  }

  const records = aggregates.map((agg) => {
    const events = (byInstance.get(agg.instanceId) ?? []).sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id,
    );
    const spawned = events.find((e) => e.type === "agent.spawned")?.payload as
      | { task?: string; profileKind?: string; model?: string }
      | undefined;
    const instantiated = events.find((e) => e.type === "agent.instantiated");
    const instantiatedPayload = instantiated?.payload as
      | { profileKind?: string; profileSnapshot?: ProfileSnapshotData }
      | undefined;
    const terminal = [...events].reverse().find((e) => TERMINAL_STATUS[e.type] !== undefined);
    const ctx = assembleExecutionContext(events);

    const snapshot = ctx.snapshot;
    const model = snapshot?.model ?? spawned?.model;
    return {
      instanceId: agg.instanceId,
      agentKind: agg.agentKind,
      profileKind:
        instantiatedPayload?.profileKind ??
        spawned?.profileKind ??
        (agg.agentKind === "main" ? "main-session" : "subagent-worker"),
      ...(model !== undefined ? { model } : {}),
      status: terminal !== undefined ? TERMINAL_STATUS[terminal.type]! : ("running" as const),
      startedAt: instantiated?.ts ?? (events.find((e) => e.type === "agent.spawned")?.ts ?? agg.firstTs),
      ...(terminal !== undefined ? { endedAt: terminal.ts } : {}),
      ...(typeof spawned?.task === "string" ? { task: spawned.task } : {}),
      eventCount: agg.eventCount,
      ...(snapshot !== undefined ? { snapshot } : {}),
      snapshotMissing: ctx.snapshotMissing,
      ...(ctx.modelTimeline.length > 0 ? { modelTimeline: ctx.modelTimeline } : {}),
      // 当前生效模型 = 时间线末条 ?? 快照 model ?? spawn 透传值（单发 Sub 无快照场景）
      ...((ctx.currentModel ?? spawned?.model) !== undefined ? { currentModel: ctx.currentModel ?? spawned?.model } : {}),
    } satisfies TraceInstanceRecord;
  });

  // 主实例优先，其余按启动序（startedAt 升序，instanceId 兜底稳定序）
  return records.sort((a, b) => {
    if (a.agentKind !== b.agentKind) return a.agentKind === "main" ? -1 : 1;
    const at = a.startedAt ?? "";
    const bt = b.startedAt ?? "";
    return at < bt ? -1 : at > bt ? 1 : a.instanceId.localeCompare(b.instanceId);
  });
}

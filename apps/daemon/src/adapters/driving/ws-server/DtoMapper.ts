/**
 * DtoMapper —— domain 充血模型 → @helix/protocol DTO 贫血转换（AD-17.5：
 * 转换在 adapter，domain/application 不感知协议）。
 *
 * 全部纯函数；domain 类型只以 `import type` 引入（零运行时耦合，AG-12）。
 * 线格式定稿：ts = epoch 毫秒（契约 §9-2）；args = JSON 序列化字符串。
 */
import type {
  AgentStateDto,
  AgentInstanceDto,
  ChatTurnCompletedEvent,
  ChatMessageCompletedEvent,
  EventEnvelope,
  EntryDto,
  InstanceChannelHistory,
  MessageEntryDto,
  SessionSnapshotDto,
  SessionUsageDto,
  ThinkingEntryDto,
  CompactionEntryDto,
  ToolCallEntryDto,
  ToolCallResultEvent,
  ToolCallStartedEvent,
  UsageDto,
  AgentSpawnedEvent,
  AgentQueuedEvent,
  AgentStartedEvent,
  AgentStalledEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentKilledEvent,
  ThinkingCompletedEvent,
  CompactionCompletedEvent,
  UsageRecordedEvent,
  EngineErrorEvent,
  EventType,
} from "@helix/protocol";
import { PROTOCOL_VERSION, EVENT_CHANNELS, MAIN_INSTANCE_ID } from "@helix/protocol";
import type { SessionMeta } from "@helix/protocol";
import type { SessionStateView, InstanceSnapshotEntry } from "../../../application/ports/inbound/SessionPort";
import type { SessionMetaView } from "../../../application/ports/inbound/SessionDirectoryPort";
import type { EntryData } from "../../../domain/session/Entry";
import type { SessionEntryData } from "../../../domain/session/SessionSnapshot";
import type { ThinkingEntryData } from "../../../domain/session/ThinkingEntry";
import type { CompactionEntryData } from "../../../domain/session/CompactionEntry";
import type { SessionUsageSummary, UsageSummary } from "../../../domain/session/SessionSnapshot";
import type { ToolCallRecordData } from "../../../domain/tools/ToolCallRecord";
import type {
  AgentStateChangedPayload,
  DomainEvent,
  MessageCompletedPayload,
  SteerPayload,
  ThinkingCompletedPayload,
  CompactionCompletedPayload,
  UsageRecordedPayload,
  ToolCallPayload,
  ToolResultPayload,
  TurnCompletedPayload,
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
  AgentQueuedPayload,
  AgentSpawnedPayload,
  AgentStartedPayload,
  AgentStalledPayload,
} from "../../../domain/events/DomainEvent";

/** 事件映射所需的投影上下文（由 EventStream 维护，见 EventStream.ts）。 */
export interface EventMapContext {
  /** 领域 turn.completed 事件不带 turnId（发布时聚合轮次已收口）→ 以最近轮次补齐。 */
  readonly fallbackTurnId?: string;
  /** tool.call.result 的耗时（协议要求；由 start/result 两次 occurredAt 差值算出）。 */
  readonly durationMs?: number;
}

// ── 尾窗/分页参数（G-1 钦死：契约 B §4；daemon 侧可注入） ───────────

/** 主时间轴尾窗大小（AD-1：默认 30 条，G-1）。 */
export const TAIL_WINDOW_SIZE = 30;
/** loadHistory 分页大小缺省（G-1）。 */
export const HISTORY_PAGE_DEFAULT = 50;
/** loadHistory 分页大小上限（防滥用）。 */
export const HISTORY_PAGE_MAX = 200;

/** 快照组装的尾窗参数（组合根/测试注入面）。 */
export interface SnapshotTailOptions {
  /** 主时间轴尾窗大小（缺省 TAIL_WINDOW_SIZE）。 */
  readonly tailSize?: number;
}

/** loadHistory 分页结果（契约 B §1.3；游标非法抛 Error 由调用方转 invalid_cursor）。 */
export interface HistoryPage {
  /** beforeEntryId 之前的更早历史（时间升序，至多 limit 条）。 */
  readonly entries: EntryDto[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

// ── 快照 ────────────────────────────────────────────────────

/**
 * SessionStateView（domain）→ SessionSnapshotDto（协议）。
 * D-1：消息条目与工具调用记录按 ts 时间序合并（重连/重启后工具卡随快照
 * 恢复，契约 §6）；revision 取合并后总条数（v0 无逐事件序号，以条目数为
 * 增量基线，单调且可复算——尾窗口径下仍取全量计数）；model/agentState
 * 来自组合根注入的 system 状态（domain 快照不含）。
 * T2.4：instances/usage additive 装配（契约 §6.2）——视图携带才下发，
 * domain↔协议同构字段直映射（closure/usage 七字段不变形）。
 * T2.1（AD-3/F-14⑤）：SubAgent 过程历史按实例分组进 instances[].channels
 * （v0.2 additive）。
 * T2.2（AD-1 尾窗口径，G-1=30）：主时间轴（主实例条目）只下发尾窗 tail
 *（entries 同源）；**per-instance channel 分组完整保留不截断**（F-14⑤ 硬
 * 约束——不按全局时间序切尾）；totalEntries/tailStartCursor 分页指示。
 */
export function toSnapshotDto(
  view: SessionStateView,
  model: string,
  agentState: AgentStateDto,
  opts: SnapshotTailOptions = {},
): SessionSnapshotDto {
  const snapshot = view.session;
  const queuedSteer = new Set(snapshot.pendingSteer.map((item) => item.entryId));
  // 升序稳定排序：时间并列保持组内原序（entries 原序 / toolCalls 迭代序）
  // T3.1：entries 为 message/thinking/compaction 混排联合，各变体同表合并
  const merged: EntryDto[] = [
    ...snapshot.entries.flatMap((entry) => sessionEntryDto(entry, queuedSteer)),
    ...view.toolCalls.map((record) => toolCallEntryDto(record)),
  ].sort((a, b) => entrySortKey(a) - entrySortKey(b));
  // 主时间轴 = 主实例条目（instanceId 缺省/ main）；尾窗只作用于主轴（AD-1）
  const mainAxis = merged.filter((entry) => (entry.instanceId ?? MAIN_INSTANCE_ID) === MAIN_INSTANCE_ID);
  const tailSize = opts.tailSize ?? TAIL_WINDOW_SIZE;
  const tail = mainAxis.length > tailSize ? mainAxis.slice(mainAxis.length - tailSize) : mainAxis;
  return {
    sessionId: snapshot.sessionId,
    model,
    agentState,
    revision: merged.length,
    entries: tail, // v0.2 尾窗口径：entries 与 tail 同源（契约 B §2.2）
    tail,
    totalEntries: mainAxis.length,
    tailStartCursor: mainAxis.length > tail.length ? (tail[0]?.id ?? null) : null,
    ...(view.instances !== undefined
      ? { instances: view.instances.map((instance) => instanceDto(instance, instanceChannels(merged, instance.instanceId))) }
      : {}),
    ...(view.usage !== undefined ? { usage: usageDto(view.usage) } : {}),
  };
}

/**
 * loadHistory 分页切取（契约 B §1.3，AD-1 向上回溯）：主时间轴在
 * beforeEntryId 之前的更早历史，升序至多 limit 条；hasMore/nextCursor 指示
 * 续拉。游标不在主轴内（SubAgent 条目/不存在）→ 抛错（调用方转
 * session.invalid_cursor）。
 */
export function historyPage(
  view: SessionStateView,
  beforeEntryId: string,
  limit: number = HISTORY_PAGE_DEFAULT,
): HistoryPage {
  const snapshot = view.session;
  const queuedSteer = new Set(snapshot.pendingSteer.map((item) => item.entryId));
  const merged: EntryDto[] = [
    ...snapshot.entries.flatMap((entry) => sessionEntryDto(entry, queuedSteer)),
    ...view.toolCalls.map((record) => toolCallEntryDto(record)),
  ].sort((a, b) => entrySortKey(a) - entrySortKey(b));
  const mainAxis = merged.filter((entry) => (entry.instanceId ?? MAIN_INSTANCE_ID) === MAIN_INSTANCE_ID);
  const cursorIndex = mainAxis.findIndex((entry) => entry.id === beforeEntryId);
  if (cursorIndex < 0) {
    throw new Error(`游标 ${beforeEntryId} 不在会话 ${snapshot.sessionId} 主时间轴内`);
  }
  const earlier = mainAxis.slice(0, cursorIndex); // 严格早于游标（升序）
  const size = Math.min(Math.max(1, Math.floor(limit)), HISTORY_PAGE_MAX);
  const page = earlier.length > size ? earlier.slice(earlier.length - size) : earlier;
  const hasMore = earlier.length > page.length;
  return {
    entries: page,
    hasMore,
    nextCursor: hasMore ? (page[0]?.id ?? null) : null,
  };
}

/**
 * 实例通道历史分组（T2.1 AD-3：SubAgent Entry 按实例归组——thinking/messages/
 * tools 三槽，契约 §6.2 InstanceChannelHistory）。主实例不分组（主时间轴
 * entries 全量即主实例历史；尾窗与 main channels 归 T2.2）。
 */
function instanceChannels(entries: readonly EntryDto[], instanceId: string): InstanceChannelHistory | undefined {
  if (instanceId === MAIN_INSTANCE_ID) return undefined;
  let channels: InstanceChannelHistory | undefined;
  for (const entry of entries) {
    if ((entry.instanceId ?? MAIN_INSTANCE_ID) !== instanceId) continue;
    channels ??= {};
    if (entry.kind === "message") channels.messages = [...(channels.messages ?? []), entry];
    else if (entry.kind === "thinking") channels.thinking = [...(channels.thinking ?? []), entry];
    else if (entry.kind === "tool-call") channels.tools = [...(channels.tools ?? []), entry];
    // compaction：会话级里程碑（仅主实例产生），不进实例通道
  }
  return channels;
}

/** InstanceSnapshotEntry（domain）→ AgentInstanceDto（协议；task/closure/usage 同构直映射）。
 *  T2.1：channels 携带时附加（SubAgent 通道历史分组，AD-3/F-14⑤）。 */
function instanceDto(entry: InstanceSnapshotEntry, channels?: InstanceChannelHistory): AgentInstanceDto {
  return {
    instanceId: entry.instanceId,
    kind: entry.kind,
    profileKind: entry.profileKind,
    state: entry.state,
    createdAt: entry.createdAt,
    ...(entry.task !== undefined ? { task: entry.task } : {}),
    ...(entry.usage !== undefined ? { usage: usageTotal(entry.usage) } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(entry.closure !== undefined
      ? {
          closure: {
            status: entry.closure.status,
            summary: entry.closure.summary,
            reportPath: entry.closure.reportPath ?? null,
            findings: entry.closure.findings ?? null,
            taskId: entry.closure.taskId ?? null,
          },
        }
      : {}),
  };
}

/** UsageSummary（domain 七字段）→ UsageDto（协议；cost 拍平同形）。 */
function usageTotal(u: UsageSummary): UsageDto {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    reasoning: u.reasoning,
    totalTokens: u.totalTokens,
    cost: u.cost,
  };
}

/** SessionMetaView（domain 侧）→ SessionMeta（协议；session.list 结果/list_changed 载荷同源）。 */
export function sessionMetaDto(meta: SessionMetaView): SessionMeta {
  return {
    sessionId: meta.sessionId,
    title: meta.title,
    lastActivityAt: meta.lastActivityAt,
    runState: meta.runState,
    loaded: meta.loaded,
  };
}

function usageDto(summary: SessionUsageSummary): SessionUsageDto {
  return { total: usageTotal(summary.total), compaction: usageTotal(summary.compaction) };
}

/** 排序统一键：message/tool 用 ts（epoch ms）；thinking/compaction 用
 *  createdAt（ISO，契约 §6.1）——两类字段同一时间轴。 */
function entrySortKey(entry: EntryDto): number {
  return "ts" in entry ? entry.ts : Date.parse(entry.createdAt);
}

/** 单条 SessionEntryData → 对应 EntryDto（T3.1：message/thinking/compaction
 *  分派；thinking/compaction 变体 createdAt 保持 ISO 字符串，契约 §6.1）。 */
function sessionEntryDto(entry: SessionEntryData, queuedSteer: Set<string>): EntryDto[] {
  if ("kind" in entry) {
    return entry.kind === "thinking" ? [thinkingEntryDto(entry)] : [compactionEntryDto(entry)];
  }
  return messageEntryDto(entry, queuedSteer);
}

/** domain ThinkingEntryData → ThinkingEntryDto（全字段同形）。 */
function thinkingEntryDto(entry: ThinkingEntryData): ThinkingEntryDto {
  return {
    kind: "thinking",
    id: entry.id,
    instanceId: entry.instanceId,
    text: entry.text,
    durationMs: entry.durationMs,
    reasoningTokens: entry.reasoningTokens,
    createdAt: entry.createdAt,
  };
}

/** domain CompactionEntryData → CompactionEntryDto（usage 七字段同形）。 */
function compactionEntryDto(entry: CompactionEntryData): CompactionEntryDto {
  return {
    kind: "compaction",
    id: entry.id,
    instanceId: entry.instanceId,
    tokensBefore: entry.tokensBefore,
    tokensAfter: entry.tokensAfter,
    summary: entry.summary,
    usage: entry.usage,
    createdAt: entry.createdAt,
  };
}

/** 单条 EntryData → MessageEntryDto（tool 角色当前领域侧不产生，防御跳过）。
 *  T2.1（AD-3）：SubAgent 条目携带 instanceId（前端 F1.6 分流依据）；主实例
 *  省略（缺省 = main，线格式保持 v0/v0.1 形状）。 */
function messageEntryDto(entry: EntryData, queuedSteer: Set<string>): MessageEntryDto[] {
  if (entry.role !== "user" && entry.role !== "assistant") return [];
  const dto: MessageEntryDto = {
    kind: "message",
    id: entry.id,
    role: entry.role,
    content: entry.text,
    ts: Date.parse(entry.createdAt),
  };
  if (entry.role === "user" && entry.isSteer) {
    dto.steerState = queuedSteer.has(entry.id) ? "queued" : "drained";
  }
  if (entry.instanceId !== MAIN_INSTANCE_ID) dto.instanceId = entry.instanceId;
  return [dto];
}

/** 单条 ToolCallRecordData → ToolCallEntryDto（D-1：快照侧工具条目）。
 *  三态映射与事件侧（tool.call.started/result）口径一致；result 恒发、
 *  isError 区分——completed→result、failed→error 文案（无 error 回退
 *  result）、running 无；durationMs 仅起止齐备时携带。 */
function toolCallEntryDto(record: ToolCallRecordData): ToolCallEntryDto {
  const dto: ToolCallEntryDto = {
    kind: "tool-call",
    id: record.id,
    name: record.toolName,
    args: safeJson(record.args),
    state: record.status === "completed" ? "done" : record.status === "failed" ? "error" : "running",
    ts: record.startedAt !== undefined
      ? Date.parse(record.startedAt)
      : record.endedAt !== undefined
        ? Date.parse(record.endedAt)
        : 0,
  };
  // T2.1（AD-3）：行级归属透传（SubAgent 工具卡归实例 channel；主实例省略）
  if (record.instanceId !== undefined && record.instanceId !== MAIN_INSTANCE_ID) {
    dto.instanceId = record.instanceId;
  }
  if (record.status === "completed") {
    if (record.result !== undefined) dto.result = record.result;
  } else if (record.status === "failed") {
    const result = record.error ?? record.result;
    if (result !== undefined) dto.result = result;
  }
  if (record.startedAt !== undefined && record.endedAt !== undefined) {
    dto.durationMs = Math.max(0, Date.parse(record.endedAt) - Date.parse(record.startedAt));
  }
  return dto;
}

// ── 领域事件 → 协议事件帧 ─────────────────────────────────────

/**
 * DomainEvent → EventEnvelope。返回 null = 协议目录无对应事件。
 * v0.1：事件携带 instanceId（agent.* 编排族 + SubAgent 工具事件）时帧同值
 * 挂 instanceId（缺省 = 主实例，契约 §1/§2）——前端按 id 分流投影。
 * v0.2（T2.1，AD-3/AD-4 统一信封）：全部帧章印 sessionId（事件归属会话）+
 * channel（EVENT_CHANNELS 单点登记）；instanceId 携带时透传。
 * 终验热修：engine.error 下发（provider 失败透传，原 v0 边界注记作废）。
 */
export function domainEventToEnvelope(event: DomainEvent, ctx?: EventMapContext): EventEnvelope | null {
  const frame = buildEnvelope(event, ctx);
  if (frame === null) return null;
  // v0.2 统一信封全量章印：sessionId 必发 + channel 按 EVENT_CHANNELS 判别
  // （payload 语义零变更——新增字段仅信封层，契约 A §1.2/§2）
  frame.sessionId = event.sessionId;
  frame.channel = EVENT_CHANNELS[frame.type as EventType];
  if (event.instanceId !== undefined) frame.instanceId = event.instanceId;
  return frame;
}

function buildEnvelope(event: DomainEvent, ctx?: EventMapContext): EventEnvelope | null {
  const ts = Date.parse(event.occurredAt);
  switch (event.type) {
    case "turn.started":
      return {
        v: PROTOCOL_VERSION,
        type: "chat.turn.started",
        payload: { turnId: (event.payload as { turnId: string }).turnId },
      };

    case "turn.completed": {
      const p = event.payload as TurnCompletedPayload;
      const frame: ChatTurnCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "chat.turn.completed",
        payload: {
          turnId: event.turnId ?? ctx?.fallbackTurnId ?? "",
          // 领域 done/steerDrained → 协议 completed（steerDrained 是正常收口）
          reason: p.reason === "aborted" ? "aborted" : "completed",
        },
      };
      return frame;
    }

    case "turn.interrupted": {
      const frame: ChatTurnCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "chat.turn.completed",
        payload: { turnId: event.turnId ?? ctx?.fallbackTurnId ?? "", reason: "aborted" },
      };
      return frame;
    }

    case "message.completed": {
      const p = event.payload as MessageCompletedPayload;
      if (p.role !== "user" && p.role !== "assistant") return null; // tool 角色无协议对应
      const entry: MessageEntryDto = {
        kind: "message",
        id: p.entryId,
        role: p.role,
        content: p.text,
        ts,
      };
      if (p.role === "user" && p.isSteer) entry.steerState = "queued"; // 事件时点刚入队
      // T2.1（AD-3）：SubAgent 消息帧携带条目 instanceId（前端实例分流）
      if (event.instanceId !== undefined && event.instanceId !== MAIN_INSTANCE_ID) {
        entry.instanceId = event.instanceId;
      }
      const frame: ChatMessageCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "chat.message.completed",
        payload: { entry },
      };
      return frame;
    }

    case "steer.queued":
    case "steer.drained": {
      const p = event.payload as SteerPayload;
      return {
        v: PROTOCOL_VERSION,
        type: event.type,
        payload: { entryId: p.entryId },
      };
    }

    case "tool.call.started": {
      const p = event.payload as ToolCallPayload;
      const entry: ToolCallEntryDto = {
        kind: "tool-call",
        id: p.toolCallId,
        name: p.toolName,
        args: safeJson(p.args),
        state: "running",
        ts,
      };
      // T2.1（AD-3）：SubAgent 工具卡归实例 channel（载荷内嵌 instanceId 与
      // v0.1 通道族并存口径一致；信封位为路由权威）
      if (event.instanceId !== undefined && event.instanceId !== MAIN_INSTANCE_ID) {
        entry.instanceId = event.instanceId;
      }
      const frame: ToolCallStartedEvent = {
        v: PROTOCOL_VERSION,
        type: "tool.call.started",
        payload: { entry },
      };
      return frame;
    }

    case "tool.call.result": {
      const p = event.payload as ToolResultPayload;
      const entry: ToolCallEntryDto = {
        kind: "tool-call",
        id: p.toolCallId,
        name: p.toolName,
        args: safeJson(p.args),
        result: p.result,
        state: p.isError ? "error" : "done",
        ts,
      };
      if (event.instanceId !== undefined && event.instanceId !== MAIN_INSTANCE_ID) {
        entry.instanceId = event.instanceId;
      }
      if (ctx?.durationMs !== undefined) entry.durationMs = ctx.durationMs;
      const frame: ToolCallResultEvent = {
        v: PROTOCOL_VERSION,
        type: "tool.call.result",
        payload: { entry },
      };
      return frame;
    }

    case "agent.state.changed": {
      const p = event.payload as AgentStateChangedPayload;
      return {
        v: PROTOCOL_VERSION,
        type: "agent.state.changed",
        payload: { state: p.state },
      };
    }

    // ── agent.* 编排生命周期族（T2.3，契约 §5.1；AD-7/AD-8） ──

    case "agent.spawned": {
      const p = event.payload as AgentSpawnedPayload;
      const frame: AgentSpawnedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.spawned",
        payload: { agentId: p.agentId, task: p.task, profileKind: p.profileKind, ...(p.model !== undefined ? { model: p.model } : {}) },
      };
      return frame;
    }

    case "agent.queued": {
      const p = event.payload as AgentQueuedPayload;
      const frame: AgentQueuedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.queued",
        payload: { agentId: p.agentId, position: p.position },
      };
      return frame;
    }

    case "agent.started": {
      const p = event.payload as AgentStartedPayload;
      const frame: AgentStartedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.started",
        payload: { agentId: p.agentId },
      };
      return frame;
    }

    case "agent.stalled": {
      const p = event.payload as AgentStalledPayload;
      const frame: AgentStalledEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.stalled",
        payload: { agentId: p.agentId, idleMs: p.idleMs },
      };
      return frame;
    }

    case "agent.completed": {
      const p = event.payload as AgentCompletedPayload;
      const frame: AgentCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.completed",
        payload: { agentId: p.agentId, closure: p.closure },
      };
      return frame;
    }

    case "agent.failed": {
      const p = event.payload as AgentFailedPayload;
      const frame: AgentFailedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.failed",
        payload: { agentId: p.agentId, error: p.error, closure: p.closure },
      };
      return frame;
    }

    case "agent.killed": {
      const p = event.payload as AgentKilledPayload;
      const frame: AgentKilledEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.killed",
        payload: { agentId: p.agentId, closure: p.closure },
      };
      return frame;
    }

    // ── 通道族（T3.1，契约 §5.2；payload 对齐协议 DTO，instanceId 挂帧） ──

    case "thinking.completed": {
      const p = event.payload as ThinkingCompletedPayload;
      const frame: ThinkingCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "thinking.completed",
        payload: { entry: thinkingEntryDto(p.entry) },
      };
      return frame;
    }

    case "compaction.completed": {
      const p = event.payload as CompactionCompletedPayload;
      const frame: CompactionCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "compaction.completed",
        payload: { entry: compactionEntryDto(p.entry) },
      };
      return frame;
    }

    case "usage.recorded": {
      const p = event.payload as UsageRecordedPayload;
      const frame: UsageRecordedEvent = {
        v: PROTOCOL_VERSION,
        type: "usage.recorded",
        payload: { instanceId: p.instanceId, usage: p.usage, source: p.source },
      };
      return frame;
    }

    // 终验热修：provider/引擎失败透传（错误卡片数据源；不崩会话，见 ChatService engine_error）
    case "engine.error": {
      const p = event.payload as { message: string };
      const frame: EngineErrorEvent = {
        v: PROTOCOL_VERSION,
        type: "engine.error",
        payload: { message: p.message },
      };
      return frame;
    }

    default:
      // 协议目录外领域事件（当前无——目录由 type-surface 双向一致性守护）
      return null;
  }
}

/** args 序列化（undefined → "{}"；循环/异常值的兜底为字符串占位）。 */
function safeJson(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args) ?? "{}";
  } catch {
    return String(args);
  }
}

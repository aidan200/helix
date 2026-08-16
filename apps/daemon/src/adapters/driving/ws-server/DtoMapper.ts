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
} from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { SessionStateView, InstanceSnapshotEntry } from "../../../application/ports/inbound/SessionPort";
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

// ── 快照 ────────────────────────────────────────────────────

/**
 * SessionStateView（domain）→ SessionSnapshotDto（协议）。
 * D-1：消息条目与工具调用记录按 ts 时间序合并（重连/重启后工具卡随快照
 * 恢复，契约 §6）；revision 取合并后总条数（v0 无逐事件序号，以条目数为
 * 增量基线，单调且可复算）；model/agentState 来自组合根注入的 system 状态
 * （domain 快照不含）。
 * T2.4：instances/usage additive 装配（契约 §6.2）——视图携带才下发，
 * domain↔协议同构字段直映射（closure/usage 七字段不变形）。
 */
export function toSnapshotDto(
  view: SessionStateView,
  model: string,
  agentState: AgentStateDto,
): SessionSnapshotDto {
  const snapshot = view.session;
  const queuedSteer = new Set(snapshot.pendingSteer.map((item) => item.entryId));
  // 升序稳定排序：时间并列保持组内原序（entries 原序 / toolCalls 迭代序）
  // T3.1：entries 为 message/thinking/compaction 混排联合，各变体同表合并
  const entries: EntryDto[] = [
    ...snapshot.entries.flatMap((entry) => sessionEntryDto(entry, queuedSteer)),
    ...view.toolCalls.map((record) => toolCallEntryDto(record)),
  ].sort((a, b) => entrySortKey(a) - entrySortKey(b));
  return {
    sessionId: snapshot.sessionId,
    model,
    agentState,
    revision: entries.length,
    entries,
    ...(view.instances !== undefined ? { instances: view.instances.map(instanceDto) } : {}),
    ...(view.usage !== undefined ? { usage: usageDto(view.usage) } : {}),
  };
}

/** InstanceSnapshotEntry（domain）→ AgentInstanceDto（协议；task/closure 同构直映射）。 */
function instanceDto(entry: InstanceSnapshotEntry): AgentInstanceDto {
  return {
    instanceId: entry.instanceId,
    kind: entry.kind,
    profileKind: entry.profileKind,
    state: entry.state,
    createdAt: entry.createdAt,
    ...(entry.task !== undefined ? { task: entry.task } : {}),
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

/** 单条 EntryData → MessageEntryDto（tool 角色当前领域侧不产生，防御跳过）。 */
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
 * DomainEvent → EventEnvelope。返回 null = 协议 v0 目录无对应事件
 * （engine.error：不下发，见 PROTOCOL.md §8 边界注记）。
 * v0.1：事件携带 instanceId（agent.* 编排族 + SubAgent 工具事件）时帧同值
 * 挂 instanceId（缺省 = 主实例，契约 §1/§2）——前端按 id 分流投影。
 */
export function domainEventToEnvelope(event: DomainEvent, ctx?: EventMapContext): EventEnvelope | null {
  const frame = buildEnvelope(event, ctx);
  if (frame === null) return null;
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

    default:
      // engine.error：协议 v0 12 事件无对应（领域侧可观测，协议侧丢弃）
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

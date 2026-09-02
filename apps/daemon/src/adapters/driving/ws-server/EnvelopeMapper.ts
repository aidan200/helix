/**
 * EnvelopeMapper —— 领域事件 → 协议事件帧（domainEventToEnvelope /
 * buildEnvelope / EventMapContext）。条目级 thinking/compaction 转换与
 * safeJson 复用 EntryDtoMapper（依赖方向 EnvelopeMapper → EntryDtoMapper，
 * 无环）。自 DtoMapper.ts 四域拆分落位（TR-AD-25④ 逐行搬移）。
 */
import type {
  ChatTurnCompletedEvent,
  ChatMessageCompletedEvent,
  EventEnvelope,
  MessageEntryDto,
  ToolCallEntryDto,
  ToolCallResultEvent,
  ToolCallStartedEvent,
  AgentSpawnedEvent,
  AgentQueuedEvent,
  AgentStartedEvent,
  AgentStalledEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentKilledEvent,
  AgentParkedEvent,
  AgentResumedEvent,
  ThinkingCompletedEvent,
  CompactionCompletedEvent,
  ErrorEntryEvent,
  UsageRecordedEvent,
  EngineErrorEvent,
  EngineRetryingEvent,
  EventType,
} from "@helix/protocol";
import { PROTOCOL_VERSION, EVENT_CHANNELS } from "@helix/protocol";

import type {
  AgentStateChangedPayload,
  DomainEvent,
  EngineRetryingPayload,
  MessageCompletedPayload,
  SteerPayload,
  ThinkingCompletedPayload,
  CompactionCompletedPayload,
  ErrorEntryPayload,
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
  AgentParkedPayload,
  AgentResumedPayload,
} from "../../../domain/events/DomainEvent";
import {
  compactionEntryDto,
  errorEntryDto,
  isWireMainAttribution,
  safeJson,
  thinkingEntryDto,
  WIRE_LEGACY_MAIN_ID,
} from "./EntryDtoMapper";

/** 事件映射所需的投影上下文（由 EventStream 维护，见 EventStream.ts）。 */
export interface EventMapContext {
  /** 领域 turn.completed 事件不带 turnId（发布时聚合轮次已收口）→ 以最近轮次补齐。 */
  readonly fallbackTurnId?: string;
  /** tool.call.result 的耗时（协议要求；由 start/result 两次 occurredAt 差值算出）。 */
  readonly durationMs?: number;
  /**
   * agent.spawned 帧的 spawn 锚（契约 v0.3 §1 规则②）：spawn 时值由组合根
   * 查值（SchedulerService 内存携带）经本上下文注入——**不进领域事件载荷**
   * （不落 domain_events，派生值无第二事实源）；含 null 流首（有效值）。
   */
  readonly spawnAnchor?: string | null;
  /**
   * 会话主实例 id（T10a kind 判别基准：条目级归属编码 / engine.error 抑制）。
   * EventStream 经组合根 backfill 查询注入；缺省 = legacy "main" 判别
   * （旧装配点/纯映射测试形态兼容）。
   */
  readonly mainInstanceId?: string;
}

// ── 领域事件 → 协议事件帧 ─────────────────────────────────────

/**
 * DomainEvent → EventEnvelope。返回 null = 协议目录无对应事件。
 * v0.1：事件携带 instanceId（agent.* 编排族 + SubAgent 工具事件）时帧同值
 * 挂 instanceId（缺省 = 主实例，契约 §1/§2）——前端按 id 分流投影。
 * v0.2（AD-3/AD-4 统一信封）：全部帧章印 sessionId（事件归属会话）+
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
  // T10a kind 判别基准（缺省 legacy "main"——旧装配点兼容）
  const mainId = ctx?.mainInstanceId ?? WIRE_LEGACY_MAIN_ID;
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
      if (p.role === "user" && p.isSteer) entry.steerState = p.steerState ?? "queued"; // 载荷优先；缺省 = 旧路径（事件时点刚入队）
      // 注入来源透传（T11b：idle closure/progress 注入实时帧区分；缺省不携带键）
      if (p.source !== undefined) entry.source = p.source;
      // SubAgent 消息帧携带条目 instanceId（前端实例分流；AD-3）
      if (event.instanceId !== undefined && !isWireMainAttribution(event.instanceId, mainId)) {
        entry.instanceId = event.instanceId;
      }
      // 图片下行：user 消息携带图片附件（载荷 images → entry.images 透传）
      if (p.images !== undefined && p.images.length > 0) entry.images = [...p.images];
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
        // source 透传（T11a：user/closure/progress 三值；老载荷缺省不携带键）
        payload: { entryId: p.entryId, ...(p.source !== undefined ? { source: p.source } : {}) },
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
      // SubAgent 工具卡归实例 channel（载荷内嵌 instanceId 与（AD-3）
      // v0.1 通道族并存口径一致；信封位为路由权威）
      if (event.instanceId !== undefined && !isWireMainAttribution(event.instanceId, mainId)) {
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
      if (event.instanceId !== undefined && !isWireMainAttribution(event.instanceId, mainId)) {
        entry.instanceId = event.instanceId;
      }
      // 图片下行：工具结果附带图片（工具卡缩略图数据源）
      if (p.images !== undefined && p.images.length > 0) entry.images = [...p.images];
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

    // ── agent.* 编排生命周期族（契约 §5.1；AD-7/AD-8） ──

    case "agent.spawned": {
      const p = event.payload as AgentSpawnedPayload;
      const frame: AgentSpawnedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.spawned",
        payload: {
          agentId: p.agentId,
          task: p.task,
          profileKind: p.profileKind,
          ...(p.model !== undefined ? { model: p.model } : {}),
          // 契约 v0.3 §1：spawn 锚经 ctx 注入（组合根查 SchedulerService
          // 内存携带的 spawn 时值）——领域事件载荷不携带（不落 domain_events）
          ...(ctx?.spawnAnchor !== undefined ? { anchorEntryId: ctx.spawnAnchor } : {}),
        },
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
        payload: { agentId: p.agentId, startedAtMs: p.startedAtMs },
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

    // ── park/resume 批（设计稿 park-resume §5；additive 广播帧） ──

    case "agent.parked": {
      const p = event.payload as AgentParkedPayload;
      const frame: AgentParkedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.parked",
        payload: {
          agentId: p.agentId,
          reason: p.reason,
          parkedAt: p.parkedAt,
          ...(p.summary !== undefined ? { summary: p.summary } : {}),
        },
      };
      return frame;
    }

    case "agent.resumed": {
      const p = event.payload as AgentResumedPayload;
      const frame: AgentResumedEvent = {
        v: PROTOCOL_VERSION,
        type: "agent.resumed",
        payload: { agentId: p.agentId, startedAtMs: p.startedAtMs, elapsedMs: p.elapsedMs },
      };
      return frame;
    }

    // ── 通道族（契约 §5.2；payload 对齐协议 DTO，instanceId 挂帧） ──

    case "thinking.completed": {
      const p = event.payload as ThinkingCompletedPayload;
      const frame: ThinkingCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "thinking.completed",
        payload: { entry: thinkingEntryDto(p.entry, mainId) },
      };
      return frame;
    }

    case "compaction.completed": {
      const p = event.payload as CompactionCompletedPayload;
      const frame: CompactionCompletedEvent = {
        v: PROTOCOL_VERSION,
        type: "compaction.completed",
        payload: { entry: compactionEntryDto(p.entry, mainId) },
      };
      return frame;
    }

    // error entry 批：错误条目落时间轴帧（entry 全字段经 errorEntryDto 编码）。
    // SubAgent 守卫与 engine.error 同口径（shell consumers 无 instanceId 分流，
    // 不抑制会错位弹主聊天流）；主线帧行为 = 原位红条转正数据源。
    case "error.entry": {
      if (!isWireMainAttribution(event.instanceId, mainId)) return null;
      const p = event.payload as ErrorEntryPayload;
      const frame: ErrorEntryEvent = {
        v: PROTOCOL_VERSION,
        type: "error.entry",
        payload: { entry: errorEntryDto(p.entry, mainId) },
      };
      return frame;
    }

    case "usage.recorded": {
      const p = event.payload as UsageRecordedPayload;
      // 轮末 token 用量显示面：只透传载荷 turnId（发布点单源；compaction/
      // SubAgent 不携带——信封 turnId 不落盘非权威，不回填防错挂当轮）
      const turnId = p.turnId;
      const frame: UsageRecordedEvent = {
        v: PROTOCOL_VERSION,
        type: "usage.recorded",
        payload: {
          instanceId: p.instanceId,
          usage: p.usage,
          source: p.source,
          // 轮末 token 用量显示面（additive）：携带才下发，缺省不携带键
          ...(turnId !== undefined ? { turnId } : {}),
        },
      };
      return frame;
    }

    // 终验热修：provider/引擎失败透传（错误卡片数据源；不崩会话，见 ChatService engine_error）
    case "engine.error": {
      // SubAgent 实例的 engine.error 只落 domain_events
      //（trace 数据面，WriteQueue 在 DtoMapper 之外），不产 WS 帧——shell
      // consumers/chat.ts 的 engine.error case 无 instanceId 分流，不抑制会
      // 错位弹主聊天流（AD-1 前端零改动的守护面）；主线帧行为不变。
      if (!isWireMainAttribution(event.instanceId, mainId)) return null;
      const p = event.payload as { message: string };
      const frame: EngineErrorEvent = {
        v: PROTOCOL_VERSION,
        type: "engine.error",
        payload: { message: p.message },
      };
      return frame;
    }

    // P2 ⑦ 网络重试批：LLM 瞬时失败退避等待可见反馈（chat 状态行数据源）。
    // SubAgent 守卫与 engine.error 同口径（无 instanceId 分流，不抑制会
    // 错位弹主聊天流）；主线帧行为不变。
    case "engine.retrying": {
      if (!isWireMainAttribution(event.instanceId, mainId)) return null;
      const p = event.payload as EngineRetryingPayload;
      const frame: EngineRetryingEvent = {
        v: PROTOCOL_VERSION,
        type: "engine.retrying",
        payload: {
          attempt: p.attempt,
          totalAttempts: p.totalAttempts,
          waitMs: p.waitMs,
          message: p.message,
        },
      };
      return frame;
    }

    default:
      // 协议目录外领域事件（当前无——目录由 type-surface 双向一致性守护）
      return null;
  }
}

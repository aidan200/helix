/**
 * stewardEngineTraceBridge —— 管家引擎事件 → 领域事件投影桥（段B翻转：
 * 原 LoopEvent 桥的 AgentEngineEvent 形态——输出 DomainEvent 类型/载荷面
 * 零变化，追踪页/实例面板无感）。
 *
 * - 里程碑过滤：流式中间态（message_update/thinking_delta 等）不落库
 *  （AD-16 同口径）；runId/promptSummary 恒空串占位（pi 无 run id；且
 *  pi 事件序 agent_start 先于 user 消息帧——原 LoopEvent 形态的
 *  promptSummary（前 80 字）run 锚在 pi 形态下不可得，行为检索面由
 *  message/tool 帧承载，steward-trace-projection.test 断言在案）；
 * - 归位四维：sessionId=SYSTEM_SESSION_ID / instanceId="steward"；
 * - 防自激（TR-169/TR-173）：只投领域事件进 fanout——广播面 default→null，
 *  管家不订阅广播流（零反馈边，结构上无环）；
 * - 档案行合成（fix/trace-steward-entry）：首条里程碑事件落库前合成一条
 *  agent.instantiated（payload.profileKind="steward"）——幂等位单进程一次。
 */
import type { AgentEngineEvent } from "../../application/ports/outbound/AgentEnginePort";
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { ToolCallKind, ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import { SYSTEM_SESSION_ID } from "@helix/protocol";

/** 管家实例 id（domain_events 四维落位——与主会话/SubAgent 同一标识空间）。 */
export const STEWARD_INSTANCE_ID = "steward";

export interface StewardEngineTraceBridgeDeps {
  /** 事件发布面（组合根接 FanoutPublisher——落库/投影/广播目标全集）。 */
  readonly publish: (event: DomainEvent) => void;
  /** 时钟（occurredAt；组合根 ClockPort）。 */
  readonly nowIso: () => string;
  /**
   * 工具调用监控直书口（kind='steward' 全形态入账）：start 建行 / end 收口
   * 两段写；缺席 = 不入账（监控是增量面，降级不阻断追踪）。
   */
  readonly recordToolCall?: (
    sessionId: string,
    record: ToolCallRecordData & { readonly kind: ToolCallKind },
  ) => void;
}

/** AgentEngineEvent 载荷 → domain_events 载荷（LoopEvent 桥输出面同构直转；
 *  promptSummary 恒空串占位——pi 事件序下 agent_start 先于 user 消息帧，
 *  本 run 摘要不可得（见文件头注）。 */
function payloadOf(event: AgentEngineEvent): unknown {
  switch (event.type) {
    case "agent_start":
      return { runId: "", promptSummary: "" };
    case "agent_end":
      return { runId: "", resolution: "finished" as const };
    case "engine_error":
      return { runId: "", message: event.message };
    case "turn_start":
      return { runId: "", turn: 0 };
    case "turn_end":
      return { runId: "", turn: 0, stopReason: "", tools: event.toolResultCount };
    case "tool_execution_start":
      return { runId: "", toolCallId: event.toolCallId, toolName: event.toolName, argsSummary: "" };
    case "tool_execution_end":
      return { runId: "", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError === true, resultSummary: event.result.slice(0, 120) };
    case "engine_paused":
      return { runId: "", pauseToken: event.pauseToken, toolCallId: event.toolCallId, toolName: event.toolName, argsSummary: event.argsSummary };
    case "compaction_completed":
      return {
        runId: "",
        status: "completed" as const,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
        summary: event.summary,
      };
    default:
      return undefined; // 流式中间态（过滤面）
  }
}

/** 装配：AgentEngineEvent → DomainEvent（里程碑子集）→ 发布面；首条里程碑前合成档案行。 */
export function stewardEngineTraceBridge(deps: StewardEngineTraceBridgeDeps): (event: AgentEngineEvent) => void {
  let instantiated = false; // 进程内幂等位（重启后历史行已在——重复合成无害）
  // start→end 两段写的行补齐源（end 事件无 args/name 全貌——暂存 start 载荷）
  const startedTools = new Map<string, { toolName: string; args: unknown }>();
  return (event) => {
    if (event.type === "tool_execution_start" && deps.recordToolCall !== undefined) {
      // 监控入账（kind='steward'）：id 加实例前缀防跨实例 call id 撞 PK（F3 同因）
      startedTools.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      deps.recordToolCall(SYSTEM_SESSION_ID, {
        id: `${STEWARD_INSTANCE_ID}:${event.toolCallId}`,
        instanceId: STEWARD_INSTANCE_ID,
        toolName: event.toolName,
        args: event.args,
        kind: "steward",
        status: "running",
        startedAt: deps.nowIso(),
      });
    }
    if (event.type === "tool_execution_end" && deps.recordToolCall !== undefined) {
      const started = startedTools.get(event.toolCallId);
      startedTools.delete(event.toolCallId);
      deps.recordToolCall(SYSTEM_SESSION_ID, {
        id: `${STEWARD_INSTANCE_ID}:${event.toolCallId}`,
        instanceId: STEWARD_INSTANCE_ID,
        toolName: started?.toolName ?? event.toolName,
        args: started?.args ?? null,
        kind: "steward",
        status: event.isError ? "failed" : "completed",
        ...(event.isError ? { error: event.result } : { result: event.result }),
        startedAt: deps.nowIso(),
        endedAt: deps.nowIso(),
      });
    }
    const payload = payloadOf(event);
    if (payload === undefined) return;
    if (!instantiated) {
      instantiated = true;
      deps.publish({
        type: "agent.instantiated",
        sessionId: SYSTEM_SESSION_ID,
        instanceId: STEWARD_INSTANCE_ID,
        payload: { profileKind: "steward" },
        occurredAt: deps.nowIso(),
      });
    }
    deps.publish({
      type: domainEventTypeOf(event) as DomainEvent["type"],
      sessionId: SYSTEM_SESSION_ID,
      instanceId: STEWARD_INSTANCE_ID,
      payload,
      occurredAt: deps.nowIso(),
    });
  };
}

/** AgentEngineEvent → DomainEvent 类型名（LoopEvent 桥的既有类型面）。 */
function domainEventTypeOf(event: AgentEngineEvent): string {
  switch (event.type) {
    case "agent_start":
      return "loop.run.started";
    case "agent_end":
      return "loop.run.finished";
    case "engine_error":
      return "loop.run.error";
    case "turn_start":
      return "loop.turn.started";
    case "turn_end":
      return "loop.turn.finished";
    case "tool_execution_start":
      return "loop.tool.started";
    case "tool_execution_end":
      return "loop.tool.finished";
    case "engine_paused":
      return "loop.run.paused";
    case "compaction_completed":
      return "loop.context.compacted";
    default:
      return "loop.run.started";
  }
}

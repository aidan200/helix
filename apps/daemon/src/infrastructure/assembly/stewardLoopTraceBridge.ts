/**
 * stewardLoopTraceBridge —— 管家 LoopEngine 事件 → 领域事件投影桥
 * （helix-loop L0 批；E-18 追踪唯一真实源：LoopEngine 事件同步落
 * domain_events，instanceId=steward——追踪页实例面板出现管家行为历史，
 * 只读投影零改动白拿）。
 *
 * - 里程碑过滤：流式中间态（message.delta/message.started/tool.progress/
 *   duplex.wake）不落库（AD-16 同口径——LOOP_TRACE_EVENT_TYPES 单源）；
 * - 归位四维：sessionId=SYSTEM_SESSION_ID / instanceId="steward" /
 *   agent_kind 由 event-row-persistence 按注册表判别（非主实例 → subagent）；
 * - 防自激（TR-169/TR-173）：本桥只投领域事件进 fanout——loop.* 不在
 *   STEWARD_FEED_EVENT_TYPES 粗筛集合且 EnvelopeMapper default→null，
 *   管家不订阅广播流（零反馈边，结构上无环）；
 * - 档案行合成（fix/trace-steward-entry）：首条里程碑事件落库前合成一条
 *   agent.instantiated（payload.profileKind="steward"）——assembleInstancePanel
 *   fold 出的管家行有 profileKind 档案（复用既有事件类型，零表结构/新类型）。
 *   幂等：桥闭包内状态位，单进程生命周期只发一次；重启后历史行已在
 *   domain_events（面板 fold 取首条 instantiated），重复合成无害。
 */
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { LoopEvent } from "../../domain/loop";
import { SYSTEM_SESSION_ID } from "@helix/protocol";

/** 管家实例 id（domain_events 四维落位——与主会话/SubAgent 同一标识空间）。 */
export const STEWARD_INSTANCE_ID = "steward";

export interface StewardLoopTraceBridgeDeps {
  /** 事件发布面（组合根接 FanoutPublisher——落库/投影/广播目标全集）。 */
  readonly publish: (event: DomainEvent) => void;
  /** 时钟（occurredAt；组合根 ClockPort）。 */
  readonly nowIso: () => string;
}

/** LoopEvent 载荷 → domain_events 载荷（同构直转——字段名与协议帧一致）。 */
function payloadOf(event: LoopEvent): unknown {
  switch (event.type) {
    case "loop.run.started":
      return { runId: event.runId, promptSummary: event.promptSummary };
    case "loop.run.finished":
      return { runId: event.runId, resolution: event.resolution };
    case "loop.run.error":
      return { runId: event.runId, message: event.message };
    case "loop.turn.started":
      return { runId: event.runId, turn: event.turn };
    case "loop.turn.finished":
      return { runId: event.runId, turn: event.turn, stopReason: event.stopReason, tools: event.tools };
    case "loop.tool.started":
      return { runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, argsSummary: event.argsSummary };
    case "loop.tool.finished":
      return { runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, resultSummary: event.resultSummary };
    case "loop.run.paused":
      return { runId: event.runId, pauseToken: event.pauseToken, toolCallId: event.toolCallId, toolName: event.toolName, argsSummary: event.argsSummary };
    case "loop.run.resumed":
      return { runId: event.runId, pauseToken: event.pauseToken, decision: event.decision };
    case "loop.run.interrupted":
      return { runId: event.runId, reason: event.reason };
    default:
      return undefined; // 流式中间态/占位型（过滤面已挡，防御兜底）
  }
}

/** 装配：LoopEvent → DomainEvent（里程碑子集）→ 发布面；首条里程碑前合成档案行。 */
export function stewardLoopTraceBridge(deps: StewardLoopTraceBridgeDeps): (event: LoopEvent) => void {
  let instantiated = false; // 进程内幂等位（重启后历史行已在——重复合成无害）
  return (event) => {
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
      type: event.type as DomainEvent["type"],
      sessionId: SYSTEM_SESSION_ID,
      instanceId: STEWARD_INSTANCE_ID,
      payload,
      occurredAt: deps.nowIso(),
    });
  };
}

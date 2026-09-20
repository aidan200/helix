/**
 * LoopEvent —— loop 域事件族（helix-loop L0 批；设计 §3）。
 *
 * 15 型：pi agent-loop 11 型同构（type 字面量按协议 dot.case 重命名）+
 * 4 扩展（run_paused/run_resumed 暂停原语；run_interrupted/duplex_wake
 * 双工挂点——L0 只定义不实现触发）。
 *
 * 载荷与 @helix/protocol events/loop.ts 帧同构对应（AG-02 禁 domain import
 * protocol——形状同构对应是 TR-AD-3 既有模式；装配层单点转换）。流式
 * 中间态（message.delta）不落事件存储（AD-16 同口径），仅实时通道消费。
 */
import type { LoopMessage, LoopToolCallContext } from "./LoopTypes";

/** 轮次终态因（pi turn_end stopReason 投影面）。 */
export type LoopTurnStopReason = "text" | "toolUse";

/** 暂停恢复决策判别（协议 LoopResumeDecisionKind 同构镜像）。 */
export type LoopResumeDecisionKind = "approve" | "approveWith" | "reject" | "resolve";

/** run 收口形态（aborted = signal 取代——非错误非终答，行为历史诚实投影）。 */
export type LoopRunResolution = "answer" | "confirm_required" | "resolved" | "roundLimit" | "error" | "aborted";

export type LoopEvent =
  /** pi agent_start 同构：run 启动。 */
  | { readonly type: "loop.run.started"; readonly runId: string; readonly promptSummary: string }
  /** pi turn_start 同构。 */
  | { readonly type: "loop.turn.started"; readonly runId: string; readonly turn: number }
  /** pi message_start 同构（流式中间态——不落事件存储）。 */
  | { readonly type: "loop.message.started"; readonly runId: string; readonly turn: number }
  /** pi message_update 同构（流式增量——不落事件存储）。 */
  | { readonly type: "loop.message.delta"; readonly runId: string; readonly turn: number; readonly delta: string }
  /** pi message_end 同构。 */
  | { readonly type: "loop.message.finished"; readonly runId: string; readonly turn: number; readonly stopReason: LoopTurnStopReason }
  /** pi tool_execution_start 同构。 */
  | {
      readonly type: "loop.tool.started";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argsSummary: string;
    }
  /** pi tool_execution_update 同构（L0 顺序执行面不发射；协议对齐占位）。 */
  | { readonly type: "loop.tool.progress"; readonly runId: string; readonly toolCallId: string; readonly partial: string }
  /** pi tool_execution_end 同构（result + isError 语义对齐——E-17 四态投影源）。 */
  | {
      readonly type: "loop.tool.finished";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      readonly resultSummary: string;
    }
  /** pi turn_end 同构（轮终态 + 本轮工具名清单）。 */
  | {
      readonly type: "loop.turn.finished";
      readonly runId: string;
      readonly turn: number;
      readonly stopReason: LoopTurnStopReason;
      readonly tools: readonly string[];
    }
  /** pi agent_end 同构（run 终态）。 */
  | { readonly type: "loop.run.finished"; readonly runId: string; readonly resolution: LoopRunResolution }
  /** run 错误收口（pi 以 stopReason=error 隐式表达；helix 显式事件型）。 */
  | { readonly type: "loop.run.error"; readonly runId: string; readonly message: string }
  /** helix 扩展：暂停点触发（beforeToolCallPause 挂闸）。 */
  | {
      readonly type: "loop.run.paused";
      readonly runId: string;
      readonly pauseToken: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argsSummary: string;
    }
  /** helix 扩展：暂停恢复（带决策投影）。 */
  | { readonly type: "loop.run.resumed"; readonly runId: string; readonly pauseToken: string; readonly decision: LoopResumeDecisionKind }
  /** helix 扩展（L2 双工挂点，L0 只定义）：外部中断（barge-in 截断保留）。 */
  | { readonly type: "loop.run.interrupted"; readonly runId: string; readonly reason: string }
  /** helix 扩展（L2 双工挂点，L0 只定义）：idle 挂监听态被唤醒。 */
  | { readonly type: "loop.duplex.wake"; readonly source: string };

/** 落事件存储的里程碑子集（流式中间态排除——message.delta/message.started
 *  与 protocol 对齐但不进 domain_events；调用方投影面单点判定）。 */
export const LOOP_TRACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "loop.run.started",
  "loop.turn.started",
  "loop.turn.finished",
  "loop.tool.started",
  "loop.tool.finished",
  "loop.run.finished",
  "loop.run.error",
  "loop.run.paused",
  "loop.run.resumed",
  "loop.run.interrupted",
]);

/** 消息终态事件载荷推导辅助（装配层投影用）。 */
export function loopToolArgsSummary(args: Record<string, unknown>, maxChars = 200): string {
  const raw = JSON.stringify(args);
  return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}…`;
}

/** LoopMessage → 摘要（事件载荷检索面；非权威——全文在调用方事实源）。 */
export function loopMessageSummary(message: LoopMessage): string {
  if (message.role === "user") return message.text.slice(0, 200);
  if (message.role === "toolResult") return message.text.slice(0, 200);
  return (message.text ?? "").slice(0, 200);
}

/** 工具调用上下文 → tool.started/paused 载荷共形（context 投影面）。 */
export function loopToolCallEventFields(context: LoopToolCallContext, argsSummary?: string): {
  toolCallId: string;
  toolName: string;
  argsSummary: string;
} {
  return {
    toolCallId: context.toolCallId,
    toolName: context.toolName,
    argsSummary: argsSummary ?? loopToolArgsSummary(context.args),
  };
}

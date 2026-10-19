/**
 * loop 族事件（helix-loop L0 批，additive；新 Channel 值 "loop"——扩展纪律：
 * 新增族 = additive，不动分发器，"steward" 族先例同构口径）。
 *
 * helix 自有 agent loop（domain/loop LoopEngine）的事件族——pi agent-loop
 * 11 型事件逐一同构（字段语义对齐，type 字面量按本协议 dot.case 风格重命名：
 * agent_start→loop.run.started、message_update→loop.message.delta、
 * tool_execution_end→loop.tool.finished 等），外加 4 个 helix 扩展型
 * （run_paused / run_resumed / run_interrupted / duplex_wake——后两者 L0 仅
 * 定义协议不实现触发，供 L2 双工挂点接线）。
 *
 * 设计锚：docs/temp/helix-loop-design.md §3（事件族）——L3 替换 pi-agent-core
 * 主会话引擎时，shell/trace 消费面按本协议编程零改动（pi 事件族 → 本族的
 * 同构映射在 daemon 装配层单点）。L0 消费面：LoopEngine 事件同步投影落
 * domain_events（E-18 追踪唯一真实源——管家行为历史经 trace.query 白拿）；
 * 广播面 L0 不接（屏幕通道既有 steward.* 帧覆盖，避免双轨）。
 */
import type { EventFrame } from "../envelope";

/** loop.run.started payload：run 启动（pi agent_start 同构）。 */
export interface LoopRunStartedPayload {
  /** run 标识（LoopEngine 发号；实例内单调）。 */
  runId: string;
  /** 首条 prompt 摘要（行为历史检索面；截断短串）。 */
  promptSummary: string;
}

/** loop.run.started：agent loop run 启动（channel = "loop"）。 */
export interface LoopRunStartedEvent extends EventFrame<LoopRunStartedPayload> {
  channel?: "loop";
  type: "loop.run.started";
}

/** run 收口形态（终答 / 暂停待确认 / 外部 resume 决策终结 / 轮次熔断 / 错误 /
 *  abort 取代——非错误非终答，行为历史诚实投影）。 */
export type LoopRunResolution =
  | "answer"
  | "confirm_required"
  | "resolved"
  | "roundLimit"
  | "error"
  | "aborted";

/** loop.run.finished payload：run 终态（pi agent_end 同构；messages 不上协议——
 *  行为历史面只携摘要，全文在事件存储与工作记忆）。 */
export interface LoopRunFinishedPayload {
  runId: string;
  resolution: LoopRunResolution;
}

/** loop.run.finished：agent loop run 终态（channel = "loop"）。 */
export interface LoopRunFinishedEvent extends EventFrame<LoopRunFinishedPayload> {
  channel?: "loop";
  type: "loop.run.finished";
}

/** loop.turn.started payload：轮次开始（pi turn_start 同构）。 */
export interface LoopTurnStartedPayload {
  runId: string;
  /** 轮次序号（run 内 1 起）。 */
  turn: number;
}

/** loop.turn.started：LLM 轮次开始（channel = "loop"）。 */
export interface LoopTurnStartedEvent extends EventFrame<LoopTurnStartedPayload> {
  channel?: "loop";
  type: "loop.turn.started";
}

/** 轮次终态因：text = 文本终答轮；toolUse = 工具调用轮（工具执行完毕）。 */
export type LoopTurnStopReason = "text" | "toolUse";

/** loop.turn.finished payload：轮次终态（pi turn_end 同构——message +
 *  toolResults 的投影面：stopReason + 工具名清单，全文留在事件存储）。 */
export interface LoopTurnFinishedPayload {
  runId: string;
  turn: number;
  stopReason: LoopTurnStopReason;
  /** 本轮执行的工具名清单（顺序执行序；文本轮为空数组）。 */
  tools: readonly string[];
}

/** loop.turn.finished：LLM 轮次终态（channel = "loop"）。 */
export interface LoopTurnFinishedEvent extends EventFrame<LoopTurnFinishedPayload> {
  channel?: "loop";
  type: "loop.turn.finished";
}

/** loop.message.started payload：assistant 消息开始流式生成（pi message_start 同构）。 */
export interface LoopMessageStartedPayload {
  runId: string;
  turn: number;
}

/** loop.message.started：assistant 消息开始（channel = "loop"；流式中间态——
 *  广播面不落 domain_events，E-2/AD-16 同口径）。 */
export interface LoopMessageStartedEvent extends EventFrame<LoopMessageStartedPayload> {
  channel?: "loop";
  type: "loop.message.started";
}

/** loop.message.delta payload：assistant 消息流式增量（pi message_update 同构）。 */
export interface LoopMessageDeltaPayload {
  runId: string;
  turn: number;
  /** 本帧文本增量（非累计——消费端聚合，chat.stream.delta 同构语义）。 */
  delta: string;
}

/** loop.message.delta：流式文本增量帧（channel = "loop"；流式中间态不落盘）。 */
export interface LoopMessageDeltaEvent extends EventFrame<LoopMessageDeltaPayload> {
  channel?: "loop";
  type: "loop.message.delta";
}

/** loop.message.finished payload：assistant 消息终态（pi message_end 同构）。 */
export interface LoopMessageFinishedPayload {
  runId: string;
  turn: number;
  /** 消息终态因：text / toolUse（工具调用轮在消息终态后进入工具执行段）。 */
  stopReason: LoopTurnStopReason;
}

/** loop.message.finished：assistant 消息终态（channel = "loop"）。 */
export interface LoopMessageFinishedEvent extends EventFrame<LoopMessageFinishedPayload> {
  channel?: "loop";
  type: "loop.message.finished";
}

/** loop.tool.started payload：工具执行开始（pi tool_execution_start 同构）。 */
export interface LoopToolStartedPayload {
  runId: string;
  toolCallId: string;
  toolName: string;
  /** 参数摘要（JSON 短串；防御性截断——与 steward.tool 帧 argsSummary 同口径）。 */
  argsSummary: string;
}

/** loop.tool.started：工具执行开始（channel = "loop"）。 */
export interface LoopToolStartedEvent extends EventFrame<LoopToolStartedPayload> {
  channel?: "loop";
  type: "loop.tool.started";
}

/** loop.tool.progress payload：工具执行过程更新（pi tool_execution_update 同构；
 *  L0 顺序执行面不发射，协议先占位对齐 pi 11 型）。 */
export interface LoopToolProgressPayload {
  runId: string;
  toolCallId: string;
  /** 部分结果摘要。 */
  partial: string;
}

/** loop.tool.progress：工具执行过程更新（channel = "loop"；L0 不发射）。 */
export interface LoopToolProgressEvent extends EventFrame<LoopToolProgressPayload> {
  channel?: "loop";
  type: "loop.tool.progress";
}

/** loop.tool.finished payload：工具执行终态（pi tool_execution_end 同构——
 *  result + isError 语义对齐；全文留在事件存储/工作记忆，帧携摘要）。 */
export interface LoopToolFinishedPayload {
  runId: string;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /** 结果摘要（截断短串）。 */
  resultSummary: string;
}

/** loop.tool.finished：工具执行终态（channel = "loop"）。 */
export interface LoopToolFinishedEvent extends EventFrame<LoopToolFinishedPayload> {
  channel?: "loop";
  type: "loop.tool.finished";
}

/** loop.run.error payload：run 错误收口（pi 以 stopReason=error 隐式表达，
 *  helix 显式事件型——错误可观测面单点）。 */
export interface LoopRunErrorPayload {
  runId: string;
  /** 错误原因（含引导文案）。 */
  message: string;
}

/** loop.run.error：run 错误收口（channel = "loop"）。 */
export interface LoopRunErrorEvent extends EventFrame<LoopRunErrorPayload> {
  channel?: "loop";
  type: "loop.run.error";
}

/** 确认闸暂停的恢复决策判别（resumeWith 的决策面投影——E-46 工具四态语义：
 *  approve/approveWith → running→completed；reject → 回灌引导后续行）。 */
export type LoopResumeDecisionKind =
  | "approve"
  | "approveWith"
  | "reject"
  | "resolve";

/** loop.run.paused payload：暂停点触发（helix 扩展——pi 无此概念：
 *  beforeToolCallPause 挂钩在工具执行前挂起 run，等外部人工确认）。 */
export interface LoopRunPausedPayload {
  runId: string;
  /** 暂停凭据（外部 resume 入口定位；一次性消费）。 */
  pauseToken: string;
  toolCallId: string;
  toolName: string;
  argsSummary: string;
}

/** loop.run.paused：确认闸暂停（channel = "loop"；消费者：确认卡 UI、trace）。 */
export interface LoopRunPausedEvent extends EventFrame<LoopRunPausedPayload> {
  channel?: "loop";
  type: "loop.run.paused";
}

/** loop.run.resumed payload：暂停恢复（带决策投影）。 */
export interface LoopRunResumedPayload {
  runId: string;
  pauseToken: string;
  decision: LoopResumeDecisionKind;
}

/** loop.run.resumed：暂停点恢复（channel = "loop"）。 */
export interface LoopRunResumedEvent extends EventFrame<LoopRunResumedPayload> {
  channel?: "loop";
  type: "loop.run.resumed";
}

/** loop.run.interrupted payload：外部中断（helix 扩展，L2 双工挂点——barge-in
 *  截断保留：保留已生成部分、进 listening；与 abort 的区别 = 语义面保留
 *  partial。L0 仅定义协议，不实现触发）。 */
export interface LoopRunInterruptedPayload {
  runId: string;
  /** 中断原因（如 "barge-in"）。 */
  reason: string;
}

/** loop.run.interrupted：外部中断（channel = "loop"；L2 接线）。 */
export interface LoopRunInterruptedEvent extends EventFrame<LoopRunInterruptedPayload> {
  channel?: "loop";
  type: "loop.run.interrupted";
}

/** loop.duplex.wake payload：idle 挂监听态被唤醒（helix 扩展，L2 双工挂点——
 *  VAD 检出人声/关键词/WS 命令命中 → 新轮。L0 仅定义协议，不实现触发）。 */
export interface LoopDuplexWakePayload {
  /** 唤醒源（如 "vad" / "keyword" / "ws"）。 */
  source: string;
}

/** loop.duplex.wake：双工唤醒（channel = "loop"；L2 接线）。 */
export interface LoopDuplexWakeEvent extends EventFrame<LoopDuplexWakePayload> {
  channel?: "loop";
  type: "loop.duplex.wake";
}

/** loop.context.compacted payload：上下文压缩里程碑（helix 扩展，L1 件一；
 *  TR-47 语义同族：压的是历史不是工作集——尾部滚动窗保留原文）。
 *  failed 同型记错（压缩是优化不是依赖：降级粗裁剪不阻塞对话）。 */
export type LoopContextCompactedPayload =
  | {
      runId: string;
      /** completed = 窗口已替换为摘要 + 尾窗。 */
      status: "completed";
      /** 压前窗口 token 估算（estimateLoopTokens 同族口径）。 */
      tokensBefore: number;
      /** 压后窗口 token 估算。 */
      tokensAfter: number;
      /** 摘要短串（截断 200 字符）。 */
      summary: string;
    }
  | {
      runId: string;
      /** failed = 保留原窗口（粗裁剪兑底）——失败必带 error，无 tokensAfter/summary。 */
      status: "failed";
      tokensBefore: number;
      /** 失败原因。 */
      error: string;
    };

/** loop.context.compacted：上下文压缩里程碑帧（channel = "loop"；追踪页
 *  可见压缩何时发生——tokensBefore/After 水位 + 摘要）。 */
export interface LoopContextCompactedEvent extends EventFrame<LoopContextCompactedPayload> {
  channel?: "loop";
  type: "loop.context.compacted";
}

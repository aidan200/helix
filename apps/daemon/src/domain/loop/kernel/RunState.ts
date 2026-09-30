/**
 * kernel/RunState —— run 作用域状态与转录装配（helix-loop Phase 0a 四层拆分；
 * 设计 §2.2：原 LoopEngine 单类五合一拆四件之首）。
 *
 * 不变量：transcript 单写者——run 内消息窗口只经 recordMessage 变更
 * （push + onNewMessage 持久化回调 await 串行保序）；messages 引用稳定
 * （压缩整窗替换也在同引用上重排）。
 */
import type {
  LoopAbortAudit,
  LoopCompactionInfo,
  LoopContentBlock,
  LoopMessage,
  LoopMessageSink,
  LoopPauseDecision,
  LoopResumeDecision,
  LoopToolCallContext,
  LoopToolSchema,
} from "../contracts";

/** run 收口判别（对外终态面；Phase 1 块模型——finished 携完整块集）。 */
export type LoopRunResult =
  /** text 终答（完整块集——text-only 即单 text 块，混排块原样保留）。 */
  | { readonly kind: "finished"; readonly blocks: readonly LoopContentBlock[] }
  /** 暂停点挂起：resumeWith 决定放行/改参/拒绝/外部已执行（返回续跑 promise——
   *  续跑可能再次 paused（下一工具又挂闸），递归同构）。 */
  | {
      readonly kind: "paused";
      readonly pauseToken: string;
      readonly toolCall: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> };
      readonly resumeWith: (decision: LoopResumeDecision) => Promise<LoopRunResult>;
    }
  /** 外部 resume 决策终结（confirm 执行体路径）。 */
  | { readonly kind: "resolved" }
  /** 工具轮上限熔断。 */
  | { readonly kind: "roundLimit"; readonly maxRounds: number }
  /** 错误收口（LLM 失败 / 工具 terminate / 超限详情文案）。 */
  | { readonly kind: "error"; readonly message: string }
  /** signal abort（新 ask 取代类）——E-198 partial 保留：安全块已入账 +
   *  截断标记；半截 text 入账（G1：partialText 并入尾批文本），半截
   *  thinking/toolCall 丢弃（audit = I6 审计摘要，无入账且无丢弃时缺席）。 */
  | { readonly kind: "aborted"; readonly audit?: LoopAbortAudit };

/** startRun 返回句柄。 */
export interface LoopRunHandle {
  readonly runId: string;
  readonly promise: Promise<LoopRunResult>;
}

/** run 内可变状态（暂停后跨 resume 续跑保持；messages 引用稳定——压缩
 *  整窗替换也在同引用上重排）。 */
export interface RunState {
  readonly runId: string;
  messages: LoopMessage[];
  turn: number;
  rounds: number;
}

/** 过程可见回调面（与 StewardAskEvents 等价——屏幕通道）。 */
export interface LoopRunCallbacks {
  readonly onDelta?: (chunk: string) => void;
  readonly onThinking?: (block: string) => void;
  readonly onToolStart?: (name: string, argsSummary: string) => void;
  readonly onToolEnd?: (name: string, resultSummary: string) => void;
}

/** run 装配输入（LoopEngine.startRun 单点入口）。 */
export interface LoopRunInput {
  readonly systemPrompt: string;
  /** 初始消息窗口（调用方事实源重建——管家 = buildLlmWindow(dialog.snapshot())）。 */
  readonly messages: readonly LoopMessage[];
  /** LLM 工具面投影（ToolRegistry.llmTools()——注册面与声明面分离）。 */
  readonly tools: readonly LoopToolSchema[];
  /** 工具轮上限（成本护栏：超限熔断，不无限循环）。 */
  readonly maxRounds: number;
  /** abort 信号（Phase 3 批语义：signal 尽力传播进工具 ctx——R4.2；批收口等
 *  全部在飞枚 settle；LLM 流式段照旧自治收口）。 */
  readonly signal?: AbortSignal;
  /** 暂停挂钩（write 类工具挂闸的判定面；缺席 = 无暂停点。Phase 3 R6.7：
 *  增可选 signal（additive）——阻塞等待中的闸可被打断）。 */
  readonly beforeToolCallPause?: (context: LoopToolCallContext, signal?: AbortSignal) => Promise<LoopPauseDecision>;
  /** 新消息持久化回调（assistant 终态/toolResult——await 串行保序）。 */
  readonly onNewMessage?: LoopMessageSink;
  /** L1 件一：压缩完成回调（事实源整窗替换——摘要入账 + 尾部保留）。 */
  readonly onCompacted?: (info: LoopCompactionInfo) => Promise<void>;
  /** 过程可见回调（屏幕通道等价面）。 */
  readonly callbacks?: LoopRunCallbacks;
  /** run 首条 prompt 摘要（run.started 事件检索面）。 */
  readonly promptSummary?: string;
  /** Phase 2 A3：轮边界 steer 注入挂点（runtime 注入——kernel 不持队列，分层：
   *  队列是跨 run 态归 runtime，轮内 poll 是 kernel 挂点）。
   *  时序（R2.2/R7.4 轮首序）：abort 检查 → rounds 熔断 → 压缩 →
   *  turn.started → drain+注入 → streamFn；每调用至多取一条
   *  （one-at-a-time R2.3）；返回 undefined = 本轮无注入。 */
  readonly drainSteering?: () => LoopMessage | undefined;
  /** Phase 2 A3：steer 队列非空探测（R2.5：text 终答轮后队列非空 → run
   *  不收口继续新 turn；取走仍只在轮首单 drain 点——R2.3 简化口径）。 */
  readonly hasSteering?: () => boolean;
  /** Phase 3 D9：批内并发执行上限（缺省 Infinity 无上限——R1.5 随 pi；
   *  AgentConfig 级可选项，V3 实测后再议收紧）。 */
  readonly maxConcurrentTools?: number;
}

/** abort 原因提取（E-198 I5：interrupted 事件 reason 面；AbortController.abort
 *  幂等——首个 reason 定格，重复信号零漂移）。kernel 共享 util（LoopKernel 轮首检查
 *  与 ToolPhase 批收口同源）。 */
export function abortReasonOf(signal: AbortSignal | undefined): string {
  if (signal === undefined) return "aborted";
  const reason: unknown = signal.reason;
  if (typeof reason === "string" && reason !== "") return reason;
  if (reason instanceof Error && reason.message !== "") return reason.message;
  return "aborted";
}

/** 新消息入窗口 + 持久化回调（await 串行保序——调用方事实源同步面）。
 *  transcript 单写者唯一入口：kernel/ToolPhase/AbortSettler 一律经此变更
 *  run 消息窗口（policy 压缩步的整窗替换是唯一例外——同引用重排）。 */
export async function recordMessage(state: RunState, input: LoopRunInput, message: LoopMessage): Promise<void> {
  state.messages.push(message);
  await input.onNewMessage?.(message);
}

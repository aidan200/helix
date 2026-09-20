/**
 * LoopTypes —— helix 自有 agent loop 的结构契约（helix-loop L0 批；
 * docs/temp/helix-loop-design.md §2/§4）。
 *
 * domain/loop 本体零 pi import（连 type-only 都不出现——比管家现状更干净）：
 * - 消息/工具 schema/response 形状为 loop 域自有窄面（与 application 的
 *   StewardLlmMessage/StewardLlmTool/StewardLlmResponse 结构同构——
 *   LoopMessageShapeIsomorphic 断言锚定，TS 结构类型直接互通）；
 * - LoopStreamFn 是 StreamFn duck-type 结构契约：pi-ai 的
 *   Models.streamSimple 消费器满足形状（真体在 adapters/driven/loop 装配注入，
 *   satisfies 锚定编译期断形状漂移——设计 §7-3）。pi-ai 从「框架依赖」
 *   降级为「满足 StreamFn 形状的库」。
 */
import type { LoopEvent } from "./LoopEvent";

/** thinking 块（全精度：文本 + provider 回传凭据）。 */
export interface LoopThinking {
  readonly text: string;
  readonly signature?: string;
}

/** 对话消息（loop 域窄面；与 StewardLlmMessage 同构）。 */
export type LoopMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text?: string;
      readonly thinking?: LoopThinking;
      readonly toolCall?: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> };
    }
  | { readonly role: "toolResult"; readonly toolCallId: string; readonly name: string; readonly text: string };

/** 工具声明（LLM function calling 面；与 StewardLlmTool 同构）。 */
export interface LoopToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** LLM 单步请求。 */
export interface LoopStreamInput {
  readonly systemPrompt: string;
  readonly messages: readonly LoopMessage[];
  readonly tools: readonly LoopToolSchema[];
}

/** 流式回调面（与 StewardAskEvents 过程面同语义）。 */
export interface LoopStreamCallbacks {
  /** 文本生成段增量（仅 text chunk；工具调用段静默）。 */
  readonly onDelta?: (chunk: string) => void;
  /** thinking 段级（一个完成态块一帧全量文本）。 */
  readonly onThinking?: (block: string) => void;
}

/** LLM 单步响应判别（与 StewardLlmResponse 同构 + aborted 判别——
 *  duplex-truncation §6.3：aborted 不再混在 throw 里）。 */
export type LoopStreamResult =
  | { readonly kind: "text"; readonly text: string; readonly thinking?: LoopThinking }
  | {
      readonly kind: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
      readonly thinking?: LoopThinking;
    }
  | { readonly kind: "aborted" };

/**
 * StreamFn duck-type 结构契约（loop 域零 pi import 的核心承载）：
 * 单步 LLM 流式补全——请求消息窗口 + 工具面 → 流式回调 + 终态判别。
 *
 * pi-ai 满足形状的路径：driven adapter 内以 Models.streamSimple 为主体实现
 * （abort 经 signal 透传——pi-ai error 事件 reason=aborted 收口为本契约的
 * { kind: "aborted" }，partial 保留语义见 duplex-truncation §2.1）。
 * 依赖纪律：本类型零 pi import；真体唯一合法落点 adapters/driven/loop。
 */
export type LoopStreamFn = (
  input: LoopStreamInput,
  callbacks?: LoopStreamCallbacks & { readonly signal?: AbortSignal },
) => Promise<LoopStreamResult>;

/** 工具调用上下文（dispatch 与暂停挂钩的判别面）。 */
export interface LoopToolCallContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/** 工具执行结果判别（summary = 过程帧/事件摘要覆盖面——缺省用 text 派生）。 */
export type LoopToolOutcome =
  | { readonly kind: "result"; readonly text: string; readonly isError?: boolean; readonly summary?: string }
  /** run 终止直出错误回执（propose_send 类防火墙前置拒——不回灌循环）。 */
  | { readonly kind: "terminate"; readonly reason: string };

/** 工具 handler 形状（ToolRegistry 注册项的执行面）。 */
export type LoopToolHandler = (
  args: Record<string, unknown>,
  context: LoopToolCallContext,
) => Promise<LoopToolOutcome>;

/** 暂停恢复决策（beforeToolCallPause 挂闸后的外部裁决面——确认闸语义）。 */
export type LoopResumeDecision =
  /** 放行原参执行（handler 正常路径）。 */
  | { readonly kind: "approve" }
  /** 改参执行。 */
  | { readonly kind: "approveWith"; readonly args: Record<string, unknown> }
  /** 拒绝：toolResult(拒绝文案) 回灌 + 循环继续（模型可自纠）。 */
  | { readonly kind: "reject"; readonly text: string }
  /** 外部已执行：toolResult(text) 回灌 + run 终止（confirm 执行体路径）。 */
  | { readonly kind: "resolve"; readonly text: string; readonly isError?: boolean };

/** beforeToolCallPause 挂钩判定（工具执行前可挂起——helix 独有暂停原语，
 *  比 pi 的 block-or-pass 多「暂停后继续」；设计 §4①）。
 *  pause:false + outcome = 挂钩内前置校验产物（跳过 handler 执行直接回灌——
 *  校验单点在挂钩，approve 后 handler 才执行写动作）。 */
export type LoopPauseDecision =
  | { readonly pause: false; readonly outcome?: LoopToolOutcome }
  | { readonly pause: true };

/** run 运行面事件发射器（LoopEngine → 外部投影的唯一通道）。 */
export type LoopEventEmitter = (event: LoopEvent) => void;

/** run 内新消息持久化回调（调用方工作记忆/事件存储同步——await 串行保序）。 */
export type LoopMessageSink = (message: LoopMessage) => Promise<void>;

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
  /** abort 信号（只作用于 LLM 流式段；工具执行段不打断——duplex §6.2）。 */
  readonly signal?: AbortSignal;
  /** 暂停挂钩（write 类工具挂闸的判定面；缺席 = 无暂停点）。 */
  readonly beforeToolCallPause?: (context: LoopToolCallContext) => Promise<LoopPauseDecision>;
  /** 新消息持久化回调（assistant 终态/toolResult——await 串行保序）。 */
  readonly onNewMessage?: LoopMessageSink;
  /** 过程可见回调（屏幕通道等价面）。 */
  readonly callbacks?: LoopRunCallbacks;
  /** run 首条 prompt 摘要（run.started 事件检索面）。 */
  readonly promptSummary?: string;
}

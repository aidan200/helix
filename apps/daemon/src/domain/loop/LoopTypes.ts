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
  | {
      readonly role: "user";
      readonly text: string;
      /** L1 件一：压缩摘要合成消息标记（synthesized——非用户真实输入；
       *  回传面与普通 user 同构，标记仅供 UI/追踪区分）。 */
      readonly compaction?: true;
    }
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

/** 流式回调面（与 StewardAskEvents 过程面同语义；onBlockEnd = E-198 块边界
 *  扩展——pi 三段式 *_start/delta/end 中 end 的块级帧）。 */
export interface LoopStreamCallbacks {
  /** 文本生成段增量（仅 text chunk；工具调用段静默）。 */
  readonly onDelta?: (chunk: string) => void;
  /** thinking 段级（一个完成态块一帧全量文本）。 */
  readonly onThinking?: (block: string) => void;
  /** 块级完整收尾帧（text/thinking/toolCall 块 *_end）——E-198 打断善后的
   *  收集面：块 end 是完整性唯一凭证（I1），已收 end 的块安全入账；未收 end
   *  的半截块中 text 经 aborted 判别 partialText 入账（G1），thinking/toolCall
   *  无帧丢弃。 */
  readonly onBlockEnd?: (block: LoopStreamBlock) => void;
}

/** E-198：流块完整收尾帧（pi AssistantMessageEvent 的 text_end/thinking_end/
 *  toolcall_end 同构载荷）——打断时已收 end 的块可安全入账（I1），未收 end
 *  的半截块中 text 经 partialText 入账（G1），thinking/toolCall 不进下轮上下文
 *  （I2）。domain 零 pi import：adapter 映射真体。 */
export type LoopStreamBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string; readonly signature?: string }
  | { readonly kind: "toolCall"; readonly id: string; readonly name: string; readonly args: Record<string, unknown> };

/** E-198：打断截断标记（turn 级「此处被掐」）——固定常量文本的 user 角色
 *  合成消息（外部中断事件的模型面：三角色 schema 下 user 是外部事件的唯一
 *  合法通道；固定常量 = KV/审计/sediment 过滤的同源识别凭据；provider 面
 *  user 消息恒合法）。 */
export const LOOP_INTERRUPTED_MARKER_TEXT =
  "[loop:interrupt] 上一条回复被用户中断，此处截断（完整内容与未完句已保留，未完成的思考/工具调用已丢弃）";

/** E-198：完整收尾但未执行的 toolCall 合成结果（I3 配对不变量——pi 判例①
 *  同族：孤儿 toolCall 必有对应 toolResult，合成也算）。 */
export const LOOP_INTERRUPTED_TOOL_RESULT_TEXT = "【已中断】该工具调用未执行（回复被用户中断）";

/** E-198 audit：完成但被策略丢弃的块（I6 审计面——丢弃内容日志必留，
 *  审计面与模型面分离：丢弃原因不入上下文，只入调用方日志）。 */
export interface LoopAbortDroppedBlock {
  readonly kind: "thinking" | "text" | "toolCall";
  readonly reason: string;
  readonly summary: string;
}

/** E-198 audit：aborted 轮善后摘要（LoopRunResult.aborted 携带——调用方
 *  日志面；无入账且无丢弃时缺席 = 形状零漂移）。 */
export interface LoopAbortAudit {
  /** 入账消息数（安全块；截断标记在外）。 */
  readonly keptMessages: number;
  /** 完成但不可回传被丢弃的块清单。 */
  readonly droppedBlocks: readonly LoopAbortDroppedBlock[];
}

/** LLM 单步响应判别（与 StewardLlmResponse 同构 + aborted 判别——
 *  duplex-truncation §6.3：aborted 不再混在 throw 里；G1（§3.3 text 行定稿）：
 *  aborted 可选携 partialText = 未关账 text 块累积增量（text_start 开档 /
 *  delta 累积 / text_end 关档清档——不得含已 onBlockEnd 关账的完成块，
 *  防重复入账；缺席/空 = 无半截 text，行为与 G1 前一致）。 */
export type LoopStreamResult =
  | { readonly kind: "text"; readonly text: string; readonly thinking?: LoopThinking }
  | {
      readonly kind: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
      readonly thinking?: LoopThinking;
    }
  | { readonly kind: "aborted"; readonly partialText?: string };

/**
 * StreamFn duck-type 结构契约（loop 域零 pi import 的核心承载）：
 * 单步 LLM 流式补全——请求消息窗口 + 工具面 → 流式回调 + 终态判别。
 *
 * pi-ai 满足形状的路径：driven adapter 内以 Models.streamSimple 为主体实现
 * （abort 经 signal 透传——pi-ai error 事件 reason=aborted 收口为本契约的
 * { kind: "aborted", partialText? }，partialText = 未关账 text 块增量（G1），
 * partial 保留语义见 duplex-truncation §2.1/§3.3）。
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

/** L1 件一：压缩能力契约（LoopEngineDeps.compaction 注入面）——
 *  domain 零 LLM 依赖：摘要执行体由调用方注入（管家 = StewardLlmPort
 *  单轮无工具形态），domain 只做阈值判定/边界规划/配对保护（LoopCompaction
 *  纯函数）。失败语义：summarize 抛错/空摘要 = 压缩失败，保留原窗口继续
 *  （调用方粗裁剪兑底）——压缩是优化不是依赖，永不阻塞对话。 */
export interface LoopCompactionOptions {
  /** 触发阈值（token 估算——estimateLoopTokens 同族口径）。 */
  readonly thresholdTokens: number;
  /** 保留尾部滚动窗条数（TR-47：压的是历史不是工作集）。 */
  readonly keepRecent: number;
  /** 压缩区间 → 摘要文本（异步 LLM 单轮）。 */
  readonly summarize: (messages: readonly LoopMessage[]) => Promise<string>;
}

/** 压缩完成回调信息（调用方事实源同步面——管家工作记忆 KV 整窗替换）。 */
export interface LoopCompactionInfo {
  /** 摘要合成消息（compaction: true——入事实源的形态）。 */
  readonly summaryMessage: LoopMessage & { role: "user"; compaction: true };
  /** 保留区消息（滚动窗原文）。 */
  readonly keptMessages: readonly LoopMessage[];
  /** 被压缩抆的历史消息条数。 */
  readonly droppedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

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
  /** L1 件一：压缩完成回调（事实源整窗替换——摘要入账 + 尾部保留）。 */
  readonly onCompacted?: (info: LoopCompactionInfo) => Promise<void>;
  /** 过程可见回调（屏幕通道等价面）。 */
  readonly callbacks?: LoopRunCallbacks;
  /** run 首条 prompt 摘要（run.started 事件检索面）。 */
  readonly promptSummary?: string;
}

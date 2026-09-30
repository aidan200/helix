/**
 * contracts/stream —— loop 域 LLM 流式契约（helix-loop Phase 0a 四层拆分；
 * 原 LoopTypes.ts 按主题拆六件之一，设计 §2.1）。
 *
 * StreamFn duck-type 结构契约（loop 域零 pi import 的核心承载）：
 * pi-ai 满足形状的路径：driven adapter 内以 Models.streamSimple 为主体实现
 * （abort 经 signal 透传——pi-ai error 事件 reason=aborted 收口为本契约的
 * { kind: "aborted", partialText? }）。依赖纪律：本层零 pi import；真体唯一
 * 合法落点 adapters/driven/loop。
 */
import type { LoopMessage, LoopThinking } from "./message";
import type { LoopToolSchema } from "./tool";

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

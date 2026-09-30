/**
 * contracts/stream —— loop 域 LLM 流式契约（helix-loop Phase 0a 四层拆分；
 * Phase 1 块模型演进：LoopStreamResult 从「text/toolCall 双判别」改为
 * blocks 判别（终态 = 完整块集 + 模型停因；设计 §3.2——批语义下 streamFn
 * 一次产全块集，kernel 自块集判别 turn 走向，toolCall 不再是顶层判别）。
 *
 * StreamFn duck-type 结构契约（loop 域零 pi import 的核心承载）：
 * pi-ai 满足形状的路径：driven adapter 内以 Models.streamSimple 为主体实现
 * （abort 经 signal 透传——pi-ai error 事件 reason=aborted 收口为本契约的
 * { kind: "aborted", partialText? }）。依赖纪律：本层零 pi import；真体唯一
 * 合法落点 adapters/driven/loop。
 */
import type { LoopContentBlock, LoopMessage } from "./message";
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
  /** 块级完整收尾帧（text/thinking/toolCall 块 *_end，载荷 = LoopContentBlock
   *  ——块模型下与 assistant content 块同一形状，块序即流序）——E-198 打断
   *  善后的收集面：块 end 是完整性唯一凭证（I1），已收 end 的块安全入账；
   *  未收 end 的半截块中 text 经 aborted 判别 partialText 入账（G1），
   *  thinking/toolCall 无帧丢弃（I2）。image 块 Phase 1 无帧面（adapter
   *  不产——处理逻辑后续 Phase）。 */
  readonly onBlockEnd?: (block: LoopContentBlock) => void;
}

/** 流停因（pi AssistantMessage.stopReason 的动作相关子集透传：stop = 终答、
 *  toolUse = 有工具调用、length = 截断；error/aborted 由契约收口为 throw /
 *  aborted 判别不进本枚举）。kernel 的 turn 走向判据是块集（toolCall 块在
 *  即工具轮），stopReason 是模型侧意图声明（事件/审计面）。 */
export type LoopStreamStopReason = "stop" | "toolUse" | "length";

/** LLM 单步响应判别（与 StewardLlmResponse 同构 + aborted 判别——
 *  duplex-truncation §6.3：aborted 不再混在 throw 里；G1（§3.3 text 行定稿）：
 *  aborted 可选携 partialText = 未关账 text 块累积增量（text_start 开档 /
 *  delta 累积 / text_end 关档清档——不得含已 onBlockEnd 关账的完成块，
 *  防重复入账；缺席/空 = 无半截 text，行为与 G1 前一致）。
 *  blocks 判别（Phase 1 块模型）：终态完整块集——text-only 即单 text 块，
 *  单 toolCall 与多 toolCall 是同一形状的 1 和 N（Phase 3 批执行接手）。 */
export type LoopStreamResult =
  | {
      readonly kind: "blocks";
      readonly blocks: readonly LoopContentBlock[];
      readonly stopReason: LoopStreamStopReason;
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

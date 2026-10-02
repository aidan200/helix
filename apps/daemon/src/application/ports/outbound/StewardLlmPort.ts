/** 出站端口（outbound，V2.5 文本管家批；流式回调面 = V2.5 体验批；
 * thinking 面 = A1 工作记忆批；块模型 = helix-loop Phase 1）。
 *
 * StewardService（application 层）的 LLM 面抽象：单轮补全（消息 + 工具面 →
 * 完整块集或首个工具调用）。实现体 = adapters/driven/loop/PiStewardLlmAdapter
 * （pi-ai streamSimple + 模型目录解析 + auth.json key getter——复用 daemon
 * 现有 provider 体系，模型槽位独立配置，建议最强模型；helix-loop L0 批
 * 平移至 driven/loop/——管家面 pi-ai 唯一执行点）。
 *
 * 端口面收敛为「首个工具调用」单步语义（服务层驱动循环——工具轮上限在
 * service 单点，adapter 无循环）；消息形状为 port 自有窄面（pi-ai 类型不越
 * 墙进 application 层，AG-01/AG-13 同构纪律）。
 *
 * 流式面（V2.5 体验批 additive）：complete 可选 onDelta 回调——文本生成段
 * 逐 chunk 调用（仅 text 增量；工具调用段静默不回调）；终态响应仍由返回值
 * 权威承载（onDelta 只作显示增量，不参与响应聚合）。
 *
 * 块模型（helix-loop Phase 1，与 domain LoopMessage/LoopStreamResult 结构
 * 同构——原 PiLoopStreamAdapter 编译锚随主会话 loop 通道退役删，同构
 * 断言历史可考）：
 * - assistant 消息 content = 块数组（text/thinking/toolCall/image 混排，
 *   块序即流序——单 toolCall 与多 toolCall 是同一形状的 1 和 N，Phase 3
 *   批执行接手）；thinking 块 signature = provider 不透明回传凭据
 *   （Anthropic 式最严约束：多轮 thinking 块须携签名回传；provider 差异由
 *   pi-ai convertMessages 收口）；
 * - complete 返回值 blocks 判别 = 终态完整块集 + 模型停因（stopReason）；
 * - complete 第三参 onThinking = 段级回调（一个完成态 thinking 块一帧——
 *   探明定案：折叠显示用段级粒度，token 级 delta 高频帧无增益）；
 * - complete 第五参 onBlockEnd = 块级完整收尾回调（E-198 打断善后：pi
 *   text_end/thinking_end/toolcall_end 的块帧——块 end 是完整性唯一凭证，
 *   abort 时已收 end 的块可安全入账，半截块无此帧）。
 */

/** 工具声明（LLM function calling 面；parameters = JSON Schema 对象）。 */
export interface StewardLlmTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** assistant 内容块（Phase 1 块模型——与 domain LoopContentBlock 结构同构，
 *  编译锚锁定；块判别 type，字段名 port 词典 text/signature/args）。 */
export type StewardLlmContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string; readonly signature?: string }
  | { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** E-198：流块完整收尾帧（块 end = 完整性唯一凭证，与 domain content 块
 *  同一形状——adapter 编译锚锁定；image 块 Phase 1 无帧面）。 */
export type StewardLlmBlock = StewardLlmContentBlock;

/** 对话消息（port 窄面：user / assistant（content 块数组）/ 工具结果；与
 *  domain LoopMessage 结构同构——协议 StewardHistoryRecord 的投影翻译在
 *  StewardService 单点）。 */
export type StewardLlmMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      /** 内容块数组（Phase 1 块模型——块序即流序，混排零拆分）。 */
      readonly content: readonly StewardLlmContentBlock[];
    }
  | { readonly role: "toolResult"; readonly toolCallId: string; readonly name: string; readonly text: string };

/** 单轮补全请求。 */
export interface StewardLlmRequest {
  /** 系统提示词（管家三分法骨架，设计 §2）。 */
  readonly systemPrompt: string;
  /** 对话消息（完整工作记忆窗口——thinking/工具全精度，服务层维护）。 */
  readonly messages: readonly StewardLlmMessage[];
  /** 工具面（只读查询 + propose_send 唯一写注入提案原语）。 */
  readonly tools: readonly StewardLlmTool[];
}

/** 模型停因（pi stopReason 动作相关子集：stop = 终答、toolUse = 有工具调用、
 *  length = 截断——服务层行为判据是块集，stopReason 是模型侧意图声明）。 */
export type StewardLlmStopReason = "stop" | "toolUse" | "length";

/** 单轮补全响应（Phase 1 块模型）：blocks = 终态完整块集（text-only 即单
 *  text 块）；aborted = signal 取代收口（helix-loop L0 批——duplex-truncation
 *  §6.3：aborted 不再混在 throw 里，调用方按门控语义分流；G1（§3.3 text 行
 *  定稿）：可选携 partialText = 未关账 text 块累积增量——不得含已经
 *  onBlockEnd 关账的完成块，防重复入账；缺席/空 = 无半截 text）。 */
export type StewardLlmResponse =
  | {
      readonly kind: "blocks";
      readonly blocks: readonly StewardLlmContentBlock[];
      readonly stopReason: StewardLlmStopReason;
    }
  | { readonly kind: "aborted"; readonly partialText?: string };

export interface StewardLlmPort {
  /** 模型槽位现值（"provider/model-id"；设置页显示/诊断面）。 */
  readonly modelId: string;
  /** 单轮补全（fail-fast：key 缺失/模型未配/网络错误抛中文错误）；
   * 可选 onDelta = 文本生成段增量回调（仅 text chunk，工具段静默；终态以
   * 返回值为权威——onDelta 只作显示增量，V2.5 体验批）；
   * 可选 onThinking = thinking 段级回调（一个完成态块一帧，全量文本——
   * A1 工作记忆批；不参与响应聚合，终态 thinking 以返回值为权威）。 */
  complete(
    request: StewardLlmRequest,
    onDelta?: (chunk: string) => void,
    onThinking?: (block: string) => void,
    signal?: AbortSignal,
    onBlockEnd?: (block: StewardLlmBlock) => void,
  ): Promise<StewardLlmResponse>;
}

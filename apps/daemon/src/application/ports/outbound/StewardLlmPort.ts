/** 出站端口（outbound，V2.5 文本管家批；流式回调面 = V2.5 体验批）。
 *
 * StewardService（application 层）的 LLM 面抽象：单轮补全（消息 + 工具面 →
 * 文本或首个工具调用）。实现体 = adapters/driven/steward/PiStewardLlmAdapter
 * （pi-ai streamSimple + 模型目录解析 + auth.json key getter——复用 daemon
 * 现有 provider 体系，模型槽位独立配置，flash 级建议）。
 *
 * 端口面收敛为「首个工具调用」单步语义（服务层驱动循环——工具轮上限在
 * service 单点，adapter 无循环）；消息形状为 port 自有窄面（pi-ai 类型不越
 * 墙进 application 层，AG-01/AG-13 同构纪律）。
 *
 * 流式面（V2.5 体验批 additive）：complete 可选 onDelta 回调——文本生成段
 * 逐 chunk 调用（仅 text 增量；工具调用段静默不回调）；终态响应仍由返回值
 * 权威承载（onDelta 只作显示增量，不参与响应聚合）。消息形状与工具面不动。
 */

/** 工具声明（LLM function calling 面；parameters = JSON Schema 对象）。 */
export interface StewardLlmTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** 对话消息（port 窄面：user / assistant（文本或工具调用）/ 工具结果）。 */
export type StewardLlmMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      /** 回答文本（可缺席——纯工具调用轮）。 */
      readonly text?: string;
      /** 本轮工具调用（可缺席——纯文本轮）。 */
      readonly toolCall?: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> };
    }
  | { readonly role: "toolResult"; readonly toolCallId: string; readonly name: string; readonly text: string };

/** 单轮补全请求。 */
export interface StewardLlmRequest {
  /** 系统提示词（管家三分法骨架，设计 §2）。 */
  readonly systemPrompt: string;
  /** 对话消息（会话内滚动窗口，服务层维护）。 */
  readonly messages: readonly StewardLlmMessage[];
  /** 工具面（只读查询 + propose_send 唯一写注入提案原语）。 */
  readonly tools: readonly StewardLlmTool[];
}

/** 单轮补全响应：文本直答 / 首个工具调用（服务层裁决执行或过闸）。 */
export type StewardLlmResponse =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
    };

export interface StewardLlmPort {
  /** 模型槽位现值（"provider/model-id"；设置页显示/诊断面）。 */
  readonly modelId: string;
  /** 单轮补全（fail-fast：key 缺失/模型未配/网络错误抛中文错误）；可选
   *  onDelta = 文本生成段增量回调（仅 text chunk，工具段静默；终态以返回值
   *  为权威——onDelta 只作显示增量，V2.5 体验批）。 */
  complete(request: StewardLlmRequest, onDelta?: (chunk: string) => void): Promise<StewardLlmResponse>;
}

/**
 * PiStewardLlmAdapter —— StewardLlmPort 的 pi-ai 实现（driven；V2.5 文本管家批；
 * thinking 面 = A1 工作记忆批）。
 *
 * 复用 daemon 现有 provider 体系（AD-11/AD-13 纪律，model-provider.ts 先例）：
 * - 模型解析：槽位字符串（RuntimeConfig steward.model）→ resolveModel
 *   （"provider/model-id" 目录解析，未设置 = 组合根注入的默认）；
 * - key：组合根 getter（auth.json provider 位，与主引擎同一键位——显式传入
 *   不走环境变量；缺 key fail-fast 中文错误指向设置页录入路径）；
 * - 补全面：models.streamSimple（单轮 AssistantMessage 聚合）→ 首个 toolCall
 *   或文本直答（port 单步语义，循环归 StewardService）。
 *
 * thinking 开启（A1 批：管家「全场最智能 agent」定位——thinking 默认开启，
 * 不暴露开关）：
 * - streamSimple options.reasoning = STEWARD_THINKING_LEVEL（"high"）；
 * - 能力判据 model.reasoning === true（不支持思考的模型不带参——provider
 *   默认，AD-3 同构；supportsThinkingLevel 语义面但档位 map 缺省键 = 支持）；
 * - 流式：thinking_delta 聚积 → thinking_end 时 onThinking(整块文本) 段级
 *   回调（与 text_delta 透传同一 for-await——pi-ai EventStream 队列单消费者）；
 * - 回传：终态 ThinkingContent 块 → 响应 thinking { text, signature }；历史
 *   轮 assistant.thinking → Context ThinkingContent 块（signature 透传——
 *   Anthropic 式最严约束；provider 差异由 pi-ai convertMessages 收口）。
 *
 * 本文件是 pi-ai import 的合法执行点之一（architecture.md §8.3 红线；
 * application 层只见 StewardLlmPort 窄面——pi-ai 类型不越墙）。
 */
import type { AssistantMessage, Models, Model, Context, Message, Tool, ThinkingLevel } from "@earendil-works/pi-ai";
import { resolveModel } from "../pi-engine/model-provider";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
  StewardLlmThinking,
} from "../../../application/ports/outbound/StewardLlmPort";

/** 管家默认模型槽位（建议最强模型——A1 批定位改写；deepseek 键位目录内
 *  常驻模型；用户可经 steward.set_config 换任意目录内模型）。 */
export const STEWARD_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/** 管家 thinking 档位（A1 批：默认开启不暴露开关——管家定位最强模型配
 *  强推理；能力判据不过（model.reasoning ≠ true）时不带参走 provider 默认）。 */
export const STEWARD_THINKING_LEVEL: ThinkingLevel = "high";

export interface PiStewardLlmDeps {
  /** pi-ai 静态+用户目录（组合根 buildModels 产物）。 */
  readonly models: Models;
  /** 模型槽位现值 getter（RuntimeConfig steward.model；undefined = 默认槽位）。 */
  readonly modelSlot: () => string | undefined;
  /** 默认槽位（组合根注入，如 "deepseek/deepseek-v4-flash"）。 */
  readonly defaultModel: string;
  /** provider key getter（组合根注入 authStore.apiKeyOf——每次调用重读）。 */
  readonly getApiKey: (provider: string) => string | undefined;
}

export class PiStewardLlmAdapter implements StewardLlmPort {
  private readonly deps: PiStewardLlmDeps;

  constructor(deps: PiStewardLlmDeps) {
    this.deps = deps;
  }

  get modelId(): string {
    return this.deps.modelSlot() ?? this.deps.defaultModel;
  }

  async complete(
    request: StewardLlmRequest,
    onDelta?: (chunk: string) => void,
    onThinking?: (block: string) => void,
  ): Promise<StewardLlmResponse> {
    const modelStr = this.modelId;
    let model: Model<any>;
    try {
      model = resolveModel(this.deps.models, modelStr);
    } catch (err) {
      throw new Error(`管家模型解析失败：${(err as Error).message}`);
    }
    const apiKey = this.deps.getApiKey(model.provider);
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        `auth.json 中没有 provider "${model.provider}" 的 API key（请经设置页 auth.set_key 录入；管家模型 = ${modelStr}）`,
      );
    }
    const context = this.toContext(request, model);
    // thinking 开启（A1 批）：reasoning 档位仅在模型声明思考能力时携带
    //（不支持思考的模型带参 = provider 拒答风险；AD-3 provider 默认纪律）
    const stream = this.deps.models.streamSimple(model, context, {
      apiKey,
      ...(model.reasoning === true ? { reasoning: STEWARD_THINKING_LEVEL } : {}),
    });
    if (onDelta === undefined && onThinking === undefined) {
      const assistant = await stream.result();
      return this.toResponse(assistant);
    }
    // 流式透传（V2.5 体验批 + A1 thinking 段级）：pi-ai EventStream 队列单
    // 消费者——本 for-await 是唯一迭代器，result() 只等 final promise（不
    // 消费队列），两者并存安全；仅透传 text_delta（工具段静默）与段级
    // thinking_end（整块文本——thinking_delta 聚积后块末一次性回调，折叠
    // 显示用段级粒度）；回调异常不阻断流。await 迭代完成后再返回：保证
    // 全部回调先于 complete resolve（否则终态帧可早于末尾回调下发，前端
    // 清缓冲后迟到增量残留）。
    const consume = (async () => {
      let thinkingBuf = "";
      for await (const ev of stream) {
        if (ev.type === "text_delta") {
          try {
            onDelta?.(ev.delta);
          } catch {
            /* 消费者异常不阻断流 */
          }
          continue;
        }
        if (ev.type === "thinking_delta") {
          thinkingBuf += ev.delta;
          continue;
        }
        if (ev.type === "thinking_end") {
          // 块终态内容为权威（ev.content；redacted 块可能空 delta 直达 end）
          const block = ev.content !== "" ? ev.content : thinkingBuf;
          thinkingBuf = "";
          if (block !== "") {
            try {
              onThinking?.(block);
            } catch {
              /* 消费者异常不阻断流 */
            }
          }
        }
      }
    })().catch(() => {
      /* 迭代异常由 result() 主路径收口（stopReason=error → throw） */
    });
    const [assistant] = await Promise.all([stream.result(), consume]);
    return this.toResponse(assistant);
  }

  /** 终态消息 → port 响应判别（text 直答 / 首个 toolCall；thinking 块随
   *  终态携出——signature 透传；错误统一 throw）。 */
  private toResponse(assistant: AssistantMessage): StewardLlmResponse {
    if (assistant.stopReason === "error") {
      throw new Error(assistant.errorMessage ?? "管家模型返回错误（无错误详情）");
    }
    const thinking = this.collectThinking(assistant);
    const toolCall = assistant.content.find((c) => c.type === "toolCall");
    if (toolCall !== undefined && toolCall.type === "toolCall") {
      return { kind: "toolCall", id: toolCall.id, name: toolCall.name, args: toolCall.arguments, thinking };
    }
    const text = assistant.content
      .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    return { kind: "text", text, thinking };
  }

  /** 终态 ThinkingContent 块聚合（多块拼接文本、签名取首块——回传凭据面）。 */
  private collectThinking(assistant: AssistantMessage): StewardLlmThinking | undefined {
    const blocks = assistant.content.filter(
      (c): c is Extract<typeof c, { type: "thinking" }> => c.type === "thinking",
    );
    if (blocks.length === 0) return undefined;
    const text = blocks.map((b) => b.thinking).join("\n");
    if (text === "") return undefined;
    const signature = blocks.find((b) => typeof b.thinkingSignature === "string" && b.thinkingSignature !== "")?.thinkingSignature;
    return signature === undefined ? { text } : { text, signature };
  }

  /** port 窄面消息 → pi-ai Context（assistant 历史轮重建占位元数据——只回灌
   *  载荷面（thinking/文本/工具调用/结果），usage 等记账位为回放占位，不参与
   *  请求体；thinking 块置首——Anthropic 语义面 thinking 先于 text/toolCall）。 */
  private toContext(request: StewardLlmRequest, model: Model<any>): Context {
    const timestamp = Date.now();
    const messages: Message[] = [];
    for (const m of request.messages) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.text, timestamp });
        continue;
      }
      if (m.role === "assistant") {
        const content: Message extends never ? never : Extract<Message, { role: "assistant" }>["content"] = [];
        if (m.thinking !== undefined && m.thinking.text !== "") {
          content.push({
            type: "thinking",
            thinking: m.thinking.text,
            ...(m.thinking.signature !== undefined ? { thinkingSignature: m.thinking.signature } : {}),
          });
        }
        if (m.text !== undefined && m.text !== "") content.push({ type: "text", text: m.text });
        if (m.toolCall !== undefined) {
          content.push({ type: "toolCall", id: m.toolCall.id, name: m.toolCall.name, arguments: m.toolCall.args });
        }
        messages.push({
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: m.toolCall !== undefined ? "toolUse" : "stop",
          timestamp,
        });
        continue;
      }
      messages.push({
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.name,
        content: [{ type: "text", text: m.text }],
        isError: false,
        timestamp,
      });
    }
    const tools: Tool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Tool["parameters"],
    }));
    return { systemPrompt: request.systemPrompt, messages, tools };
  }
}

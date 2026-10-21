/**
 * PiStewardLlmAdapter —— StewardLlmPort 的 pi-ai 实现（driven；V2.5 文本管家批；
 * thinking 面 = A1 工作记忆批；helix-loop L0 批平移至 adapters/driven/loop/
 * 并改造：signal 透传 + aborted 判别——本文件成为管家面 pi-ai 的执行点
 * （设计 §2：adapters/driven/loop/ ← pi-ai 唯一 import 执行点）。Phase 1 块
 * 模型：pi AssistantMessage.content 块数组 → port blocks 判别直映射（pi 本
 * 就是块流——终态块集直转，旧「三字段拆装」翻译消失）。
 *
 * 复用 daemon 现有 provider 体系（AD-11/AD-13 纪律，model-provider.ts 先例）：
 * - 模型解析：槽位字符串（RuntimeConfig steward.model）→ resolveModel
 *   （"provider/model-id" 目录解析，未设置 = 组合根注入的默认）；
 * - key：组合根 getter（auth.json provider 位，与主引擎同一键位——显式传入
 *   不走环境变量；缺 key fail-fast 中文错误指向设置页录入路径）；
 * - 补全面：models.streamSimple（单轮 AssistantMessage 聚合）→ 终态完整
 *   块集（port blocks 判别，循环归 StewardService）；G1（duplex-truncation
 *   §3.3 text 行定稿）：abort 时未关账 text 块增量随 aborted 判别
 *   partialText 携出（text_start 开档 / delta 累积 / text_end 关档清档——
 *   已关账块经 onBlockEnd 交付不进 partialText，防重复入账）。
 *
 * thinking 开启（A1 批：管家「全场最智能 agent」定位——thinking 默认开启，
 * 不暴露开关）：
 * - streamSimple options.reasoning = STEWARD_THINKING_LEVEL（"high"）；
 * - 能力判据 model.reasoning === true（不支持思考的模型不带参——provider
 *   默认，AD-3 同构；supportsThinkingLevel 语义面但档位 map 缺省键 = 支持）；
 * - 流式：thinking_delta 聚积 → thinking_end 时 onThinking(整块文本) 段级
 *   回调（与 text_delta 透传同一 for-await——pi-ai EventStream 队列单消费者）；
 * - 回传：历史轮 assistant content 内 thinking 块直接映射 ThinkingContent
 *   （signature 透传——Anthropic 式最严约束；provider 差异由 pi-ai
 *   convertMessages 收口）。
 *
 * 本文件是 pi-ai import 的合法执行点之一（architecture.md §8.3 红线；
 * application 层只见 StewardLlmPort 窄面——pi-ai 类型不越墙）。
 */
import type { AssistantMessage, Models, Model, Context, JsonObject, Message, Tool, ThinkingLevel } from "@earendil-works/pi-ai";
import { resolveModel } from "../llm";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
  StewardLlmBlock,
  StewardLlmContentBlock,
} from "../../../application/ports/outbound/StewardLlmPort";

/** 管家默认模型槽位（建议最强模型——A1 批定位改写；deepseek 键位目录内
 *  常驻模型；用户可经 steward.set_config 换任意目录内模型）。 */
export const STEWARD_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/** 管家 thinking 档位（A1 批：默认开启不暴露开关——管家定位最强模型配
 *  强推理；能力判据不过（model.reasoning ≠ true）时不带参走 provider 默认）。 */
export const STEWARD_THINKING_LEVEL: ThinkingLevel = "high";

/** E-198：块级收尾帧安全发射（消费者异常不阻断流——与 onDelta/onThinking
 *  同口径）。 */
function emitBlockEndSafe(onBlockEnd: ((block: StewardLlmBlock) => void) | undefined, block: StewardLlmBlock): void {
  if (onBlockEnd === undefined) return;
  try {
    onBlockEnd(block);
  } catch {
    /* 消费者异常不阻断流 */
  }
}

/** E-198：thinking_end 时点的签名提取（pi 事件不直接携带签名——终态凭据
 *  在 partial.content[contentIndex].thinkingSignature；未到/无签名 = undefined
 *  → 块帧不带 signature（引擎侧按无签名不可回传丢弃，pi 判例③）；
 *  partial 缺席（伪造流/防御）= undefined）。 */
function thinkingSignatureAt(partial: AssistantMessage | null, contentIndex: number): string | undefined {
  if (partial === null || partial === undefined) return undefined;
  const block = partial.content[contentIndex];
  if (block === undefined || block === null || block.type !== "thinking") return undefined;
  const signature = block.thinkingSignature;
  return typeof signature === "string" && signature !== "" ? signature : undefined;
}

export interface PiStewardLlmDeps {
  /** pi-ai 静态+用户目录（组合根 buildModels 产物）。 */
  readonly models: Models;
  /** 模型槽位现值 getter（RuntimeConfig steward.model；undefined = 默认槽位）。 */
  readonly modelSlot: () => string | undefined;
  /** 默认槽位（组合根注入，如 "deepseek/deepseek-v4-flash"）。 */
  readonly defaultModel: string;
  /** provider key getter（组合根注入 authStore.apiKeyOf——每次调用重读）。 */
  readonly getApiKey: (provider: string) => string | undefined;
  /** 凭据类型读面（OAuth 分流：oauth 凭据存在 → 不覆盖 apiKey，交 pi-ai store 解析）。 */
  readonly getCredentialType?: (provider: string) => "api_key" | "oauth" | undefined;
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
    signal?: AbortSignal,
    onBlockEnd?: (block: StewardLlmBlock) => void,
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
      // OAuth 分流（订阅登录批）：oauth 凭据存在 → 不覆盖 apiKey，交 pi-ai
      // 注入 store 解析（锁内自动 refresh）；两无仍 fail-fast
      if (this.deps.getCredentialType?.(model.provider) !== "oauth") {
        throw new Error(
          `auth.json 中没有 provider "${model.provider}" 的凭据（请经设置页 auth.set_key 录入 key 或订阅登录；管家模型 = ${modelStr}）`,
        );
      }
    }
    const context = this.toContext(request, model);
    // thinking 开启（A1 批）：reasoning 档位仅在模型声明思考能力时携带
    //（不支持思考的模型带参 = provider 拒答风险；AD-3 provider 默认纪律）
    const stream = this.deps.models.streamSimple(model, context, {
      ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
      ...(model.reasoning === true ? { reasoning: STEWARD_THINKING_LEVEL } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (onDelta === undefined && onThinking === undefined && onBlockEnd === undefined) {
      const assistant = await stream.result();
      return this.toResponse(assistant);
    }
    // 流式透传（V2.5 体验批 + A1 thinking 段级 + E-198 块级收尾）：pi-ai
    // EventStream 队列单消费者——本 for-await 是唯一迭代器，result() 只等
    // final promise（不消费队列），两者并存安全；透传 text_delta（工具段静
    // 默）、段级 thinking_end（整块文本）与块级 *_end 收尾帧（E-198：abort
    // 前 已收 end 的块经此帧入 engine 缓冲——半截块无帧天然丢弃；回调异常
    // 不阻断流）；await 迭代完成后再返回：保证全部回调先于 complete resolve
    // （否则终态帧可早于末尾回调下发，前端清缓冲后迟到增量残留）。
    const consume = (async () => {
      let thinkingBuf = "";
      // G1（duplex-truncation §3.3 text 行）：未关账 text 块累积档（text_start
      // 开档 / delta 累积 / text_end 关档清档）——终态时作为 aborted 判别的
      // partialText 携出；已关账块经 onBlockEnd 交付，不进此档（防重复入账）。
      let openText: string | undefined;
      for await (const ev of stream) {
        if (ev.type === "text_start") {
          openText = "";
          continue;
        }
        if (ev.type === "text_delta") {
          // 防御：无 text_start 的 delta 隐式开档（provider 帧型差异兑底）
          openText = (openText ?? "") + ev.delta;
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
          const sig = thinkingSignatureAt(ev.partial, ev.contentIndex);
          if (block !== "") {
            try {
              onThinking?.(block);
            } catch {
              /* 消费者异常不阻断流 */
            }
          }
          emitBlockEndSafe(onBlockEnd, {
            type: "thinking",
            text: block,
            ...(sig !== undefined ? { signature: sig } : {}),
          });
          continue;
        }
        if (ev.type === "text_end") {
          // 关档清档——完成块经 onBlockEnd 关账入账（verbatim），不进 partialText
          openText = undefined;
          emitBlockEndSafe(onBlockEnd, { type: "text", text: ev.content });
          continue;
        }
        if (ev.type === "toolcall_end") {
          emitBlockEndSafe(onBlockEnd, {
            type: "toolCall",
            id: ev.toolCall.id,
            name: ev.toolCall.name,
            args: ev.toolCall.arguments as Record<string, unknown>,
          });
        }
      }
      return openText;
    })().catch(() => undefined);
    // 迭代异常由 result() 主路径收口（stopReason=error → throw）；consume 失败
    // 仅损失 partialText（防御降级，不阻断终态判别）。
    const [assistant, openText] = await Promise.all([stream.result(), consume]);
    return this.toResponse(assistant, openText);
  }

  /** 终态消息 → port 响应判别（Phase 1 块模型：pi content 块数组直转 blocks
   *  判别——thinking→thinking 块（signature 透传）、text→text 块、toolCall→
   *  toolCall 块（arguments→args），块序原样；stopReason 透传动作相关子集，
   *  非枚举值（pending 等防御）归 stop；错误统一 throw；aborted 判别收口——
   *  helix-loop L0：signal abort 后 resolve { kind: "aborted" } 而非 throw
   *  （duplex-truncation §6.3 port 面扩展）；G1（§3.3 text 行定稿）：aborted
   *  携 partialText = 未关账 text 块增量（openText——模型须记得被掐断的已播
   *  半句，P2）；空/缺席 = 无半截 text（行为不变）。 */
  private toResponse(assistant: AssistantMessage, openText?: string): StewardLlmResponse {
    if (assistant.stopReason === "aborted") {
      return { kind: "aborted", ...(openText !== undefined && openText !== "" ? { partialText: openText } : {}) };
    }
    if (assistant.stopReason === "error") {
      throw new Error(assistant.errorMessage ?? "管家模型返回错误（无错误详情）");
    }
    const blocks: StewardLlmContentBlock[] = [];
    for (const c of assistant.content) {
      if (c.type === "text") {
        blocks.push({ type: "text", text: c.text });
      } else if (c.type === "thinking") {
        blocks.push({
          type: "thinking",
          text: c.thinking,
          ...(typeof c.thinkingSignature === "string" && c.thinkingSignature !== ""
            ? { signature: c.thinkingSignature }
            : {}),
        });
      } else {
        blocks.push({ type: "toolCall", id: c.id, name: c.name, args: c.arguments as Record<string, unknown> });
      }
    }
    const stopReason =
      assistant.stopReason === "toolUse" || assistant.stopReason === "length" ? assistant.stopReason : "stop";
    return { kind: "blocks", blocks, stopReason };
  }

  /** port 窄面消息 → pi-ai Context（Phase 1 块模型：assistant content 块数组
   *  直映射——pi 本就是块流，旧「三字段拆装」翻译消失；块序即流序（Anthropic
   *  语义面 provider 侧收口）；历史轮重建占位元数据——只回灌载荷面
   *  （thinking/文本/工具调用/结果），usage 等记账位为回放占位，不参与请求体）。 */
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
        let hasToolCall = false;
        for (const b of m.content) {
          if (b.type === "text" && b.text !== "") {
            content.push({ type: "text", text: b.text });
          } else if (b.type === "thinking" && b.text !== "") {
            content.push({
              type: "thinking",
              thinking: b.text,
              ...(b.signature !== undefined ? { thinkingSignature: b.signature } : {}),
            });
          } else if (b.type === "toolCall") {
            hasToolCall = true;
            // port args 源头是 pi JsonObject（toResponse 透传 toolCall.arguments），
            // 闭环内 JSON 保证——断言收窄回 0.87 收紧的 ToolCall.arguments 形态。
            content.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.args as JsonObject });
          }
          // image 块 Phase 1 无回传面（pi AssistantMessage.content 不含 image；
          // 图片上行接线是后续 Phase）——防御性忽略
        }
        messages.push({
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: hasToolCall ? "toolUse" : "stop",
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

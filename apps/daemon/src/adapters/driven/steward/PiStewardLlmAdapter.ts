/**
 * PiStewardLlmAdapter —— StewardLlmPort 的 pi-ai 实现（driven；V2.5 文本管家批）。
 *
 * 复用 daemon 现有 provider 体系（AD-11/AD-13 纪律，model-provider.ts 先例）：
 * - 模型解析：槽位字符串（RuntimeConfig steward.model）→ resolveModel
 *   （"provider/model-id" 目录解析，未设置 = 组合根注入的 flash 级默认）；
 * - key：组合根 getter（auth.json provider 位，与主引擎同一键位——显式传入
 *   不走环境变量；缺 key fail-fast 中文错误指向设置页录入路径）；
 * - 补全面：models.streamSimple（单轮 AssistantMessage 聚合）→ 首个 toolCall
 *   或文本直答（port 单步语义，循环归 StewardService）。
 *
 * 本文件是 pi-ai import 的合法执行点之一（architecture.md §8.3 红线；
 * application 层只见 StewardLlmPort 窄面——pi-ai 类型不越墙）。
 */
import type { Models, Model, Context, Message, Tool } from "@earendil-works/pi-ai";
import { resolveModel } from "../pi-engine/model-provider";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../../application/ports/outbound/StewardLlmPort";

/** 管家默认模型槽位（flash 级；设计 §4.2「flash 级 LLM 常驻」——deepseek
 *  键位与目录内 flash 模型；用户可经 steward.set_config 换任意目录内模型）。 */
export const STEWARD_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export interface PiStewardLlmDeps {
  /** pi-ai 静态+用户目录（组合根 buildModels 产物）。 */
  readonly models: Models;
  /** 模型槽位现值 getter（RuntimeConfig steward.model；undefined = 默认槽位）。 */
  readonly modelSlot: () => string | undefined;
  /** 默认槽位（组合根注入 flash 级默认，如 "deepseek/deepseek-v4-flash"）。 */
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

  async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
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
    const assistant = await this.deps.models
      .streamSimple(model, context, { apiKey })
      .result();
    if (assistant.stopReason === "error") {
      throw new Error(assistant.errorMessage ?? "管家模型返回错误（无错误详情）");
    }
    const toolCall = assistant.content.find((c) => c.type === "toolCall");
    if (toolCall !== undefined && toolCall.type === "toolCall") {
      return { kind: "toolCall", id: toolCall.id, name: toolCall.name, args: toolCall.arguments };
    }
    const text = assistant.content
      .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    return { kind: "text", text };
  }

  /** port 窄面消息 → pi-ai Context（assistant 历史轮重建占位元数据——只回灌
   *  载荷面（文本/工具调用/结果），usage 等记账位为回放占位，不参与请求体）。 */
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

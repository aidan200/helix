/**
 * 管家测试接缝（段B翻转）：fake StewardLlmPort 剧本 → createEngine 工厂。
 *
 * 生产走标准 streamFn 配置链（container 经 buildStewardEngine 唯一配方）；
 * 测试剧本保持 port 脚本工效（最后一问派发/signal abort 语义），经本 helper
 * 合成 streamFnOverride 注入**同一配方**（buildStewardEngine）——同轨测试。
 */
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentEnginePort } from "../../../src/application/ports/outbound/AgentEnginePort";
import type { StewardEngineAssemblyOptions } from "../../../src/application/steward/StewardService";
import type { StewardLlmPort, StewardLlmResponse } from "../../../src/application/ports/outbound/StewardLlmPort";
import { buildStewardEngine } from "../../../src/adapters/driven/steward/StewardEngineBuilder";
import { piMessagesToSteward } from "../../../src/adapters/driven/steward/StewardLlmMessages";

export const fakeStewardModel = {
  id: "model",
  name: "Fake",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "x",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

export const fakeStewardModels = {
  getModel: () => fakeStewardModel,
  getModels: () => [fakeStewardModel],
  streamSimple: () => {
    throw new Error("不应走到真实流");
  },
} as unknown as Models;

/** port 剧本 → pi StreamFn（请求翻译 + 事件流合成——delta/aborted/error 三面）。 */
export function portScriptStreamFn(port: StewardLlmPort): StreamFn {
  return (model: Model<any>, context, options): ReturnType<typeof createAssistantMessageEventStream> => {
    const stream = createAssistantMessageEventStream();
    // abort 语义对齐真 provider：已中止信号 → 立即 aborted 流（剧本不再消费）
    if (options?.signal?.aborted) {
      const abortedMsg = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "aborted", timestamp: Date.now() } as never;
      void (async () => {
        stream.push({ type: "start", partial: abortedMsg });
        stream.push({ type: "error", reason: "aborted", error: abortedMsg });
      })();
      return stream;
    }
    const placeholder = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: Date.now(),
    } as never;
    let flushedText = "";
    const baseMsg = (): Record<string, unknown> => ({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
    });
    void (async () => {
      stream.push({ type: "start", partial: placeholder });
      try {
        const first = context.messages[0] as { role?: string; content?: unknown } | undefined;
        const sysText =
          first !== undefined && first.role === "system"
            ? typeof first.content === "string"
              ? first.content
              : Array.isArray(first.content)
                ? (first.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
                : ""
            : "";
        const res: StewardLlmResponse = await port.complete(
          {
            systemPrompt: sysText,
            messages: piMessagesToSteward(context.messages),
            tools: getCurrentTools(context.messages).map((t) => ({
              name: t.name,
              description: t.description,
              parameters: (t.parameters ?? {}) as Record<string, unknown>,
            })),
          },
          (delta) => stream.push({ type: "text_delta", contentIndex: 0, delta, partial: placeholder }),
          (thinking) => stream.push({ type: "thinking_delta", contentIndex: 1, delta: thinking, partial: placeholder }),
          options?.signal,
          (block) => {
            // 块级收尾帧 → text_delta 冲刷（port 剧本以完整块驱动——pi 累积
            // partial 由此获得文本；abort 时已冲刷块即 transcript 安全文本）
            if (block.type === "text") {
              flushedText += block.text;
              stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: placeholder });
            }
          },
        );
        if (res.kind === "aborted") {
          // aborted 终态消息携带半截文本（port partialText 优先，已冲刷块兜底）
          //——pi 以 result() 替换 transcript partial，不带则冲刷文本丢失
          const partial = res.partialText !== undefined && res.partialText !== "" ? res.partialText : flushedText;
          stream.push({
            type: "error",
            reason: "aborted",
            error: {
              ...baseMsg(),
              stopReason: "aborted",
              ...(partial !== "" ? { content: [{ type: "text", text: partial }] } : { content: [] }),
            } as never,
          });
          return;
        }
        const content = res.blocks.map((b) => {
          if (b.type === "text") return { type: "text" as const, text: b.text };
          if (b.type === "thinking") {
            return { type: "thinking" as const, thinking: b.text, ...(b.signature !== undefined ? { signature: b.signature } : {}) };
          }
          if (b.type === "toolCall") {
            return { type: "toolCall" as const, id: b.id, name: b.name, arguments: b.args as never };
          }
          return { type: "text" as const, text: "(image)" };
        });
        const message = { ...baseMsg(), content, stopReason: res.stopReason } as never;
        stream.push({ type: "done", reason: res.stopReason, message });
      } catch (error) {
        stream.push({
          type: "error",
          reason: "error",
          error: { ...baseMsg(), content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], stopReason: "error" } as never,
        });
      }
    })();
    return stream;
  };
}

/** fake port → createEngine dep（buildStewardEngine 同配方 + 剧本 streamFnOverride）。 */
export function createEngineFromPort(port: StewardLlmPort): (opts: StewardEngineAssemblyOptions) => AgentEnginePort {
  return (opts) =>
    buildStewardEngine({
      systemPrompt: opts.systemPrompt,
      model: fakeStewardModel,
      apiKeys: { fake: "key" },
      models: fakeStewardModels,
      tools: opts.tools,
      gatedTools: opts.gatedTools,
      persistentListener: opts.persistentListener,
      ...(opts.initialMessages.length > 0 ? { initialMessages: opts.initialMessages } : {}),
      ...(opts.compaction !== undefined
        ? {
            compaction: {
              enabled: true,
              reserveTokens: Math.max(1024, fakeStewardModel.contextWindow - opts.compaction.thresholdTokens),
              keepRecentTokens: opts.compaction.keepRecent * 512,
              ...(opts.compaction.summarizeInstructions !== undefined
                ? { customInstructions: opts.compaction.summarizeInstructions }
                : {}),
              trigger: "request" as const,
              summarize: async (_systemPrompt: string, messages: readonly import("../../../src/application/ports/outbound/StewardLlmPort").StewardLlmMessage[]) => {
                const response = await port.complete({
                  systemPrompt: "你是 helix 管家的上下文压缩器。把给定的历史对话压缩为一段摘要，供后续对话作为最早的上下文使用。",
                  messages,
                  tools: [],
                });
                if (response.kind !== "blocks") throw new Error(`压缩摘要响应非块集（${response.kind}）`);
                return response.blocks.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
              },
            },
          }
        : {}),
      streamFnOverride: portScriptStreamFn(port),
    });
}

/**
 * LoopEngineStream —— loop 通道生产 LoopStreamFn 桥（helix-loop Phase 5；
 * TR-224：pi-ai 栈 import 合法执行点——本目录与 PiStewardLlmAdapter 同位）。
 *
 * 主会话引擎通道（flag HELIX_AGENT_ENGINE=loop 显式开启）的 LLM 执行体：
 * pi-ai Models.streamSimple → LoopStreamFn duck-type 契约（块模型直映射——
 * pi 本就是块流）。装配复用 llm 中立层（TR-224 永存半边）：
 * - withNetworkRetry：传输层重试包装（P2 ⑦；onRetry → port engine_retrying
 *   事件——adapter 装配面注入）；
 * - wrapStreamFnThinking：thinking 注入器（解析链读面每次调用重读）；
 * - aborted 判别（E-198/G1）：signal abort → { kind:"aborted", partialText }
 *   ——未关账 text 块增量随判别携出（text_start 开档/delta 累积/text_end 清档）。
 *
 * 与 PiStewardLlmAdapter（管家面）的差异：引擎面模型由组合根 mutable 槽持有
 * （getter 每请求重读——setModel 下一请求生效，AD-2 同构），thinking 档经
 * 注入器注入而非固定档位。
 */
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  JsonObject,
  Message,
  Model,
  Models,
  SimpleStreamOptions,
  ThinkingLevel,
  Tool,
} from "@earendil-works/pi-ai";
import type { LoopContentBlock, LoopMessage, LoopStreamFn, LoopToolSchema } from "../../../domain/loop/contracts";
import { withNetworkRetry, wrapStreamFnThinking } from "../llm";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** 本文件局部流形状（Models.streamSimple 入参面——raw Context；agent-core
 *  StreamFn 的 TranscriptContext 品牌位经包装边界断言，运行时同构）。 */
type ContextStreamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface LoopEngineStreamDeps {
  /** pi-ai 目录（静态+用户）。 */
  readonly models: Models;
  /** 当前模型 getter（组合根 mutable 槽——每请求重读，setModel 下一请求生效）。 */
  readonly model: () => Model<any>;
  /** provider key getter（authStore 快照——每次调用重读）。 */
  readonly getApiKey: (provider: string) => string | undefined;
  /** thinking 解析读面（§3.5 注入器同源 getter；缺省不装注入器）。 */
  readonly resolveThinking?: (model: Model<any>) => string | undefined;
  /** 网络重试观测回调（等待期 engine_retrying 事件源）。 */
  readonly onRetry?: (info: { attempt: number; totalAttempts: number; waitMs: number; message: string }) => void;
  /** 重试配置（测试假时钟面）。 */
  readonly retry?: {
    readonly backoffMs?: readonly number[];
    readonly streamBackoffMs?: readonly number[];
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
}

/** pi content 块 → LoopContentBlock（块模型 Phase 1 直映射——PiStewardLlmAdapter.toResponse 同构）。 */
function toLoopBlocks(content: AssistantMessage["content"]): LoopContentBlock[] {
  const blocks: LoopContentBlock[] = [];
  for (const c of content) {
    if (c.type === "text") {
      blocks.push({ type: "text", text: c.text });
    } else if (c.type === "thinking") {
      blocks.push({
        type: "thinking",
        text: c.thinking,
        ...(typeof c.thinkingSignature === "string" && c.thinkingSignature !== "" ? { signature: c.thinkingSignature } : {}),
      });
    } else if (c.type === "toolCall") {
      blocks.push({ type: "toolCall", id: c.id, name: c.name, args: c.arguments as Record<string, unknown> });
    }
    // image 块：pi AssistantMessage.content 不含 image——防御性忽略
  }
  return blocks;
}

/** LoopMessage 窗口 → pi Context（PiStewardLlmAdapter.toContext 同构——回放占位元数据）。 */
function toContext(input: { systemPrompt: string; messages: readonly LoopMessage[]; tools: readonly LoopToolSchema[] }, model: Model<any>): Context {
  const timestamp = Date.now();
  const messages: Message[] = [];
  for (const m of input.messages) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.text, timestamp });
      continue;
    }
    if (m.role === "assistant") {
      const content: Extract<Message, { role: "assistant" }>["content"] = [];
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
          content.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.args as JsonObject });
        }
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
  const tools: Tool[] = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Tool["parameters"],
  }));
  return { systemPrompt: input.systemPrompt, messages, tools };
}

/**
 * 生产 LoopStreamFn（loop 通道引擎面）。重试包装在最外层（与
 * PiAgentEngineAdapter 装配序同构：retry → thinking → streamSimple）。
 */
export function createLoopSessionStreamFn(deps: LoopEngineStreamDeps): LoopStreamFn {
  const base = (model: Model<any>, context: Context, options?: SimpleStreamOptions) =>
    deps.models.streamSimple(model, context, options);
  const withRetry = withNetworkRetry(base as unknown as StreamFn, {
    ...(deps.retry?.backoffMs !== undefined ? { backoffMs: deps.retry.backoffMs } : {}),
    ...(deps.retry?.streamBackoffMs !== undefined ? { streamBackoffMs: deps.retry.streamBackoffMs } : {}),
    ...(deps.retry?.sleep !== undefined ? { sleep: deps.retry.sleep } : {}),
    ...(deps.onRetry !== undefined ? { onRetry: deps.onRetry } : {}),
  });
  const piStream = (
    deps.resolveThinking === undefined ? withRetry : wrapStreamFnThinking(withRetry, deps.resolveThinking)
  ) as unknown as ContextStreamFn;
  return async (input, callbacks) => {
    const model = deps.model();
    const apiKey = deps.getApiKey(model.provider);
    if (apiKey === undefined || apiKey === "") {
      throw new Error(`auth.json 中没有 provider "${model.provider}" 的 API key（loop 引擎通道，请经设置页 auth.set_key 录入）`);
    }
    const stream = piStream(model, toContext(input, model), {
      apiKey,
      ...(callbacks?.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
    // 流式透传 + G1 未关账 text 档（PiStewardLlmAdapter.complete 同构——
    // EventStream 队列单消费者，result() 只等 final promise 两者并存安全）
    let openText: string | undefined;
    const consume = (async () => {
      for await (const ev of stream) {
        if (ev.type === "text_start") {
          openText = "";
          continue;
        }
        if (ev.type === "text_delta") {
          openText = (openText ?? "") + ev.delta;
          try {
            callbacks?.onDelta?.(ev.delta);
          } catch {
            /* 消费者异常不阻断流 */
          }
          continue;
        }
        if (ev.type === "thinking_end") {
          const block = ev.content;
          if (block !== "") {
            try {
              callbacks?.onThinking?.(block);
            } catch {
              /* 消费者异常不阻断流 */
            }
          }
          continue;
        }
        if (ev.type === "text_end") {
          openText = undefined; // 关档清档——完成块经 onBlockEnd 关账
          try {
            callbacks?.onBlockEnd?.({ type: "text", text: ev.content });
          } catch {
            /* 消费者异常不阻断流 */
          }
          continue;
        }
        if (ev.type === "toolcall_end") {
          try {
            callbacks?.onBlockEnd?.({
              type: "toolCall",
              id: ev.toolCall.id,
              name: ev.toolCall.name,
              args: ev.toolCall.arguments as Record<string, unknown>,
            });
          } catch {
            /* 消费者异常不阻断流 */
          }
        }
      }
      return openText;
    })().catch(() => undefined);
    const [assistant, openTextOut] = await Promise.all([stream.result(), consume]);
    if (assistant.stopReason === "aborted") {
      return {
        kind: "aborted" as const,
        ...(openTextOut !== undefined && openTextOut !== "" ? { partialText: openTextOut } : {}),
      };
    }
    if (assistant.stopReason === "error") {
      throw new Error(assistant.errorMessage ?? "loop 引擎通道模型调用失败（provider 未返回错误详情）");
    }
    const stopReason = assistant.stopReason === "toolUse" || assistant.stopReason === "length" ? assistant.stopReason : ("stop" as const);
    return { kind: "blocks" as const, blocks: toLoopBlocks(assistant.content), stopReason };
  };
}

/** thinking 档位透传辅助（解析链产物 → pi-ai ThinkingLevel 断言面；组合根用）。 */
export function asThinkingLevel(level: string): ThinkingLevel {
  return level as ThinkingLevel;
}

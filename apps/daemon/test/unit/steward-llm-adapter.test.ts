/**
 * PiStewardLlmAdapter 单测（V2.5 文本管家批——driven 面最小闭环）。
 *
 * 断言面：
 * 1. modelId：槽位设置优先，未设置回落默认 flash 槽位；
 * 2. 缺 key fail-fast 中文错误（指向设置页录入路径）；
 * 3. complete：fake Models 注入——streamSimple 载荷（systemPrompt/messages/
 *    tools/apiKey）逐项断言 + toolCall/text 两判别映射；
 * 4. 模型不在目录 → 中文 fail-fast（前缀「管家模型解析失败」）。
 */
import { describe, expect, test } from "bun:test";
import type { Models, Model, AssistantMessage, AssistantMessageEventStream, Context } from "@earendil-works/pi-ai";
import { PiStewardLlmAdapter } from "../../src/adapters/driven/steward/PiStewardLlmAdapter";
import type { StewardLlmRequest } from "../../src/application/ports/outbound/StewardLlmPort";

interface StreamCall {
  readonly model: string;
  readonly context: Record<string, unknown>;
  readonly options: Record<string, unknown>;
}

/** 可迭代 fake 事件流（V2.5 流式体验批）：逐事件推给迭代器 + result() 终态。 */
function iterableStream(events: unknown[], reply: AssistantMessage): AssistantMessageEventStream {
  const queue = [...events];
  const final = { ...reply };
  return {
    result: async () => final,
    [Symbol.asyncIterator]: async function* () {
      while (queue.length > 0) {
        yield queue.shift();
      }
    },
  } as unknown as AssistantMessageEventStream;
}

function fakeModels(opts: {
  resolveFail?: boolean;
  reply?: AssistantMessage;
  events?: unknown[];
}): Models & { calls: StreamCall[] } {
  const calls: StreamCall[] = [];
  const model: Model<any> = {
    api: "openai-completions",
    provider: "deepseek",
    id: "deepseek-v4-flash",
  } as unknown as Model<any>;
  const reply: AssistantMessage =
    opts.reply ??
    ({
      role: "assistant",
      content: [{ type: "text", text: "答" }],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0 } },
      stopReason: "stop",
    } as unknown as AssistantMessage);
  const stream = (opts.events !== undefined ? iterableStream(opts.events, reply) : ({
    result: async () => reply,
  } as unknown as AssistantMessageEventStream));
  return {
    calls,
    getModel: (provider: string, id: string) =>
      opts.resolveFail || provider !== "deepseek" || id !== "deepseek-v4-flash" ? undefined : model,
    getModels: () => [model],
    streamSimple: (m: Model<any>, context: unknown, options: unknown) => {
      calls.push({ model: `${m.provider}/${m.id}`, context: context as Record<string, unknown>, options: options as Record<string, unknown> });
      return stream;
    },
  } as unknown as Models & { calls: StreamCall[] };
}

const REQ: StewardLlmRequest = {
  systemPrompt: "你是管家",
  messages: [{ role: "user", text: "在跑什么？" }],
  tools: [
    { name: "list_instances", description: "实例清单", parameters: { type: "object", properties: {} } },
  ],
};

function makeAdapter(models: Models, slot: string | undefined, key = "sk-test") {
  return new PiStewardLlmAdapter({
    models,
    modelSlot: () => slot,
    defaultModel: "deepseek/deepseek-v4-flash",
    getApiKey: (provider) => (provider === "deepseek" ? key : undefined),
  });
}

describe("PiStewardLlmAdapter（driven 面）", () => {
  test("modelId：槽位优先，缺省回落默认 flash 槽位", () => {
    const models = fakeModels({});
    expect(makeAdapter(models, "deepseek/deepseek-v4-flash").modelId).toBe("deepseek/deepseek-v4-flash");
    expect(makeAdapter(models, undefined).modelId).toBe("deepseek/deepseek-v4-flash");
  });

  test("缺 key fail-fast：中文错误指向设置页录入路径", async () => {
    const models = fakeModels({});
    const adapter = makeAdapter(models, undefined, "");
    expect(adapter.complete(REQ)).rejects.toThrow("auth.set_key");
  });

  test("complete：streamSimple 载荷逐项（model/systemPrompt/messages/tools/apiKey）+ 文本判别", async () => {
    const models = fakeModels({});
    const adapter = makeAdapter(models, undefined);
    const res = await adapter.complete(REQ);
    expect(res).toEqual({ kind: "text", text: "答" });
    expect(models.calls.length).toBe(1);
    const call = models.calls[0]!;
    expect(call.model).toBe("deepseek/deepseek-v4-flash");
    expect(call.context.systemPrompt).toBe("你是管家");
    expect(call.context.tools).toHaveLength(1);
    expect(call.options.apiKey).toBe("sk-test");
    const messages = call.context.messages as { role: string; content?: unknown }[];
    expect(messages[0]!.role).toBe("user");
  });

  test("complete：toolCall 判别映射（id/name/args）", async () => {
    const models = fakeModels({
      reply: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "list_instances", arguments: {} }],
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0 } },
        stopReason: "toolUse",
      } as unknown as AssistantMessage,
    });
    const adapter = makeAdapter(models, undefined);
    const res = await adapter.complete(REQ);
    expect(res).toEqual({ kind: "toolCall", id: "call-1", name: "list_instances", args: {} });
  });

  test("模型不在目录 → 中文 fail-fast（前缀「管家模型解析失败」）", async () => {
    const models = fakeModels({ resolveFail: true });
    const adapter = makeAdapter(models, undefined);
    expect(adapter.complete(REQ)).rejects.toThrow("管家模型解析失败");
  });

  test("流式：onDelta 透传 text_delta chunk（按序），toolcall_delta 不透传（工具段静默）", async () => {
    const models = fakeModels({
      reply: {
        role: "assistant",
        content: [{ type: "text", text: "当前 2 个" }],
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0 } },
        stopReason: "stop",
      } as unknown as AssistantMessage,
      events: [
        { type: "start", partial: null },
        { type: "text_start", contentIndex: 0, partial: null },
        { type: "text_delta", contentIndex: 0, delta: "当前 ", partial: null },
        { type: "toolcall_delta", contentIndex: 1, delta: "{\"x\":1}", partial: null },
        { type: "text_delta", contentIndex: 0, delta: "2 个", partial: null },
      ],
    });
    const adapter = makeAdapter(models, undefined);
    const chunks: string[] = [];
    const res = await adapter.complete(REQ, (c) => chunks.push(c));
    expect(chunks).toEqual(["当前 ", "2 个"]); // 仅 text_delta，按序
    expect(res).toEqual({ kind: "text", text: "当前 2 个" }); // 终态仍由 result() 权威聚合
  });

  test("流式：无 onDelta（旧调用面）不碰迭代器——纯 result() 路径不变", async () => {
    const models = fakeModels({
      events: [{ type: "text_delta", contentIndex: 0, delta: "x", partial: null }],
    });
    const adapter = makeAdapter(models, undefined);
    const res = await adapter.complete(REQ);
    expect(res).toEqual({ kind: "text", text: "答" });
  });
});

// ══════════════════════════════════════════════════════════
// A1 工作记忆批：thinking 开启（reasoning 透传）/ 段级回调 / 历史回传
// ══════════════════════════════════════════════════════════

/** reasoning 能力模型 fake（model.reasoning === true）。 */
function reasoningModels(opts: { reply?: AssistantMessage; events?: unknown[]; reasoning?: boolean }): ReturnType<typeof fakeModels> {
  const base = fakeModels(opts);
  // 覆写 model 对象带 reasoning 能力位——fakeModels 内部 model 不透明，这里
  // 通过 getModels 注入带能力位的实例（streamSimple 消费同一对象）
  const withReasoning = {
    api: "openai-completions",
    provider: "deepseek",
    id: "deepseek-v4-flash",
    reasoning: opts.reasoning !== false,
  } as unknown as Model<any>;
  return {
    ...base,
    getModel: (provider: string, id: string) =>
      provider === "deepseek" && id === "deepseek-v4-flash" ? withReasoning : undefined,
    getModels: () => [withReasoning],
    streamSimple: (m: Model<any>, context: unknown, options: unknown) => {
      (base.calls as StreamCall[]).push({
        model: `${m.provider}/${m.id}`,
        context: context as Record<string, unknown>,
        options: options as Record<string, unknown>,
      });
      return fakeModels(opts as { reply?: AssistantMessage; events?: unknown[] }).streamSimple(m, context as Context, options as never);
    },
  } as unknown as ReturnType<typeof fakeModels>;
}

describe("PiStewardLlmAdapter（A1 thinking 面）", () => {
  test("thinking 开启：model.reasoning=true → streamSimple options.reasoning = \"high\"", async () => {
    const models = reasoningModels({});
    const adapter = makeAdapter(models, undefined);
    await adapter.complete(REQ);
    expect(models.calls.length).toBe(1);
    expect(models.calls[0]!.options.reasoning).toBe("high"); // A1：管家 thinking 档位
  });

  test("能力判据：model.reasoning≠true → 不带 reasoning（provider 默认纪律）", async () => {
    const models = fakeModels({}); // 默认 model 无 reasoning 位
    const adapter = makeAdapter(models, undefined);
    await adapter.complete(REQ);
    expect(models.calls[0]!.options.reasoning).toBeUndefined();
  });

  test("段级回调：thinking_delta 聚积 → thinking_end 一帧（终态 content 权威）；redacted 空块零回调", async () => {
    const models = fakeModels({
      reply: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "块一完整", thinkingSignature: "sig-1" },
          { type: "text", text: "答" },
        ],
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0 } },
        stopReason: "stop",
      } as unknown as AssistantMessage,
      events: [
        { type: "start", partial: null },
        { type: "thinking_start", contentIndex: 0, partial: null },
        { type: "thinking_delta", contentIndex: 0, delta: "块一", partial: null },
        { type: "thinking_delta", contentIndex: 0, delta: "完整", partial: null },
        { type: "thinking_end", contentIndex: 0, content: "块一完整", partial: null },
      ],
    });
    const adapter = makeAdapter(models, undefined);
    const blocks: string[] = [];
    const res = await adapter.complete(REQ, undefined, (b) => blocks.push(b));
    expect(blocks).toEqual(["块一完整"]); // 段级：一完成块一帧（非逐 delta）
    expect(res.kind).toBe("text");
    if (res.kind !== "text") throw new Error("unreachable");
    expect(res.thinking).toEqual({ text: "块一完整", signature: "sig-1" }); // 终态权威 + signature 透传
  });

  test("历史回传：assistant.thinking → Context ThinkingContent 块（signature 透传，thinking 置首）", async () => {
    const models = fakeModels({});
    const adapter = makeAdapter(models, undefined);
    await adapter.complete({
      systemPrompt: "s",
      messages: [
        { role: "user", text: "问" },
        { role: "assistant", thinking: { text: "上一轮思考。", signature: "sig-old" }, text: "答", toolCall: { id: "c0", name: "list_tasks", args: {} } },
        { role: "toolResult", toolCallId: "c0", name: "list_tasks", text: "[]" },
      ],
      tools: [],
    });
    const messages = models.calls[0]!.context.messages as {
      role: string;
      content: { type: string; thinking?: string; thinkingSignature?: string; text?: string }[];
    }[];
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "上一轮思考。", thinkingSignature: "sig-old" }); // 最严约束：签名随块回传
    expect(assistant.content[1]).toEqual({ type: "text", text: "答" });
    expect(assistant.content[2]!.type).toBe("toolCall");
  });
});

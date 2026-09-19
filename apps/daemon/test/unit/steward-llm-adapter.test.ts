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
import type { Models, Model, AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
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

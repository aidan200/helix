/**
 * StewardVoiceSummarizerAdapter 单测（语音播报批 ③层 LLM 摘要）。
 *
 * 断言面：
 * 1. isAvailable 组合判别：管家开关关 / 模型槽位空 → false（②层模板回退的
 *    gate 输入面）；开关开 + 模型槽位非空 → true；
 * 2. complete 防腐透传：{systemPrompt, userPrompt} → StewardLlmRequest
 *    （messages 恰一条 user；tools 空——摘要无工具面）；text 响应原样返回；
 * 3. 异常面：toolCall 响应（tools 空下不应发生）→ throw 中文错误；
 *    LLM 抛错 → 透传（服务层回退路径接住）。
 */
import { describe, expect, test } from "bun:test";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import { StewardVoiceSummarizerAdapter } from "../../src/adapters/driven/voice/StewardVoiceSummarizerAdapter";

function fakeLlm(opts?: {
  modelId?: string;
  response?: StewardLlmResponse;
  error?: Error;
}): StewardLlmPort & { requests: StewardLlmRequest[] } {
  const requests: StewardLlmRequest[] = [];
  return {
    requests,
    modelId: opts?.modelId ?? "deepseek/deepseek-v4-flash",
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      requests.push(request);
      if (opts?.error !== undefined) throw opts.error;
      return opts?.response ?? { kind: "blocks", blocks: [{ type: "text", text: "白话摘要文本" }], stopReason: "stop" };
    },
  };
}

const makeAdapter = (llm: StewardLlmPort, enabled = true) =>
  new StewardVoiceSummarizerAdapter({ llm, enabled: () => enabled });

describe("StewardVoiceSummarizerAdapter：isAvailable（②层回退 gate 输入面）", () => {
  test("管家开关开 + 模型槽位非空 → 可用", () => {
    expect(makeAdapter(fakeLlm(), true).isAvailable()).toBe(true);
  });

  test("管家开关关（steward.enabled ≠ \"1\"）→ 不可用（零 LLM 调用，②层模板直出）", () => {
    expect(makeAdapter(fakeLlm(), false).isAvailable()).toBe(false);
  });

  test("模型槽位空字符串（未配置模型）→ 不可用", () => {
    expect(makeAdapter(fakeLlm({ modelId: "" }), true).isAvailable()).toBe(false);
    expect(makeAdapter(fakeLlm({ modelId: "  " }), true).isAvailable()).toBe(false);
  });
});

describe("StewardVoiceSummarizerAdapter：complete（防腐透传）", () => {
  test("prompt → StewardLlmRequest：systemPrompt 透传；messages 恰一条 user；tools 空", async () => {
    const llm = fakeLlm();
    const text = await makeAdapter(llm).complete({
      systemPrompt: "你是播报摘要员",
      userPrompt: "事件：任务完成\nagent：a1",
    });
    expect(text).toBe("白话摘要文本");
    expect(llm.requests.length).toBe(1);
    const req = llm.requests[0]!;
    expect(req.systemPrompt).toBe("你是播报摘要员");
    expect(req.messages).toEqual([{ role: "user", text: "事件：任务完成\nagent：a1" }]);
    expect(req.tools).toEqual([]);
  });

  test("toolCall 响应（tools 空下不应发生）→ throw 中文错误（服务层回退接住）", async () => {
    const llm = fakeLlm({ response: { kind: "blocks", blocks: [{ type: "toolCall", id: "c1", name: "x", args: {} }], stopReason: "toolUse" } });
    expect(
      makeAdapter(llm).complete({ systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("工具调用");
  });

  test("LLM 抛错 → 透传（fail-fast，回退决策归 BroadcastService）", async () => {
    const llm = fakeLlm({ error: new Error("key 缺失") });
    expect(
      makeAdapter(llm).complete({ systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("key 缺失");
  });
});

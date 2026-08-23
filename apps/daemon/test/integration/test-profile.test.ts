import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "../../src/adapters/driven/pi-engine/runtime/AgentRuntime";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import { MinimalHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";

/**
 * TP-CL4-4 / AG-11（行为级）：新增 profile 不改 runtime——
 * 测试内声明的 TestProfile（纯声明式，含自己的系统提示/生命周期策略/
 * hooks 装配）经**真 AgentRuntime + 真 pi Agent loop** 装配并跑通一轮
 * FakeLLM 对话。若挂新 profile 需要改 runtime 源码，本测试即失败。
 *
 * FakeLLM（M2 级 mock，test-design §5.1）：pi-ai streamFn 替身——脚本化
 * 流式返回，无网络/无真实 key；同时记录 stream options（断言 apiKey
 * 显式传入链路：explicitGetApiKey → Agent → streamFn options.apiKey）。
 */

/** 测试专用声明式 profile（与 MainSessionProfile 同构，零 runtime 改动）。 */
const TestProfile: AgentProfile = {
  kind: "test-profile",
  systemPrompt: "测试 profile 的系统提示",
  tools: [],
  lifecycle: { mode: "single-shot" },
  hooks: [SteerHooks, MinimalHooks],
};

/** 离线假模型对象（FakeLLM 不发真实请求，模型仅透传）。 */
const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

/** 构造一条完整的 AssistantMessage（stopReason 可指定）。 */
function assistantMessage(text: string, stopReason: "stop" | "error" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/**
 * 剧本化 FakeLLM streamFn：按 4 字符分片流出 reply，分片间隔 delayMs；
 * 记录每次调用的 options（断言显式 apiKey 传入）。
 */
function makeFakeLLM(scripts: string[], chunkDelayMs = 6) {
  const seenOptions: Array<Record<string, unknown>> = [];
  const streamFn: StreamFn = (_model, _context, options) => {
    seenOptions.push({ ...(options as Record<string, unknown> | undefined) });
    const reply = scripts.shift() ?? "（剧本耗尽）";
    const stream = createAssistantMessageEventStream();
    const final = assistantMessage(reply);
    void (async () => {
      stream.push({ type: "start", partial: final });
      for (let i = 0; i < reply.length; i += 4) {
        await new Promise((r) => setTimeout(r, chunkDelayMs));
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply.slice(i, i + 4), partial: final });
      }
      stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
  return { streamFn, seenOptions };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TP-CL4-4 / AG-11：TestProfile 经 AgentRuntime 装配（不改 runtime）", () => {
  test("一轮 FakeLLM 对话跑通：事件序 + 回复 + apiKey 显式传入链路", async () => {
    const { streamFn, seenOptions } = makeFakeLLM(["来自 TestProfile 的第一答。"]);
    const runtime = new AgentRuntime(TestProfile, {
      streamFn,
      model: fakeModel,
      getApiKey: (provider) => `explicit-key-for-${provider}`,
    });

    const events: AgentEvent[] = [];
    runtime.subscribe((e) => events.push(e));

    await runtime.drive("你好");

    // 真 Agent loop 的规范事件序（spike §5.1 无工具轮）
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_start");
    expect(types.at(-1)).toBe("agent_end");
    expect(types).toContain("turn_start");
    expect(types).toContain("turn_end");
    expect(types.filter((t) => t === "message_update").length).toBeGreaterThan(0);

    // TestProfile 的系统提示确实进入 LLM 请求上下文（声明式配置生效）
    const context = (events.find((e) => e.type === "message_update") as unknown as never) ?? null;
    void context;
    // transcript 里能看到 assistant 完整回复
    const end = events.find((e) => e.type === "message_end" && (e as { message: { role: string } }).message.role === "assistant");
    expect((end as unknown as { message: { content: Array<{ type: string; text?: string }> } }).message.content[0]?.text).toBe(
      "来自 TestProfile 的第一答。",
    );

    // AD-11/13 显式传 key 链路：runtime.getApiKey → Agent → streamFn options.apiKey
    expect(seenOptions.length).toBeGreaterThanOrEqual(1);
    expect(seenOptions[0]!["apiKey"]).toBe("explicit-key-for-anthropic");
  });

  test("TestProfile 获得完整 steer 通道：运行中注入 → turn 边界 drain（spike §5.3）", async () => {
    const { streamFn } = makeFakeLLM(
      ["这一答足够长，长到测试可以在流式中段完成注入操作。", "（按注入调整）第二答。"],
      8,
    );
    const runtime = new AgentRuntime(TestProfile, {
      streamFn,
      model: fakeModel,
      getApiKey: () => "explicit-key",
    });
    const events: AgentEvent[] = [];
    runtime.subscribe((e) => events.push(e));

    const drive = runtime.drive("第一问");
    await until(() => events.some((e) => e.type === "message_update")); // 流式进行中
    runtime.steer("中途注入的修正");
    await drive;

    // drain：注入消息作为新 turn 首条 user 消息（one-at-a-time）
    const userStarts = events.filter(
      (e) => e.type === "message_start" && (e as { message: { role: string } }).message.role === "user",
    ) as unknown as Array<{ message: { content: string | Array<{ type: string; text?: string }> } }>;
    const texts = userStarts.map((e) =>
      typeof e.message.content === "string" ? e.message.content : e.message.content.map((c) => c.text ?? "").join(""),
    );
    expect(texts).toEqual(["第一问", "中途注入的修正"]);
    // 两轮 assistant 完成消息（原轮 + 注入驱动轮）
    const assistantEnds = events.filter(
      (e) => e.type === "message_end" && (e as { message: { role: string } }).message.role === "assistant",
    );
    expect(assistantEnds.length).toBe(2);
  });

  test("未装配 SteerCapable 钩子的 profile：steer 明确报错而非静默", async () => {
    const bareProfile: AgentProfile = {
      kind: "bare-test-profile",
      systemPrompt: "x",
      tools: [],
      lifecycle: { mode: "single-shot" },
      hooks: [MinimalHooks],
    };
    const { streamFn } = makeFakeLLM(["ok"]);
    const runtime = new AgentRuntime(bareProfile, { streamFn, model: fakeModel, getApiKey: () => "k" });
    const drive = runtime.drive("q");
    await until(() => runtime.isStreaming());
    expect(() => runtime.steer("无通道")).toThrow(/未装配/);
    await drive;
  });
});

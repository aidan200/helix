import { describe, expect, test } from "bun:test";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";

/**
 * engineBlocksOf thinking 签名透传（评审 B8）：pi ThinkingContent 的签名字段是
 * thinkingSignature（pi-ai dist/types.d.ts），非 signature——适配器按真 pi 形状块
 * 透传签名字段，下游 StewardService 取 blocks 签名入账、回放侧无签名 thinking
 * 被判不可回传丢弃（PiStewardLlmAdapter.toContext 判例③）。
 */

const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as const,
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const BlocksProfile: AgentProfile = {
  kind: "test-blocks-signature",
  systemPrompt: "test",
  tools: [],
  lifecycle: { mode: "single-shot" },
  hooks: [SteerHooks],
} satisfies AgentProfile;

function assistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function scriptedLLM(script: AssistantMessage[]): StreamFn {
  let i = 0;
  return () => {
    const msg = script[i++] ?? assistant([{ type: "text", text: "剧本耗尽" }], "stop");
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: (msg.stopReason ?? "stop") as never, message: msg });
    })();
    return stream;
  };
}

describe("PiAgentEngineAdapter message_end blocks：pi 形状 thinking 签名透传", () => {
  test("thinking 块的 thinkingSignature 映射为 port 块 signature（真 pi 形状）", async () => {
    const events: AgentEngineEvent[] = [];
    const adapter = new PiAgentEngineAdapter({
      profile: BlocksProfile,
      model: fakeModel,
      apiKeys: { anthropic: "test" },
      streamFnOverride: scriptedLLM([
        assistant(
          [
            { type: "thinking", thinking: "先想一步", thinkingSignature: "sig-abc-123" },
            { type: "text", text: "答案在此" },
          ],
          "stop",
        ),
      ]),
    });
    await adapter.start("跑一轮", (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 50));

    const end = events.find(
      (e): e is Extract<AgentEngineEvent, { type: "message_end" }> => e.type === "message_end" && e.role === "assistant",
    );
    expect(end).toBeDefined();
    expect(end?.blocks).toBeDefined();
    const thinking = end?.blocks?.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    // 真 pi 形状：签名字段名 thinkingSignature → port 词典 signature（与 toResponse 同口径）
    expect((thinking as { signature?: string }).signature).toBe("sig-abc-123");
    const text = end?.blocks?.find((b) => b.type === "text");
    expect((text as { text?: string }).text).toBe("答案在此");
  });

  test("无签名的 thinking 块不带 signature 字段（可缺省）", async () => {
    const events: AgentEngineEvent[] = [];
    const adapter = new PiAgentEngineAdapter({
      profile: BlocksProfile,
      model: fakeModel,
      apiKeys: { anthropic: "test" },
      streamFnOverride: scriptedLLM([
        assistant([{ type: "thinking", thinking: "无签名思考" }], "stop"),
      ]),
    });
    await adapter.start("跑一轮", (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 50));

    const end = events.find(
      (e): e is Extract<AgentEngineEvent, { type: "message_end" }> => e.type === "message_end" && e.role === "assistant",
    );
    const thinking = end?.blocks?.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    expect("signature" in (thinking ?? {})).toBe(false);
  });
});

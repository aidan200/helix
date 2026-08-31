import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { MinimalHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";

/**
 * P2 ⑦ 适配器级：网络重试装配面（全局生效挂点）+ engine_retrying 可观测事件。
 *
 * - 装配：PiAgentEngineAdapter 构造器内 withNetworkRetry 包装（主会话/
 *   SubAgent 子进程/编排器三装配点同源）——streamFnOverride 剧本注入，
 *   retry.backoffMs/sleep 假时钟注入；
 * - 瞬时失败 2 次后成功：监听器收 engine_retrying×2（attempt/total/waitMs/
 *   message 逐字段）+ 最终 message_end 成功，无 engine_error；
 * - 永久类（401）：零 engine_retrying，直接既有 engine_error 路径。
 */

const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as const,
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const retryProfile: AgentProfile = {
  kind: "test-network-retry",
  systemPrompt: "测试系统提示",
  tools: [],
  lifecycle: { mode: "persistent" },
  hooks: [SteerHooks, MinimalHooks],
};

function okMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function errorMessage(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 剧本 streamFn：逐调用消费剧本项（error=纯 error 单帧；ok=start+delta+done）；耗尽重复末项（持续失败场景）。 */
function scriptedStreamFn(scripts: ({ err: string } | { text: string })[]): { streamFn: StreamFn; calls: string[] } {
  const calls: string[] = [];
  const queue = [...scripts];
  const streamFn: StreamFn = () => {
    const script = queue.length > 0 ? queue.shift()! : scripts[scripts.length - 1]!;
    const stream = createAssistantMessageEventStream();
    if ("err" in script) {
      calls.push(`err:${script.err}`);
      stream.push({ type: "error", reason: "error", error: errorMessage(script.err) });
    } else {
      calls.push(`ok:${script.text}`);
      const final = okMessage(script.text);
      void (async () => {
        stream.push({ type: "start", partial: final });
        stream.push({ type: "text_delta", contentIndex: 0, delta: script.text, partial: final });
        stream.push({ type: "done", reason: "stop", message: final });
      })();
    }
    return stream;
  };
  return { streamFn, calls };
}

/** 假时钟：记录退避消费序列，立即放行。 */
function fakeSleep(slept: number[]) {
  return (ms: number) => {
    slept.push(ms);
    return Promise.resolve();
  };
}

describe("PiAgentEngineAdapter 网络重试装配（engine_retrying 可观测）", () => {
  test("瞬时失败 2 次后成功：engine_retrying×2 → message_end 成功，无 engine_error", async () => {
    const slept: number[] = [];
    const { streamFn, calls } = scriptedStreamFn([
      { err: "fetch failed" },
      { err: "connect ETIMEDOUT" },
      { text: "恢复后的回答" },
    ]);
    const engine = new PiAgentEngineAdapter({
      profile: retryProfile,
      model: fakeModel,
      apiKeys: { anthropic: "explicit-key" },
      streamFnOverride: streamFn,
      retry: { backoffMs: [10, 30, 60], sleep: fakeSleep(slept) },
    });

    const events: AgentEngineEvent[] = [];
    await engine.start("你好", (e) => events.push(e));

    expect(calls).toEqual(["err:fetch failed", "err:connect ETIMEDOUT", "ok:恢复后的回答"]);
    expect(slept).toEqual([10, 30]); // 退避序列消费（假时钟）

    const retrying = events.filter((e) => e.type === "engine_retrying");
    expect(retrying).toEqual([
      { type: "engine_retrying", attempt: 1, totalAttempts: 3, waitMs: 10, message: "fetch failed" },
      { type: "engine_retrying", attempt: 2, totalAttempts: 3, waitMs: 30, message: "connect ETIMEDOUT" },
    ]);
    // 最终成功：message_end(assistant, stopReason=stop) 存在；无 engine_error
    expect(events.some((e) => e.type === "engine_error")).toBe(false);
    const end = events.find((e) => e.type === "message_end" && e.role === "assistant");
    expect(end).toMatchObject({ type: "message_end", role: "assistant", stopReason: "stop" });
  });

  test("永久类（401 鉴权）：零重试零 engine_retrying，既有 engine_error 路径", async () => {
    const slept: number[] = [];
    const { streamFn, calls } = scriptedStreamFn([{ err: "401 authentication_error" }]);
    const engine = new PiAgentEngineAdapter({
      profile: retryProfile,
      model: fakeModel,
      apiKeys: { anthropic: "explicit-key" },
      streamFnOverride: streamFn,
      retry: { backoffMs: [10, 30, 60], sleep: fakeSleep(slept) },
    });

    const events: AgentEngineEvent[] = [];
    await engine.start("你好", (e) => events.push(e));

    expect(calls).toEqual(["err:401 authentication_error"]);
    expect(slept).toEqual([]);
    expect(events.filter((e) => e.type === "engine_retrying")).toEqual([]);
    const err = events.find((e) => e.type === "engine_error");
    expect(err).toMatchObject({ type: "engine_error", message: "401 authentication_error" });
    // 既有失败语义：message_end(assistant, stopReason=error) + agent_end 收口
    expect(events.some((e) => e.type === "message_end" && e.role === "assistant" && e.stopReason === "error")).toBe(true);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
  });

  test("持续瞬时失败：1+3 次尝试后退避耗尽，走既有失败路径", async () => {
    const slept: number[] = [];
    const { streamFn, calls } = scriptedStreamFn([{ err: "503 Service Unavailable" }]);
    const engine = new PiAgentEngineAdapter({
      profile: retryProfile,
      model: fakeModel,
      apiKeys: { anthropic: "explicit-key" },
      streamFnOverride: streamFn,
      retry: { backoffMs: [10, 30, 60], sleep: fakeSleep(slept) },
    });

    const events: AgentEngineEvent[] = [];
    await engine.start("你好", (e) => events.push(e));

    expect(calls).toHaveLength(4); // 首调 + 3 重试（剧本耗尽重复末项 = 持续 503）
    expect(slept).toEqual([10, 30, 60]);
    expect(events.filter((e) => e.type === "engine_retrying")).toHaveLength(3);
    expect(events.find((e) => e.type === "engine_error")).toMatchObject({
      message: "503 Service Unavailable",
    });
    expect(events.some((e) => e.type === "message_end" && e.role === "assistant" && e.stopReason === "error")).toBe(true);
  });
});

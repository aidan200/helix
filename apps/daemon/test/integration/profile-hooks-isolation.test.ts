import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "../../src/adapters/driven/pi-engine/runtime/AgentRuntime";
import type { HookSet, SteerCapable } from "../../src/adapters/driven/pi-engine/runtime/HookSet";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { buildModels } from "../../src/adapters/driven/pi-engine/model-provider";

/**
 * T1（P0）：SteerHooks 跨会话串台回归测试。
 *
 * 生产形态复刻（buildSessionStack.engineFor）：daemon 多会话下，每个会话
 * 用**同一个常量 profile 对象**（MainSessionProfile）装配各自的 AgentRuntime。
 * 修复前 profile.hooks 声明的是模块级共享实例——AgentRuntime 构造时
 * `hook.bind(agent)` 把共享 SteerHooks.agent 覆盖成最后构造的会话，
 * 导致会话 A 的 steer/abort 全部打到会话 B 的 agent 上（实测：A 的
 * SubAgent closure 注入进了 B 的 LLM 上下文）。
 *
 * 修复后（类引用方案）：profile.hooks 声明构造器引用（纯数据），AgentRuntime
 * 装配点每 runtime `new H()`——同一常量 profile 构造的两个 runtime 各持
 * 独立钩子实例，bind 状态互不覆盖。
 *
 * 契约：同一 profile 对象构造的多个 runtime 必须持有互不干扰的 steer/abort
 * 通道——A 的注入只进 A 的 transcript/LLM 上下文，B 的 LLM 上下文零污染；
 * A 的 abort 只中断 A 的 run。
 *
 * FakeLLM（M2 级 mock，同 test-profile.test.ts）：pi-ai streamFn 替身，
 * 剧本化分片流出 + signal 感知（abort → aborted 消息收尾），同时记录每次
 * 调用收到的 LLM 上下文（断言「B 的 LLM 未收到 A 的注入」）。
 */

/** 离线假模型对象（FakeLLM 不发真实请求，模型仅透传）。 */
const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

/** compaction 接线要求的 models 目录（MainSessionProfile 声明 enabled；小上下文不触发摘要）。 */
const models = buildModels();

function assistantMessage(text: string, stopReason: "stop" | "aborted"): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/**
 * 剧本化 FakeLLM streamFn：按 4 字符分片流出 replies（记录每次调用收到的
 * user 文本序列）；分片间检查 abort signal——已中止时以 stopReason="aborted"
 * 消息收尾（同 scriptedEngine.makeScriptedStreamFn 语义）。
 */
function makeFakeLLM(replies: string[], chunkDelayMs = 6) {
  const seenUserTexts: string[][] = [];
  const streamFn: StreamFn = (_model, ctx, opts) => {
    seenUserTexts.push(
      (ctx.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>)
        .filter((m) => m.role === "user")
        .map((m) =>
          typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""),
        ),
    );
    const reply = replies.shift() ?? "（剧本耗尽）";
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    const stream = createAssistantMessageEventStream();
    const final = assistantMessage(reply, "stop");
    void (async () => {
      stream.push({ type: "start", partial: final });
      for (let i = 0; i < reply.length; i += 4) {
        if (signal?.aborted) {
          stream.push({
            type: "done",
            reason: "stop",
            message: assistantMessage(reply.slice(0, i), "aborted"),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, chunkDelayMs));
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply.slice(i, i + 4), partial: final });
      }
      stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
  return { streamFn, seenUserTexts };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 事件流里 user 消息的文本序列（message_start 面）。 */
function userTextsOf(events: AgentEvent[]): string[] {
  return events
    .filter((e) => e.type === "message_start" && (e as { message: { role: string } }).message.role === "user")
    .map((e) => {
      const content = (e as unknown as { message: { content: string | Array<{ type: string; text?: string }> } }).message.content;
      return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
    });
}

/** 事件流里 assistant 完成消息（message_end 面）。 */
function assistantEndsOf(events: AgentEvent[]): Array<{ stopReason: string | undefined }> {
  return events
    .filter((e) => e.type === "message_end" && (e as { message: { role: string } }).message.role === "assistant")
    .map((e) => ({ stopReason: (e as unknown as { message: { stopReason?: string } }).message.stopReason }));
}

/** 同一常量 profile 构造 runtime（生产 engineFor 同构：会话共用常量声明）。 */
function buildRuntime(streamFn: StreamFn): AgentRuntime {
  return new AgentRuntime(MainSessionProfile, {
    streamFn,
    model: fakeModel,
    models,
    getApiKey: () => "explicit-key",
  });
}

describe("T1（P0）：同一常量 profile 的两个 runtime —— steer/abort 不跨会话串台", () => {
  test("同一 profile 对象构造的两个 runtime：hooks 实例独立（装配点 new 判据）", () => {
    const runtimeA = buildRuntime(makeFakeLLM(["A ok"]).streamFn);
    const runtimeB = buildRuntime(makeFakeLLM(["B ok"]).streamFn);
    // AgentRuntime 装配点每 runtime new H()——steerHook（SteerHooks 实例）
    // 互不同引用（bind 状态隔离的地基；修复前共享同一模块级实例）
    const steerA = (runtimeA as unknown as { steerHook?: HookSet & SteerCapable }).steerHook;
    const steerB = (runtimeB as unknown as { steerHook?: HookSet & SteerCapable }).steerHook;
    expect(steerA).toBeDefined();
    expect(steerB).toBeDefined();
    expect(steerA).not.toBe(steerB);
    // 快照读面不受影响：类引用的 hookName 与既有实例名等值
    expect(MainSessionProfile.hooks.map((H) => H.hookName)).toEqual(["steer", "minimal"]);
  });

  test("steer 串台复现：A 运行中注入 → A 收到（drain 为新 turn），B 的 LLM 上下文零污染", async () => {
    const llmA = makeFakeLLM([
      "A 的第一答足够长，长到测试可以在流式中段完成注入操作。",
      "A 按注入调整后的第二答。",
    ]);
    const llmB = makeFakeLLM(["B 的第一答。", "B 的第二答。"]);
    // 会话 A 先建、会话 B 后建（生产时序：修复前共享 SteerHooks.agent 被 B 覆盖）
    const runtimeA = buildRuntime(llmA.streamFn);
    const runtimeB = buildRuntime(llmB.streamFn);
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    runtimeA.subscribe((e) => eventsA.push(e));
    runtimeB.subscribe((e) => eventsB.push(e));

    // A 驱动（流式中段注入）——注入只应进 A
    const driveA = runtimeA.drive("A 的第一问");
    await until(() => eventsA.some((e) => e.type === "message_update"));
    runtimeA.steer("给 A 的补充指令");
    await driveA;

    expect(userTextsOf(eventsA)).toEqual(["A 的第一问", "给 A 的补充指令"]);
    expect(assistantEndsOf(eventsA).length).toBe(2);

    // B 随后驱动：B 的 transcript/LLM 上下文里不得出现 A 的注入
    await runtimeB.drive("B 的第一问");
    expect(userTextsOf(eventsB)).toEqual(["B 的第一问"]);
    expect(assistantEndsOf(eventsB).length).toBe(1);
    // LLM 上下文直证：B 的每次 streamFn 调用只见过自己的输入
    expect(llmB.seenUserTexts).toEqual([["B 的第一问"]]);
  });

  test("abort 串台复现：A 的 abort 只中断 A 的 run，B 不受影响", async () => {
    const longReply = "A 的长回复。".repeat(40); // 分片足够多以留出 abort 时窗
    const llmA = makeFakeLLM([longReply], 8);
    const llmB = makeFakeLLM(["B 的第一答。".repeat(40)], 8);
    const runtimeA = buildRuntime(llmA.streamFn);
    const runtimeB = buildRuntime(llmB.streamFn);
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    runtimeA.subscribe((e) => eventsA.push(e));
    runtimeB.subscribe((e) => eventsB.push(e));

    // 两会话并发流式中
    const driveA = runtimeA.drive("A 的第一问");
    await until(() => eventsA.some((e) => e.type === "message_update"));
    const driveB = runtimeB.drive("B 的第一问");
    await until(() => eventsB.some((e) => e.type === "message_update"));

    runtimeA.abort(); // 会话 A 的用户点停止——只应中断 A

    await driveA;
    await driveB;

    // A 被 abort（assistant 收尾 stopReason=aborted）；B 完整完成（stop）
    const endsA = assistantEndsOf(eventsA);
    expect(endsA.length).toBe(1);
    expect(endsA[0]!.stopReason).toBe("aborted");
    const endsB = assistantEndsOf(eventsB);
    expect(endsB.length).toBe(1);
    expect(endsB[0]!.stopReason).toBe("stop");
    expect(userTextsOf(eventsB)).toEqual(["B 的第一问"]);
  });
});

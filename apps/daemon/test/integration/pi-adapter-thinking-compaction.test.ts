import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import { MinimalHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";

/**
 * T3.1 RED：pi→port 通道族事件转发（thinking 三事件 + message_end usage +
 * compaction_completed）——真 PiAgentEngineAdapter + 真 pi Agent loop +
 * FakeLLM（剧本化 streamFn）+ 假 Models（completeSimple 摘要替身，离线）。
 *
 * 回归锚：PiAgentEngineAdapter L103-108「thinking 三事件被有意丢弃」——
 * 本套件断言其不再丢弃（转发完整、时序在 assistant 文本流之前）。
 */

/** 离线假模型对象（contextWindow=1000 便于小阈值触发 compaction）。 */
const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 8192,
} as unknown as Model<any>;

/** 一条带 thinking 块与 usage 的完整 AssistantMessage（withUsage=false 时不携带
 *  usage——compaction 触发判定走字符启发式，不受 provider usage 遮蔽）。 */
function fullMessage(thinking: string, text: string, withUsage = true): AssistantMessage {
  const usage = withUsage
    ? {
        input: 11,
        output: 7,
        cacheRead: 2,
        cacheWrite: 3,
        reasoning: 5,
        totalTokens: 18,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.05, total: 0.5 },
      }
    : undefined;
  return {
    role: "assistant",
    content: [
      ...(thinking !== "" ? [{ type: "thinking", thinking }] : []),
      { type: "text", text },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    ...(usage !== undefined ? { usage } : {}),
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 摘要回复（fake Models.completeSimple 返回；usage 是 compaction 账目源）。 */
function summaryMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: {
      input: 40,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 46,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

interface FakeScript {
  thinking: string;
  text: string;
  /** 携带 usage（缺省 true，七字段提取断言用）；compaction 测试传 false——
   *  estimateContextTokens 优先用 provider usage，会遮蔽字符启发式估 token。 */
  withUsage?: boolean;
}

/**
 * 剧本化 FakeLLM：thinking 块先行（thinking_start/delta×N/end，contentIndex 0），
 * 随后 text 块（contentIndex 1），done 携带完整消息（含 thinking 块与 usage）。
 * 记录每次调用的 context（compaction 后 prompt 长度下降断言源）。
 */
function makeFakeLLM(scripts: FakeScript[]) {
  const seenContexts: { messages: { role: string }[] }[] = [];
  const streamFn: StreamFn = (_model, context) => {
    seenContexts.push({ messages: [...(context.messages as { role: string }[])] });
    const script = scripts.shift() ?? { thinking: "", text: "（剧本耗尽）" };
    const final = fullMessage(script.thinking, script.text, script.withUsage !== false);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: final });
      // thinking 块（contentIndex 0）：分片流出
      stream.push({ type: "thinking_start", contentIndex: 0, partial: final });
      for (let i = 0; i < script.thinking.length; i += 6) {
        await new Promise((r) => setTimeout(r, 1));
        stream.push({
          type: "thinking_delta",
          contentIndex: 0,
          delta: script.thinking.slice(i, i + 6),
          partial: final,
        });
      }
      stream.push({ type: "thinking_end", contentIndex: 0, content: script.thinking, partial: final });
      // text 块（contentIndex 1）
      for (let i = 0; i < script.text.length; i += 6) {
        await new Promise((r) => setTimeout(r, 1));
        stream.push({
          type: "text_delta",
          contentIndex: 1,
          delta: script.text.slice(i, i + 6),
          partial: final,
        });
      }
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
  return { streamFn, seenContexts };
}

/** 假 Models：completeSimple 返回剧本摘要（split turn 时多次调用各自计数）。 */
function makeFakeModels(summaryText: string, opts?: { failWith?: Error }) {
  const calls: number[] = [];
  const models = {
    completeSimple: async () => {
      calls.push(Date.now());
      if (opts?.failWith) throw opts.failWith;
      return summaryMessage(summaryText);
    },
  };
  return { models: models as unknown as Models, calls };
}

function makeAdapter(profile: AgentProfile, streamFn: StreamFn, models: Models) {
  const engine = new PiAgentEngineAdapter({
    profile,
    model: fakeModel,
    apiKeys: { anthropic: "explicit-key" },
    models,
    streamFnOverride: streamFn,
  });
  const events: AgentEngineEvent[] = [];
  return {
    engine,
    events,
    drive: (input: string) => engine.start(input, (e) => events.push(e)),
  };
}

/** 带 compaction 的小阈值测试 profile（阈值 = 1000 - reserveTokens）。 */
function compactionProfile(reserveTokens: number): AgentProfile {
  return {
    kind: "test-channel",
    systemPrompt: "测试系统提示",
    tools: [],
    lifecycle: { mode: "persistent" },
    hooks: [SteerHooks, MinimalHooks],
    compaction: { enabled: true, reserveTokens, keepRecentTokens: 100 },
  };
}

const LONG_TEXT = "这是一段被刻意拉长的回复正文。".repeat(80); // ~1280 字符 ≈ 320 tokens（字符启发式）
const MEDIUM_TEXT = "中等长度的回复正文。".repeat(24); // 240 字符 ≈ 60 tokens/turn，4 轮累计 ≈ 250 > 阈值 200

describe("T3.1 adapter：thinking 三事件转发不丢弃（回归锚 L103-108）", () => {
  test("thinking_start/delta/end 按序转发，先于文本 delta，payload 完整", async () => {
    const { streamFn } = makeFakeLLM([{ thinking: "先分析结构，再拆解步骤。", text: "正式回答。" }]);
    const { models } = makeFakeModels("摘要");
    const h = makeAdapter(compactionProfile(0), streamFn, models); // reserveTokens 0 → 永不触发

    await h.drive("你好");

    const types = h.events.map((e) => e.type);
    const started = types.indexOf("thinking_started");
    const firstText = types.indexOf("message_update");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(firstText).toBeGreaterThan(started);

    const deltas = h.events.filter((e) => e.type === "thinking_delta");
    expect(deltas.map((e) => (e as { delta: string }).delta).join("")).toBe("先分析结构，再拆解步骤。");

    const end = h.events.find((e) => e.type === "thinking_end") as { content: string; contentIndex: number };
    expect(end.content).toBe("先分析结构，再拆解步骤。");
    expect(end.contentIndex).toBe(0);
    expect((h.events.find((e) => e.type === "thinking_started") as { contentIndex: number }).contentIndex).toBe(0);
  });
});

describe("T3.1 adapter：message_end usage 七字段提取（cost 拍平）", () => {
  test("assistant message_end 携带 usage{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost}", async () => {
    const { streamFn } = makeFakeLLM([{ thinking: "思考。", text: "答案。" }]);
    const { models } = makeFakeModels("摘要");
    const h = makeAdapter(compactionProfile(0), streamFn, models);

    await h.drive("你好");

    const end = h.events.find(
      (e) => e.type === "message_end" && (e as { role: string }).role === "assistant",
    ) as { usage?: Record<string, unknown>; text: string };
    expect(end.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 3,
      reasoning: 5,
      totalTokens: 18,
      cost: 0.5,
    });
    // thinking 块不污染消息文本（textOfContent：thinking 块贡献空串）
    expect(end.text).toBe("答案。");
  });
});

describe("T3.1 runtime：turn 边界 compaction 全链（小阈值触发）", () => {
  test("超阈值 → compaction_completed 携带四字段 + 后续 prompt 上下文变 summary+retainedTail", async () => {
    // 4 轮回复累计 ≈ 250 tokens > 阈值 200（cw 1000 - reserve 800）→ 第 4 轮 turn 边界触发；
    // keepRecent 100 → 保留尾部 ~2-3 条，早期历史进摘要（真实下降非同量置换）
    const { streamFn, seenContexts } = makeFakeLLM([
      { thinking: "", text: MEDIUM_TEXT, withUsage: false },
      { thinking: "", text: MEDIUM_TEXT, withUsage: false },
      { thinking: "", text: MEDIUM_TEXT, withUsage: false },
      { thinking: "", text: MEDIUM_TEXT, withUsage: false },
      { thinking: "", text: "压缩后的短回复。", withUsage: false },
    ]);
    const { models, calls } = makeFakeModels("【摘要】此前对话讨论了测试主题。代号 MARLIN-77 已记录。");
    const h = makeAdapter(compactionProfile(800), streamFn, models);

    await h.drive("第一问");
    await h.drive("第二问");
    await h.drive("第三问");
    await h.drive("第四问"); // 此轮 turn 边界触发 compaction
    expect(calls.length).toBeGreaterThanOrEqual(1); // 摘要调用真实发生

    const compacted = h.events.find((e) => e.type === "compaction_completed") as {
      tokensBefore: number;
      tokensAfter: number;
      summary: string;
      usage?: Record<string, number>;
    };
    expect(compacted).toBeDefined();
    expect(compacted.tokensBefore).toBeGreaterThan(compacted.tokensAfter);
    expect(compacted.summary).toContain("MARLIN-77");
    expect(compacted.usage).toMatchObject({ input: expect.any(Number), totalTokens: expect.any(Number) });

    // 会话可继续：下一问的 provider 上下文 = 压缩后窗口（compaction 摘要以
    // user 消息形式打头——pi convertToLlm 转换，summary 内容可达 provider）
    await h.drive("第五问");
    expect(seenContexts.length).toBe(5);
    const after = seenContexts[4]!.messages as unknown as {
      role: string;
      content?: { type: string; text?: string }[];
    }[];
    expect(after[0]!.role).toBe("user");
    expect(JSON.stringify(after[0])).toContain("MARLIN-77");
    // 压缩前全量历史（4 轮 8 条）比压缩后 prompt（summary+尾部+新问）短不了多少也要短
    const beforeChars = JSON.stringify(seenContexts[3]!.messages).length;
    const afterChars = JSON.stringify(after).length;
    expect(afterChars).toBeLessThan(beforeChars);
  });

  test("compaction 摘要失败（provider 抛错）→ engine_error 事件 + 会话无损可继续", async () => {
    const { streamFn, seenContexts } = makeFakeLLM([
      { thinking: "", text: LONG_TEXT, withUsage: false }, // ≈ 320 tokens > 200 阈值 → 触发
      { thinking: "", text: "失败后的继续回复。" },
    ]);
    const { models } = makeFakeModels("摘要", { failWith: new Error("provider summarization down") });
    const h = makeAdapter(compactionProfile(800), streamFn, models);

    await h.drive("第一问");
    const err = h.events.find((e) => e.type === "engine_error") as { message: string };
    expect(err).toBeDefined();
    expect(err.message).toContain("provider summarization down");
    // 未收到 compaction_completed（失败不产生完成事件）
    expect(h.events.find((e) => e.type === "compaction_completed")).toBeUndefined();

    // 会话无损：继续对话正常完成（上下文未被破坏）
    await h.drive("第二问");
    expect(seenContexts.length).toBe(2);
    expect(seenContexts[1]!.messages.length).toBeGreaterThan(0);
    const end = h.events.filter(
      (e) => e.type === "message_end" && (e as { role: string }).role === "assistant",
    );
    expect((end.at(-1) as { text: string }).text).toBe("失败后的继续回复。");
  });
});

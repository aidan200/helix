import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import type { StewardToolSpec } from "../../src/application/ports/outbound/StewardToolSpec";
import { buildStewardEngine } from "../../src/adapters/driven/steward/StewardEngineBuilder";

/**
 * 管家引擎构造配方集成（段B）：唯一配方 buildStewardEngine 的同轨行为锚——
 * 生产装配与测试共用本配方，本套断言 = 管家形态的关键轨道件（挂闸确认链 /
 * 事件块集载荷 / followUp 队列语义 / 跨 run 常驻监听）。
 */

const fakeModel = {
  id: "model",
  name: "Fake",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "x",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 8192,
} as never;
const fakeModels = {
  getModel: () => fakeModel,
  getModels: () => [fakeModel],
  streamSimple: () => {
    throw new Error("不应走到真实流");
  },
} as never;

/** 块形剧本 → pi StreamFn（管家测试剧本通道的标准合成器）。 */
function blockScriptStream(rounds: readonly { text?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown> } }[]) {
  let call = 0;
  return (): ReturnType<typeof createAssistantMessageEventStream> => {
    const round = rounds[call++] ?? { text: "（剧本耗尽）" };
    const content: Record<string, unknown>[] = [];
    if (round.toolCall !== undefined) {
      content.push({ type: "toolCall", id: round.toolCall.id, name: round.toolCall.name, arguments: round.toolCall.args ?? {} });
    } else {
      content.push({ type: "text", text: round.text ?? "" });
    }
    const stopReason = round.toolCall !== undefined ? "toolUse" : "stop";
    const message = {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "fake",
      model: "model",
      stopReason,
      timestamp: Date.now(),
    } as never;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      if (round.toolCall === undefined && round.text !== undefined) {
        stream.push({ type: "text_delta", contentIndex: 0, delta: round.text, partial: message });
      }
      stream.push({ type: "done", reason: stopReason, message });
    })();
    return stream;
  };
}

function specOf(name: string): StewardToolSpec {
  return {
    name,
    description: name,
    parameters: { type: "object" },
    execute: async () => ({ text: `${name} 执行结果` }),
  };
}

async function until(predicate: () => boolean, ms = 2000, what = "条件"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("StewardEngineBuilder：管家引擎配方（段B 同轨）", () => {
  test("E1 挂闸确认链：propose 工具挂闸 → engine_paused 携 args → resume(resolve) → 结果入账 + run 终结 + 常驻监听全程可见", async () => {
    const events: AgentEngineEvent[] = [];
    const engine = buildStewardEngine({
      model: fakeModel,
      apiKeys: { fake: "key" },
      models: fakeModels,
      tools: [specOf("propose_send"), specOf("memory_query")],
      gatedTools: new Set(["propose_send"]),
      persistentListener: (e) => events.push(e),
      streamFnOverride: blockScriptStream([
        { toolCall: { id: "tc-1", name: "propose_send", args: { agentId: "a1", message: "提案" } } },
        { text: "不应到达（resolve 终结零续跑）" },
      ]) as never,
    });
    const run = engine.start("去提案", () => undefined);
    await until(() => events.some((e) => e.type === "engine_paused"), 3000, "engine_paused");
    const paused = events.find((e) => e.type === "engine_paused") as Extract<AgentEngineEvent, { type: "engine_paused" }>;
    expect(paused.toolName).toBe("propose_send");
    expect(paused.args).toMatchObject({ agentId: "a1" }); // 桥透传原始 args（管家校验面消费）
    await engine.resume(paused.pauseToken, { kind: "resolve", text: "确认执行完毕", isError: false });
    await run;
    const ends = events.filter((e): e is Extract<AgentEngineEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end");
    expect(ends[0]?.result).toBe("确认执行完毕"); // resolve 文案入账（isError 强制 true 为声明偏差）
    expect(ends[0]?.isError).toBe(true);
    expect(events.some((e) => e.type === "message_end" && e.role === "assistant" && e.text === "不应到达（resolve 终结零续跑）")).toBe(false); // 零续跑
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  test("E2 非挂闸工具直行 + assistant 块集载荷（toolCall 块进 message_end.blocks——dialog 投影精度面）", async () => {
    const events: AgentEngineEvent[] = [];
    const engine = buildStewardEngine({
      model: fakeModel,
      apiKeys: { fake: "key" },
      models: fakeModels,
      tools: [specOf("memory_query")],
      gatedTools: new Set(["propose_send"]),
      persistentListener: (e) => events.push(e),
      streamFnOverride: blockScriptStream([
        { toolCall: { id: "tc-2", name: "memory_query", args: { q: "x" } } },
        { text: "查完了" },
      ]) as never,
    });
    await engine.start("查记忆", () => undefined);
    await until(() => events.some((e) => e.type === "agent_end"), 3000, "agent_end");
    // 工具真执行（无闸）+ toolResult 配对锚载荷
    const ends = events.filter((e): e is Extract<AgentEngineEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end");
    expect(ends[0]?.result).toBe("memory_query 执行结果");
    expect(ends[0]?.isError).not.toBe(true);
    const toolResultMsg = events.find((e) => e.type === "message_end" && e.role === "toolResult") as Extract<AgentEngineEvent, { type: "message_end" }>;
    expect(toolResultMsg?.toolCallId).toBe("tc-2"); // 段B additive 配对锚
    expect(toolResultMsg?.toolName).toBe("memory_query");
    // assistant 块集：工具轮消息的 blocks 携 toolCall 块（args 词典）
    const assistantMsgs = events.filter((e): e is Extract<AgentEngineEvent, { type: "message_end" }> => e.type === "message_end" && e.role === "assistant");
    expect(assistantMsgs[0]?.blocks).toEqual([{ type: "toolCall", id: "tc-2", name: "memory_query", args: { q: "x" } }]);
  });

  test("E3 空闸集不装闸（gatedTools 空 = approvalGate 缺席——配方裁剪面）", async () => {
    const events: AgentEngineEvent[] = [];
    const engine = buildStewardEngine({
      model: fakeModel,
      apiKeys: { fake: "key" },
      models: fakeModels,
      tools: [specOf("memory_query")],
      gatedTools: new Set(),
      persistentListener: (e) => events.push(e),
      streamFnOverride: blockScriptStream([{ text: "直答" }]) as never,
    });
    await engine.start("问", () => undefined);
    await until(() => events.some((e) => e.type === "agent_end"), 3000, "agent_end");
    expect(events.some((e) => e.type === "engine_paused")).toBe(false);
    await expect(engine.resume("any", { kind: "approve" })).rejects.toThrow(/审批闸/); // 未装闸面恒报错
  });
});

import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";

/**
 * followUp 面集成（管家批段B additive——pi 原生队列语义）：
 * - 活跃 run 在 turn 边界 drain（steering 优先）——入队消息成为当前 run 的
 *   后续 turn 输入（不自动开新 run）；
 * - idle 后队列存活，由下一次 start() 驱动消费；
 * - 跨 run 事件经 persistentListener 可见（start() 的逐 run listener 在 run
 *   收口后置空——后续事件只有常驻面能收到）。
 *
 * 与 steer 的差异锚：steer 混入 drain 优先级高且事件面标 source="steer-drain"；
 * followUp 优先级低、drain 消息 source="prompt"（pi 事件面无 drain 源标记）。
 */

/** 剧本面：调用序回放预制文本轮（pi GoldenScenario 同源的轻量版）。 */

const fakeModel = {
  id: "model",
  name: "Fake",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as never;

const fakeModels = {
  getModel: () => fakeModel,
  getModels: () => [fakeModel],
  streamSimple: () => {
    throw new Error("不应走到真实流");
  },
} as never;

function buildEngine(
  rounds: readonly string[],
  persistentListener: (e: AgentEngineEvent) => void,
  delays?: readonly number[],
): PiAgentEngineAdapter {
  let call = 0;
  const streamFn = (): ReturnType<typeof createAssistantMessageEventStream> => {
    const text = rounds[call] ?? "（剧本耗尽）";
    const delay = delays?.[call] ?? 0;
    call++;
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "fake",
      model: "model",
      stopReason: "stop",
      timestamp: Date.now(),
    } as never;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay)); // 受控在途窗口
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
  return new PiAgentEngineAdapter({
    profile: {
      kind: "test",
      systemPrompt: "follow-up 集成",
      tools: [],
      lifecycle: { mode: "persistent" },
      hooks: [SteerHooks],
    } satisfies AgentProfile,
    model: fakeModel,
    apiKeys: { fake: "key" },
    models: fakeModels,
    streamFnOverride: streamFn as never,
    persistentListener,
  });
}

/** 等待谓词成立（超时即败——后继 run 异步自动开的收口面）。 */
async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时（后继 run 未收口）");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("followUp 面（pi 引擎，管家批段B）", () => {
  test("F1 运行中入队 → 当前 run 的 turn 边界 drain 消费（不自动开新 run；persistentListener 跨 run 可见）", async () => {
    const events: AgentEngineEvent[] = [];
    const engine = buildEngine(["第一问答案", "第二问答案"], (e) => events.push(e), [60, 0]);
    let firstRunSettled = false;
    const run1 = engine.start("第一问", () => undefined).then(() => {
      firstRunSettled = true;
    });
    // run 1 在途时入队（首帧事件到达即视为在途）
    await until(() => events.some((e) => e.type === "agent_start"));
    engine.followUp!("第二问");
    await run1;
    expect(firstRunSettled).toBe(true);
    // pi 原生语义：入队消息在当前 run 的 turn 边界 drain（单一 run 收容两问）
    await until(() => events.some((e) => e.type === "agent_end"));
    expect(events.filter((e) => e.type === "agent_start")).toHaveLength(1);
    // 两个 user 消息都 source="prompt"（followUp drain 无源标记）
    const userPrompts = events.filter((e) => e.type === "message_start" && e.role === "user");
    expect(userPrompts).toHaveLength(2);
    for (const e of userPrompts) {
      expect(e.type === "message_start" && e.source).toBe("prompt");
    }
    // 两轮答案都出（剧本全消费）
    const texts = events.filter((e) => e.type === "message_end" && e.role === "assistant").map((e) => (e.type === "message_end" ? e.text : ""));
    expect(texts).toContain("第一问答案");
    expect(texts).toContain("第二问答案");
    expect(engine.isStreaming()).toBe(false);
  });

  test("F2 idle 态入队 → 队列存活不自动开 run；下一次 start() 驱动时作为 drain 轮消费", async () => {
    const events: AgentEngineEvent[] = [];
    const engine = buildEngine(["首答", "追问答案"], (e) => events.push(e));
    await engine.start("首问", () => undefined);
    await until(() => events.some((e) => e.type === "agent_end"));
    // idle 入队：不自动开 run（等待窗口零新事件）
    engine.followUp!("追问");
    const settles = events.filter((e) => e.type === "agent_end").length;
    await new Promise((r) => setTimeout(r, 150));
    expect(events.filter((e) => e.type === "agent_start")).toHaveLength(1); // 无自动新 run
    // 下一次 start 驱动：入队消息作为 drain 轮在同一 run 内消费
    await engine.start("下一主动问", () => undefined);
    await until(() => events.filter((e) => e.type === "agent_end").length >= settles + 1);
    const userTexts = events.filter((e) => e.type === "message_end" && e.role === "user").map((e) => (e.type === "message_end" ? e.text : ""));
    expect(userTexts).toContain("下一主动问");
    expect(userTexts).toContain("追问");
    expect(events.some((e) => e.type === "message_end" && e.role === "assistant" && e.text === "追问答案")).toBe(true);
  });

  test("F3 无 SteerHooks 的 profile → followUp 显式报错（守卫面同 steer）", () => {
    const engine = new PiAgentEngineAdapter({
      profile: {
        kind: "test",
        systemPrompt: "无钩子",
        tools: [],
        lifecycle: { mode: "persistent" },
        hooks: [],
      } satisfies AgentProfile,
      model: fakeModel,
      apiKeys: { fake: "key" },
      models: fakeModels,
      streamFnOverride: (() => {
        throw new Error("不应驱动");
      }) as never,
    });
    expect(() => engine.followUp!("x")).toThrow("followUp");
  });
});

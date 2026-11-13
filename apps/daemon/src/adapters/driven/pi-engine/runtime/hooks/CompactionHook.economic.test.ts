import { describe, expect, test } from "bun:test";
import type { Agent, PrepareRequestContext } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { CompactionOutcome } from "./CompactionHook";
import { CompactionHook } from "./CompactionHook";
import type { CompactionSettings } from "../AgentProfile";

/**
 * CompactionHook 经济水位（economicCeiling）单测：
 * 分层计价模型（cost.tiers[].inputTokensAbove）提前触发压缩——
 * min(防溢出线, 经济线) 语义；无 tiers 模型回落纯防溢出线（现状保留）；
 * 显式覆盖位 economicCeilingTokens 优先于 tiers 推导。
 * 摘要调用经 summarizeRequest 替身（request 档同构面，不走真 Models）。
 */

/** 超阈值对话构造：n 对 user/assistant 长文本对（估算 token 随 n 线性）。 */
function longMessages(pairs: number): AgentMessage[] {
  const long = "x".repeat(600);
  const messages: AgentMessage[] = [{ role: "system", content: "SYS_PROMPT", timestamp: 1 } as never];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `${long}#${i}` }], timestamp: i * 2 + 2 } as never);
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `${long}@${i}` }],
      stopReason: "stop",
      timestamp: i * 2 + 3,
    } as never);
  }
  return messages;
}

/** 基线 settings：reserveTokens=500（ctx 1_000 → 防溢出线 500）。
 *  messages(2) ≈ 2 对 × ~300token ≈ 600+，messages(0) ≈ ~10。 */
const settings: CompactionSettings = { enabled: true, reserveTokens: 500, keepRecentTokens: 20 };

/** 分层计价模型：ctx 1_000、经济线 300（inputTokensAbove）。 */
const tieredModel = {
  provider: "stub",
  id: "tiered-model",
  name: "Tiered",
  api: "pi-messages",
  contextWindow: 1_000,
  maxTokens: 4_096,
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 300, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
} as never as Model<any>;

/** 无 tiers 模型（现状行为保留组）。 */
const flatModel = {
  provider: "stub",
  id: "flat-model",
  name: "Flat",
  api: "pi-messages",
  contextWindow: 1_000,
  maxTokens: 4_096,
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
} as never as Model<any>;

const fakeModels = {} as Models;

function fakeAgent(messages: AgentMessage[], model: Model<any>): Agent {
  return {
    state: {
      model,
      messages,
      tools: [],
    },
  } as never as Agent;
}

function fakeRequest(messages: AgentMessage[], model: Model<any>): PrepareRequestContext {
  return {
    context: { messages, tools: [] },
    model,
    thinkingLevel: "off",
  } as never as PrepareRequestContext;
}

function stubSummarize() {
  return async () => ({
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text: "SUMMARY_TEXT" }],
    usage: { input: 1, output: 2, totalTokens: 3, cost: { input: 0, output: 0, total: 0 } },
  });
}

function buildHook(over: Partial<ConstructorParameters<typeof CompactionHook>[0]> = {}) {
  const outcomes: CompactionOutcome[] = [];
  const failures: string[] = [];
  const hook = new CompactionHook({
    settings,
    models: fakeModels,
    model: tieredModel,
    trigger: "request",
    summarizeRequest: stubSummarize() as never,
    onCompleted: (o) => outcomes.push(o),
    onFailed: (m) => failures.push(m),
    ...over,
  });
  return { hook, outcomes, failures };
}

describe("CompactionHook 经济水位（economicCeiling）", () => {
  test("分层计价模型超经济线（未超防溢出线）→ 触发压缩", async () => {
    // messages(1) ≈ 310 token：> 经济线 300、< 防溢出线 500——现状不触发，经济水位应触发
    const { hook, outcomes, failures } = buildHook();
    const messages = longMessages(1);
    hook.bind(fakeAgent(messages, tieredModel));
    const update = await hook.prepareRequest(fakeRequest(messages, tieredModel));
    expect(failures).toHaveLength(0);
    expect(outcomes).toHaveLength(1);
    expect(update).toBeDefined();
  });

  test("分层计价模型在经济线下 → 不触发（现状行为保留）", async () => {
    // messages(0) ≈ ~10 token：< 经济线 300——不触发
    const { hook, outcomes } = buildHook();
    const messages = longMessages(0);
    hook.bind(fakeAgent(messages, tieredModel));
    expect(await hook.prepareRequest(fakeRequest(messages, tieredModel))).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  test("无 tiers 模型 → 回落纯防溢出线（经济线不生效）", async () => {
    // messages(2) ≈ 600：> 经济线 300 但模型无 tiers——不应因经济线触发；
    // 但 600 > 防溢出线 500，防溢出线自己会触发——用 messages(1) ≈ ~300 隔离：
    // < 防溢出线（500）且无经济线 → 不触发
    const { hook, outcomes } = buildHook({ model: flatModel });
    const messages = longMessages(1);
    hook.bind(fakeAgent(messages, flatModel));
    expect(await hook.prepareRequest(fakeRequest(messages, flatModel))).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  test("防溢出线低于经济线 → 防溢出线优先（min 语义）", async () => {
    // ctx 1_000/reserve 500 → 防溢出线 500 < 经济线 300？否——本组反向构造：
    // 紧窗口模型（ctx 700 → 防溢出线 200 < 经济线 300），messages(1) ≈ 300 > 200：
    // 两线均超、防溢出线先到——触发（min 语义下防溢出线更低时由它决定）
    const tightModel = {
      ...tieredModel,
      contextWindow: 700,
    } as never as Model<any>;
    const { hook, outcomes } = buildHook({ model: tightModel });
    const messages = longMessages(1);
    hook.bind(fakeAgent(messages, tightModel));
    await hook.prepareRequest(fakeRequest(messages, tightModel));
    expect(outcomes).toHaveLength(1);
  });

  test("显式覆盖位 economicCeilingTokens 优先于 tiers 推导", async () => {
    // 覆盖 100：messages(1) ≈ 300 > 100 → 触发（tiers 线 300 不到，覆盖线更低生效）
    const { hook, outcomes } = buildHook({ settings: { ...settings, economicCeilingTokens: 100 } });
    const messages = longMessages(1);
    hook.bind(fakeAgent(messages, tieredModel));
    await hook.prepareRequest(fakeRequest(messages, tieredModel));
    expect(outcomes).toHaveLength(1);
  });

  test("覆盖位为 0 → 关闭经济线（回落纯防溢出线）", async () => {
    // 0 = 显式关闭（0 不是合法触发线——一切 token 都超 0，语义荒谬；约定 0=off）
    const { hook, outcomes } = buildHook({ settings: { ...settings, economicCeilingTokens: 0 } });
    const messages = longMessages(1);
    hook.bind(fakeAgent(messages, tieredModel));
    // messages(1) ≈ 300 < 防溢出线 500 → 不触发
    expect(await hook.prepareRequest(fakeRequest(messages, tieredModel))).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  test("换模跟随：现场模型换到无 tiers → 回落纯防溢出线", async () => {
    // agent.state.model（现场）= flatModel（deps.model 兜底 = tieredModel）
    const { hook, outcomes } = buildHook({ model: tieredModel });
    const messages = longMessages(1); // ≈ 300：< 防溢出线 500
    hook.bind(fakeAgent(messages, flatModel)); // 现场换 flat
    expect(await hook.prepareRequest(fakeRequest(messages, flatModel))).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  test("多 tiers 取最低门槛（最保守最早触发）", async () => {
    const multiTierModel = {
      ...tieredModel,
      cost: {
        ...tieredModel.cost,
        tiers: [
          { inputTokensAbove: 800, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
          { inputTokensAbove: 250, input: 8, output: 20, cacheRead: 0.4, cacheWrite: 10 },
        ],
      },
    } as never as Model<any>;
    // messages(1) ≈ 300 > 最低门槛 250 → 触发
    const { hook, outcomes } = buildHook({ model: multiTierModel });
    const messages = longMessages(1);
    hook.bind(fakeAgent(messages, multiTierModel));
    await hook.prepareRequest(fakeRequest(messages, multiTierModel));
    expect(outcomes).toHaveLength(1);
  });
});

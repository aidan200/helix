import { describe, expect, test } from "bun:test";
import type { Agent, PrepareRequestContext } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { CompactionOutcome } from "./CompactionHook";
import { CompactionHook } from "./CompactionHook";
import type { CompactionSettings } from "../AgentProfile";

/**
 * CompactionHook request 档单测（钩子位批）：transformContext → prepareRequest
 * 迁移后的行为保持——门卫、触发判定、重建上下文（leading system 保留 +
 * compactionSummary + retainedTail）、state 双写、失败降级。
 * 摘要调用经 summarizeRequest 替身（管家单轮 LLM port 同构面），不走真 Models。
 */

/** 超阈值对话：leading system + 长文本 user/assistant 对（>2000 字符 → >500 估算 token）。 */
function overThresholdMessages(): AgentMessage[] {
  const long = "x".repeat(600);
  const messages: AgentMessage[] = [{ role: "system", content: "SYS_PROMPT", timestamp: 1 } as never];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `${long}#${i}` }], timestamp: i + 2 } as never);
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `${long}@${i}` }],
      stopReason: "stop",
      timestamp: i + 3,
    } as never);
  }
  return messages;
}

const settings: CompactionSettings = { enabled: true, reserveTokens: 500, keepRecentTokens: 20 };

const fakeModel = {
  provider: "stub",
  id: "stub-model",
  name: "Stub",
  api: "pi-messages",
  contextWindow: 1_000,
  maxTokens: 4_096,
} as never as Model<any>;

const fakeModels = {} as Models;

function fakeAgent(messages: AgentMessage[]): Agent {
  return {
    state: {
      model: fakeModel,
      messages,
      tools: [],
    },
  } as never as Agent;
}

function fakeRequest(messages: AgentMessage[]): PrepareRequestContext {
  return {
    context: { messages, tools: [] },
    model: fakeModel,
    thinkingLevel: "off",
  } as never as PrepareRequestContext;
}

/** summarizeRequest 替身：可编程 stopReason/content（generateSummaryWithRequest 契约形状；
 *  usage 须带 cost——vendored usage 加法读 cost.input）。 */
function stubSummarize(stopReason: "stop" | "error" = "stop") {
  return async () => ({
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "boom" } : {}),
    content: [{ type: "text" as const, text: "SUMMARY_TEXT" }],
    usage: { input: 1, output: 2, totalTokens: 3, cost: { input: 0, output: 0, total: 0 } },
  });
}

function buildHook(over: Partial<Parameters<typeof CompactionHook.prototype.prepareRequest> extends never ? never : ConstructorParameters<typeof CompactionHook>[0]> = {}) {
  const outcomes: CompactionOutcome[] = [];
  const failures: string[] = [];
  const hook = new CompactionHook({
    settings,
    models: fakeModels,
    model: fakeModel,
    trigger: "request",
    summarizeRequest: stubSummarize() as never,
    onCompleted: (o) => outcomes.push(o),
    onFailed: (m) => failures.push(m),
    ...over,
  });
  return { hook, outcomes, failures };
}

describe("CompactionHook request 档（prepareRequest 挂点）", () => {
  test("trigger 缺省（turn 档）→ prepareRequest 恒 undefined", async () => {
    const { hook } = buildHook({ trigger: undefined, summarizeRequest: stubSummarize() as never });
    hook.bind(fakeAgent(overThresholdMessages()));
    expect(await hook.prepareRequest(fakeRequest(overThresholdMessages()))).toBeUndefined();
  });

  test("未 bind → 安全降级 undefined", async () => {
    const { hook } = buildHook();
    expect(await hook.prepareRequest(fakeRequest(overThresholdMessages()))).toBeUndefined();
  });

  test("未超阈值 → undefined（不触发压缩）", async () => {
    const { hook, outcomes } = buildHook();
    const short: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } as never];
    const agent = fakeAgent(short);
    hook.bind(agent);
    expect(await hook.prepareRequest(fakeRequest(short))).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  test("超阈值 → 重建上下文 + state 双写 + onCompleted", async () => {
    const { hook, outcomes, failures } = buildHook();
    const messages = overThresholdMessages();
    const agent = fakeAgent(messages);
    hook.bind(agent);
    const update = await hook.prepareRequest(fakeRequest(messages));
    expect(failures).toHaveLength(0);
    expect(outcomes).toHaveLength(1);
    // split-turn 路径（切点落在 turn 内）摘要 = 历史 + Turn Context 拼接——toContain 兼容两形态
    expect(outcomes[0]!.summary).toContain("SUMMARY_TEXT");
    expect(update).toBeDefined();
    const rebuilt = update?.context?.messages ?? [];
    // leading system 保留 + compactionSummary 消息在场（role 标识）
    expect(rebuilt[0]?.role).toBe("system");
    expect((rebuilt[1] as { role?: string } | undefined)?.role).toBe("compactionSummary");
    // state 双写（跨 run 持久——与 turn 档同口径）
    expect(agent.state.messages).toEqual(rebuilt);
    expect(rebuilt.length).toBeLessThan(messages.length);
  });

  test("摘要替身失败 → undefined + onFailed（不崩会话）", async () => {
    const { hook, outcomes, failures } = buildHook({ summarizeRequest: stubSummarize("error") as never });
    const messages = overThresholdMessages();
    hook.bind(fakeAgent(messages));
    expect(await hook.prepareRequest(fakeRequest(messages))).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(outcomes).toHaveLength(0);
    expect(messages.length).toBe(17); // 原上下文不动（state 未被双写破坏）
  });

  // ── 事故热修批⑤：空输入守卫（零 LLM 零写入） ───────────────────

  test("【事故热修⑤】空对话（仅 system）超阈值 → 跳过压缩：零摘要调用零 onCompleted，原窗口不动", async () => {
    let summarizeCalls = 0;
    const { hook, outcomes, failures } = buildHook({
      summarizeRequest: (async () => {
        summarizeCalls += 1;
        return (await stubSummarize()()) as never;
      }) as never,
    });
    // 空对话形态：仅 leading system（管家首轮事故形态——system prompt +
    // 工具声明很大，在阈值紧时 est 超阈触发检查）
    const empty: AgentMessage[] = [
      { role: "system", content: "SYS_PROMPT_" + "x".repeat(900), timestamp: 1 } as never,
    ];
    const agent = fakeAgent(empty);
    hook.bind(agent);
    const update = await hook.prepareRequest(fakeRequest(empty));
    expect(update).toBeUndefined(); // 不触发压缩
    expect(summarizeCalls).toBe(0); // 零 LLM
    expect(outcomes).toHaveLength(0); // 零写入（onCompleted 零上抛）
    expect(failures).toHaveLength(0); // 也不是失败（正常跳过）
    expect(agent.state.messages).toEqual(empty); // 原窗口不动
  });

  test("【事故热修⑤】空文本 user 轮不构成实质内容（trim 判定）；有实质内容的长窗口压缩照常（既有超阈值用例覆盖）", async () => {
    const { hook: hookEmpty, outcomes: outcomesEmpty } = buildHook();
    const blankUser: AgentMessage[] = [
      { role: "system", content: "SYS_" + "x".repeat(900), timestamp: 1 } as never,
      { role: "user", content: [{ type: "text", text: "   " }], timestamp: 2 } as never,
    ];
    hookEmpty.bind(fakeAgent(blankUser));
    expect(await hookEmpty.prepareRequest(fakeRequest(blankUser))).toBeUndefined();
    expect(outcomesEmpty).toHaveLength(0);
    // 对照：同阈值下有实质内容（既有 overThreshold 形态裁短版）不触发守卫
    const { hook: hookReal, outcomes: outcomesReal } = buildHook();
    const real: AgentMessage[] = [
      { role: "system", content: "SYS_" + "x".repeat(900), timestamp: 1 } as never,
      { role: "user", content: [{ type: "text", text: "x".repeat(600) }], timestamp: 2 } as never,
      { role: "assistant", content: [{ type: "text", text: "x".repeat(600) }], stopReason: "stop", timestamp: 3 } as never,
      ...Array.from({ length: 7 }, (_, i) => ({ role: "user", content: [{ type: "text", text: `${"x".repeat(600)}#${i}` }], timestamp: 4 + i * 2 } as never)),
    ];
    hookReal.bind(fakeAgent(real));
    await hookReal.prepareRequest(fakeRequest(real));
    expect(outcomesReal).toHaveLength(1); // 有实质内容照常压缩（守卫零误杀）
  });
});

import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "../../src/adapters/driven/pi-engine/runtime/AgentRuntime";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import type { HookSet } from "../../src/adapters/driven/pi-engine/runtime/HookSet";

/**
 * beforeToolCall 链组合语义（低危批）：**首个 block 结果**短路，非「首个非空结果」。
 *
 * 契约来源 = HookSet.ts 位注释与 E-72（beforeToolCall 链上首个 block 短路）。
 * 旧实现 `if (result) return result` 让任何 `{ block: false }`（显式放行）也截断链路
 * ——排后的审批闸（ApprovalGateHook 类）被静默跳过 = 审批旁路。
 */

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
} as unknown as Model<any>;

function assistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 剧本式 streamFn：第一次吐工具调用，第二次收口。 */
function scriptedLLM(): StreamFn {
  let call = 0;
  const script = [
    assistant([{ type: "toolCall", id: "tc-1", name: "probe", arguments: { x: 1 } } as never], "toolCall"),
    assistant([{ type: "text", text: "收口" }], "stop"),
  ];
  return () => {
    const msg = script[call++] ?? script[1]!;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: (msg.stopReason ?? "stop") as never, message: msg });
    })();
    return stream;
  };
}

const profile: AgentProfile = {
  kind: "test-beforetoolcall-chain",
  systemPrompt: "test",
  tools: ["probe"],
  lifecycle: { mode: "single-shot" },
  hooks: [],
};

function probeTool(executed: { calls: number }) {
  return {
    name: "probe",
    label: "探针",
    description: "测试用探针工具",
    parameters: { type: "object", properties: { x: { type: "number" } } } as never,
    async execute() {
      executed.calls += 1;
      return { content: [{ type: "text" as const, text: "executed" }] };
    },
  };
}

function runtimeWith(hooks: readonly HookSet[], executed: { calls: number }): AgentRuntime {
  const tool = probeTool(executed);
  return new AgentRuntime(profile, {
    streamFn: scriptedLLM(),
    model: fakeModel,
    getApiKey: () => "key",
    resolveTools: () => [tool as never],
    extraHooks: hooks,
  });
}

/** 记录调用序的假钩子：beforeToolCall 返回注入结果。 */
function hook(
  name: string,
  trace: string[],
  result: { block: boolean; reason?: string } | undefined,
): HookSet & { staticName: string } {
  return {
    staticName: name,
    get name() {
      return name;
    },
    async beforeToolCall() {
      trace.push(name);
      return result;
    },
  } as unknown as HookSet & { staticName: string };
}

describe("AgentRuntime beforeToolCall 链（首个 block 短路，低危批）", () => {
  test("① 前序钩子返回 {block:false} → 不短路，排后钩子仍执行且其 block 生效", async () => {
    const trace: string[] = [];
    const executed = { calls: 0 };
    const runtime = runtimeWith(
      [hook("只放行", trace, { block: false }), hook("闸", trace, { block: true, reason: "审批未通过" })],
      executed,
    );
    await runtime.drive("go");
    expect(trace).toEqual(["只放行", "闸"]); // 旧实现（首个非空即返回）= ["只放行"]
    expect(executed.calls).toBe(0); // 闸的 block 生效，工具未执行
  });

  test("② 前序钩子返回 {block:true} → 短路：排后钩子不执行（首个 block 短路语义保留）", async () => {
    const trace: string[] = [];
    const executed = { calls: 0 };
    const runtime = runtimeWith(
      [hook("闸", trace, { block: true, reason: "先拒" }), hook("只放行", trace, { block: false })],
      executed,
    );
    await runtime.drive("go");
    expect(trace).toEqual(["闸"]);
    expect(executed.calls).toBe(0);
  });

  test("③ 全部钩子放行（undefined/false 混合）→ 工具真执行", async () => {
    const trace: string[] = [];
    const executed = { calls: 0 };
    const runtime = runtimeWith([hook("甲", trace, { block: false }), hook("乙", trace, undefined)], executed);
    await runtime.drive("go");
    expect(trace).toEqual(["甲", "乙"]);
    expect(executed.calls).toBe(1);
  });
});

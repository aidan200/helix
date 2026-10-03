import { describe, expect, test } from "bun:test";
import type {
  AgentRequestUpdate,
  AgentTool,
  AgentTurnContext,
  AgentTurnDecision,
  PrepareRequestContext,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentRuntime } from "./AgentRuntime";
import type { AgentProfile } from "./AgentProfile";
import type { HookSet } from "./HookSet";
import { SteerHooks } from "./hooks/SteerHooks";

/**
 * pi 0.87 新钩子位接线验证（钩子位批）：prepareRequest / finishTurn 经
 * HookSet 组合进 Agent options 的端到端生效——含首轮请求覆盖（prepareNextTurn
 * 的盲区）、context 替换透传、end 裁决短路、peekQueuedMessages 读面。
 *
 * 【为什么存在】组合器（combinePrepareRequest/combineFinishTurn）是
 * AgentRuntime 模块私有函数，接线正确性只能经真 Agent 驱动验证——
 * 单测钩子类（McpDeferredHooks.test 风格）覆盖不到「组合后接进了 loop」
 * 这一层。
 */

const stubModel = {
  provider: "stub",
  id: "stub-model",
  name: "Stub",
  api: "pi-messages",
  contextWindow: 100_000,
} as never as Model<any>;

/** 最小 assistant 消息（text 或 toolCall 内容）。 */
function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "pi-messages",
    provider: "stub",
    model: "stub-model",
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never as AssistantMessage;
}

/** 剧本式 streamFn：依序回放响应，记录每次请求收到的消息与全局时序。 */
function scriptedStream(responses: readonly AssistantMessage[], order: string[] = []) {
  const seenMessages: unknown[][] = [];
  let index = 0;
  const streamFn: StreamFn = (_model, context) => {
    order.push("stream");
    seenMessages.push(context.messages);
    const stream = createAssistantMessageEventStream();
    const message = responses[Math.min(index++, responses.length - 1)]!;
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  return { streamFn, order, seenMessages };
}

/** 探针钩子：记录两新钩子位的调用与时序（与 streamFn 共享 order），可注入返回值。 */
class ProbeHooks implements HookSet {
  readonly name = "probe";
  readonly requestCalls: PrepareRequestContext[] = [];
  readonly finishCalls: AgentTurnContext[] = [];
  requestUpdate?: (request: PrepareRequestContext) => AgentRequestUpdate | undefined;
  finishDecision?: AgentTurnDecision;
  constructor(private readonly order: string[] = []) {}
  async prepareRequest(request: PrepareRequestContext): Promise<AgentRequestUpdate | undefined> {
    this.order.push("prepareRequest");
    this.requestCalls.push(request);
    return this.requestUpdate?.(request);
  }
  async finishTurn(turn: AgentTurnContext): Promise<AgentTurnDecision | undefined> {
    this.order.push("finishTurn");
    this.finishCalls.push(turn);
    return this.finishDecision;
  }
}

const echoTool: AgentTool<any> = {
  label: "Echo",
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {} } as never,
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
};

function buildRuntime(
  streamFn: StreamFn,
  extraHooks: readonly HookSet[],
  profileHooks: AgentProfile["hooks"] = [],
  tools: readonly string[] = [],
): AgentRuntime {
  const profile: AgentProfile = {
    kind: "test",
    systemPrompt: "test prompt",
    tools,
    lifecycle: { mode: "single-shot" },
    hooks: profileHooks,
  };
  return new AgentRuntime(profile, {
    streamFn,
    model: stubModel,
    getApiKey: () => undefined,
    ...(tools.length > 0 ? { resolveTools: () => [echoTool] } : {}),
    extraHooks,
  });
}

describe("AgentRuntime pi 0.87 钩子位接线", () => {
  test("prepareRequest 覆盖首轮请求且时序在流式请求前", async () => {
    const order: string[] = [];
    const { streamFn } = scriptedStream([assistantMessage([{ type: "text", text: "hi" }])], order);
    const probe = new ProbeHooks(order);
    const runtime = buildRuntime(streamFn, [probe]);
    await runtime.drive("hello");
    // 首轮：prepareRequest 先于 stream（prepareNextTurn 不覆盖首轮——盲区由新位补齐）
    expect(order).toEqual(["prepareRequest", "stream", "finishTurn"]);
    expect(probe.requestCalls).toHaveLength(1);
    expect(probe.requestCalls[0]!.context.messages.length).toBeGreaterThan(0);
  });

  test("prepareRequest 返回 context 替换本次请求生效", async () => {
    const { streamFn, seenMessages } = scriptedStream([assistantMessage([{ type: "text", text: "done" }])]);
    const probe = new ProbeHooks();
    probe.requestUpdate = () => ({
      context: {
        messages: [
          { role: "user", content: [{ type: "text", text: "REPLACED_CANONICAL" }], timestamp: Date.now() } as never,
        ],
        tools: [],
      },
    });
    const runtime = buildRuntime(streamFn, [probe]);
    await runtime.drive("hello");
    // streamFn 收到替换后的 canonical messages（而非原始 prompt）
    expect(JSON.stringify(seenMessages[0] ?? [])).toContain("REPLACED_CANONICAL");
  });

  test("finishTurn end 裁决：带工具调用的轮被终止，无第二次请求", async () => {
    const { streamFn, seenMessages } = scriptedStream([
      assistantMessage([{ type: "toolCall", id: "t1", name: "echo", arguments: {} } as never]),
      assistantMessage([{ type: "text", text: "never" }]), // end 生效则不会到达
    ]);
    const probe = new ProbeHooks();
    probe.finishDecision = { action: "end" };
    const runtime = buildRuntime(streamFn, [probe], [], ["echo"]);
    await runtime.drive("hello");
    expect(seenMessages).toHaveLength(1); // 工具轮后本会自然继续——end 短路了第二次请求
    expect(probe.finishCalls).toHaveLength(1);
  });

  test("finishTurn undefined：自然调度——工具轮后继续，纯文本轮后停", async () => {
    const { streamFn, seenMessages } = scriptedStream([
      assistantMessage([{ type: "toolCall", id: "t1", name: "echo", arguments: {} } as never]),
      assistantMessage([{ type: "text", text: "all done" }]),
    ]);
    const probe = new ProbeHooks(); // 无决策 → 自然调度
    const runtime = buildRuntime(streamFn, [probe], [], ["echo"]);
    await runtime.drive("hello");
    expect(seenMessages).toHaveLength(2); // 工具结果驱动第二轮，文本轮自然停
    expect(probe.finishCalls).toHaveLength(2);
  });

  test("peekQueuedMessages：steer 后可预览、drive 消费后清空", async () => {
    const { streamFn } = scriptedStream([
      assistantMessage([{ type: "text", text: "first" }]),
      assistantMessage([{ type: "text", text: "second" }]),
    ]);
    const runtime = buildRuntime(streamFn, [], [SteerHooks]);
    runtime.steer("queued closure");
    expect(runtime.peekQueuedMessages()).toHaveLength(1);
    expect(JSON.stringify(runtime.peekQueuedMessages())).toContain("queued closure");
    await runtime.drive("go");
    expect(runtime.peekQueuedMessages()).toHaveLength(0); // turn 边界 drain 消费
  });
});

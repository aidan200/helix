import { describe, expect, test } from "bun:test";
import type { Agent, PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import { McpDeferredHooks } from "./McpDeferredHooks";

/**
 * McpDeferredHooks 单测：state.tools ↔ turn.context.tools 漂移检测与
 * 精准替换（只换 tools，systemPrompt/messages 保留 turn 现值）。
 */

function fakeTurn(toolNames: string[]): PrepareNextTurnContext {
  return {
    message: { role: "assistant", content: [] } as never,
    toolResults: [],
    context: {
      systemPrompt: "SP",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] } as never],
      tools: toolNames.map((name) => ({ name, description: "" }) as never),
    },
    newMessages: [],
  };
}

function fakeAgent(toolNames: string[]): Agent {
  let tools = toolNames.map((name) => ({ name, description: "" }) as never);
  return {
    state: {
      get tools() {
        return tools;
      },
      set tools(next: never[]) {
        tools = next;
      },
    },
  } as never as Agent;
}

describe("McpDeferredHooks", () => {
  test("未 bind → undefined（安全降级）", () => {
    expect(new McpDeferredHooks().prepareNextTurn(fakeTurn([]))).toBeUndefined();
  });

  test("无漂移 → undefined（零干扰路径）", () => {
    const hook = new McpDeferredHooks();
    const agent = fakeAgent(["bash", "fake__discover"]);
    hook.bind(agent);
    expect(hook.prepareNextTurn(fakeTurn(["bash", "fake__discover"]))).toBeUndefined();
  });

  test("漂移（物化新增）→ 替换 context.tools，保留 systemPrompt/messages", () => {
    const hook = new McpDeferredHooks();
    const agent = fakeAgent(["bash", "fake__discover"]);
    hook.bind(agent);
    // 物化链 setTools：state 追加两个具体工具
    (agent.state.tools as unknown[]).push({ name: "fake__echo" } as never, { name: "fake__ping" } as never);
    const update = hook.prepareNextTurn(fakeTurn(["bash", "fake__discover"]));
    expect(update).toBeDefined();
    const tools = update?.context?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual([
      "bash",
      "fake__discover",
      "fake__echo",
      "fake__ping",
    ]);
    expect(update!.context!.systemPrompt).toBe("SP");
    expect(update!.context!.messages).toHaveLength(1);
  });

  test("漂移（toggle 摘除，同名集缩小）→ 同样对齐", () => {
    const hook = new McpDeferredHooks();
    const agent = fakeAgent(["bash"]);
    hook.bind(agent);
    const update = hook.prepareNextTurn(fakeTurn(["bash", "web_search"]));
    expect((update?.context?.tools ?? []).map((t) => t.name)).toEqual(["bash"]);
  });
});

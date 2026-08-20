import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "../../src/adapters/driven/pi-engine/runtime/AgentRuntime";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { MinimalHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * M6 T2 state 直改三件套（照抄 set_model 六层链先例 AgentRuntime.setModel）：
 * - setTools(tools)：AgentTool[] 直改 AgentState.tools——能力+提示双料事实源
 *   （provider function calling 面与分发面读同一数组），下一 run 生效；
 * - setSystemPrompt(text)：直改 AgentState.systemPrompt，下一 run 生效；
 * - 机械判据（同 set_model 测试）：FakeLLM 捕获 streamFn 第二参 llmContext
 *   的 systemPrompt / tools 名单——run 级 context snapshot 已定格，
 *   in-flight run 不受影响，下一 run 起为新值。
 * - adapter 面：setTools(names) 经注入的 resolveTools（CoreToolExecutor 既有
 *   注入路径）解析成 AgentTool[]；未注入 resolveTools 的 adapter 明确报错。
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

function assistantMessage(text: string): AssistantMessage {
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

/** 捕获型 FakeLLM：记录每次请求的 llmContext（systemPrompt + tools 名单）。 */
function makeCapturingLLM(seen: Array<{ systemPrompt?: string; tools: string[] }>, chunkDelayMs = 4) {
  const streamFn: StreamFn = (model, context) => {
    const ctx = context as unknown as { systemPrompt?: string; tools?: Array<{ name: string }> };
    seen.push({ systemPrompt: ctx.systemPrompt, tools: (ctx.tools ?? []).map((t) => t.name) });
    const stream = createAssistantMessageEventStream();
    const final = assistantMessage(`ok@${model.id}`);
    void (async () => {
      stream.push({ type: "start", partial: final });
      await new Promise((r) => setTimeout(r, chunkDelayMs));
      stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
  return streamFn;
}

const TestProfile: AgentProfile = {
  kind: "test-state-mutation",
  systemPrompt: "初始系统提示",
  tools: ["bash", "grep"],
  lifecycle: { mode: "single-shot" },
  hooks: [new MinimalHooks()],
};

const tmpRoots: string[] = [];
const tmpCwd = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t2-state-"));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("AgentRuntime state 直改（setTools/setSystemPrompt，M6 T2）", () => {

  test("① 初始装配：profile.systemPrompt + resolveTools(names) 进入 llmContext", async () => {
    const executor = new CoreToolExecutor({ cwd: tmpCwd() });
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    const runtime = new AgentRuntime(TestProfile, {
      streamFn: makeCapturingLLM(seen),
      model: fakeModel,
      getApiKey: () => "k",
      resolveTools: (names) => executor.resolveTools(names),
    });
    await runtime.drive("q1");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.systemPrompt).toBe("初始系统提示");
    expect(seen[0]!.tools).toEqual(["bash", "grep"]);
  });

  test("② setSystemPrompt + setTools：下一 run 生效（in-flight 不变，机械判据同 set_model）", async () => {
    const executor = new CoreToolExecutor({ cwd: tmpCwd() });
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    const runtime = new AgentRuntime(TestProfile, {
      streamFn: makeCapturingLLM(seen, 40), // run 3 拉长时窗供 in-flight 直改
      model: fakeModel,
      getApiKey: () => "k",
      resolveTools: (names) => executor.resolveTools(names),
    });

    // run 1：初始值
    await runtime.drive("q1");
    expect(seen[0]!.systemPrompt).toBe("初始系统提示");
    expect(seen[0]!.tools).toEqual(["bash", "grep"]);

    // run 2 前直改：下一 run 起生效（systemPrompt 换文 + tools 收缩到 read）
    runtime.setSystemPrompt("刷新后的三段提示");
    runtime.setTools(executor.resolveTools(["read"]));
    await runtime.drive("q2");
    expect(seen[1]!.systemPrompt).toBe("刷新后的三段提示");
    expect(seen[1]!.tools).toEqual(["read"]); // 能力+提示双料同源：llmContext.tools 即分发面

    // in-flight 不变：run 3 进行中（context snapshot 已定格）直改 → 本 run 仍旧值
    const drive3 = runtime.drive("q3");
    await new Promise((r) => setTimeout(r, 10)); // 确认 streamFn 已被调用（快照已定）
    runtime.setSystemPrompt("run3 中的直改");
    runtime.setTools(executor.resolveTools(["bash"]));
    await drive3;
    expect(seen[2]!.systemPrompt).toBe("刷新后的三段提示"); // 本 run 仍旧值
    expect(seen[2]!.tools).toEqual(["read"]);
    // 下一 run 起新值
    await runtime.drive("q4");
    expect(seen[3]!.systemPrompt).toBe("run3 中的直改");
    expect(seen[3]!.tools).toEqual(["bash"]);
  });
});

describe("PiAgentEngineAdapter 直改面（M6 T2）", () => {
  test("③ setTools(names) 经注入 resolveTools 解析为 AgentTool[]；setSystemPrompt 透传", async () => {
    const executor = new CoreToolExecutor({ cwd: tmpCwd() });
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    const engine = new PiAgentEngineAdapter({
      profile: TestProfile,
      model: fakeModel,
      apiKeys: { anthropic: "sk-test" },
      streamFnOverride: makeCapturingLLM(seen),
      resolveTools: (names) => executor.resolveTools(names),
    });
    await engine.start("q1", () => undefined);
    expect(seen[0]!.tools).toEqual(["bash", "grep"]);

    engine.setSystemPrompt("adapter 直改提示");
    engine.setTools(["read", "grep"]);
    await engine.start("q2", () => undefined);
    expect(seen[1]!.systemPrompt).toBe("adapter 直改提示");
    expect(seen[1]!.tools).toEqual(["read", "grep"]);
    expect(engine.currentModel()).toBe("anthropic/fake-model");
  });

  test("④ 未注入 resolveTools 的 adapter：setTools 明确报错（fail-fast，不静默）", () => {
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    const engine = new PiAgentEngineAdapter({
      profile: { ...TestProfile, tools: [] },
      model: fakeModel,
      apiKeys: { anthropic: "sk-test" },
      streamFnOverride: makeCapturingLLM(seen),
    });
    expect(() => engine.setTools(["bash"])).toThrow(/resolveTools|工具/);
    // setSystemPrompt 不依赖 resolveTools：仍可用
    engine.setSystemPrompt("仅提示直改");
  });
});

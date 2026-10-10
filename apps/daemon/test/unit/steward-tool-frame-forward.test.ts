/**
 * 管家工具帧转发验证测试（steward.tool 两相帧——零覆盖段补位）。
 *
 * 背景：用户报障「光球上看不到正在调用的工具」。静态链路六段核查全通
 * （pi adapter tool_execution_start 转发 → persistentListener →
 * StewardService.forwardStreamCallbacks → ask events → WS steward.tool 帧），
 * 但该段 daemon 侧零测试覆盖。本测试 fake 引擎按 AgentEnginePort 时序契约
 * emit 完整工具轮事件，断言 ask events 面收到 onToolStart/onToolEnd——
 * 红 = 转发段断点实锤；绿 = service 层链路通，排查面移向 handler/运行环境。
 *
 * 时序（AgentEnginePort 头注释契约 §5 带工具轮）：
 * agent_start → turn_start → message(user) → message(assistant, toolUse)
 * → tool_execution_start → tool_execution_end → message(toolResult)
 * → message(assistant, 文本终答) → turn_end → agent_end。
 */
import { describe, expect, test } from "bun:test";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { AgentEnginePort, AgentEngineEvent, AgentEngineListener } from "../../src/application/ports/outbound/AgentEnginePort";
import type { StewardEngineAssemblyOptions } from "../../src/application/steward/StewardService";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";

// ── fakes（最小面——只装本测试断言需要的探针） ─────────────────

const fakeLlm: StewardLlmPort = {
  modelId: "fake/flash",
  async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
    throw new Error("本测试不走 LLM 剧本（fake 引擎直控事件）");
  },
};

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => void kv.set(key, value),
    all: () => Object.fromEntries(kv),
    subscribe: () => () => undefined,
  } as unknown as RuntimeConfigPort;
}

/** fake 引擎：start 即按固定时序 emit 事件（一次工具轮 + 文本终答）。 */
function scriptEngine(): { engine: AgentEnginePort; events: AgentEngineEvent[] } {
  const emitted: AgentEngineEvent[] = [];
  let listener: AgentEngineListener | null = null;
  const emit = (e: AgentEngineEvent) => {
    emitted.push(e);
    listener?.(e);
  };
  const engine: AgentEnginePort = {
    async start(_input: string, l: AgentEngineListener): Promise<void> {
      listener = l;
      emit({ type: "agent_start" });
      emit({ type: "turn_start" });
      emit({ type: "message_start", role: "user", source: "prompt" });
      emit({ type: "message_end", role: "user", text: "查一下" });
      emit({ type: "message_start", role: "assistant", source: "prompt" });
      emit({
        type: "message_end",
        role: "assistant",
        text: "",
        stopReason: "toolUse",
        blocks: [{ type: "toolCall", id: "tc-1", name: "memory_search", args: { query: "偏好" } }],
      });
      emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "memory_search", args: { query: "偏好" } });
      emit({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "memory_search", isError: false, result: "命中 2 条" });
      emit({ type: "message_start", role: "toolResult", source: "prompt" });
      emit({ type: "message_end", role: "toolResult", text: "命中 2 条", toolCallId: "tc-1", toolName: "memory_search" });
      emit({ type: "message_start", role: "assistant", source: "prompt" });
      emit({ type: "message_update", delta: "找到了" });
      emit({ type: "message_end", role: "assistant", text: "找到了", stopReason: "stop" });
      emit({ type: "turn_end", toolResultCount: 1 });
      emit({ type: "agent_end", messageCount: 4 });
    },
    steer: () => undefined,
    abort: () => undefined,
    isStreaming: () => false,
  };
  return { engine, events: emitted };
}

/** 微任务/投影链排空。 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("管家工具帧转发（steward.tool 两相帧——service 层）", () => {
  test("引擎 tool_execution_start/end → ask events onToolStart/onToolEnd 逐帧转发", async () => {
    const script = scriptEngine();
    let createdOpts: StewardEngineAssemblyOptions | null = null;
    const svc = new StewardService({
      llm: fakeLlm,
      orchestration: {
        listInstances: async () => [],
      } as never,
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      dialog: new StewardDialogMemory(fakeDialogStore()),
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => undefined,
      emitNotify: () => undefined,
      emitActionCompleted: () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
      createEngine: (opts) => {
        createdOpts = opts;
        // persistentListener 透传验证（生产配方 buildStewardEngine 同参透传）：
        // 事件必须经 persistentListener 进入 StewardService（逐 run listener
        // 不承载跨 run 流式转发——StewardService 1452 行只接 persistentListener）。
        const inner = script.engine;
        return {
          ...inner,
          start: async (input: string, l: AgentEngineListener) => {
            // 直接走 script 引擎（listener 参数被 StewardService 置 no-op——
            // 事件面全走 persistentListener）
            void l;
            void createdOpts;
            return inner.start(input, (e) => opts.persistentListener(e));
          },
        } as AgentEnginePort;
      },
    });

    const toolStarts: { name: string; argsSummary: string }[] = [];
    const toolEnds: { name: string; resultSummary: string }[] = [];
    const deltas: string[] = [];
    const results: { status: string; text?: string }[] = [];
    const payload = await svc.ask(
      "查一下",
      {
        onDelta: (d) => deltas.push(d),
        onToolStart: (name, argsSummary) => toolStarts.push({ name, argsSummary }),
        onToolEnd: (name, resultSummary) => toolEnds.push({ name, resultSummary }),
      },
      (p) => results.push({ status: p.status, text: "text" in p ? p.text : undefined }),
    );
    await settle();

    // 两相帧各一，顺序 start → end
    expect(toolStarts).toEqual([{ name: "memory_search", argsSummary: JSON.stringify({ query: "偏好" }) }]);
    expect(toolEnds).toEqual([{ name: "memory_search", resultSummary: "命中 2 条" }]);
    // 流式 delta 照常（同 events 面共存）
    expect(deltas).toEqual(["找到了"]);
    // run 收口 = answer
    expect(payload.status).toBe("answer");
    if (payload.status === "answer") expect(payload.text).toBe("找到了");
  });
});

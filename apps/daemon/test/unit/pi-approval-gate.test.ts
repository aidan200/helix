import { describe, expect, test } from "bun:test";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  ApprovalGateHook,
  type ApprovalGatePausedInfo,
} from "../../src/adapters/driven/pi-engine/runtime/hooks/ApprovalGateHook";
import type { HookSet } from "../../src/adapters/driven/pi-engine/runtime/HookSet";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import type { AgentEngineEvent, EngineResumeDecision } from "../../src/application/ports/outbound/AgentEnginePort";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";

/**
 * pi 通道审批闸（暂停四态，POC 落地批）：
 * - 机制 = beforeToolCall 阻塞闸（POC 验证 15/15：挂起等人工决策、
 *   abort signal 唤醒不挂死、暂停期 steer 只入队 turn 边界 drain）；
 * - 契约 = AgentEnginePort.engine_paused + resume（loop 通道 Phase 5 已有，
 *   pi 适配器本批补齐——四态中 approve/reject 完整；approveWith/resolve
 *   超 pi BeforeToolCallResult（block/reason/terminate）能力面，映射点
 *   显式报错不静默降级）。
 * 缺省不装配（零漂移守护 ⑫）。
 */

// ── 测试材质 ─────────────────────────────────────────────────────

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

function assistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 剧本式 streamFn：每次调用依序吐一条预制 assistant 消息。 */
function scriptedLLM(script: AssistantMessage[], calls?: { count: number; lastContext?: unknown }): StreamFn {
  let i = 0;
  return (_model, context) => {
    calls && (calls.count = i + 1, calls.lastContext = context);
    const msg = script[i++] ?? assistant([{ type: "text", text: "剧本耗尽" }], "stop");
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: (msg.stopReason ?? "stop") as never, message: msg });
    })();
    return stream;
  };
}

/** 轮询等待（超时即失败——闸挂死会被这里暴露）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "条件"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function gateContext(name: string, args: unknown): Parameters<NonNullable<HookSet["beforeToolCall"]>>[0] {
  return {
    assistantMessage: assistant([{ type: "text", text: "call" }], "toolCall"),
    toolCall: { type: "toolCall", id: `tc-${name}`, name, arguments: args },
    args,
  } as never;
}

// ── Part A：钩子单测 ─────────────────────────────────────────────

describe("ApprovalGateHook（pi 通道审批闸——钩子位）", () => {
  test("A1 策略不命中 → 直通放行，不挂闸不通知", async () => {
    const paused: ApprovalGatePausedInfo[] = [];
    const gate = new ApprovalGateHook({
      shouldGate: (name) => name === "danger",
      onPaused: (info) => paused.push(info),
      generateToken: () => "tok-A1",
    });
    const result = await gate.beforeToolCall(gateContext("safe", { x: 1 }));
    expect(result).toBeUndefined();
    expect(paused).toHaveLength(0);
  });

  test("A2 命中 → onPaused 携带 token/工具名/参数摘要；resume 前挂起", async () => {
    const paused: ApprovalGatePausedInfo[] = [];
    const gate = new ApprovalGateHook({
      shouldGate: () => true,
      onPaused: (info) => paused.push(info),
      generateToken: () => "tok-A2",
    });
    let settled = false;
    const pending = gate.beforeToolCall(gateContext("danger", { cmd: "rm -rf" }));
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // 挂闸中
    expect(paused).toHaveLength(1);
    expect(paused[0]?.pauseToken).toBe("tok-A2");
    expect(paused[0]?.toolName).toBe("danger");
    expect(paused[0]?.argsSummary).toContain("rm -rf");
  });

  test("A3 resume(approve) → 放行（undefined）", async () => {
    const gate = new ApprovalGateHook({ shouldGate: () => true, onPaused: () => {}, generateToken: () => "tok-A3" });
    const pending = gate.beforeToolCall(gateContext("danger", {}));
    gate.resume("tok-A3", { kind: "approve" });
    expect(await pending).toBeUndefined();
  });

  test("A4 resume(reject) → { block, reason } 拒绝文案成为工具回执", async () => {
    const gate = new ApprovalGateHook({ shouldGate: () => true, onPaused: () => {}, generateToken: () => "tok-A4" });
    const pending = gate.beforeToolCall(gateContext("danger", {}));
    gate.resume("tok-A4", { kind: "reject", text: "用户拒绝：危险操作" });
    expect(await pending).toEqual({ block: true, reason: "用户拒绝：危险操作" });
  });

  test("A5 resume(approveWith) → 显式报错（pi 能力面外，不静默降级）；resolve → block+terminate 翻译（段B）", async () => {
    const gate = new ApprovalGateHook({ shouldGate: () => true, onPaused: () => {}, generateToken: () => "tok-A5" });
    const pending = gate.beforeToolCall(gateContext("danger", {}));
    expect(() => gate.resume("tok-A5", { kind: "approveWith", args: {} } as never)).toThrow(/approveWith/);
    // resolve 翻译：结果入账（拒绝框定）+ run 终结——loop 域 resolve 的 pi 映射
    gate.resume("tok-A5", { kind: "resolve", text: "确认动作执行完毕：已沉淀" });
    expect(await pending).toEqual({ block: true, reason: "确认动作执行完毕：已沉淀", terminate: true });
  });

  test("A5b resolve 与 reject 形态对照：同框定文本，仅 terminate 位分野", async () => {
    const gateR = new ApprovalGateHook({ shouldGate: () => true, onPaused: () => {}, generateToken: () => "tok-R" });
    const gateJ = new ApprovalGateHook({ shouldGate: () => true, onPaused: () => {}, generateToken: () => "tok-J" });
    const pR = gateR.beforeToolCall(gateContext("t", {}));
    const pJ = gateJ.beforeToolCall(gateContext("t", {}));
    gateR.resume("tok-R", { kind: "resolve", text: "同文案" });
    gateJ.resume("tok-J", { kind: "reject", text: "同文案" });
    expect(await pR).toEqual({ block: true, reason: "同文案", terminate: true });
    expect(await pJ).toEqual({ block: true, reason: "同文案" }); // reject：模型续跑
  });

  test("A6 未知 token → 报错（过期/伪造凭据不炸闸）", () => {
    const gate = new ApprovalGateHook({ shouldGate: () => true, onPaused: () => {} });
    expect(() => gate.resume("ghost", { kind: "approve" })).toThrow(/pauseToken/);
  });

  test("A7 abort signal 唤醒 → 返回 undefined（loop aborted 检查接管），不挂死", async () => {
    const gate = new ApprovalGateHook({ shouldGate: () => true, onPaused: () => {}, generateToken: () => "tok-A7" });
    const ac = new AbortController();
    const pending = gate.beforeToolCall(gateContext("danger", {}), ac.signal);
    ac.abort();
    expect(await pending).toBeUndefined(); // POC S3：loop 检 signal.aborted → "Operation aborted"
    // abort 后同 token resume → unknown（挂起已随 signal 清理）
    expect(() => gate.resume("tok-A7", { kind: "approve" })).toThrow(/pauseToken/);
  });
});

// ── Part B：适配器集成（真 Agent + 剧本 LLM——POC 四态全链路） ─────

function makeDangerTool(executed: { calls: unknown[] }) {
  return {
    name: "danger",
    label: "危险工具",
    description: "测试用危险工具",
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } as never,
    async execute(_id: string, args: { target: string }) {
      executed.calls.push(args);
      return { content: [{ type: "text" as const, text: `executed:${args.target}` }] };
    },
  };
}

const GateProfile: AgentProfile = {
  kind: "test-approval-gate",
  systemPrompt: "test",
  tools: ["danger"],
  lifecycle: { mode: "single-shot" },
  hooks: [SteerHooks],
};

function makeAdapter(opts: {
  script: AssistantMessage[];
  gate?: boolean;
  events?: AgentEngineEvent[];
  executed?: { calls: unknown[] };
  llmCalls?: { count: number; lastContext?: unknown };
}) {
  const danger = makeDangerTool(opts.executed ?? { calls: [] });
  return new PiAgentEngineAdapter({
    profile: GateProfile,
    model: fakeModel,
    apiKeys: { anthropic: "test" },
    streamFnOverride: scriptedLLM(opts.script, opts.llmCalls),
    resolveTools: () => [danger as never],
    ...(opts.gate ? { approvalGate: { shouldGate: (name: string) => name === "danger" } } : {}),
  });
}

describe("PiAgentEngineAdapter 审批闸接线（engine_paused + resume 四态）", () => {
  test("B1 approve：挂闸→engine_paused→resume 放行→工具真执行→续跑收口", async () => {
    const events: AgentEngineEvent[] = [];
    const executed = { calls: [] as unknown[] };
    const adapter = makeAdapter({
      script: [
        assistant([{ type: "toolCall", id: "tc-1", name: "danger", arguments: { target: "prod-db" } } as never], "toolCall"),
        assistant([{ type: "text", text: "all done" }], "stop"),
      ],
      gate: true,
      events,
      executed,
    });
    const run = adapter.start("go", (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "engine_paused"), 3000, "engine_paused");
    const paused = events.find((e) => e.type === "engine_paused");
    expect(paused).toBeDefined();
    if (paused?.type !== "engine_paused") throw new Error("unreachable");
    expect(paused.toolName).toBe("danger");
    expect(paused.argsSummary).toContain("prod-db");
    expect(executed.calls).toHaveLength(0); // 挂闸期工具未执行
    await adapter.resume(paused.pauseToken, { kind: "approve" });
    await run;
    expect(executed.calls).toEqual([{ target: "prod-db" }]); // 放行后真执行
    const end = events.filter((e) => e.type === "tool_execution_end");
    expect(end).toHaveLength(1);
  });

  test("B2 reject：工具不执行，拒绝文案成为错误工具回执，模型知情续跑", async () => {
    const events: AgentEngineEvent[] = [];
    const executed = { calls: [] as unknown[] };
    const adapter = makeAdapter({
      script: [
        assistant([{ type: "toolCall", id: "tc-2", name: "danger", arguments: { target: "x" } } as never], "toolCall"),
        assistant([{ type: "text", text: "好的我改道" }], "stop"),
      ],
      gate: true,
      executed,
    });
    const run = adapter.start("go", (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "engine_paused"), 3000, "engine_paused");
    const paused = events.find((e) => e.type === "engine_paused");
    if (paused?.type !== "engine_paused") throw new Error("unreachable");
    await adapter.resume(paused.pauseToken, { kind: "reject", text: "用户拒绝：不许动生产库" });
    await run;
    expect(executed.calls).toHaveLength(0); // 工具从未执行
    const end = events.find((e) => e.type === "tool_execution_end");
    expect(end).toBeDefined();
    if (end?.type !== "tool_execution_end") throw new Error("unreachable");
    expect(end.isError).toBe(true); // block 回执 = 错误工具结果
    expect(end.result).toContain("用户拒绝：不许动生产库");
  });

  test("B3 暂停期 steer：只入队，放行后 turn 边界 drain 进新轮", async () => {
    const events: AgentEngineEvent[] = [];
    const executed = { calls: [] as unknown[] };
    const llmCalls = { count: 0, lastContext: undefined as unknown };
    const adapter = makeAdapter({
      script: [
        assistant([{ type: "toolCall", id: "tc-3", name: "danger", arguments: { target: "y" } } as never], "toolCall"),
        assistant([{ type: "text", text: "工具完成" }], "stop"),
        assistant([{ type: "text", text: "已处理 steer" }], "stop"),
      ],
      gate: true,
      executed,
      llmCalls,
    });
    const run = adapter.start("go", (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "engine_paused"), 3000, "engine_paused");
    adapter.steer("先回答这个问题"); // 挂闸期注入
    await adapter.resume((events.find((e) => e.type === "engine_paused") as { pauseToken: string }).pauseToken, { kind: "approve" });
    await run;
    // pi 语义（POC 发现 #2）：steer 在工具结果回灌后直接 drain 并入续轮请求
    //（不空答一轮）——挂闸期 steer 不丢，且不产生额外 LLM 调用。
    expect(llmCalls.count).toBe(2);
    const transcript = ((llmCalls.lastContext as { messages?: { role: string; content: unknown }[] }).messages ?? []);
    const steerSeen = transcript.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("先回答这个问题"),
    );
    expect(steerSeen).toBe(true);
  });

  test("B4 挂闸期 abort：闸被 signal 唤醒，run 及时收口不挂死，工具不执行", async () => {
    const events: AgentEngineEvent[] = [];
    const executed = { calls: [] as unknown[] };
    const adapter = makeAdapter({
      script: [assistant([{ type: "toolCall", id: "tc-4", name: "danger", arguments: { target: "z" } } as never], "toolCall")],
      gate: true,
      executed,
    });
    const run = adapter.start("go", (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "engine_paused"), 3000, "engine_paused");
    adapter.abort();
    await run; // 超时保护由 waitFor 哲学兜底——这里 run 不 resolve 会直接测试超时失败
    expect(executed.calls).toHaveLength(0);
  });

  test("B5 缺省零漂移：未装配审批闸 → 工具直行无 engine_paused；resume 显式报错", async () => {
    const events: AgentEngineEvent[] = [];
    const executed = { calls: [] as unknown[] };
    const adapter = makeAdapter({
      script: [
        assistant([{ type: "toolCall", id: "tc-5", name: "danger", arguments: { target: "w" } } as never], "toolCall"),
        assistant([{ type: "text", text: "done" }], "stop"),
      ],
      executed,
    });
    await adapter.start("go", (e) => events.push(e));
    expect(executed.calls).toEqual([{ target: "w" }]); // 无闸直行
    expect(events.some((e) => e.type === "engine_paused")).toBe(false);
    await expect(adapter.resume("any", { kind: "approve" })).rejects.toThrow(/审批闸/);
  });

  test("B6 approveWith 能力面外报错；resolve 经 block+terminate 翻译——结果入账 + run 终结（段B）", async () => {
    const events: AgentEngineEvent[] = [];
    const adapter = makeAdapter({
      script: [
        assistant([{ type: "toolCall", id: "tc-6", name: "danger", arguments: { target: "v" } } as never], "toolCall"),
        assistant([{ type: "text", text: "不应到达（resolve 终结零续跑）" }], "text"), // 终结后不应消费
      ],
      gate: true,
      events,
    });
    const run = adapter.start("go", (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "engine_paused"), 3000, "engine_paused");
    const paused = events.find((e) => e.type === "engine_paused") as { pauseToken: string };
    await expect(adapter.resume(paused.pauseToken, { kind: "approveWith", args: {} } as EngineResumeDecision)).rejects.toThrow(/approveWith/);
    // resolve 翻译：拒绝框定结果入账 + run 终结（零续跑——尾轮剧本不应消费）
    await adapter.resume(paused.pauseToken, { kind: "resolve", text: "确认动作执行完毕：已沉淀" } as EngineResumeDecision);
    await run;
    const ends = events.filter((e): e is Extract<AgentEngineEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.result).toBe("确认动作执行完毕：已沉淀");
    expect(events.some((e) => e.type === "message_end" && e.role === "assistant" && e.text === "不应到达（resolve 终结零续跑）")).toBe(false);
    expect(events.at(-1)?.type).toBe("agent_end");
  });
});

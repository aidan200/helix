/**
 * StewardService 单测（V2.5 文本管家批；TDD 红绿证据链——设计 §2 三分法 /
 * §5.2 权限分级 / §5.3 ①②层）。
 *
 * 断言面（任务 brief 测试要求逐条）：
 * 1. 只读状态问答直达：LLM 经 list_instances/list_tasks 工具取数 → answer
 *    直答（一问一答闭环，工具轮执行只读面）；
 * 2. 写注入必过闸：LLM propose_send → confirm_required 回执 + 零执行
 *    （未确认 = orchestration.send 零调用——§5.2 防火墙）；
 * 3. 闸内确认后执行一次：confirm(actionId) → send 恰一次 + 参数正确；
 *    actionId 单次消费（二次 confirm → error 判别，send 仍恰一次）；
 * 4. 越权意图拒绝应答：system prompt 含拒绝清单（不代答工作上下文/不执行
 *    未过闸写操作/不伪装用户身份）——prompt 骨架断言（§2 三分法落面）；
 * 5. 开关关 = 零 LLM 调用：steward.enabled ≠ "1" → ask 直接 error 判别，
 *    fake LLM 零调用（money gate 服务端权威）；
 * 6. feed 面板事件流：agent 生命周期事件 → 模板文本行（复用事件流零新源）；
 *    零订阅连接零推送；无关事件零发（①层粗筛）；
 * 7. 工具轮上限：LLM 连续工具调用超限 → error 判别（成本护栏）。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { AgentOrchestrationPort, AgentInstanceStatus } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardFeedPayload } from "@helix/protocol";
import {
  StewardService,
  STEWARD_FEED_EVENT_TYPES,
  STEWARD_MAX_TOOL_ROUNDS,
} from "../../src/application/steward/StewardService";
import {
  StewardDialogMemory,
  trimToBudget,
  isExpired,
} from "../../src/application/steward/StewardDialogMemory";

// ── fakes ─────────────────────────────────────────────────

interface LlmCall {
  readonly request: StewardLlmRequest;
  readonly round: number;
}

/** 剧本化 fake LLM：按调用序出队响应；断言面记录全部调用（A1 扩：
 *  响应携 thinking 时先回调 onThinking 段级——模拟 adapter 块终态回调序）。 */
function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(
      request: StewardLlmRequest,
      _onDelta?: (chunk: string) => void,
      onThinking?: (block: string) => void,
    ): Promise<StewardLlmResponse> {
      const round = calls.length;
      calls.push({ request, round });
      const next = script[round];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      if (onThinking !== undefined && next.thinking !== undefined && next.thinking.text !== "") {
        onThinking(next.thinking.text);
      }
      return next;
    },
  };
}

/** 流式剧本轮（V2.5 体验批）：响应 + 可选增量 chunk 序列（text 生成段）。 */
interface ScriptedTurn {
  readonly response: StewardLlmResponse;
  /** 逐 chunk 调 onDelta 的序列（工具轮缺省 = 静默零 delta）。 */
  readonly chunks?: readonly string[];
  /** chunks 后抛错（模拟中途失败）。 */
  readonly failAfterChunks?: boolean;
}

/** 流式 fake LLM：complete(request, onDelta) 双参面——逐 chunk 回调后出队响应。 */
function streamingLlm(script: readonly ScriptedTurn[]): StewardLlmPort & { calls: (LlmCall & { onDelta?: (chunk: string) => void })[] } {
  const calls: (LlmCall & { onDelta?: (chunk: string) => void })[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest, onDelta?: (chunk: string) => void): Promise<StewardLlmResponse> {
      const round = calls.length;
      calls.push({ request, round, onDelta });
      const next = script[round];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      if (onDelta !== undefined && next.chunks !== undefined) {
        for (const c of next.chunks) onDelta(c);
      }
      if (next.failAfterChunks === true) throw new Error("模拟模型中断");
      return next.response;
    },
  };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

function fakeOrchestration(statuses: readonly AgentInstanceStatus[] = []) {
  const sends: { agentId: string; message: string }[] = [];
  const orchestration = {
    sends,
    status: (agentId?: string): AgentInstanceStatus[] =>
      agentId === undefined ? [...statuses] : statuses.filter((s) => s.agentId === agentId),
    send: (agentId: string, message: string): { delivered: boolean; detail: string } => {
      sends.push({ agentId, message });
      const target = statuses.find((s) => s.agentId === agentId && s.state === "running");
      if (target === undefined) return { delivered: false, detail: `实例 ${agentId} 非运行中` };
      return { delivered: true, detail: "已投递（turn 边界注入生效）" };
    },
  };
  return orchestration as unknown as Pick<AgentOrchestrationPort, "status" | "send"> & typeof orchestration;
}

function makeService(opts: {
  llm: StewardLlmPort;
  orchestration?: ReturnType<typeof fakeOrchestration>;
  config?: RuntimeConfigPort;
  feedSubscribers?: number;
}) {
  const orchestration = opts.orchestration ?? fakeOrchestration([
    {
      agentId: "agent-1",
      state: "running",
      displayState: "active",
      profileKind: "subagent-worker",
      task: "修复登录超时",
    },
    {
      agentId: "agent-2",
      state: "done",
      displayState: "done",
      profileKind: "subagent-worker",
      task: "写单测",
      summary: "已完成：8 用例全绿",
    },
  ]);
  const config = opts.config ?? fakeConfig({ "steward.enabled": "1" });
  const feeds: StewardFeedPayload[] = [];
  const svc = new StewardService({
    llm: opts.llm,
    orchestration,
    tasks: {
      listTasks: () => [
        {
          jobId: "job-1",
          type: "code-fix",
          title: "修复登录超时",
          status: "running",
          projects: ["helix"],
          createdBy: "chat",
          createdAt: "2026-09-19T02:00:00.000Z",
          updatedAt: "2026-09-19T02:10:00.000Z",
          progress: { stageName: "实现", batchesDone: 2, batchesTotal: 4, percent: 50 },
          error: null,
        },
      ],
    },
    config,
    feedGate: { hasStewardSubscribers: () => (opts.feedSubscribers ?? 1) > 0 },
    emitFeed: (payload) => feeds.push(payload),
  });
  return { svc, orchestration, config, feeds };
}

const toolCall = (name: string, args: Record<string, unknown>, round = 0): StewardLlmResponse => ({
  kind: "toolCall",
  id: `call-${round}`,
  name,
  args,
});

describe("① 只读状态问答直达（§2 三分法之一）", () => {
  test("list_instances → list_tasks → answer：工具轮执行只读面，最终直答", async () => {
    const llm = fakeLlm([
      toolCall("list_instances", {}),
      toolCall("list_tasks", {}),
      { kind: "text", text: "2 个实例：agent-1 运行中（修复登录超时），agent-2 已完成。1 个任务进行中（50%)." },
    ]);
    const { svc } = makeService({ llm });
    const result = await svc.ask("现在都有什么在跑？");
    expect(result.status).toBe("answer");
    if (result.status !== "answer") throw new Error("unreachable");
    expect(result.text).toContain("agent-1");
    // 工具轮回灌：toolResult 消息携带实例/任务清单 JSON
    const secondCall = llm.calls[1]!;
    const toolResult = secondCall.request.messages.find(
      (m) => m.role === "toolResult" && m.name === "list_instances",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.text).toContain("agent-1");
    // system prompt 携带三分法骨架
    expect(llm.calls[0]!.request.systemPrompt).toContain("快问快答");
    expect(llm.calls[0]!.request.systemPrompt).toContain("递话");
  });

  test("ask 后会话历史滚动进上下文（第二条 ask 携带首问首答）", async () => {
    const llm = fakeLlm([
      { kind: "text", text: "第一答" },
      { kind: "text", text: "第二答" },
    ]);
    const { svc } = makeService({ llm });
    await svc.ask("第一问");
    await svc.ask("第二问");
    const messages = llm.calls[1]!.request.messages;
    expect(messages.some((m) => m.role === "user" && m.text === "第一问")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.text === "第一答")).toBe(true);
  });
});

describe("② 写注入必过闸（§5.2 确认闸防火墙）", () => {
  test("propose_send → confirm_required 回执 + 零执行", async () => {
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "顺带跑一下 lint" }),
    ]);
    const { svc, orchestration } = makeService({ llm });
    const result = await svc.ask("让 agent-1 顺带跑一下 lint");
    expect(result.status).toBe("confirm_required");
    if (result.status !== "confirm_required") throw new Error("unreachable");
    expect(result.agentId).toBe("agent-1");
    expect(result.message).toBe("顺带跑一下 lint");
    expect(typeof result.actionId).toBe("string");
    expect(result.actionId.length).toBeGreaterThan(0);
    // 防火墙：未确认零执行
    expect(orchestration.sends.length).toBe(0);
  });

  test("propose_send 目标非运行中 → 拒绝提案（error 判别，零 pending 登记）", async () => {
    const llm = fakeLlm([toolCall("propose_send", { agentId: "agent-x", message: "hi" })]);
    const { svc } = makeService({ llm });
    const result = await svc.ask("给 agent-x 递话");
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.reason).toContain("agent-x");
  });
});

describe("③ 闸内确认后执行一次（§5.2 确认 → 执行）", () => {
  test("confirm → send 恰一次 + 参数正确；actionId 单次消费", async () => {
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "顺带跑一下 lint" }),
    ]);
    const { svc, orchestration } = makeService({ llm });
    const askResult = await svc.ask("让 agent-1 顺带跑 lint");
    if (askResult.status !== "confirm_required") throw new Error("应过闸");
    const confirmed = await svc.confirm(askResult.actionId);
    expect(confirmed.status).toBe("ok");
    if (confirmed.status !== "ok") throw new Error("unreachable");
    expect(confirmed.agentId).toBe("agent-1");
    expect(confirmed.detail).toContain("已投递");
    expect(orchestration.sends).toEqual([{ agentId: "agent-1", message: "顺带跑一下 lint" }]);
    // 单次消费：二次 confirm → error，send 仍恰一次
    const second = await svc.confirm(askResult.actionId);
    expect(second.status).toBe("error");
    expect(orchestration.sends.length).toBe(1);
  });

  test("confirm 未知 actionId → error 判别", async () => {
    const llm = fakeLlm([]);
    const { svc } = makeService({ llm });
    const result = await svc.confirm("no-such-action");
    expect(result.status).toBe("error");
  });
});

describe("④ 越权拒绝（§2 三分法之三——prompt 骨架落面）", () => {
  test("system prompt 拒绝清单三连：不代答工作上下文 / 不执行未过闸写操作 / 不伪装用户身份", async () => {
    const llm = fakeLlm([{ kind: "text", text: "请把这句发给持有上下文的 agent。" }]);
    const { svc } = makeService({ llm });
    await svc.ask("就按刚才聊的改");
    const prompt = llm.calls[0]!.request.systemPrompt;
    expect(prompt).toContain("不代答工作上下文");
    expect(prompt).toContain("不执行未过闸");
    expect(prompt).toContain("不伪装用户身份");
  });

  test("工具面恰为三个只读+提案原语（list_instances/list_tasks/propose_send）——无 spawn/kill 等旁路", async () => {
    const llm = fakeLlm([{ kind: "text", text: "ok" }]);
    const { svc } = makeService({ llm });
    await svc.ask("hi");
    const names = llm.calls[0]!.request.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_instances", "list_tasks", "propose_send"]);
  });
});

describe("⑤ 开关关 = 零 LLM 调用（money gate 服务端权威）", () => {
  test("steward.enabled ≠ 1 → ask 直接 error 判别，fake LLM 零调用", async () => {
    const llm = fakeLlm([{ kind: "text", text: "不该被调用" }]);
    const { svc } = makeService({ llm, config: fakeConfig({}) });
    const result = await svc.ask("现在有什么在跑？");
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.reason).toContain("设置");
    expect(llm.calls.length).toBe(0);
  });
});

describe("⑥ 事件 feed 文本行（§5.3 ①②层——模板直出不进 LLM）", () => {
  function agentEvent(type: string, payload: unknown): DomainEvent {
    return {
      type: type as DomainEvent["type"],
      sessionId: "sess-1",
      instanceId: "agent-1",
      payload,
      occurredAt: "2026-09-19T06:00:00.000Z",
    };
  }
  const closure = { status: "done" as const, summary: "修复登录超时", reportPath: null, findings: null, taskId: null };

  test("生命周期事件 → 模板文本行（seq 单调递增）；零订阅零推送；无关事件零发", () => {
    const llm = fakeLlm([]);
    const { svc, feeds } = makeService({ llm, feedSubscribers: 1 });
    svc.onDomainEvent(agentEvent("agent.spawned", { agentId: "agent-1", task: "修复登录超时", profileKind: "subagent-worker" }));
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-1", closure }));
    svc.onDomainEvent(agentEvent("chat.turn.completed", { turnId: "t1", reason: "stop" }));
    expect(feeds.length).toBe(2);
    expect(feeds[0]!.kind).toBe("agent.spawned");
    expect(feeds[0]!.text).toContain("agent-1");
    expect(feeds[0]!.seq).toBe(1);
    expect(feeds[1]!.kind).toBe("agent.completed");
    expect(feeds[1]!.text).toContain("修复登录超时");
    expect(feeds[1]!.seq).toBe(2);
  });

  test("零订阅连接 → 事件直接丢弃（零推送闸门）", () => {
    const llm = fakeLlm([]);
    const { svc, feeds } = makeService({ llm, feedSubscribers: 0 });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-1", closure }));
    expect(feeds.length).toBe(0);
  });

  test("feed 集合恒为 agent 生命周期子集（粗筛单源常量）", () => {
    expect([...STEWARD_FEED_EVENT_TYPES].sort()).toEqual(
      ["agent.completed", "agent.failed", "agent.killed", "agent.parked", "agent.resumed", "agent.spawned"].sort(),
    );
  });
});

describe("⑦ 成本护栏", () => {
  test(`连续工具调用超限（>${STEWARD_MAX_TOOL_ROUNDS} 轮）→ error 判别不无限循环`, async () => {
    const script: StewardLlmResponse[] = Array.from({ length: 20 }, (_, i) => toolCall("list_instances", {}, i));
    const llm = fakeLlm(script);
    const { svc } = makeService({ llm });
    const result = await svc.ask("连环工具调用");
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.reason).toContain("循环");
    // 恰好停在护栏上（不超发一轮）
    expect(llm.calls.length).toBe(STEWARD_MAX_TOOL_ROUNDS);
  });

  test("ask 空文本 → error 判别（payload 防御）", async () => {
    const llm = fakeLlm([]);
    const { svc } = makeService({ llm });
    const result = await svc.ask("  ");
    expect(result.status).toBe("error");
    expect(llm.calls.length).toBe(0);
  });
});

describe("⑧ 流式体验批（V2.5——steward.ask.delta 语义）", () => {
  test("文本生成段逐 chunk 透传 onDelta（多 chunk 按序）+ 终态 answer 权威文本", async () => {
    const llm = streamingLlm([
      { response: { kind: "text", text: "当前 2 个实例运行中：agent-1、agent-2。" }, chunks: ["当前 ", "2 个", "实例运行中"] },
    ]);
    const { svc } = makeService({ llm });
    const deltas: string[] = [];
    const result = await svc.ask("在跑什么？", { onDelta: (chunk) => deltas.push(chunk) });
    expect(deltas).toEqual(["当前 ", "2 个", "实例运行中"]);
    expect(result.status).toBe("answer");
    if (result.status !== "answer") throw new Error("unreachable");
    expect(result.text).toBe("当前 2 个实例运行中：agent-1、agent-2。"); // 终态权威（非 chunks 拼接）
  });

  test("工具循环：工具段零 delta（静默），后续文本轮 delta 按序", async () => {
    const llm = streamingLlm([
      { response: toolCall("list_instances", {}) }, // 工具轮：无 chunks —— 静默
      { response: { kind: "text", text: "1 个运行中" }, chunks: ["1 个", "运行中"] },
    ]);
    const { svc } = makeService({ llm });
    const deltas: string[] = [];
    const result = await svc.ask("在跑什么？", { onDelta: (chunk) => deltas.push(chunk) });
    expect(deltas).toEqual(["1 个", "运行中"]);
    expect(result.status).toBe("answer");
    expect(llm.calls[0]!.onDelta).toBeDefined(); // 回调面两轮均传递（工具轮天然零 text delta）
  });

  test("money gate 关闭 → 零 LLM 调用零 delta（闸门前置）", async () => {
    const llm = streamingLlm([
      { response: { kind: "text", text: "不该被调用" }, chunks: ["不该"] },
    ]);
    const { svc } = makeService({ llm, config: fakeConfig({}) });
    const deltas: string[] = [];
    const result = await svc.ask("在跑什么？", { onDelta: (chunk) => deltas.push(chunk) });
    expect(result.status).toBe("error");
    expect(deltas.length).toBe(0);
    expect(llm.calls.length).toBe(0);
  });

  test("LLM 中途抛错 → 已发 delta 保留在回调流，终态 error 判别（前端清流缓冲）", async () => {
    const llm = streamingLlm([
      { response: { kind: "text", text: "不该到达" }, chunks: ["部分", "输出"], failAfterChunks: true },
    ]);
    const { svc } = makeService({ llm });
    const deltas: string[] = [];
    const result = await svc.ask("在跑什么？", { onDelta: (chunk) => deltas.push(chunk) });
    expect(deltas).toEqual(["部分", "输出"]);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.reason).toContain("模型调用失败");
  });
});

// ══════════════════════════════════════════════════════════
// A1 工作记忆批：thinking 回传 / KV 三闸 / 回放同源 / 过程事件
// ══════════════════════════════════════════════════════════

/** thinking 剧本轮：响应携 thinking 块（A1 批 fake 面扩展）。 */
function thinkingTurn(script: readonly (StewardLlmResponse & { thinking?: { text: string; signature?: string } })[]) {
  return script;
}

describe("⑨ A1：thinking 回传——多轮工具链上下文含 thinking 形态", () => {
  test("thinking 随 assistant 记录入 KV；下一轮 LLM 请求窗口含 thinking 形态（text+signature）", async () => {
    const llm = fakeLlm(
      thinkingTurn([
        {
          kind: "toolCall",
          id: "call-0",
          name: "list_instances",
          args: {},
          thinking: { text: "用户问全局状态，先查实例清单。", signature: "sig-opaque-1" },
        },
        {
          kind: "text",
          text: "agent-1 运行中。",
          thinking: { text: "工具结果只有一条，直接回答。", signature: "sig-opaque-2" },
        },
      ]),
    );
    const { svc, config } = makeService({ llm });
    const result = await svc.ask("在跑什么？");
    expect(result.status).toBe("answer");

    // 第二轮请求窗口（多轮回传断言）：assistant 工具轮记录含 thinking 块
    const secondRound = llm.calls[1]!.request.messages;
    const toolTurn = secondRound.find(
      (m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant" && m.toolCall !== undefined,
    );
    expect(toolTurn).toBeDefined();
    expect(toolTurn!.thinking).toEqual({ text: "用户问全局状态，先查实例清单。", signature: "sig-opaque-1" });
    expect(toolTurn!.toolCall!.name).toBe("list_instances");

    // KV 记录含 thinking（assistant 文本轮 + 工具轮）
    const kv = JSON.parse((config as unknown as { kv: Map<string, string> }).kv.get("steward_dialog")!) as {
      records: { kind: string; thinking?: unknown }[];
    };
    const withThinking = kv.records.filter((r) => r.thinking !== undefined);
    expect(withThinking.length).toBe(2);
  });

  test("无 thinking 响应（不支持思考的模型）→ 记录无 thinking 位，窗口形态不变", async () => {
    const llm = fakeLlm([{ kind: "text", text: "直答" }]);
    const { svc } = makeService({ llm });
    await svc.ask("问");
    const window = llm.calls[0]!.request.messages;
    expect(window[0]).toEqual({ role: "user", text: "问" });
    const assistant = window.filter((m) => m.role === "assistant");
    expect(assistant.every((m) => (m as { thinking?: unknown }).thinking === undefined)).toBe(true);
  });
});

describe("⑩ A1：KV 三闸——预算裁剪 / TTL 清空 / 新对话三处一致", () => {
  test("预算闸：append 超预算丢最老记录（保序保留最新）", async () => {
    const kv = fakeConfig({ "steward.enabled": "1" });
    const dialog = new StewardDialogMemory(kv, {
      budgetTokens: 40, // 极小预算：两三条即裁
      now: () => 1_000,
    });
    const svc = new StewardService({
      llm: fakeLlm([{ kind: "text", text: "答一" }, { kind: "text", text: "答二" }]),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      dialog,
      clock: () => 1_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    });
    await svc.ask("第一问（长长长长长长长长长长长长长长长长长长长长长长长长）");
    await svc.ask("第二问（长长长长长长长长长长长长长长长长长长长长长长长长）");
    const records = await svc.getHistory();
    expect(records.length).toBeLessThan(4); // 预算闸已裁（user+assistant×2 全记为 4）
    expect(records.length).toBeGreaterThanOrEqual(1); // 至少保最新一条
    // 纯函数直测：预算裁剪语义
    const trimmed = trimToBudget(
      [
        { kind: "user", text: "a".repeat(200), at: 1 },
        { kind: "assistant", text: "b".repeat(10), at: 2 },
      ],
      20,
    );
    expect(trimmed.length).toBe(1);
    expect(trimmed[0]!.kind).toBe("assistant"); // 老记录先弃
  });

  test("TTL 闸：72h 无活动 → 懒加载时整 key 清空（daemon 重启恢复为空窗口）", async () => {
    let now = 1_000_000;
    const kv = fakeConfig({ "steward.enabled": "1" });
    const dialogA = new StewardDialogMemory(kv, { now: () => now });
    const svcA = new StewardService({
      llm: fakeLlm([{ kind: "text", text: "答" }]),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      dialog: dialogA,
      clock: () => now,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    });
    await svcA.ask("留下的对话");
    expect((await svcA.getHistory()).length).toBe(2);

    now += 73 * 60 * 60 * 1000; // 73h 后重启（新实例同 KV）
    const dialogB = new StewardDialogMemory(kv, { now: () => now });
    const svcB = new StewardService({
      llm: fakeLlm([{ kind: "text", text: "新答" }]),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      dialog: dialogB,
      clock: () => now,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    });
    expect((await svcB.getHistory()).length).toBe(0); // TTL 清空
    // 纯函数直测：TTL 边界（72h 恰等 = 未过期；超 1ms = 过期）
    expect(isExpired(0, 72 * 60 * 60 * 1000, 72 * 60 * 60 * 1000)).toBe(false);
    expect(isExpired(0, 72 * 60 * 60 * 1000 + 1, 72 * 60 * 60 * 1000)).toBe(true);
  });

  test("新对话闸：clearHistory 三处一致——KV 清空 + LLM 窗口清空 + pending 作废", async () => {
    const kv = fakeConfig({ "steward.enabled": "1" });
    const llm = fakeLlm([
      { kind: "toolCall", id: "call-0", name: "propose_send", args: { agentId: "agent-1", message: "递话" } },
      { kind: "text", text: "清空后的新答" },
    ]);
    const orchestration = fakeOrchestration([
      { agentId: "agent-1", state: "running", displayState: "active", profileKind: "subagent-worker", task: "t" },
    ]);
    const svc = new StewardService({
      llm,
      orchestration,
      tasks: { listTasks: () => [] },
      config: kv,
      clock: () => 2_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    });
    // 一轮产生确认卡 + 记录
    const r1 = await svc.ask("帮我递话给 agent-1");
    expect(r1.status).toBe("confirm_required");
    expect((await svc.getHistory()).length).toBe(2);

    await svc.clearHistory();
    // ① KV 清空
    expect(await svc.getHistory()).toEqual([]);
    // ② LLM 窗口清空（下一轮请求窗口零历史——回执为证）
    const r2 = await svc.ask("新对话第一问");
    expect(r2.status).toBe("answer");
    expect(llm.calls[1]!.request.messages.length).toBe(1); // 仅本轮 user
    // ③ pending 作废：旧 actionId confirm → error（单次消费 + 清空作废）
    const confirmResult = await svc.confirm("steward-action-1");
    expect(confirmResult.status).toBe("error");
  });
});

describe("⑪ A1：回放同源——重启恢复后 UI 与 LLM 窗口一致（同源数据）", () => {
  test("daemon 重启（新 service 同 KV）→ getHistory 回放完整记录 + 下一轮 LLM 窗口 = KV 记录映射", async () => {
    const kv = fakeConfig({ "steward.enabled": "1" });
    const svcA = new StewardService({
      llm: fakeLlm([
        {
          kind: "toolCall",
          id: "call-0",
          name: "list_tasks",
          args: {},
          thinking: { text: "查任务清单。", signature: "sig-a" },
        },
        { kind: "text", text: "1 个任务在跑。", thinking: { text: "汇总回答。", signature: "sig-b" } },
      ]),
      orchestration: fakeOrchestration([]),
      tasks: {
        listTasks: () => [
          {
            jobId: "job-1",
            title: "修复",
            status: "running",
            progress: { stageName: null, batchesDone: 1, batchesTotal: 2, percent: 50 },
            error: null,
          },
        ],
      },
      config: kv,
      clock: () => 5_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    });
    await svcA.ask("任务状态？");

    // 重启：新实例（LLM 窗口重建自 KV 懒加载）
    const llm2 = fakeLlm([{ kind: "text", text: "重启后的回答" }]);
    const svcB = new StewardService({
      llm: llm2,
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      clock: () => 6_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    });
    const replay = await svcB.getHistory();
    expect(replay.map((r) => r.kind)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const thinkingRound = replay.find((r) => r.kind === "assistant" && r.thinking !== undefined);
    expect(thinkingRound).toBeDefined();

    // 同源断言：重启后 LLM 请求窗口 = 回放记录的同构映射（UI 显示的 = LLM 记得的）
    await svcB.ask("继续问");
    const window = llm2.calls[0]!.request.messages;
    expect(window.length).toBe(replay.length + 1);
    expect(window[0]).toEqual({ role: "user", text: "任务状态？" });
    const replayToolTurn = replay[1] as Extract<(typeof replay)[number], { kind: "assistant" }>;
    const windowToolTurn = window[1] as Extract<(typeof window)[number], { role: "assistant" }>;
    expect(windowToolTurn.thinking).toEqual(replayToolTurn.thinking);
    expect(windowToolTurn.toolCall).toEqual(replayToolTurn.toolCall);
  });
});

describe("⑫ A1：过程事件 shape——工具两相帧 + thinking 段级帧", () => {
  test("工具轮：onToolStart(name, argsSummary) → 执行 → onToolEnd(name, resultSummary)；顺序正确", async () => {
    const llm = fakeLlm([
      { kind: "toolCall", id: "call-0", name: "list_instances", args: {} },
      { kind: "text", text: "回答" },
    ]);
    const { svc } = makeService({ llm });
    const events: string[] = [];
    await svc.ask("在跑什么？", {
      onToolStart: (name, argsSummary) => events.push(`start:${name}:${argsSummary}`),
      onToolEnd: (name, resultSummary) => events.push(`end:${name}:${resultSummary.slice(0, 10)}`),
    });
    expect(events.length).toBe(2);
    expect(events[0]).toBe("start:list_instances:{}");
    expect(events[1]!.startsWith("end:list_instances:")).toBe(true);
  });

  test("thinking 段级：onThinking(block) 逐完成块回调（工具轮与文本轮的 thinking 均达）", async () => {
    const llm = fakeLlm(
      thinkingTurn([
        { kind: "toolCall", id: "call-0", name: "list_tasks", args: {}, thinking: { text: "先查清单。" } },
        { kind: "text", text: "答", thinking: { text: "直接答。" } },
      ]),
    );
    const { svc } = makeService({ llm });
    const blocks: string[] = [];
    await svc.ask("问", { onThinking: (block) => blocks.push(block) });
    expect(blocks).toEqual(["先查清单。", "直接答。"]);
  });

  test("money gate 关 → 零过程事件（thinking/tool 零回调）", async () => {
    const llm = fakeLlm([{ kind: "text", text: "x", thinking: { text: "不该出现" } }]);
    const { svc } = makeService({ llm, config: fakeConfig({}) });
    const events: string[] = [];
    await svc.ask("问", {
      onThinking: (b) => events.push(`think:${b}`),
      onToolStart: (n) => events.push(`start:${n}`),
    });
    expect(events).toEqual([]);
  });
});

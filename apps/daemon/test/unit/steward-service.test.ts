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

// ── fakes ─────────────────────────────────────────────────

interface LlmCall {
  readonly request: StewardLlmRequest;
  readonly round: number;
}

/** 剧本化 fake LLM：按调用序出队响应；断言面记录全部调用。 */
function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      const round = calls.length;
      calls.push({ request, round });
      const next = script[round];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
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

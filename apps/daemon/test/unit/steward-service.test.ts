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
import type { StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import {
  STEWARD_FEED_EVENT_TYPES,
  STEWARD_MAX_TOOL_ROUNDS,
} from "../../src/application/steward/StewardService";
import {
  fakeConfig,
  fakeLlm,
  makeService,
  streamingLlm,
  toolCall,
} from "./helpers/steward-service-fixtures";

describe("① 只读状态问答直达（§2 三分法之一）", () => {
  test("list_instances → list_tasks → answer：工具轮执行只读面，最终直答", async () => {
    const llm = fakeLlm([
      toolCall("list_instances", {}),
      toolCall("list_tasks", {}),
      { kind: "blocks", blocks: [{ type: "text", text: "2 个实例：agent-1 运行中（修复登录超时），agent-2 已完成。1 个任务进行中（50%)." }], stopReason: "stop" },
    ]);
    const { svc } = makeService({ llm });
    const result = await svc.ask("现在都有什么在跑？");
    expect(result.status).toBe("answer");
    if (result.status !== "answer") throw new Error("unreachable");
    expect(result.text).toContain("agent-1");
    // 工具轮回灌：toolResult 消息携带实例/任务清单 JSON
    const secondCall = llm.calls[1]!;
    const toolResult = secondCall.request.messages.find(
      (m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult" && m.name === "list_instances",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.text).toContain("agent-1");
    // system prompt 携带三分法骨架
    expect(llm.calls[0]!.request.systemPrompt).toContain("快问快答");
    expect(llm.calls[0]!.request.systemPrompt).toContain("递话");
  });

  test("ask 后会话历史滚动进上下文（第二条 ask 携带首问首答）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "text", text: "第一答" }], stopReason: "stop" },
      { kind: "blocks", blocks: [{ type: "text", text: "第二答" }], stopReason: "stop" },
    ]);
    const { svc } = makeService({ llm });
    await svc.ask("第一问");
    await svc.ask("第二问");
    const messages = llm.calls[1]!.request.messages;
    expect(messages.some((m) => m.role === "user" && m.text === "第一问")).toBe(true);
    expect(
      messages.some(
        (m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === "第一答"),
      ),
    ).toBe(true);
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
    const completed: import("@helix/protocol").StewardActionCompletedPayload[] = [];
    const confirmed = await svc.confirm(askResult.actionId, (p2) => completed.push(p2));
    expect(confirmed.status).toBe("accepted"); // B1 两段式：受理即回
    await new Promise((r) => setTimeout(r, 10)); // 异步执行体收口
    expect(completed.length).toBe(1);
    expect(completed[0]!.ok).toBe(true);
    expect(completed[0]!.detail).toContain("已投递");
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
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "请把这句发给持有上下文的 agent。" }], stopReason: "stop" }]);
    const { svc } = makeService({ llm });
    await svc.ask("就按刚才聊的改");
    const prompt = llm.calls[0]!.request.systemPrompt;
    expect(prompt).toContain("不代答工作上下文");
    expect(prompt).toContain("不执行未过闸");
    expect(prompt).toContain("不伪装用户身份");
  });

  // 【显式契约变更·记忆批（同轨换轨）】工具面十六个 → 十七个：新增 memory_search
  // ——机械召回注入退役，管家记忆消费工具化（SOP 纪律驱动，与编码 agent
  // 同轨）。变更点仅此计数/清单断言。
  test("工具面恰为十七个（七只读——四状态问答 + kg_search/kg_get 项目知识检索 + memory_search 记忆检索 + 六提案原语 + M2 四泛型表面工具 surface_list/snapshot/read/act——A2 扩 query_recent_work/create_session/spawn_review_task；驾驶舱批扩 deliver_to_session；管家记忆 B1 扩 remember；start_session 批扩带话题开局；progress 批 M3 扩 read_session；批A 扩 kg_search/kg_get；记忆批扩 memory_search）——无 spawn/kill 等旁路", async () => {
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const { svc } = makeService({ llm });
    await svc.ask("hi");
    const names = llm.calls[0]!.request.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "act",
      "create_session",
      "deliver_to_session",
      "kg_get",
      "kg_search",
      "list_instances",
      "list_tasks",
      "memory_search",
      "propose_send",
      "query_recent_work",
      "read",
      "read_session",
      "remember",
      "snapshot",
      "spawn_review_task",
      "start_session",
      "surface_list",
    ]);
  });
});

describe("⑤ 开关关 = 零 LLM 调用（money gate 服务端权威）", () => {
  test("steward.enabled ≠ 1 → ask 直接 error 判别，fake LLM 零调用", async () => {
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "不该被调用" }], stopReason: "stop" }]);
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
    // 声明适配（pi 形态）：熔断在超限轮工具起跑时触发——该轮 LLM 调用已
    // 发生；abort 后剧本流断（不无限循环）。上限 N+2 内收口
    expect(llm.calls.length).toBeLessThanOrEqual(STEWARD_MAX_TOOL_ROUNDS + 2);
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
      { response: { kind: "blocks", blocks: [{ type: "text", text: "当前 2 个实例运行中：agent-1、agent-2。" }], stopReason: "stop" }, chunks: ["当前 ", "2 个", "实例运行中"] },
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
      { response: { kind: "blocks", blocks: [{ type: "text", text: "1 个运行中" }], stopReason: "stop" }, chunks: ["1 个", "运行中"] },
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
      { response: { kind: "blocks", blocks: [{ type: "text", text: "不该被调用" }], stopReason: "stop" }, chunks: ["不该"] },
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
      { response: { kind: "blocks", blocks: [{ type: "text", text: "不该到达" }], stopReason: "stop" }, chunks: ["部分", "输出"], failAfterChunks: true },
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

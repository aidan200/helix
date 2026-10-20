/**
 * StewardService 单测——A1 工作记忆批（thinking 回传 / KV 三闸 / 回放同源 /
 * 过程事件）。纯位置迁移自 steward-service.test.ts（P1 体量门拆分批，测试
 * 逻辑与断言零改动）；共享夹具在 ./helpers/steward-service-fixtures。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { StewardAskResultPayload } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import {
  StewardDialogMemory,
  trimToBudget,
  isExpired,
} from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";
import {
  fakeConfig,
  fakeLlm,
  fakeOrchestration,
  makeService,
  toolCall,
} from "./helpers/steward-service-fixtures";


// ══════════════════════════════════════════════════════════
// A1 工作记忆批：thinking 回传 / KV 三闸 / 回放同源 / 过程事件
// ══════════════════════════════════════════════════════════

/** thinking 剧本轮：响应块集含 thinking 块（Phase 1 块模型——A1 批 fake 面扩展）。 */
function thinkingTurn(script: readonly StewardLlmResponse[]) {
  return script;
}

describe("⑨ A1：thinking 回传——多轮工具链上下文含 thinking 形态", () => {
  test("thinking 随 assistant 记录入 KV；下一轮 LLM 请求窗口含 thinking 形态（text+signature）", async () => {
    const llm = fakeLlm(
      thinkingTurn([
        { kind: "blocks", blocks: [{ type: "thinking", text: "用户问全局状态，先查实例清单。", signature: "sig-opaque-1" }, { type: "toolCall", id: "call-0", name: "list_instances", args: {} }], stopReason: "toolUse" },
        { kind: "blocks", blocks: [{ type: "thinking", text: "工具结果只有一条，直接回答。", signature: "sig-opaque-2" }, { type: "text", text: "agent-1 运行中。" }], stopReason: "stop" },
      ]),
    );
    const { svc, dialogStore } = makeService({ llm });
    const result = await svc.ask("在跑什么？");
    expect(result.status).toBe("answer");

    // 第二轮请求窗口（多轮回传断言）：assistant 工具轮记录含 thinking 块
    const secondRound = llm.calls[1]!.request.messages;
    const toolTurn = secondRound.find(
      (m): m is Extract<typeof m, { role: "assistant" }> =>
        m.role === "assistant" && m.content.some((b) => b.type === "toolCall"),
    );
    expect(toolTurn).toBeDefined();
    const toolTurnThinking = toolTurn?.content.find((b) => b.type === "thinking");
    expect(toolTurnThinking).toEqual({ type: "thinking", text: "用户问全局状态，先查实例清单。", signature: "sig-opaque-1" });
    const toolTurnCall = toolTurn?.content.find((b) => b.type === "toolCall");
    expect(toolTurnCall && toolTurnCall.type === "toolCall" && toolTurnCall.name).toBe("list_instances");

    // 落盘记录含 thinking（assistant 文本轮 + 工具轮）
    const withThinking = dialogStore.inspect().records.filter((r) => (r as { thinking?: unknown }).thinking !== undefined);
    expect(withThinking.length).toBe(2);
  });

  test("无 thinking 响应（不支持思考的模型）→ 记录无 thinking 位，窗口形态不变", async () => {
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "直答" }], stopReason: "stop" }]);
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
    const dialog = new StewardDialogMemory(fakeDialogStore(), {
      budgetTokens: 40, // 极小预算：两三条即裁
      now: () => 1_000,
    });
    const svc = new StewardService({
      llm: fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "答一" }], stopReason: "stop" }, { kind: "blocks", blocks: [{ type: "text", text: "答二" }], stopReason: "stop" }]),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      dialog,
      clock: () => 1_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "答一" }], stopReason: "stop" }, { kind: "blocks", blocks: [{ type: "text", text: "答二" }], stopReason: "stop" }]))});
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
    // B6：跨「重启」共享同一行式存储（同库语义）
    const store = fakeDialogStore();
    const dialogA = new StewardDialogMemory(store, { now: () => now });
    const svcA = new StewardService({
      llm: fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "答" }], stopReason: "stop" }]),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      dialog: dialogA,
      clock: () => now,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "答" }], stopReason: "stop" }]))});
    await svcA.ask("留下的对话");
    expect((await svcA.getHistory()).length).toBe(2);

    now += 73 * 60 * 60 * 1000; // 73h 后重启（新实例同存储）
    const dialogB = new StewardDialogMemory(store, { now: () => now });
    const svcB = new StewardService({
      llm: fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "新答" }], stopReason: "stop" }]),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      dialog: dialogB,
      clock: () => now,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "新答" }], stopReason: "stop" }]))});
    expect((await svcB.getHistory()).length).toBe(0); // TTL 清空
    // 纯函数直测：TTL 边界（72h 恰等 = 未过期；超 1ms = 过期）
    expect(isExpired(0, 72 * 60 * 60 * 1000, 72 * 60 * 60 * 1000)).toBe(false);
    expect(isExpired(0, 72 * 60 * 60 * 1000 + 1, 72 * 60 * 60 * 1000)).toBe(true);
  });

  test("新对话闸：clearHistory 三处一致——KV 清空 + LLM 窗口清空 + pending 作废", async () => {
    const kv = fakeConfig({ "steward.enabled": "1" });
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "propose_send", args: { agentId: "agent-1", message: "递话" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "清空后的新答" }], stopReason: "stop" },
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
    createEngine: createEngineFromPort(llm)});
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

  test("新对话闸：clearHistory 收口在途/排队 ask——promise 必 resolve、排队项必 deliver（孤儿化）", async () => {
    // 挂起流：首次 complete 永不返回（在途 run 打不醒的挂死形态），清空后
    // 重建引擎的第二轮正常应答（验证清场不误伤新对话）。
    let llmCalls = 0;
    const hangLlm = {
      modelId: "fake",
      complete: () => {
        llmCalls += 1;
        if (llmCalls === 1) return new Promise<StewardLlmResponse>(() => {});
        return Promise.resolve({
          kind: "blocks",
          blocks: [{ type: "text", text: "新答" }],
          stopReason: "stop",
        } as StewardLlmResponse);
      },
    } as unknown as StewardLlmPort;
    const svc = new StewardService({
      llm: hangLlm,
      createEngine: createEngineFromPort(hangLlm),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      clock: () => 1_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    });
    const delivered: StewardAskResultPayload[] = [];
    const inFlight = svc.ask("在途问题");
    const queued = await svc.ask("排队问题", {}, (p) => delivered.push(p));
    expect(queued.status).toBe("queued"); // 首问已同步占位，次问入队
    await new Promise((r) => setTimeout(r, 10)); // 在途 run 起跑（askSettler 就位）
    await svc.clearHistory();
    // 在途 ask promise 必收口（孤儿化修复面）：error 判别 + aborted 分类
    const outcome = await inFlight;
    expect(outcome).toMatchObject({ status: "error", errorKind: "aborted" });
    // 排队项必作废回执（deliver 面——新对话不再处理）
    expect(delivered.length).toBe(1);
    expect(delivered[0]).toMatchObject({ status: "error" });
    // 清场后新 ask 照常（run 态复位不误伤新对话）
    const fresh = await svc.ask("新对话第一问");
    expect(fresh.status).toBe("answer");
    expect((fresh as { text?: string }).text).toBe("新答");
  });
});

describe("⑪ A1：回放同源——重启恢复后 UI 与 LLM 窗口一致（同源数据）", () => {
  test("daemon 重启（新 service 同存储）→ getHistory 回放完整记录 + 下一轮 LLM 窗口 = 落盘记录映射", async () => {
    const kv = fakeConfig({ "steward.enabled": "1" });
    // B6：跨「重启」共享同一行式存储（同库语义）
    const store = fakeDialogStore();
    const svcA = new StewardService({
      llm: fakeLlm([
        { kind: "blocks", blocks: [{ type: "thinking", text: "查任务清单。", signature: "sig-a" }, { type: "toolCall", id: "call-0", name: "list_tasks", args: {} }], stopReason: "toolUse" },
        { kind: "blocks", blocks: [{ type: "thinking", text: "汇总回答。", signature: "sig-b" }, { type: "text", text: "1 个任务在跑。" }], stopReason: "stop" },
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
      dialog: new StewardDialogMemory(store),
      clock: () => 5_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(fakeLlm([
        { kind: "blocks", blocks: [{ type: "thinking", text: "查任务清单。", signature: "sig-a" }, { type: "toolCall", id: "call-0", name: "list_tasks", args: {} }], stopReason: "toolUse" },
        { kind: "blocks", blocks: [{ type: "thinking", text: "汇总回答。", signature: "sig-b" }, { type: "text", text: "1 个任务在跑。" }], stopReason: "stop" },
      ]))});
    await svcA.ask("任务状态？");

    // 重启：新实例（LLM 窗口重建自 KV 懒加载）
    const llm2 = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "重启后的回答" }], stopReason: "stop" }]);
    const svcB = new StewardService({
      llm: llm2,
      createEngine: createEngineFromPort(llm2),
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: kv,
      dialog: new StewardDialogMemory(store),
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
    // 同源映射：投影记录（thinking/toolCall 三字段）↔ 窗口块数组（块序 thinking → toolCall）
    const replayThinking = replayToolTurn.thinking;
    expect(
      windowToolTurn.content.some(
        (b) => b.type === "thinking" && replayThinking !== undefined && b.text === replayThinking.text && b.signature === replayThinking.signature,
      ),
    ).toBe(true);
    if (replayToolTurn.toolCall !== undefined) {
      expect(
        windowToolTurn.content.some(
          (b) =>
            b.type === "toolCall" && b.id === replayToolTurn.toolCall!.id && b.name === replayToolTurn.toolCall!.name,
        ),
      ).toBe(true);
    }
  });
});

describe("⑫ A1：过程事件 shape——工具两相帧 + thinking 段级帧", () => {
  test("工具轮：onToolStart(name, argsSummary) → 执行 → onToolEnd(name, resultSummary)；顺序正确", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "list_instances", args: {} }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "回答" }], stopReason: "stop" },
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
        { kind: "blocks", blocks: [{ type: "thinking", text: "先查清单。" }, { type: "toolCall", id: "call-0", name: "list_tasks", args: {} }], stopReason: "toolUse" },
        { kind: "blocks", blocks: [{ type: "thinking", text: "直接答。" }, { type: "text", text: "答" }], stopReason: "stop" },
      ]),
    );
    const { svc } = makeService({ llm });
    const blocks: string[] = [];
    await svc.ask("问", { onThinking: (block) => blocks.push(block) });
    expect(blocks).toEqual(["先查清单。", "直接答。"]);
  });

  test("money gate 关 → 零过程事件（thinking/tool 零回调）", async () => {
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "thinking", text: "不该出现" }, { type: "text", text: "x" }], stopReason: "stop" }]);
    const { svc } = makeService({ llm, config: fakeConfig({}) });
    const events: string[] = [];
    await svc.ask("问", {
      onThinking: (b) => events.push(`think:${b}`),
      onToolStart: (n) => events.push(`start:${n}`),
    });
    expect(events).toEqual([]);
  });
});

/**
 * StewardService 单测——A1-hotfix toolCall/toolResult 配对完整性批（裁剪器
 * 配对感知 + 构建面防御 + 端到端自愈）。纯位置迁移自 steward-service.test.ts
 * （P1 体量门拆分批，测试逻辑与断言零改动）；共享夹具在
 * ./helpers/steward-service-fixtures。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type { StewardLlmMessage } from "../../src/application/ports/outbound/StewardLlmPort";
import type { StewardHistoryRecord } from "@helix/protocol";
import {
  StewardService,
  buildLlmWindow,
  capToolResultText,
  compactInstanceRows,
  STEWARD_MISSING_TOOL_RESULT_TEXT,
  TOOL_RESULT_MAX_CHARS,
  INSTANCE_TASK_MAX_CHARS,
  INSTANCE_SUMMARY_MAX_CHARS,
} from "../../src/application/steward/StewardService";
import { StewardDialogMemory, trimToBudget } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";
import {
  fakeConfig,
  fakeLlm,
  fakeOrchestration,
  toolCall,
} from "./helpers/steward-service-fixtures";


// ══════════════════════════════════════════════════════════
// A1-hotfix：toolCall/toolResult 配对完整性（400 tool_call_id is not found）
// 双保险：裁剪器配对感知（trimToBudget）+ 构建面防御（buildLlmWindow）
// ══════════════════════════════════════════════════════════

/** 配对完整性断言（送 LLM 的窗口不变量）：
 *  ① 每个 toolResult 的 toolCallId 在窗内有配对 assistant toolCall 块；
 *  ② 每个 assistant toolCall 块在窗内有配对 toolResult（合成的也算）。 */
function assertPairingComplete(messages: readonly unknown[]): void {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const msg = m as { role?: string; content?: readonly { type?: string; id?: string }[]; toolCallId?: string };
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "toolCall" && typeof b.id === "string") callIds.add(b.id);
      }
    }
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") resultIds.add(msg.toolCallId);
  }
  for (const id of resultIds) expect(callIds.has(id)).toBe(true);
  for (const id of callIds) expect(resultIds.has(id)).toBe(true);
}

describe("⑬ A1-hotfix：裁剪器配对感知（trimToBudget）", () => {
  test("预算触顶 + 裁剪线切中配对 → 窗口头无孤儿 toolResult（配对整体弃）", () => {
    // 预算 30：弃 user(108) 后仍超（38>30）→ 再弃 assistant(toolCall 14) 后
    // 达标（24≤30）→ 旧实现窗口头 = toolResult(c1) 孤儿（400 根因）；
    // 配对感知后连弃。
    const trimmed = trimToBudget(
      [
        { kind: "user", text: "x".repeat(200), at: 1 },
        { kind: "assistant", toolCall: { id: "c1", name: "list_tasks", args: {} }, at: 2 },
        { kind: "toolResult", toolCallId: "c1", name: "list_tasks", text: "[]", at: 3 },
        { kind: "user", text: "继续问", at: 4 },
      ],
      30,
    );
    expect(trimmed.map((r) => r.kind)).toEqual(["user"]);
  });

  test("未触预算但头部有孤儿（脏 KV 残留）→ 同样丢弃（append 路径自愈）；连续多孤儿全弃", () => {
    const cleaned = trimToBudget(
      [
        { kind: "toolResult", toolCallId: "gone-1", name: "list_tasks", text: "[]", at: 1 },
        { kind: "toolResult", toolCallId: "gone-2", name: "list_instances", text: "[]", at: 2 },
        { kind: "user", text: "问", at: 3 },
        { kind: "assistant", text: "答", at: 4 },
      ],
      16_384,
    );
    expect(cleaned.map((r) => r.kind)).toEqual(["user", "assistant"]);
  });

  test("回归：配对完整窗口的正常裁剪不误伤（toolCall+toolResult 成对保留）", () => {
    const trimmed = trimToBudget(
      [
        { kind: "user", text: "x".repeat(200), at: 1 },
        { kind: "assistant", toolCall: { id: "c1", name: "list_tasks", args: {} }, at: 2 },
        { kind: "toolResult", toolCallId: "c1", name: "list_tasks", text: "[]", at: 3 },
        { kind: "assistant", text: "答", at: 4 },
      ],
      60,
    );
    expect(trimmed.map((r) => r.kind)).toEqual(["assistant", "toolResult", "assistant"]);
  });

  test("孤儿独活清空：唯一幸存条为巨型孤儿 toolResult → 允许清空（空窗口优于毒孤儿——537KB 根因场景）", () => {
    // 预算 40 + 巨型 toolResult（537,026 字符 ≈ 27 万 token = 预算 17 倍）：
    // 旧「至少留一条」保底会留住毒孤儿直达 provider → 400；新语义允许清空。
    const emptied = trimToBudget(
      [
        { kind: "user", text: "旧问", at: 1 },
        { kind: "toolResult", toolCallId: "call-mega", name: "list_instances", text: "x".repeat(537_026), at: 2 },
      ],
      40,
    );
    expect(emptied).toEqual([]);
  });

  test("回归护栏：单条巨型 assistant/user 超预算仍保留（至少留一条语义维持——截断问题由写入面 4000 上限兑底）", () => {
    const kept = trimToBudget([{ kind: "assistant", text: "x".repeat(537_026), at: 1 }], 40);
    expect(kept.length).toBe(1);
    expect(kept[0]!.kind).toBe("assistant");
  });
});

describe("⑭ A1-hotfix：构建面防御（buildLlmWindow）", () => {
  test("孤儿 toolResult 丢弃 + 缺结果 toolCall 追加合成 toolResult（紧随其后）", () => {
    const input: StewardHistoryRecord[] = [
      { kind: "toolResult", toolCallId: "orphan", name: "list_tasks", text: "孤儿结果", at: 1 },
      { kind: "user", text: "问", at: 2 },
      { kind: "assistant", toolCall: { id: "c9", name: "propose_send", args: { agentId: "agent-1", message: "m" } }, at: 3 },
    ];
    const snapshot = [...input];
    const messages = buildLlmWindow(input);
    // 纯读面：输入数组不被改写（防御修复零写副作用）
    expect(input).toEqual(snapshot);
    // 孤儿 toolResult 丢弃
    expect(messages.some((m) => m.role === "toolResult" && m.toolCallId === "orphan")).toBe(false);
    // 缺结果 toolCall → 合成 toolResult（id/name 对齐 + 指定文案）紧随其后
    const callIdx = messages.findIndex(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === "c9"),
    );
    expect(callIdx).toBeGreaterThan(-1);
    const synth = messages[callIdx + 1];
    expect(synth).toEqual({
      role: "toolResult",
      toolCallId: "c9",
      name: "propose_send",
      text: STEWARD_MISSING_TOOL_RESULT_TEXT,
    });
    assertPairingComplete(messages);
  });

  test("回归：配对完整的记录 1:1 直映（零合成零丢弃）", () => {
    const messages = buildLlmWindow([
      { kind: "user", text: "问", at: 1 },
      { kind: "assistant", toolCall: { id: "c1", name: "list_tasks", args: {} }, at: 2 },
      { kind: "toolResult", toolCallId: "c1", name: "list_tasks", text: "[]", at: 3 },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
  });
});

describe("⑮ A1-hotfix：脏 KV 回放自愈（端到端）", () => {
  function dirtyStore(): ReturnType<typeof fakeDialogStore> {
    const now = Date.now();
    const store = fakeDialogStore();
    store.replaceAll(
      [
        // 旧裁剪器残留：孤儿 toolResult（配对头已不在窗内）
        { kind: "toolResult", toolCallId: "call-cut", name: "list_instances", text: "[]", at: now - 2500 },
        { kind: "user", text: "旧问", at: now - 5000 },
        { kind: "assistant", toolCall: { id: "call-ok", name: "list_tasks", args: {} }, at: now - 4000 },
        { kind: "toolResult", toolCallId: "call-ok", name: "list_tasks", text: "[]", at: now - 3000 },
        // 确认闸挂起形态：toolCall 无结果
        {
          kind: "assistant",
          toolCall: { id: "call-hang", name: "propose_send", args: { agentId: "agent-1", message: "递话" } },
          at: now - 2000,
        },
        { kind: "user", text: "继续", at: now - 1000 },
      ],
      now - 1000,
    );
    return store;
  }

  test("预置孤儿 + 挂起 toolCall → ask 窗口配对完整；读面回放原样（防御修复零写）", async () => {
    const store = dirtyStore();
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "新答" }], stopReason: "stop" }]);
    const svc = new StewardService({
      llm,
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      dialog: new StewardDialogMemory(store),
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(llm)});
    // 纯读面（history 回放）：脏记录原样返回（UI 显示照旧——防御不碰 KV 读面）
    const replay = await svc.getHistory();
    expect(replay.length).toBe(6);
    expect(replay.some((r) => r.kind === "toolResult" && r.toolCallId === "call-cut")).toBe(true);

    await svc.ask("新问");
    const window = llm.calls[0]!.request.messages;
    // 孤儿 toolResult 不入 LLM 窗口
    expect(window.some((m) => m.role === "toolResult" && m.toolCallId === "call-cut")).toBe(false);
    // 挂起 toolCall 有合成结果（指定文案）
    const synth = window.find((m) => m.role === "toolResult" && m.toolCallId === "call-hang");
    expect(synth).toEqual({
      role: "toolResult",
      toolCallId: "call-hang",
      name: "propose_send",
      text: STEWARD_MISSING_TOOL_RESULT_TEXT,
    });
    assertPairingComplete(window);
    // 正常配对记录原样在窗
    expect(window.some((m) => m.role === "toolResult" && m.toolCallId === "call-ok")).toBe(true);
  });

  test("append 路径自愈：ask 后落盘内孤儿被裁剪器清除（窗口头配对头齐整）", async () => {
    const store = dirtyStore();
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "新答" }], stopReason: "stop" }]);
    const svc = new StewardService({
      llm,
      orchestration: fakeOrchestration([]),
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      dialog: new StewardDialogMemory(store),
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(llm)});
    await svc.ask("新问");
    const records = await svc.getHistory();
    // 孤儿被 append 时裁剪器清除；其余记录 + 新增记录保留
    expect(records.some((r) => r.kind === "toolResult" && r.toolCallId === "call-cut")).toBe(false);
    expect(records.some((r) => r.kind === "user" && r.text === "新问")).toBe(true);
    expect(records.some((r) => r.kind === "toolResult" && r.toolCallId === "call-ok")).toBe(true);
  });
});

describe("⑯ A1-hotfix：预算裁剪切中配对（端到端小预算）", () => {
  test("小预算 + 工具轮 → 下一轮 LLM 窗口头无孤儿、配对完整", async () => {
    const kv = fakeConfig({ "steward.enabled": "1" });
    const dialog = new StewardDialogMemory(fakeDialogStore(), { budgetTokens: 40, now: () => 1_000 });
    const llm = fakeLlm([
      toolCall("list_instances", {}), // round 0 → call-0
      { kind: "blocks", blocks: [{ type: "text", text: "答" }], stopReason: "stop" },
      { kind: "blocks", blocks: [{ type: "text", text: "答二" }], stopReason: "stop" },
    ]);
    const svc = new StewardService({
      llm,
      orchestration: fakeOrchestration([]), // status() → [] → 工具结果 "[]"（小体积可控）
      tasks: { listTasks: () => [] },
      config: kv,
      dialog,
      clock: () => 1_000,
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(llm)});
    const first = await svc.ask("x".repeat(200)); // user(108) 触顶
    expect(first.status).toBe("answer");
    const second = await svc.ask("继续问");
    expect(second.status).toBe("answer");
    const window = llm.calls[2]!.request.messages; // 第二次 ask 的首轮请求
    expect(window[0]!.role).not.toBe("toolResult"); // 窗口头非孤儿 toolResult
    assertPairingComplete(window);
  });
});

describe("⑰ A1-hotfix：确认闸挂起 toolCall（端到端）", () => {
  test("propose_send → confirm_required（无 toolResult 入史）→ 下一轮窗口对挂起调用有合成结果", async () => {
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "顺带跑一下 lint" }),
      { kind: "blocks", blocks: [{ type: "text", text: "好" }], stopReason: "stop" },
    ]);
    const orchestration = fakeOrchestration([
      { agentId: "agent-1", state: "running", displayState: "active", profileKind: "subagent-worker", task: "t" },
    ]);
    const svc = new StewardService({
      llm,
      orchestration,
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(llm)});
    const first = await svc.ask("帮我递话给 agent-1");
    expect(first.status).toBe("confirm_required");
    const second = await svc.ask("然后呢？");
    expect(second.status).toBe("answer");
    const window = llm.calls[1]!.request.messages;
    assertPairingComplete(window);
    // 声明适配（pi 形态）：挂起 toolCall 的新 ask 走 abort-再驱动——被弃
    // run 的挂起调用由引擎合成 "Operation aborted" 回执配对（原 loop 合成
    // STEWARD_MISSING_TOOL_RESULT_TEXT 占位）；配对完整性不变量保持
    const synth = window.find((m) => m.role === "toolResult" && m.toolCallId === "call-0");
    expect(synth).toMatchObject({ role: "toolResult", toolCallId: "call-0", name: "propose_send" });
    expect(((synth as { text?: string } | undefined)?.text ?? "").length).toBeGreaterThan(0);
  });
});

describe("⑱ A1-hotfix：工具结果体量护栏（537KB 根因实证）", () => {
  test("capToolResultText 边界：≤4000 原样；超出截断 + 指定标记", () => {
    const short = "x".repeat(TOOL_RESULT_MAX_CHARS);
    expect(capToolResultText(short)).toBe(short);
    const over = "y".repeat(TOOL_RESULT_MAX_CHARS + 1);
    const capped = capToolResultText(over);
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 30); // 截断 + 标记
    expect(capped).toContain("…（已截断，完整结果见过程帧）");
    expect(capped.startsWith("y")).toBe(true);
  });

  test("compactInstanceRows：active 保 id/state/task(≤120)/summary；非 active 仅 id/state/summary(≤80)，弃 displayState/task", () => {
    const rows = compactInstanceRows([
      {
        agentId: "agent-1",
        state: "running",
        displayState: "active",
        task: "t".repeat(500),
        summary: "s".repeat(500),
      },
      {
        agentId: "agent-2",
        state: "done",
        displayState: "done",
        task: "t".repeat(500),
        summary: "s".repeat(500),
      },
    ]);
    expect(rows[0]).toEqual({
      agentId: "agent-1",
      state: "running",
      task: "t".repeat(INSTANCE_TASK_MAX_CHARS) + "…",
      summary: "s".repeat(INSTANCE_TASK_MAX_CHARS) + "…",
    });
    expect(rows[1]).toEqual({
      agentId: "agent-2",
      state: "done",
      summary: "s".repeat(INSTANCE_SUMMARY_MAX_CHARS) + "…",
    });
  });

  test("端到端：多实例 × 长 task → 送 LLM 的 toolResult ≤ 4000 + 截断标记；onToolEnd 过程帧摘要不受影响", async () => {
    const statuses = Array.from({ length: 60 }, (_, i) => ({
      agentId: `agent-${i}`,
      state: "running" as const,
      displayState: "active" as const,
      profileKind: "subagent-worker",
      task: `任务 ${i}：` + "t".repeat(200),
    }));
    const llm = fakeLlm([toolCall("list_instances", {}), { kind: "blocks", blocks: [{ type: "text", text: "答" }], stopReason: "stop" }]);
    const orchestration = fakeOrchestration(statuses);
    const svc = new StewardService({
      llm,
      orchestration,
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(llm)});
    const toolEnds: string[] = [];
    const result = await svc.ask("在跑什么？", { onToolEnd: (_n, s) => toolEnds.push(s) });
    expect(result.status).toBe("answer");
    const toolResult = llm.calls[1]!.request.messages.find(
      (m): m is Extract<StewardLlmMessage, { role: "toolResult" }> => m.role === "toolResult" && m.name === "list_instances",
    );
    if (toolResult === undefined) throw new Error("toolResult 消息缺席");
    expect(toolResult.text.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 30);
    expect(toolResult.text).toContain("…（已截断，完整结果见过程帧）");
    // 声明适配（pi 形态）：事件面无工具自报 summary——过程帧摘要 = 结果
    // 短摘派生（≤120 面）；写入面截断护栏不受影响
    expect(toolEnds.length).toBe(1);
    expect(toolEnds[0]!.length).toBeLessThanOrEqual(120);
  });

  test("端到端：单实例 537KB task → 投影瘦身（task ≤ 120）；预算恢复健康（第二轮窗口保留第一轮对话）", async () => {
    const llm = fakeLlm([
      toolCall("list_instances", {}),
      { kind: "blocks", blocks: [{ type: "text", text: "答一" }], stopReason: "stop" },
      { kind: "blocks", blocks: [{ type: "text", text: "答二" }], stopReason: "stop" },
    ]);
    const orchestration = fakeOrchestration([
      {
        agentId: "agent-mega",
        state: "running",
        displayState: "active",
        profileKind: "subagent-worker",
        task: "x".repeat(537_026), // 生产根因体量：完整 task brief 文本
      },
    ]);
    const svc = new StewardService({
      llm,
      orchestration,
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      feedGate: { hasStewardSubscribers: () => false },
      emitFeed: () => {},
    createEngine: createEngineFromPort(llm)});
    await svc.ask("第一问");
    await svc.ask("第二问");
    // 投影瘦身：送 LLM 的 toolResult 不含 537KB 原文，task 被截到 ≤120
    const toolResult = llm.calls[1]!.request.messages.find(
      (m): m is Extract<StewardLlmMessage, { role: "toolResult" }> => m.role === "toolResult" && m.name === "list_instances",
    );
    if (toolResult === undefined) throw new Error("toolResult 消息缺席");
    expect(toolResult.text.length).toBeLessThan(500);
    expect(toolResult.text).toContain("agent-mega");
    // 预算恢复健康：无巨毒记录挤占窗口——第二轮首轮请求仍携带第一轮对话
    const secondWindow = llm.calls[2]!.request.messages;
    expect(secondWindow.some((m) => m.role === "user" && m.text === "第一问")).toBe(true);
    assertPairingComplete(secondWindow);
  });
});

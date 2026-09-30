import { describe, expect, test } from "bun:test";
import type { LoopEvent, LoopMessage, LoopStreamFn, LoopStreamResult, LoopToolOutcome } from "../../src/domain/loop";
import { LoopEngine, ToolRegistry } from "../../src/domain/loop";
import { estimateLoopTokens, planCompactionWindow } from "../../src/domain/loop/policy/Compaction";

/**
 * helix-loop L1 件一（上下文压缩）单测——domain 层零依赖可测：
 * 1. 触发：窗口超阈 → summarize 调用发起 → synthesized 消息入窗
 *    （compaction: true）→ 后续 streamFn 从压缩态起算 → 事件
 *    loop.context.compacted(completed, tokensBefore/After)；
 * 2. 配对保护（duplex-truncation I5 同族）：压缩区间含 toolCall/toolResult
 *    配对边界 → 保留区头不得是孤儿 toolResult（边界左移纳入压缩区）；
 * 3. 失败降级：summarize 抛错 → 事件 failed → 原窗口继续（粗裁剪兜底）→
 *    对话不中断；
 * 4. 阈值内不触发（零 LLM 调用开销）。
 */

/** 剧本便捷构造（Phase 1 块模型判别——blocks + stopReason）。 */
function textResult(text: string): LoopStreamResult {
  return { kind: "blocks", blocks: [{ type: "text", text }], stopReason: "stop" };
}

function toolCallResult(id: string, name: string, args: Record<string, unknown>): LoopStreamResult {
  return { kind: "blocks", blocks: [{ type: "toolCall", id, name, args }], stopReason: "toolUse" };
}

function fakeStream(
  script: readonly LoopStreamResult[],
  hooks?: { onCall?: (messages: readonly LoopMessage[]) => void },
): LoopStreamFn {
  let round = 0;
  return async (input, callbacks) => {
    hooks?.onCall?.(input.messages);
    const next = script[round];
    round += 1;
    if (next === undefined) throw new Error("剧本耗尽");
    if (next.kind === "blocks" && next.blocks.some((b) => b.type === "text") && callbacks?.onDelta !== undefined) {
      callbacks.onDelta("段");
    }
    return next;
  };
}

function registryWithNoop(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "noop",
    parameters: { type: "object", properties: {} },
    handler: async (): Promise<LoopToolOutcome> => ({ kind: "result", text: "ok" }),
  });
  return registry;
}

/** 长文本消息（token 体量驱动用）。 */
function longUser(text: string): LoopMessage {
  return { role: "user", text };
}

describe("LoopCompaction：纯函数", () => {
  test("estimateLoopTokens：chars/2 + 每条 8 形状开销（与 StewardDialogMemory.estimateTokens 同族口径）", () => {
    const single = estimateLoopTokens([{ role: "user", text: "abcd" }]);
    expect(single).toBe(2 + 8); // ceil(4/2) + 8
    const two = estimateLoopTokens([longUser("abcd"), longUser("ef")]);
    expect(two).toBe(3 + 16);
  });

  test("planCompactionWindow：阈值内 → null（不触发）", () => {
    const messages = [longUser("短"), longUser("话")];
    expect(planCompactionWindow(messages, { thresholdTokens: 10_000, keepRecent: 6 })).toBeNull();
  });

  test("planCompactionWindow：超阈 → 保尾 keepRecent 条；保留区头孤儿 toolResult 边界左移（I5 配对保护）", () => {
    // 构造：3 条长历史 + assistant toolCall(tc-1) + user 插话 + toolResult(tc-1)
    // + 5 条近话 = 11 条。keepRecent=6 → 初始 compactFrom=5 → messages[5] 是
    // toolResult(tc-1)，其配对 call 在 index 3（保留区内 callIds 不含 tc-1）
    // → 孤儿 → 边界左移；messages[4] 是 user（非孤儿）→ 停 → compactFrom=4。
    const messages: LoopMessage[] = [];
    for (let i = 0; i < 3; i += 1) messages.push(longUser(`历史话题${i}-${"x".repeat(200)}`));
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "list_tasks", args: {} }] });
    messages.push(longUser(`插话-${"y".repeat(200)}`));
    messages.push({ role: "toolResult", toolCallId: "tc-1", name: "list_tasks", text: "z".repeat(200) });
    for (let i = 0; i < 5; i += 1) messages.push(longUser(`近话${i}-${"w".repeat(200)}`));
    const plan = planCompactionWindow(messages, { thresholdTokens: 600, keepRecent: 6 });
    expect(plan).not.toBeNull();
    expect(plan!.compactFrom).toBe(4);
    // 保留区头（messages[4]）非孤儿 toolResult（I5 满足）
    expect(messages[plan!.compactFrom]!.role).toBe("user");
  });

  test("planCompactionWindow：配对完整落在保留窗内 → 边界不左移（原样保尾）", () => {
    // 7 条：5 历史 + call(idx5) + result(idx6)。keepRecent=6 → compactFrom=1
    // → 保留区 [1,7) 含完整 call/result 对；头 idx1 是 user（非孤儿）→ 不左移。
    const messages: LoopMessage[] = [];
    for (let i = 0; i < 5; i += 1) messages.push(longUser(`历史${i}-${"x".repeat(200)}`));
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "t", args: {} }] });
    messages.push({ role: "toolResult", toolCallId: "tc-1", name: "t", text: "r".repeat(200) });
    const plan = planCompactionWindow(messages, { thresholdTokens: 400, keepRecent: 6 });
    expect(plan).not.toBeNull();
    expect(plan!.compactFrom).toBe(1);
  });

  test("planCompactionWindow：全部在保留窗内（超窗但无可压区间）→ null（粗裁剪兜底）", () => {
    const messages = [longUser("唯一巨长".repeat(500))];
    expect(planCompactionWindow(messages, { thresholdTokens: 100, keepRecent: 6 })).toBeNull();
  });
});

describe("LoopEngine：压缩挂点（每轮结束后→下轮 streamFn 前检查，首轮前同查）", () => {
  test("用例1 压缩触发：超阈 → summarize 发起（携压缩区间）→ 摘要入窗（compaction:true）→ 后续轮从压缩态起算 → completed 事件 + onCompacted 回调", async () => {
    const events: LoopEvent[] = [];
    const summarized: (readonly LoopMessage[])[] = [];
    const compactedInfos: unknown[] = [];
    const streamWindows: (readonly LoopMessage[])[] = [];
    // 剧本：首轮 toolCall（历史含 8 条长消息超阈但首轮前压缩已把历史折叠）
    // → 工具回灌 → 第二轮（轮边界再查：工具结果回灌后可能再超→再压或已低于阈）
    // → text 终答。
    const engine = new LoopEngine({
      streamFn: fakeStream(
        [toolCallResult("tc-1", "noop", {}), textResult("终答")],
        { onCall: (m) => streamWindows.push([...m]) },
      ),
      registry: registryWithNoop(),
      emit: (e) => events.push(e),
      compaction: {
        thresholdTokens: 400,
        keepRecent: 6,
        summarize: async (msgs) => {
          summarized.push(msgs);
          return "（压缩摘要：用户问了任务状态，工具查得 2 条在跑）";
        },
      },
    });
    const initial: LoopMessage[] = [];
    for (let i = 0; i < 8; i += 1) initial.push(longUser(`历史${i}-${"a".repeat(150)}`));
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: initial,
        tools: [],
        maxRounds: 6,
        onCompacted: async (info) => {
          compactedInfos.push(info);
        },
      })
      .promise;
    expect(result).toEqual({ kind: "finished", blocks: [{ type: "text", text: "终答" }] });
    // summarize 被调用（首轮前——历史 8 条超 400 阈值即触发）
    expect(summarized.length).toBeGreaterThanOrEqual(1);
    // 后续轮窗口从压缩态起算：messages[0] = 摘要（compaction:true）
    const secondWindow = streamWindows[1]!;
    expect((secondWindow[0] as { compaction?: boolean }).compaction).toBe(true);
    expect((secondWindow[0] as { text?: string }).text).toContain("压缩摘要");
    // completed 事件：tokensBefore > tokensAfter
    const compacted = events.filter((e) => e.type === "loop.context.compacted");
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    const first = compacted[0]!;
    if (first.type === "loop.context.compacted") {
      expect(first.status).toBe("completed");
      expect(first.tokensBefore).toBeGreaterThan(first.tokensAfter!);
      expect(first.summary).toContain("压缩摘要");
    }
    // onCompacted 回调（调用方 KV 替换面）
    expect(compactedInfos.length).toBeGreaterThanOrEqual(1);
  });

  test("用例2 配对保护：压缩替换后窗口无孤儿 toolResult（保留区头恒配对完整）", async () => {
    const events: LoopEvent[] = [];
    const streamWindows: (readonly LoopMessage[])[] = [];
    const messages: LoopMessage[] = [];
    for (let i = 0; i < 5; i += 1) messages.push(longUser(`历史${i}-${"a".repeat(200)}`));
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: "tc-9", name: "noop", args: {} }] });
    messages.push({ role: "toolResult", toolCallId: "tc-9", name: "noop", text: "r".repeat(200) });
    for (let i = 0; i < 5; i += 1) messages.push(longUser(`近${i}-${"b".repeat(200)}`));
    const engine = new LoopEngine({
      streamFn: fakeStream([textResult("答")], { onCall: (m) => streamWindows.push([...m]) }),
      registry: registryWithNoop(),
      emit: (e) => events.push(e),
      compaction: {
        thresholdTokens: 500,
        keepRecent: 4, // 初始边界切在 call(idx5) 与 result(idx6) 之间 → 孤儿 → 左移
        summarize: async () => "摘要：工具已查过，结论 X。",
      },
    });
    await engine.startRun({ systemPrompt: "s", messages, tools: [], maxRounds: 6 }).promise;
    // 首请求窗口：压缩后 messages[0]=摘要；窗内无孤儿 toolResult
    const window = streamWindows[0]!;
    expect((window[0] as { compaction?: boolean }).compaction).toBe(true);
    const callIds = new Set<string>();
    for (const m of window) {
      if (m.role === "assistant") {
        for (const b of m.content) {
          if (b.type === "toolCall") callIds.add(b.id);
        }
      }
    }
    for (const m of window) {
      if (m.role === "toolResult") {
        expect(callIds.has(m.toolCallId)).toBe(true); // I1/I5：无孤儿
      }
    }
  });

  test("用例3 压缩失败降级：summarize 抛错 → failed 事件 → 原窗口继续（粗裁剪由调用方兜底）→ 对话完成不中断", async () => {
    const events: LoopEvent[] = [];
    const streamWindows: (readonly LoopMessage[])[] = [];
    const initial: LoopMessage[] = [];
    for (let i = 0; i < 8; i += 1) initial.push(longUser(`历史${i}-${"a".repeat(150)}`));
    const engine = new LoopEngine({
      streamFn: fakeStream([textResult("答")], { onCall: (m) => streamWindows.push([...m]) }),
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      compaction: {
        thresholdTokens: 400,
        keepRecent: 6,
        summarize: async () => {
          throw new Error("压缩模型调用失败");
        },
      },
    });
    const result = await engine.startRun({ systemPrompt: "s", messages: initial, tools: [], maxRounds: 6 }).promise;
    expect(result).toEqual({ kind: "finished", blocks: [{ type: "text", text: "答" }] }); // 永不阻塞对话
    const compacted = events.find((e) => e.type === "loop.context.compacted");
    expect(compacted).toBeDefined();
    if (compacted!.type === "loop.context.compacted") {
      expect(compacted!.status).toBe("failed");
      expect(compacted!.error).toContain("压缩模型调用失败");
    }
    // 原窗口继续：首请求 messages 原样（无摘要头）
    const window = streamWindows[0]!;
    expect((window[0] as { compaction?: boolean }).compaction).toBeUndefined();
    expect(window.length).toBe(initial.length);
  });

  test("阈值内不触发：无 summarize 调用、无压缩事件（零额外 LLM 开销）", async () => {
    const events: LoopEvent[] = [];
    let summarizeCalls = 0;
    const engine = new LoopEngine({
      streamFn: fakeStream([textResult("答")]),
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      compaction: {
        thresholdTokens: 10_000,
        keepRecent: 6,
        summarize: async () => {
          summarizeCalls += 1;
          return "不应被调用";
        },
      },
    });
    await engine.startRun({ systemPrompt: "s", messages: [longUser("问")], tools: [], maxRounds: 6 }).promise;
    expect(summarizeCalls).toBe(0);
    expect(events.some((e) => e.type === "loop.context.compacted")).toBe(false);
  });
});

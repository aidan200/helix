import { describe, expect, test } from "bun:test";
import type {
  LoopEvent,
  LoopMessage,
  LoopStreamBlock,
} from "../../src/domain/loop";
import { LoopEngine, ToolRegistry } from "../../src/domain/loop";
import {
  LOOP_INTERRUPTED_MARKER_TEXT,
  LOOP_INTERRUPTED_TOOL_RESULT_TEXT,
} from "../../src/domain/loop";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import { StewardService } from "../../src/application/steward/StewardService";

/**
 * E-198 打断善后（partial 保留）单测——aborted 轮从「整轮丢弃」升级为
 * 「安全块入账 + 截断标记 + 不安全块丢弃」（G1 定稿对齐：无 text_end 的
 * 半截 text 经 aborted 判别 partialText 入账 + 截断标记——duplex-truncation
 * §3.3 text 行；partialText 缺席/空 = 行为与 G1 前完全一致）：
 * - T1 text 流中段打断：完整块 + 半截 text（partialText）同批入账 + 标记在、零重复；
 * - T1b 仅半截 text：入账 + 截断标记（G1 语义翻转——原丢弃）；
 * - T1c/T1d abort 于 text_end 之后 / partialText 空串：无未关账块，行为不变；
 * - T2 thinking 流中段打断：半截丢（无签名不可回传；悬挂 thinking 亦不可
 *   单独回传——"reasoning without following item"）；
 * - T3 toolcall 参数流中段打断：半截丢、无孤儿 toolCall（完整收尾但未执行
 *   的 toolCall → 合成中断 toolResult 配对，I3）；
 * - T6 连续多次打断：标记正确累积不重复；
 * - T9 打断信号重复到达：幂等（无二次入账/事件各一次）；
 * - 事件序：loop.run.interrupted 先于 loop.run.finished(aborted)，各一次。
 *
 * 契约前提：LoopStreamCallbacks.onBlockEnd（块 end = 完整性唯一凭证 I1——
 * 半截块无此帧，天然在丢弃面）。
 */

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 子串出现次数（零重复入账断言面）。 */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("LoopEngine：打断善后（E-198 partial 保留）", () => {
  test("T1 text 流中段打断：完整块 + 半截 text（partialText，G1）同批入账 + 截断标记；零重复；audit 携带", async () => {
    const controller = new AbortController();
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        // 块 1 完整（text_end 凭证）
        callbacks?.onBlockEnd?.({ kind: "text", text: "第一块完整内容" });
        // 块 2 半截：text_start 后只有 delta，无 end——adapter 只把未关账增量
        // 累积为 partialText（不得含已关账块，防重复入账）
        callbacks?.onDelta?.("第二块半截");
        controller.abort("barge-in");
        return { kind: "aborted", partialText: "第二块半截" };
      },
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      newRunId: () => "t1",
    });
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(result.kind).toBe("aborted");
    // 完成块 + 半截 text 同批入账（G1：与完成块同批记录）+ 截断标记
    expect(recorded).toEqual([
      { role: "assistant", text: "第一块完整内容\n\n第二块半截" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
    // 零重复入账：完成块与 partialText 各恰一次（partialText 只携未关账增量）
    const flat = recorded.map((m) => m.text ?? "").join("\n");
    expect(countOccurrences(flat, "第一块完整内容")).toBe(1);
    expect(countOccurrences(flat, "第二块半截")).toBe(1);
    // 事件序：interrupted 先于 finished(aborted)，各一次
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "loop.run.interrupted").length).toBe(1);
    expect(types.filter((t) => t === "loop.run.finished").length).toBe(1);
    expect(types.indexOf("loop.run.interrupted")).toBeLessThan(types.indexOf("loop.run.finished"));
    const finished = events.find((e) => e.type === "loop.run.finished") as { resolution: string };
    expect(finished.resolution).toBe("aborted");
    const interrupted = events.find((e) => e.type === "loop.run.interrupted") as { reason: string };
    expect(interrupted.reason).toContain("barge-in");
    // audit：入账 1 条（I6 审计面）
    if (result.kind !== "aborted") throw new Error("应 aborted");
    expect(result.audit?.keptMessages).toBe(1);
  });

  test("T1b 仅半截 text（无完成块）：入账 + 截断标记（G1 语义翻转——原「半截 text 丢弃」）", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        // 单 text 块长回答中途被掐：text_start 后只有 delta，无 end
        callbacks?.onDelta?.("只有半截句");
        controller.abort("barge-in");
        return { kind: "aborted", partialText: "只有半截句" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t1b",
    });
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(result.kind).toBe("aborted");
    // 半截 text 入账（模型记得被掐断的已播半句——P2）+ 截断标记照落
    expect(recorded).toEqual([
      { role: "assistant", text: "只有半截句" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
    if (result.kind !== "aborted") throw new Error("应 aborted");
    expect(result.audit?.keptMessages).toBe(1);
  });

  test("T1c abort 于 text_end 之后（无未关账块，partialText 缺席）：行为与 G1 前完全一致", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        callbacks?.onBlockEnd?.({ kind: "text", text: "完整收尾" });
        controller.abort("barge-in");
        return { kind: "aborted" }; // 无未关账块——不携 partialText
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t1c",
    });
    await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(recorded).toEqual([
      { role: "assistant", text: "完整收尾" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
  });

  test("T1d partialText 空串视同缺席：行为与 G1 前完全一致", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        callbacks?.onBlockEnd?.({ kind: "text", text: "完整" });
        controller.abort("barge-in");
        return { kind: "aborted", partialText: "" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t1d",
    });
    await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(recorded).toEqual([
      { role: "assistant", text: "完整" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
  });

  test("T2 thinking 流中段打断：半截丢弃（无 end 凭证）——无 assistant 内容入账，仅标记", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        // thinking 半截：thinking_start 后 delta 聚积中被打断——无 onBlockEnd
        controller.abort("barge-in");
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t2",
    });
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(result.kind).toBe("aborted");
    // 半截 thinking 零入账（无签名不可回传）；标记仍在（模型知道自己被掐）
    expect(recorded).toEqual([{ role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT }]);
  });

  test("T2b 完整 thinking（带签名）+ 半截 text：悬挂 thinking 丢弃（单独回传非法）+ audit 记丢弃", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        callbacks?.onBlockEnd?.({ kind: "thinking", text: "推理中……", signature: "sig-1" });
        callbacks?.onDelta?.("结"); // text 半截（无 end）
        controller.abort("barge-in");
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t2b",
    });
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    if (result.kind !== "aborted") throw new Error("应 aborted");
    expect(recorded).toEqual([{ role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT }]);
    expect(result.audit?.droppedBlocks.length).toBe(1);
    expect(result.audit?.droppedBlocks[0]?.kind).toBe("thinking");
  });

  test("T2c 完整 thinking（带签名）+ 完整 text：thinking 全精度随 assistant 入账", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        callbacks?.onBlockEnd?.({ kind: "thinking", text: "推理", signature: "sig-1" });
        callbacks?.onBlockEnd?.({ kind: "text", text: "结论前半" });
        controller.abort("barge-in");
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t2c",
    });
    await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(recorded).toEqual([
      { role: "assistant", text: "结论前半", thinking: { text: "推理", signature: "sig-1" } },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
  });

  test("T2d 完整 thinking（无签名）+ 完整 text：thinking 丢弃（无签名不可回传）+ audit 记丢弃", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        callbacks?.onBlockEnd?.({ kind: "thinking", text: "无凭据推理" });
        callbacks?.onBlockEnd?.({ kind: "text", text: "结论" });
        controller.abort("barge-in");
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t2d",
    });
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    if (result.kind !== "aborted") throw new Error("应 aborted");
    expect(recorded).toEqual([
      { role: "assistant", text: "结论" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
    expect(result.audit?.droppedBlocks.length).toBe(1);
  });

  test("T3 toolcall 参数流中段打断：半截丢弃——无 toolCall 无孤儿 toolResult，仅标记", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        // toolcall 参数半截：toolcall_start 后 delta 中断——无 end
        callbacks?.onDelta?.('{"q":');
        controller.abort("barge-in");
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t3",
    });
    await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(recorded).toEqual([{ role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT }]);
    expect(recorded.some((m) => m.role === "assistant")).toBe(false);
    expect(recorded.some((m) => m.role === "toolResult")).toBe(false);
  });

  test("T3b 完整 toolcall 收尾后打断（未执行）：assistant toolCall + 合成中断 toolResult 配对（I3）", async () => {
    const controller = new AbortController();
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        callbacks?.onBlockEnd?.({ kind: "toolCall", id: "c1", name: "query_tasks", args: { q: 1 } });
        controller.abort("barge-in");
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t3b",
    });
    await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(recorded).toEqual([
      { role: "assistant", toolCall: { id: "c1", name: "query_tasks", args: { q: 1 } } },
      { role: "toolResult", toolCallId: "c1", name: "query_tasks", text: LOOP_INTERRUPTED_TOOL_RESULT_TEXT },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
  });

  test("T6 连续多次打断（跨 run）：标记正确累积不重复（每 run 恰一枚）", async () => {
    const recorded: LoopMessage[] = [];
    let streamSeq = 0;
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        streamSeq += 1;
        callbacks?.onBlockEnd?.({ kind: "text", text: `部分答${streamSeq}` });
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "t6",
    });
    for (let i = 0; i < 2; i += 1) {
      const result = await engine
        .startRun({
          systemPrompt: "s",
          messages: [{ role: "user", text: `问${i + 1}` }],
          tools: [],
          maxRounds: 6,
          onNewMessage: async (m) => {
            recorded.push(m);
          },
        })
        .promise;
      expect(result.kind).toBe("aborted");
    }
    expect(recorded).toEqual([
      { role: "assistant", text: "部分答1" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
      { role: "assistant", text: "部分答2" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
    expect(recorded.filter((m) => m.text === LOOP_INTERRUPTED_MARKER_TEXT).length).toBe(2);
  });

  test("T9 打断信号重复到达：幂等——单次入账、事件各一次", async () => {
    const controller = new AbortController();
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        callbacks?.onBlockEnd?.({ kind: "text", text: "部分内容" });
        controller.abort("第一次"); // 到达
        controller.abort("重复信号"); // 重复到达（AbortController 幂等——reason 不变）
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      newRunId: () => "t9",
    });
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(result.kind).toBe("aborted");
    expect(recorded).toEqual([
      { role: "assistant", text: "部分内容" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
    ]);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "loop.run.interrupted").length).toBe(1);
    expect(types.filter((t) => t === "loop.run.finished").length).toBe(1);
  });

  test("轮边界 abort（工具段收尾后）：interrupted 事件发射 + 无新增入账（轮已完整记账）", async () => {
    const controller = new AbortController();
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "slow",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        controller.abort("barge-in"); // 工具执行段到达（不打断——收尾入账后退出）
        return { kind: "result", text: "慢工具完成" };
      },
    });
    const engine = new LoopEngine({
      streamFn: async () => ({ kind: "toolCall", id: "c1", name: "slow", args: {} }),
      registry,
      emit: (e) => events.push(e),
      newRunId: () => "t-edge",
    });
    const result = await engine
      .startRun({
        systemPrompt: "s",
        messages: [{ role: "user", text: "问" }],
        tools: [],
        maxRounds: 6,
        signal: controller.signal,
        onNewMessage: async (m) => {
          recorded.push(m);
        },
      })
      .promise;
    expect(result.kind).toBe("aborted");
    // 完整轮已正常记账（assistant toolCall + toolResult）；无截断标记（轮未被掐）
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect(recorded.some((m) => m.text === LOOP_INTERRUPTED_MARKER_TEXT)).toBe(false);
    // interrupted 事件仍发射（先于 finished）
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "loop.run.interrupted").length).toBe(1);
    expect(types.indexOf("loop.run.interrupted")).toBeLessThan(types.indexOf("loop.run.finished"));
  });
});

// ── StewardService 接线面（管家 = 首个消费者） ─────────────────────────

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

type Deps = ConstructorParameters<typeof StewardService>[0];

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  const base: Deps = {
    llm: undefined as unknown as Deps["llm"],
    orchestration: {
      status: () => [],
      send: () => ({ delivered: true, detail: "已注入" }),
    },
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
  };
  return { ...base, ...overrides };
}

/** 等待 signal abort（测试挂起胶水）。 */
function awaitAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const onAbort = () => resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 可中断 LLM：第 n 轮按剧本——发完整块 → 等中断 → aborted；下一轮直答。
 *  onBlockEnd = E-198 契约扩展（port 第 5 参）。 */
function interruptibleLlm(script: {
  roundBlocks: LoopStreamBlock[][]; // 每轮的完整块序列（rounds 超出后直答）
  answer?: string;
}): StewardLlmPort & { calls: StewardLlmRequest[] } {
  const calls: StewardLlmRequest[] = [];
  let round = 0;
  return {
    modelId: "m",
    calls,
    complete: async (req, _onDelta, _onThinking, signal, onBlockEnd) => {
      calls.push(req);
      const blocks = script.roundBlocks[round];
      round += 1;
      if (blocks !== undefined && signal !== undefined) {
        for (const b of blocks) onBlockEnd?.(b);
        await awaitAbort(signal);
        return { kind: "aborted" };
      }
      return { kind: "text", text: script.answer ?? "答" };
    },
  } as StewardLlmPort & { calls: StewardLlmRequest[] };
}

describe("StewardService：打断善后接线（E-198 管家面）", () => {
  test("T1 text 流中段打断：KV 入账（完整块+标记）+ 下轮请求上下文形状合法（无半截）+ 事件序", async () => {
    const events: LoopEvent[] = [];
    const llm = interruptibleLlm({ roundBlocks: [[{ kind: "text", text: "第一块完整内容" }]] });
    const svc = new StewardService({ ...baseDeps({ llm, emitLoopEvent: (e) => events.push(e) }) });
    const first = svc.ask("第一问");
    await tick();
    expect(svc.abortInFlight("barge-in")).toBe(true);
    const r1 = await first;
    expect(r1.status).toBe("error"); // aborted 回执不变（协议面零改动）
    // KV：完整块 + 截断标记入账（半截零残留）
    const history = await svc.getHistory();
    expect(history.map((r) => `${r.kind}:${(r as { text?: string }).text ?? ""}`)).toEqual([
      "user:第一问",
      "assistant:第一块完整内容",
      `user:${LOOP_INTERRUPTED_MARKER_TEXT}`,
    ]);
    // 下轮请求上下文：完整块 + 标记在、不含任何半截块（provider 合法形状）
    const second = await svc.ask("第二问");
    expect(second.status).toBe("answer");
    expect(llm.calls.length).toBe(2);
    expect(llm.calls[1]!.messages).toEqual([
      { role: "user", text: "第一问" },
      { role: "assistant", text: "第一块完整内容" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
      { role: "user", text: "第二问" },
    ]);
    // 事件序：interrupted 先于 finished(aborted)，各一次
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "loop.run.interrupted").length).toBe(1);
    expect(types.indexOf("loop.run.interrupted")).toBeLessThan(types.lastIndexOf("loop.run.finished"));
    expect(types.filter((t) => t === "loop.run.finished").length).toBe(2); // aborted + answer 各一
  });

  test("T2 thinking 流中段打断（管家面）：半截丢弃——下轮上下文无 thinking", async () => {
    const llm = interruptibleLlm({ roundBlocks: [[]] }); // 无完整块（thinking 半截）
    const svc = new StewardService({ ...baseDeps({ llm }) });
    const first = svc.ask("第一问");
    await tick();
    svc.abortInFlight("barge-in");
    await first;
    const second = await svc.ask("第二问");
    expect(second.status).toBe("answer");
    expect(llm.calls[1]!.messages).toEqual([
      { role: "user", text: "第一问" },
      { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT },
      { role: "user", text: "第二问" },
    ]);
    expect(JSON.stringify(llm.calls[1]!.messages)).not.toContain("thinking");
  });

  test("T6 连续多次打断：标记累积不重复（KV 两条 partial + 两枚标记）", async () => {
    const llm = interruptibleLlm({
      roundBlocks: [
        [{ kind: "text", text: "部分一" }],
        [{ kind: "text", text: "部分二" }],
      ],
    });
    const svc = new StewardService({ ...baseDeps({ llm }) });
    const first = svc.ask("第一问");
    await tick();
    svc.abortInFlight("barge-in");
    await first;
    const second = svc.ask("第二问");
    await tick();
    svc.abortInFlight("barge-in");
    await second;
    const third = await svc.ask("第三问");
    expect(third.status).toBe("answer");
    const history = await svc.getHistory();
    expect(history.map((r) => `${r.kind}:${(r as { text?: string }).text ?? ""}`)).toEqual([
      "user:第一问",
      "assistant:部分一",
      `user:${LOOP_INTERRUPTED_MARKER_TEXT}`,
      "user:第二问",
      "assistant:部分二",
      `user:${LOOP_INTERRUPTED_MARKER_TEXT}`,
      "user:第三问",
      "assistant:答",
    ]);
  });

  test("T9 abortInFlight 幂等 + 队列序零回归：重复 abort 无二次入账；排队 ask 收口后照常消费", async () => {
    const llm = interruptibleLlm({ roundBlocks: [[{ kind: "text", text: "部分" }], [{ kind: "text", text: "排队轮部分" }]] });
    const svc = new StewardService({ ...baseDeps({ llm }) });
    const first = svc.ask("第一问");
    await tick();
    expect(svc.abortInFlight("第一次")).toBe(true);
    // 同步双 abort：inFlightAbort 尚未清（收口异步）——第二次仍 true 但
    // AbortController.abort 幂等（reason 定格首次），引擎侧无二次入账
    expect(svc.abortInFlight("重复")).toBe(true);
    // 忙碌窗口内排队第二条（abort 收口后自动消费；queued 回执非终态 promise
    // ——经 tick 等第二轮收口后再断言）
    const second = svc.ask("第二问");
    await tick();
    svc.abortInFlight("barge-in");
    await first;
    await second;
    await tick(20);
    const history = await svc.getHistory();
    const partials = history.filter((r) => r.kind === "assistant");
    const markers = history.filter((r) => r.text === LOOP_INTERRUPTED_MARKER_TEXT);
    expect(partials.length).toBe(2); // 每 abort 恰一次入账（无重复）
    expect(markers.length).toBe(2);
  });
});

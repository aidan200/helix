import { describe, expect, test } from "bun:test";
import type {
  LoopEvent,
  LoopMessage,
  LoopPauseDecision,
  LoopResumeDecision,
  LoopStreamFn,
  LoopStreamResult,
  LoopToolCallContext,
  LoopToolOutcome,
} from "../../src/domain/loop";
import {
  LOOP_INTERRUPTED_MARKER_TEXT,
  LOOP_INTERRUPTED_TOOL_RESULT_TEXT,
  LOOP_TRUNCATED_TOOL_RESULT_TEXT,
  LoopEngine,
  ToolRegistry,
} from "../../src/domain/loop";

/**
 * Phase 3 kernel 批工具语义单测（语义定稿 docs/temp/loop-interleaving-semantics.md
 * §5 UC-01..UC-22 的 kernel 级面；R2/R3 运行时面已在 loop-agent.test.ts 覆盖
 * UC-03..07/16/19/20）。断言分型（D6）：完成序类事件（loop.tool.finished
 * 跨枚）用集合等价/受控延迟确定序；源序类（入账窗口）用严格序列。
 *
 * - R1 并行批执行序（UC-01/02/17/21）：preflight 逐枚源序 started →
 *   并发启动 → finished 完成序 → toolResult 源序入账；
 * - R4 abort 收序（UC-08/09/15）：signal 传播进 ctx、批收口等全 settle、
 *   未启动枚合成配对、直收不补 streamFn、标记+audit 批推广、暂停期惰性化；
 * - R5 批级 early-termination（UC-10/11/12）：AND 判定、全批 terminate 防火墙、
 *   gate-preflight terminate 即决（已入账保留+未启动合成配对）；
 * - R6 暂停闸 × 并行批（UC-13/14/15/22）：挂闸不冻结、首闸即 settle、
 *   approveWith 不重排、reject per-tool、resolve 兄弟照常收尾；
 * - R7 maxRounds（UC-18）：N 枚批=1 轮；熔断零吞队列；
 * - D7 截断标记文案；D9 maxConcurrentTools；R6.7 gate 收 signal；
 *   R4.2 ctx.signal；R1.10 onUpdate → tool.progress。
 */

function textResult(text: string): LoopStreamResult {
  return { kind: "blocks", blocks: [{ type: "text", text }], stopReason: "stop" };
}

function batchResult(calls: readonly { id: string; name: string; args?: Record<string, unknown> }[], stopReason: "toolUse" | "length" = "toolUse"): LoopStreamResult {
  return {
    kind: "blocks",
    blocks: calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, args: c.args ?? {} })),
    stopReason,
  };
}

interface StreamSpy {
  readonly streamFn: LoopStreamFn;
  readonly calls: readonly LoopMessage[][];
}

function fakeStream(script: readonly LoopStreamResult[], opts: { onCall?: (messages: readonly LoopMessage[]) => void } = {}): StreamSpy {
  const calls: LoopMessage[][] = [];
  const streamFn: LoopStreamFn = async (input) => {
    calls.push([...input.messages]);
    opts.onCall?.(input.messages);
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error("剧本耗尽");
    return next;
  };
  return { streamFn, calls };
}

/** 受控延迟工具执行体（delay ms 后 resolve——完成序确定化）。 */
function delayTool(outcome: () => LoopToolOutcome, delayMs: number) {
  return async (): Promise<LoopToolOutcome> => {
    await new Promise((r) => setTimeout(r, delayMs));
    return outcome();
  };
}

/** 手动放行工具执行体（测试持 release() 控制收尾时点）。 */
function gatedTool(outcome: () => LoopToolOutcome = () => ({ kind: "result", text: "done" })) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (): Promise<LoopToolOutcome> => {
    await gate;
    return outcome();
  };
  return { handler, release: () => release() };
}

/** 组装 run 输入（记录面单点）。 */
function runInput(h: { recorded: LoopMessage[] }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    systemPrompt: "s",
    messages: [{ role: "user", text: "q" }] as LoopMessage[],
    tools: [],
    maxRounds: 6,
    onNewMessage: async (m: LoopMessage) => {
      h.recorded.push(m);
    },
    ...extra,
  };
}

/** 事件序断言辅助：loop.tool.finished 的 toolCallId 序（完成序面）。 */
function finishedOrder(events: readonly LoopEvent[]): string[] {
  return events.filter((e): e is Extract<LoopEvent, { type: "loop.tool.finished" }> => e.type === "loop.tool.finished").map((e) => e.toolCallId);
}

function startedOrder(events: readonly LoopEvent[]): string[] {
  return events.filter((e): e is Extract<LoopEvent, { type: "loop.tool.started" }> => e.type === "loop.tool.started").map((e) => e.toolCallId);
}

function registryWith(tools: Record<string, (args: Record<string, unknown>, ctx: LoopToolCallContext) => Promise<LoopToolOutcome>>, executionMode?: { readonly [name: string]: "parallel" | "sequential" }): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, handler] of Object.entries(tools)) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      handler: async (args, ctx) => handler(args, ctx),
      ...(executionMode?.[name] !== undefined ? { executionMode: executionMode[name] } : {}),
    });
  }
  return registry;
}

describe("Phase 3 批工具：R1 并行批执行序", () => {
  test("UC-01 并行批 happy path：preflight started 源序 → 并发执行 → finished 完成序（B→A→C）→ toolResult 源序入账 → turn.finished(tools:[A,B,C])", async () => {
    const executed: string[] = [];
    const registry = registryWith({
      toolA: delayTool(() => {
        executed.push("A");
        return { kind: "result", text: "结果A" };
      }, 12),
      toolB: delayTool(() => {
        executed.push("B");
        return { kind: "result", text: "结果B" };
      }, 1),
      toolC: delayTool(() => {
        executed.push("C");
        return { kind: "result", text: "结果C" };
      }, 25),
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const windows: LoopMessage[][] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }]), textResult("终答")], { onCall: (m) => windows.push([...m]) });
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b1" });
    const result = await engine.startRun({
      ...runInput({ recorded }),
    } as never).promise;
    expect(result).toEqual({ kind: "finished", blocks: [{ type: "text", text: "终答" }] });
    // 全批执行（N=1 过渡语义退役）
    expect(executed.sort()).toEqual(["A", "B", "C"]);
    // started 全批源序（R1.4）
    expect(startedOrder(events)).toEqual(["ca", "cb", "cc"]);
    // finished 完成序（R1.6/D6：受控延迟确定化）
    expect(finishedOrder(events)).toEqual(["cb", "ca", "cc"]);
    // 入账源序（R1.7）：assistant(3 toolCall 块) + A/B/C toolResult 严格源序
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult", "assistant"]);
    const assistant = recorded[0] as { content: readonly { type: string; id?: string }[] };
    expect(assistant.content.map((b) => b.id)).toEqual(["ca", "cb", "cc"]);
    expect(recorded.slice(1, 4).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb", "cc"]);
    // turn.finished(tools:[A,B,C])（R1 批收口一枚）
    const turnFinished = events.find((e) => e.type === "loop.turn.finished" && (e as unknown as { stopReason: string }).stopReason === "toolUse") as unknown as { tools: string[] };
    expect(turnFinished?.tools).toEqual(["toolA", "toolB", "toolC"]);
    // 第 2 轮窗口：user → assistant → toolResult×3（源序）
    expect(windows[1]!.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "toolResult"]);
  });

  test("UC-02 混批含一枚 sequential 注册 → 全批 sequential：A 完成入账前 B 不启动执行", async () => {
    const timeline: string[] = [];
    let releaseA!: () => void;
    const registry = registryWith(
      {
        toolA: async () => {
          timeline.push("A:start");
          await new Promise<void>((r) => {
            releaseA = r;
          });
          timeline.push("A:end");
          return { kind: "result", text: "结果A" };
        },
        toolB: async () => {
          timeline.push("B:start");
          timeline.push("B:end");
          return { kind: "result", text: "结果B" };
        },
      },
      { toolB: "sequential" },
    );
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }]), textResult("完")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b2" });
    const pending = engine.startRun({ ...runInput({ recorded }) } as never).promise;
    await new Promise((r) => setTimeout(r, 5));
    releaseA();
    const result = await pending;
    expect(result.kind).toBe("finished");
    // sequential：A end 前 B 未启动；B 的 start 在 A 的 toolResult 入账之后（R1.2）
    expect(timeline).toEqual(["A:start", "A:end", "B:start", "B:end"]);
    // 入账序：assistant → toolResult(A) → toolResult(B)（严格逐枚）
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "assistant"]);
    expect(recorded.slice(1, 3).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb"]);
  });

  test("UC-17 length 截断批全 fail：逐枚 started/finished（截断文案 error）零执行 → 续跑（模型可重发）", async () => {
    const executed: string[] = [];
    const registry = registryWith({
      toolA: async () => {
        executed.push("A");
        return { kind: "result", text: "不应执行" };
      },
      toolB: async () => {
        executed.push("B");
        return { kind: "result", text: "不应执行" };
      },
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }], "length"), textResult("重发完整参数")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b17" });
    const result = await engine.startRun({ ...runInput({ recorded }) } as never).promise;
    expect(result).toEqual({ kind: "finished", blocks: [{ type: "text", text: "重发完整参数" }] });
    expect(executed).toEqual([]); // 零执行（R5.5）
    // started/finished 逐枚源序（截断枚也是 immediate 终结枚——R1.8/R1.6）
    expect(startedOrder(events)).toEqual(["ca", "cb"]);
    expect(finishedOrder(events)).toEqual(["ca", "cb"]);
    const finished = events.filter((e) => e.type === "loop.tool.finished") as unknown as { isError: boolean; resultSummary: string }[];
    expect(finished.every((f) => f.isError)).toBe(true);
    expect(finished.every((f) => f.resultSummary === LOOP_TRUNCATED_TOOL_RESULT_TEXT)).toBe(true);
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "assistant"]);
    expect(recorded.slice(1, 3).map((m) => (m as { text: string }).text)).toEqual([LOOP_TRUNCATED_TOOL_RESULT_TEXT, LOOP_TRUNCATED_TOOL_RESULT_TEXT]);
  });

  test("UC-21 批内一枚抛错不株连（error ≠ terminate）：A 抛错 error 回灌、B 照跑照记、批判定不受影响续跑", async () => {
    const registry = registryWith({
      toolA: async () => {
        throw new Error("炸了");
      },
      toolB: delayTool(() => ({ kind: "result", text: "结果B" }), 1),
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }]), textResult("继续")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b21" });
    const result = await engine.startRun({ ...runInput({ recorded }) } as never).promise;
    expect(result.kind).toBe("finished");
    const errorResult = recorded.find((m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "ca") as { text: string };
    expect(errorResult.text).toContain("工具执行异常");
    expect(recorded.slice(1, 3).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb"]);
    expect(events.some((e) => e.type === "loop.run.error")).toBe(false);
  });

  test("R1.10 onUpdate 部分结果 → loop.tool.progress 事件（toolCallId 携带）", async () => {
    const registry = registryWith({
      stream: async (_args, ctx) => {
        ctx.onUpdate?.("部分1");
        ctx.onUpdate?.("部分2");
        return { kind: "result", text: "完成" };
      },
    });
    const events: LoopEvent[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "c1", name: "stream" }]), textResult("完")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b110" });
    await engine.startRun({ ...runInput({ recorded: [] }) } as never).promise;
    const progress = events.filter((e): e is Extract<LoopEvent, { type: "loop.tool.progress" }> => e.type === "loop.tool.progress");
    expect(progress.map((p) => p.partial)).toEqual(["部分1", "部分2"]);
    expect(progress.every((p) => p.toolCallId === "c1")).toBe(true);
  });
});

describe("Phase 3 批工具：R4 abort 收序", () => {
  test("UC-08 批并发期 abort（全部已启动）：signal 传播进 ctx、批收口等全 settle、真实结果照记源序、标记+audit、直收 aborted 不补 streamFn", async () => {
    const controller = new AbortController();
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const windows: LoopMessage[][] = [];
    let drainCalls = 0;
    // A 响应 signal 早收尾（正常返回）；B 忽略 signal 慢完成；C 响应 signal 抛错
    const registry = registryWith({
      toolA: async (_args, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) resolve();
          else ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { kind: "result", text: "A 早收尾" };
      },
      toolB: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { kind: "result", text: "B 慢完成" };
      },
      toolC: async (_args, ctx): Promise<LoopToolOutcome> => {
        await new Promise<void>((_resolve, reject) => {
          if (ctx.signal?.aborted) reject(new Error("C 被打断"));
          else ctx.signal?.addEventListener("abort", () => reject(new Error("C 被打断")), { once: true });
        });
        return { kind: "result", text: "不可达" };
      },
    });
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }])], { onCall: (m) => windows.push([...m]) });
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b8" });
    const pending = engine.startRun({
      ...runInput({ recorded }),
      signal: controller.signal,
      drainSteering: () => {
        drainCalls += 1;
        return undefined;
      },
    } as never).promise;
    await new Promise((r) => setTimeout(r, 3)); // 三枚均在飞
    controller.abort("新 ask 取代");
    const result = await pending;
    // R4.6 批 settle 后直收 aborted（B 最慢 settle——批收口等全）+ audit 批推广（R4.7）
    expect(result.kind).toBe("aborted");
    if (result.kind !== "aborted") return;
    expect(result.audit?.droppedBlocks).toEqual([]);
    expect(result.audit?.keptMessages).toBe(4); // assistant + 三枚真实结果（标记在外）
    // 真实结果照记（R4.4）源序 + 截断标记一枚（R4.7/D7）
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult", "user"]);
    expect(recorded.slice(1, 4).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb", "cc"]);
    expect((recorded[4] as { text: string }).text).toBe(LOOP_INTERRUPTED_MARKER_TEXT);
    // 事件序：turn.finished → run.interrupted(reason) → run.finished(aborted)（R4.6）
    const types = events.map((e) => e.type);
    expect(types).toContain("loop.turn.finished");
    expect(types.indexOf("loop.turn.finished")).toBeLessThan(types.indexOf("loop.run.interrupted"));
    expect(types.indexOf("loop.run.interrupted")).toBeLessThan(types.indexOf("loop.run.finished"));
    const interrupted = events.find((e) => e.type === "loop.run.interrupted") as unknown as { reason: string };
    expect(interrupted.reason).toBe("新 ask 取代");
    // 不补打 streamFn（D8）：剧本仅 1 项——若续轮会「剧本耗尽」抛错；drain 仅轮首
    // P0 一次（批后零 poll——abort 收口不经过轮首，G-G 队列不丢）
    expect(windows.length).toBe(1);
    expect(drainCalls).toBe(1);
  });

  test("UC-09 批 preflight 期 abort（部分未启动）：未启动枚合成配对不执行、已启动枚真实结果照记、上下文零孤儿", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const registry = registryWith({
      toolA: async () => {
        executed.push("A");
        await new Promise((r) => setTimeout(r, 8));
        return { kind: "result", text: "A 真实" };
      },
      toolB: async () => {
        executed.push("B");
        return { kind: "result", text: "B 真实" };
      },
      toolC: async () => {
        executed.push("C");
        return { kind: "result", text: "不应执行" };
      },
    });
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }])]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b9" });
    const gate: (ctx: LoopToolCallContext, signal?: AbortSignal) => Promise<LoopPauseDecision> = async (ctx) => {
      if (ctx.toolCallId === "cc") controller.abort("superseded"); // C 的 preflight 前置位 abort
      return { pause: false };
    };
    const pending = engine.startRun({ ...runInput({ recorded }), signal: controller.signal, beforeToolCallPause: gate } as never).promise;
    const result = await pending;
    expect(result.kind).toBe("aborted");
    expect(executed.sort()).toEqual(["A", "B"]); // C 未启动（R4.3 零执行）
    // started 全批源序（含未启动枚 C——R1.4 preflight 访问即发）
    expect(startedOrder(events)).toEqual(["ca", "cb", "cc"]);
    // 入账：A/B 真实 + C 合成中断配对（G-B 零孤儿）+ 标记
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult", "user"]);
    const cResult = recorded.find((m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "cc") as { text: string };
    expect(cResult.text).toBe(LOOP_INTERRUPTED_TOOL_RESULT_TEXT);
    expect(recorded.slice(1, 4).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb", "cc"]);
    expect((recorded[4] as { text: string }).text).toBe(LOOP_INTERRUPTED_MARKER_TEXT);
  });

  test("R4.2 ctx.signal 传播：工具执行体可观察 run 的 abort signal", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const registry = registryWith({
      toolA: async (_args, ctx) => {
        seen.push(ctx.signal);
        return { kind: "result", text: "ok" };
      },
    });
    const { streamFn } = fakeStream([batchResult([{ id: "c1", name: "toolA" }]), textResult("完")]);
    const engine = new LoopEngine({ streamFn, registry, emit: () => undefined, newRunId: () => "b42" });
    await engine.startRun({ ...runInput({ recorded: [] }), signal: controller.signal } as never).promise;
    expect(seen[0]).toBe(controller.signal);
  });
});

describe("Phase 3 批工具：R5 批级 early-termination", () => {
  test("UC-10 单枚 terminate 仅普通回灌（AND 规则）：B terminate 结果 isError 照记、A/C 照跑、批判定非全批 → 续跑", async () => {
    const registry = registryWith({
      toolA: delayTool(() => ({ kind: "result", text: "A 正常" }), 3),
      toolB: delayTool(() => ({ kind: "terminate", reason: "B 需终止" }), 1),
      toolC: delayTool(() => ({ kind: "result", text: "C 正常" }), 8),
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }]), textResult("继续轮")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b10" });
    const result = await engine.startRun({ ...runInput({ recorded }) } as never).promise;
    expect(result.kind).toBe("finished");
    expect(events.some((e) => e.type === "loop.run.error")).toBe(false);
    const bResult = recorded.find((m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "cb") as { text: string };
    expect(bResult.text).toBe("B 需终止");
    const bFinished = events.find((e) => e.type === "loop.tool.finished" && (e as unknown as { toolCallId: string }).toolCallId === "cb") as unknown as { isError: boolean };
    expect(bFinished.isError).toBe(true);
    expect(recorded.slice(1, 4).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb", "cc"]);
  });

  test("UC-11 全批 terminate → 防火墙收口：turn.finished → run.error(首因) → finished(error)；不 poll 队列零续跑", async () => {
    let drainCalls = 0;
    const registry = registryWith({
      toolA: delayTool(() => ({ kind: "terminate", reason: "A 终止因" }), 1),
      toolB: delayTool(() => ({ kind: "terminate", reason: "B 终止因" }), 5),
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const windows: LoopMessage[][] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }])], { onCall: (m) => windows.push([...m]) });
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b11" });
    const result = await engine.startRun({
      ...runInput({ recorded }),
      drainSteering: () => {
        drainCalls += 1;
        return undefined;
      },
    } as never).promise;
    expect(result).toEqual({ kind: "error", message: "A 终止因" });
    // 两 terminate 结果照常入账（R5.2）
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect(recorded.slice(1, 3).map((m) => (m as { text: string }).text)).toEqual(["A 终止因", "B 终止因"]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("loop.turn.finished")).toBeLessThan(types.indexOf("loop.run.error"));
    expect(types.indexOf("loop.run.error")).toBeLessThan(types.indexOf("loop.run.finished"));
    expect((events.at(-1) as { resolution: string }).resolution).toBe("error");
    // 零续跑（剧本 1 项不耗尽）；drain 仅轮首 P0 一次（防火墙收口后零 poll——
    // R5.4 队列保留供下一次显式 run，G-G）
    expect(windows.length).toBe(1);
    expect(drainCalls).toBe(1);
  });

  test("UC-12 gate-preflight terminate 即决：B 真实结果保留、A 合成中断配对（I1）、run.error 携 A 的 reason；B 照常执行", async () => {
    const executed: string[] = [];
    const registry = registryWith({
      toolA: async () => {
        executed.push("A");
        return { kind: "result", text: "不应执行" };
      },
      toolB: async () => {
        executed.push("B");
        return { kind: "result", text: "B 真实结果" };
      },
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }])]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b12" });
    const gate: (ctx: LoopToolCallContext) => Promise<LoopPauseDecision> = async (ctx) =>
      ctx.toolCallId === "ca" ? { pause: false, outcome: { kind: "terminate", reason: "目标不存在——拒绝" } } : { pause: false };
    const result = await engine.startRun({ ...runInput({ recorded }), beforeToolCallPause: gate } as never).promise;
    expect(result).toEqual({ kind: "error", message: "目标不存在——拒绝" });
    expect(executed).toEqual(["B"]); // A 零执行（防火墙前置拒）
    // 批语义：B 真实 + A 配对（I1 优先于零入账——R5.3/D2）
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect((recorded[1] as { toolCallId: string; text: string }).toolCallId).toBe("ca");
    expect((recorded[1] as { text: string }).text).toBe("目标不存在——拒绝");
    expect((recorded[2] as { toolCallId: string; text: string }).toolCallId).toBe("cb");
    expect((recorded[2] as { text: string }).text).toBe("B 真实结果");
    const types = events.map((e) => e.type);
    expect(types.indexOf("loop.turn.finished")).toBeLessThan(types.indexOf("loop.run.error"));
    expect((events.find((e) => e.type === "loop.run.error") as unknown as { message: string }).message).toBe("目标不存在——拒绝");
    expect((events.at(-1) as { resolution: string }).resolution).toBe("error");
  });
});

describe("Phase 3 批工具：R6 暂停闸 × 并行批", () => {
  function pauseGateOn(toolCallId: string): { gate: (ctx: LoopToolCallContext, signal?: AbortSignal) => Promise<LoopPauseDecision>; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      gate: async (ctx, signal) => {
        calls.push(`${ctx.toolCallId}:${signal !== undefined ? "signal" : "nosignal"}`);
        return ctx.toolCallId === toolCallId ? { pause: true } : { pause: false };
      },
    };
  }

  test("UC-13 B 挂闸不冻结全批：首闸即 run.paused（兄弟事件照常流出）→ approve → B 执行 → 源序入账 → 续轮", async () => {
    const executed: string[] = [];
    const slowA = gatedTool(() => ({ kind: "result", text: "A 真实" }));
    const slowC = gatedTool(() => ({ kind: "result", text: "C 真实" }));
    const registry = new ToolRegistry();
    registry.register({ name: "toolA", description: "a", parameters: {}, handler: slowA.handler });
    registry.register({
      name: "toolB",
      description: "b",
      parameters: {},
      handler: async () => {
        executed.push("B");
        return { kind: "result", text: "B 执行结果" };
      },
    });
    registry.register({ name: "toolC", description: "c", parameters: {}, handler: slowC.handler });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }]), textResult("续轮终答")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b13" });
    const { gate } = pauseGateOn("cb");
    const pending = engine.startRun({ ...runInput({ recorded }), beforeToolCallPause: gate } as never).promise;
    const paused = await pending;
    expect(paused.kind).toBe("paused");
    if (paused.kind !== "paused") return;
    expect(paused.toolCall.id).toBe("cb");
    // 首闸即 settle（D1/R6.3）：挂闸时 assistant 已入账（工作记忆可见——现役契约）
    expect(recorded.map((m) => m.role)).toEqual(["assistant"]);
    // 在飞兄弟照常收尾（事件流与 promise 状态解耦）
    slowA.release();
    slowC.release();
    await new Promise((r) => setTimeout(r, 5));
    const resumed = await paused.resumeWith({ kind: "approve" });
    expect(resumed.kind).toBe("finished");
    expect(executed).toEqual(["B"]);
    // 源序入账（R1.7）：assistant + A/B/C
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult", "assistant"]);
    expect(recorded.slice(1, 4).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb", "cc"]);
    const types = events.map((e) => e.type);
    // 首闸即 settle（R6.3/D1）：started(A) → started(B) → run.paused（B 首闸处）
    // → started(C)（后台续链 preflight 照常）→ 兄弟 finished 在 paused 之后照常流出
    const toolEvents = events
      .filter((e) => e.type.startsWith("loop.tool.") || e.type === "loop.run.paused" || e.type === "loop.run.resumed")
      .map((e) =>
        e.type === "loop.tool.started" || e.type === "loop.tool.finished"
          ? `${e.type}:${(e as unknown as { toolCallId: string }).toolCallId}`
          : e.type,
      );
    expect(toolEvents.slice(0, 6)).toEqual([
      "loop.tool.started:ca",
      "loop.tool.started:cb",
      "loop.run.paused",
      "loop.tool.started:cc",
      "loop.tool.finished:ca",
      "loop.tool.finished:cc",
    ]);
    expect(types.indexOf("loop.run.paused")).toBeLessThan(types.indexOf("loop.run.resumed"));
    expect(types.filter((t) => t === "loop.turn.finished").length).toBe(2); // 批收口一枚 + 终答轮一枚
  });

  test("UC-13 变体 approveWith 只改本枚：B 以新 args 执行、A/C 无重排无重跑", async () => {
    const executionLog: string[] = [];
    const slowA = gatedTool(() => ({ kind: "result", text: "A 真实" }));
    const slowC = gatedTool(() => ({ kind: "result", text: "C 真实" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "toolA",
      description: "a",
      parameters: {},
      handler: async () => {
        executionLog.push("A");
        return slowA ? ({ kind: "result", text: "A 真实" } as LoopToolOutcome) : ({ kind: "result", text: "" } as LoopToolOutcome);
      },
    });
    registry.register({
      name: "toolB",
      description: "b",
      parameters: {},
      handler: async (args) => {
        executionLog.push(`B:${JSON.stringify(args)}`);
        return { kind: "result", text: "B 新参执行" };
      },
    });
    registry.register({
      name: "toolC",
      description: "c",
      parameters: {},
      handler: async () => {
        executionLog.push("C");
        return { kind: "result", text: "C 真实" };
      },
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA", args: { orig: 1 } }, { id: "cb", name: "toolB", args: { orig: 1 } }, { id: "cc", name: "toolC", args: { orig: 1 } }]), textResult("完")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b13w" });
    const { gate } = pauseGateOn("cb");
    const pending = engine.startRun({ ...runInput({ recorded }), beforeToolCallPause: gate } as never).promise;
    const paused = await pending;
    if (paused.kind !== "paused") throw new Error("应 paused");
    slowA.release();
    slowC.release();
    const resumed = await paused.resumeWith({ kind: "approveWith", args: { rewritten: true } });
    expect(resumed.kind).toBe("finished");
    // B 以新 args 执行；A/C 各执行一次（无重跑）
    expect(executionLog.filter((x) => x === "A").length).toBe(1);
    expect(executionLog.filter((x) => x === "C").length).toBe(1);
    expect(executionLog.some((x) => x.startsWith("B:"))).toBe(true);
    expect(executionLog.find((x) => x.startsWith("B:"))).toBe('B:{"rewritten":true}');
    const bResult = recorded.find((m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "cb") as { text: string };
    expect(bResult.text).toBe("B 新参执行");
    // started 事件各一枚（无重排——R6.4）
    expect(startedOrder(events)).toEqual(["ca", "cb", "cc"]);
  });

  test("UC-14 挂闸 resume reject → per-tool 粒度：B toolResult(拒绝文案, isError) 回灌 + 批续（兄弟照跑、循环照续）", async () => {
    const registry = registryWith({
      toolA: delayTool(() => ({ kind: "result", text: "A 真实" }), 2),
      toolB: async () => ({ kind: "result", text: "不应执行" }),
      toolC: delayTool(() => ({ kind: "result", text: "C 真实" }), 6),
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }]), textResult("模型自纠轮")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b14" });
    const { gate } = pauseGateOn("cb");
    const pending = engine.startRun({ ...runInput({ recorded }), beforeToolCallPause: gate } as never).promise;
    const paused = await pending;
    if (paused.kind !== "paused") throw new Error("应 paused");
    const resumed = await paused.resumeWith({ kind: "reject", text: "用户拒绝" });
    expect(resumed.kind).toBe("finished");
    const bResult = recorded.find((m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "cb") as { text: string };
    expect(bResult.text).toBe("用户拒绝");
    const bFinished = events.find((e) => e.type === "loop.tool.finished" && (e as unknown as { toolCallId: string }).toolCallId === "cb") as unknown as { isError: boolean };
    expect(bFinished.isError).toBe(true);
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult", "assistant"]);
  });

  test("UC-15 暂停期 abort → run 收口 aborted（挂闸枚补合成配对+标记）；resumeWith 惰性化（幂等 aborted、零执行零新事件）", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const slowA = gatedTool(() => ({ kind: "result", text: "A 真实" }));
    const slowC = gatedTool(() => ({ kind: "result", text: "C 真实" }));
    const registry = new ToolRegistry();
    registry.register({ name: "toolA", description: "a", parameters: {}, handler: slowA.handler });
    registry.register({
      name: "toolB",
      description: "b",
      parameters: {},
      handler: async () => {
        executed.push("B");
        return { kind: "result", text: "不应执行" };
      },
    });
    registry.register({ name: "toolC", description: "c", parameters: {}, handler: slowC.handler });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }])]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b15" });
    const { gate } = pauseGateOn("cb");
    const pending = engine.startRun({ ...runInput({ recorded }), signal: controller.signal, beforeToolCallPause: gate } as never).promise;
    const paused = await pending;
    if (paused.kind !== "paused") throw new Error("应 paused");
    slowA.release();
    slowC.release();
    await new Promise((r) => setTimeout(r, 5)); // 兄弟 settle
    controller.abort("barge-in");
    await new Promise((r) => setTimeout(r, 10)); // 后台续链收口（promise 已 settle paused——事件面收口）
    // run 收口：B 补合成配对 + A/C 真实 + 标记；interrupted → finished(aborted)
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult", "user"]);
    const bResult = recorded.find((m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "cb") as { text: string };
    expect(bResult.text).toBe(LOOP_INTERRUPTED_TOOL_RESULT_TEXT);
    expect((recorded[4] as { text: string }).text).toBe(LOOP_INTERRUPTED_MARKER_TEXT);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "loop.run.interrupted").length).toBe(1);
    expect((events.find((e) => e.type === "loop.run.interrupted") as unknown as { reason: string }).reason).toBe("barge-in");
    expect((events.filter((e) => e.type === "loop.run.finished").at(-1) as { resolution: string }).resolution).toBe("aborted");
    // resumeWith 惰性化（R4.8/D5）：幂等 aborted、零执行零新事件
    const eventsBefore = events.length;
    const r1 = await paused.resumeWith({ kind: "approve" });
    const r2 = await paused.resumeWith({ kind: "reject", text: "拒绝" });
    expect(r1).toEqual({ kind: "aborted" });
    expect(r2).toEqual({ kind: "aborted" });
    expect(executed).toEqual([]); // B 零执行
    expect(events.length).toBe(eventsBefore); // 零新事件
  });

  test("UC-22 resolve 批收口：B 外部 toolResult 入账 + A/C 真实照记（源序）+ run 终态 resolved 不续轮", async () => {
    const slowA = gatedTool(() => ({ kind: "result", text: "A 真实" }));
    const slowC = gatedTool(() => ({ kind: "result", text: "C 真实" }));
    const registry = new ToolRegistry();
    registry.register({ name: "toolA", description: "a", parameters: {}, handler: slowA.handler });
    registry.register({
      name: "toolB",
      description: "b",
      parameters: {},
      handler: async () => ({ kind: "result", text: "不应执行" }),
    });
    registry.register({ name: "toolC", description: "c", parameters: {}, handler: slowC.handler });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const windows: LoopMessage[][] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }, { id: "cc", name: "toolC" }])], { onCall: (m) => windows.push([...m]) });
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b22" });
    const { gate } = pauseGateOn("cb");
    const pending = engine.startRun({ ...runInput({ recorded }), beforeToolCallPause: gate } as never).promise;
    const paused = await pending;
    if (paused.kind !== "paused") throw new Error("应 paused");
    const resumePromise = paused.resumeWith({ kind: "resolve", text: "外部已执行：ok", isError: false });
    slowA.release();
    slowC.release();
    const resumed = await resumePromise;
    expect(resumed).toEqual({ kind: "resolved" });
    // B 外部结果 + A/C 真实（源序）——兄弟结果不因收口形态丢弃（R6.6/D10）
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "toolResult"]);
    expect(recorded.slice(1, 4).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["ca", "cb", "cc"]);
    expect((recorded.find((m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "cb") as { text: string }).text).toContain("外部已执行");
    const types = events.map((e) => e.type);
    expect(types.indexOf("loop.turn.finished")).toBeLessThan(types.indexOf("loop.run.finished"));
    expect((events.at(-1) as { resolution: string }).resolution).toBe("resolved");
    expect(windows.length).toBe(1); // 不续轮
  });

  test("R6.7 beforeToolCallPause 收可选 signal（additive）：挂闸判定可被打断的面就位", async () => {
    const controller = new AbortController();
    const gateSignals: (AbortSignal | undefined)[] = [];
    const registry = registryWith({ toolA: async () => ({ kind: "result", text: "ok" }) });
    const { streamFn } = fakeStream([batchResult([{ id: "c1", name: "toolA" }]), textResult("完")]);
    const engine = new LoopEngine({ streamFn, registry, emit: () => undefined, newRunId: () => "b67" });
    await engine.startRun({
      ...runInput({ recorded: [] }),
      signal: controller.signal,
      beforeToolCallPause: async (_ctx: LoopToolCallContext, signal?: AbortSignal) => {
        gateSignals.push(signal);
        return { pause: false };
      },
    } as never).promise;
    expect(gateSignals.length).toBe(1);
    expect(gateSignals[0]).toBe(controller.signal);
  });
});

describe("Phase 3 批工具：R7 maxRounds 与 D9", () => {
  test("UC-18 N 枚批=1 轮：5 枚批后 maxRounds=3 熔断 roundLimit；队列零消费（drain 在熔断检查后）", async () => {
    let executed = 0;
    const registry = registryWith({
      t: async () => {
        executed += 1;
        return { kind: "result", text: `ok${executed}` };
      },
    });
    const events: LoopEvent[] = [];
    let drainCalls = 0;
    const script = Array.from({ length: 5 }, () => batchResult([{ id: "c1", name: "t" }, { id: "c2", name: "t" }, { id: "c3", name: "t" }, { id: "c4", name: "t" }, { id: "c5", name: "t" }]));
    const { streamFn } = fakeStream(script);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "b18" });
    const result = await engine.startRun({
      ...runInput({ recorded: [] }),
      maxRounds: 3,
      drainSteering: () => {
        drainCalls += 1;
        return undefined;
      },
    } as never).promise;
    expect(result).toEqual({ kind: "roundLimit", maxRounds: 3 });
    expect(executed).toBe(15); // 3 轮 × 5 枚——批计 1 轮（R7.1）
    // 轮首 P0/P1 恒 poll（3 轮各一次）；熔断轮（rounds=4>3）零 poll——drain 在
    // 熔断检查之后，队列零吞（R7.4/G-G；队列不丢断言在 loop-agent 层 UC-18 变体）
    expect(drainCalls).toBe(3);
    expect((events.at(-1) as { resolution: string }).resolution).toBe("roundLimit");
  });

  test("UC-18 变体 maxRounds=4：第 4 轮照常 drain 注入（队列消费在熔断检查之后）", async () => {
    const registry = registryWith({ t: async () => ({ kind: "result", text: "ok" }) });
    const windows: LoopMessage[][] = [];
    const script = [
      ...Array.from({ length: 3 }, () => batchResult([{ id: "c1", name: "t" }])),
      textResult("终答"),
    ];
    const { streamFn } = fakeStream(script, { onCall: (m) => windows.push([...m]) });
    const engine = new LoopEngine({ streamFn, registry, emit: () => undefined, newRunId: () => "b18v" });
    let drainCount = 0;
    const result = await engine.startRun({
      ...runInput({ recorded: [] }),
      maxRounds: 4,
      drainSteering: () => {
        drainCount += 1;
        return drainCount >= 4 ? { role: "user", text: "s1" } : undefined; // s1 于第 4 轮轮首才可达（前 3 轮队列空）
      },
    } as never).promise;
    expect(result.kind).toBe("finished");
    // 第 4 轮（rounds=4 未超限）：drain 注入 s1 —— 注入位在三轮批 toolResult
    // 之后、本轮 streamFn 前（R2.4）；s1 从未进入压缩窗口（R2.8）
    const w4 = windows[3]!;
    expect(w4.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult", "user"]);
    expect((w4.at(-1) as { text: string }).text).toBe("s1");
  });

  test("D9 maxConcurrentTools 并发上限：3 枚批 cap=1 → 串行执行不超限、结果照常全收", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const registry = registryWith({
      t: async (_args, ctx) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(ctx.toolCallId);
        await new Promise((r) => setTimeout(r, 3));
        active -= 1;
        return { kind: "result", text: "ok" };
      },
    });
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const { streamFn } = fakeStream([batchResult([{ id: "c1", name: "t" }, { id: "c2", name: "t" }, { id: "c3", name: "t" }]), textResult("完")]);
    const engine = new LoopEngine({ streamFn, registry, emit: (e) => events.push(e), newRunId: () => "bd9" });
    const result = await engine.startRun({
      ...runInput({ recorded }),
      maxConcurrentTools: 1,
    } as never).promise;
    expect(result.kind).toBe("finished");
    expect(maxActive).toBe(1); // 并发不超 cap
    expect(order).toEqual(["c1", "c2", "c3"]); // 源序起跑
    expect(recorded.slice(1, 4).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(startedOrder(events)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("Phase 3 批工具：D7 截断标记文案", () => {
  test("标记文案对齐批语义（未执行调用为配对入账而非丢弃）+ [loop:interrupt] 前缀识别凭据保持", () => {
    expect(LOOP_INTERRUPTED_MARKER_TEXT.startsWith("[loop:interrupt]")).toBe(true);
    expect(LOOP_INTERRUPTED_MARKER_TEXT).toContain("配对");
    expect(LOOP_INTERRUPTED_MARKER_TEXT).not.toContain("工具调用已丢弃");
  });
});

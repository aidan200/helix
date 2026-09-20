import { describe, expect, test } from "bun:test";
import type {
  LoopEvent,
  LoopMessage,
  LoopResumeDecision,
  LoopStreamFn,
  LoopStreamResult,
  LoopToolOutcome,
} from "../../src/domain/loop";
import { LoopEngine, ToolRegistry } from "../../src/domain/loop";

/**
 * LoopEngine 单测（helix-loop L0 批；domain 层零依赖可测——fake StreamFn +
 * ToolRegistry 剧本）。断言面：
 * 1. 执行循环：text 直答 / 工具轮回灌续跑 / 工具轮上限熔断；
 * 2. 事件族序：pi 11 型同构子集的发射序（run/turn/message/tool）；
 * 3. 暂停点原语：beforeToolCallPause → run_paused → resumeWith 四决策
 *    （approve/approveWith/reject/resolve）；
 * 4. abort：signal 只作用于 LLM 流式段（工具段不打断——工具收尾后退出）；
 * 5. 挂钩前置校验产物（pause:false+outcome）与防火墙前置拒；
 * 6. 消息窗口快照拷贝（防引用泄漏回归锚）。
 */

function fakeStream(script: readonly LoopStreamResult[], hooks?: { onCall?: (messages: readonly LoopMessage[]) => void }): LoopStreamFn {
  let round = 0;
  return async (input, callbacks) => {
    hooks?.onCall?.(input.messages);
    const next = script[round];
    round += 1;
    if (next === undefined) throw new Error("剧本耗尽");
    if (next.kind === "text" && callbacks?.onDelta !== undefined) {
      callbacks.onDelta("段1");
    }
    return next;
  };
}

function registryWith(
  tools: Record<string, (args: Record<string, unknown>) => Promise<LoopToolOutcome>>,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, handler] of Object.entries(tools)) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      handler: async (args) => handler(args),
    });
  }
  return registry;
}

describe("LoopEngine：执行循环", () => {
  test("text 直答：事件序 run.started → turn.started → message.* → turn.finished → run.finished(answer)；assistant 入账", async () => {
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream([{ kind: "text", text: "答案" }]),
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      newRunId: () => "r1",
    });
    const run = engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "问" }],
      tools: [],
      maxRounds: 6,
      onNewMessage: async (m) => {
        recorded.push(m);
      },
    });
    const result = await run.promise;
    expect(result).toEqual({ kind: "finished", text: "答案" });
    expect(recorded).toEqual([{ role: "assistant", text: "答案" }]);
    expect(events.map((e) => e.type)).toEqual([
      "loop.run.started",
      "loop.turn.started",
      "loop.message.started",
      "loop.message.delta",
      "loop.message.finished",
      "loop.turn.finished",
      "loop.run.finished",
    ]);
    expect((events.at(-1) as { resolution: string }).resolution).toBe("answer");
  });

  test("工具轮：toolCall → registry 分发 → toolResult 回灌 → 下一轮 text；两轮窗口累积", async () => {
    const events: LoopEvent[] = [];
    const windows: LoopMessage[][] = [];
    const calls: string[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream(
        [
          { kind: "toolCall", id: "c1", name: "list", args: { q: 1 } },
          { kind: "text", text: "结论" },
        ],
        { onCall: (m) => windows.push([...m]) },
      ),
      registry: registryWith({
        list: async () => {
          calls.push("list");
          return { kind: "result", text: "数据" };
        },
      }),
      emit: (e) => events.push(e),
      newRunId: () => "r2",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "查" }],
      tools: [],
      maxRounds: 6,
    }).promise;
    expect(result).toEqual({ kind: "finished", text: "结论" });
    expect(calls).toEqual(["list"]);
    // 轮 1 窗口 = [user]；轮 2 窗口 = [user, assistant toolCall, toolResult]
    expect(windows[0]!.map((m) => m.role)).toEqual(["user"]);
    expect(windows[1]!.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    // 工具事件序：started → finished（isError false）
    const toolEvents = events.filter((e) => e.type.startsWith("loop.tool."));
    expect(toolEvents.map((e) => e.type)).toEqual(["loop.tool.started", "loop.tool.finished"]);
    expect((toolEvents[1] as { isError: boolean; resultSummary: string }).isError).toBe(false);
    // turn.finished(toolUse) 携工具名
    const turnFinished = events.find((e) => e.type === "loop.turn.finished" && (e as unknown as { stopReason: string }).stopReason === "toolUse") as unknown as { tools: string[] };
    expect(turnFinished?.tools).toEqual(["list"]);
  });

  test("工具轮上限熔断：maxRounds 轮工具调用后 → roundLimit（第 maxRounds 轮工具已执行完入账）", async () => {
    let n = 0;
    const engine = new LoopEngine({
      streamFn: fakeStream(Array.from({ length: 10 }, () => ({ kind: "toolCall", id: `c${n}`, name: "t", args: {} }))),
      registry: registryWith({
        t: async () => {
          n += 1;
          return { kind: "result", text: `ok${n}` };
        },
      }),
      emit: () => undefined,
      newRunId: () => "r3",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "无限工具" }],
      tools: [],
      maxRounds: 3,
    }).promise;
    expect(result).toEqual({ kind: "roundLimit", maxRounds: 3 });
    expect(n).toBe(3); // 第 3 轮工具照常执行收尾
  });

  test("未知工具：toolResult 报错回灌循环继续（模型可自纠）", async () => {
    const engine = new LoopEngine({
      streamFn: fakeStream([
        { kind: "toolCall", id: "c1", name: "不存在", args: {} },
        { kind: "text", text: "自纠" },
      ]),
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r4",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
    }).promise;
    expect(result).toEqual({ kind: "finished", text: "自纠" });
  });

  test("handler 异常归一 isError result 不抛（E-46 execute 同构）", async () => {
    const events: LoopEvent[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream([
        { kind: "toolCall", id: "c1", name: "boom", args: {} },
        { kind: "text", text: "恢复" },
      ]),
      registry: registryWith({
        boom: async () => {
          throw new Error("炸了");
        },
      }),
      emit: (e) => events.push(e),
      newRunId: () => "r5",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
    }).promise;
    expect(result).toEqual({ kind: "finished", text: "恢复" });
    const finished = events.find((e) => e.type === "loop.tool.finished") as { isError: boolean; resultSummary: string };
    expect(finished.isError).toBe(true);
    expect(finished.resultSummary).toContain("工具执行异常");
  });

  test("LLM 抛错 → run.error 事件 + error 收口（fail-fast，零重试——TR-185）", async () => {
    const events: LoopEvent[] = [];
    const engine = new LoopEngine({
      streamFn: async () => {
        throw new Error("网络错误");
      },
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      newRunId: () => "r6",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
    }).promise;
    expect(result).toEqual({ kind: "error", message: "网络错误" });
    expect(events.some((e) => e.type === "loop.run.error")).toBe(true);
  });
});

describe("LoopEngine：暂停点原语（beforeToolCallPause）", () => {
  test("pause:true → run_paused 事件 + run promise settle paused（assistant toolCall 已入账）；resumeWith(resolve) → toolResult 回灌 + resolved 终结", async () => {
    const events: LoopEvent[] = [];
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream([{ kind: "toolCall", id: "c1", name: "write", args: { x: 1 } }]),
      registry: registryWith({
        write: async () => ({ kind: "result", text: "不应直接执行" }),
      }),
      emit: (e) => events.push(e),
      newRunId: () => "r7",
    });
    const run = engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "写" }],
      tools: [],
      maxRounds: 6,
      beforeToolCallPause: async () => ({ pause: true }),
      onNewMessage: async (m) => {
        recorded.push(m);
      },
    });
    const paused = await run.promise;
    expect(paused.kind).toBe("paused");
    if (paused.kind !== "paused") return;
    // 挂闸时序：tool.started → assistant toolCall 入账 → run.paused（无 tool.finished）
    expect(recorded.map((m) => m.role)).toEqual(["assistant"]);
    expect((recorded[0] as { toolCall?: { id: string } }).toolCall?.id).toBe("c1");
    expect(events.map((e) => e.type)).toEqual([
      "loop.run.started",
      "loop.turn.started",
      "loop.message.started",
      "loop.message.finished",
      "loop.tool.started",
      "loop.run.paused",
    ]);
    expect((paused as { pauseToken: string }).pauseToken).toBe("r7-pause-1");
    // 外部执行（confirm 语义）→ resolve：toolResult 回灌 + run.finished(resolved)
    const resumed = await paused.resumeWith({ kind: "resolve", text: "已执行：ok", isError: false });
    expect(resumed).toEqual({ kind: "resolved" });
    expect(recorded.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect(events.some((e) => e.type === "loop.run.resumed")).toBe(true);
    expect((events.at(-1) as { resolution: string }).resolution).toBe("resolved");
  });

  test("resumeWith(approve) → handler 执行 + 循环续跑至终态", async () => {
    const executed: string[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream([
        { kind: "toolCall", id: "c1", name: "write", args: { x: 1 } },
        { kind: "text", text: "完成" },
      ]),
      registry: registryWith({
        write: async (args) => {
          executed.push(JSON.stringify(args));
          return { kind: "result", text: "done" };
        },
      }),
      emit: () => undefined,
      newRunId: () => "r8",
    });
    const run = engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
      beforeToolCallPause: async () => ({ pause: true }),
    });
    const paused = await run.promise;
    if (paused.kind !== "paused") throw new Error("应 paused");
    const resumed = await paused.resumeWith({ kind: "approve" });
    expect(resumed).toEqual({ kind: "finished", text: "完成" });
    expect(executed).toEqual([JSON.stringify({ x: 1 })]);
  });

  test("resumeWith(reject) → toolResult(拒绝文案) 回灌 + 循环继续（模型自纠面）", async () => {
    const engine = new LoopEngine({
      streamFn: fakeStream([
        { kind: "toolCall", id: "c1", name: "write", args: {} },
        { kind: "text", text: "改用别的方式" },
      ]),
      registry: registryWith({
        write: async () => ({ kind: "result", text: "不应执行" }),
      }),
      emit: () => undefined,
      newRunId: () => "r9",
    });
    const run = engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
      beforeToolCallPause: async () => ({ pause: true }),
    });
    const paused = await run.promise;
    if (paused.kind !== "paused") throw new Error("应 paused");
    const resumed = await paused.resumeWith({ kind: "reject", text: "用户拒绝" });
    expect(resumed).toEqual({ kind: "finished", text: "改用别的方式" });
  });

  test("挂钩前置校验产物（pause:false + outcome result）：toolResult 回灌循环继续（不经 handler）", async () => {
    const executed: string[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream([
        { kind: "toolCall", id: "c1", name: "write", args: {} },
        { kind: "text", text: "收到引导" },
      ]),
      registry: registryWith({
        write: async () => {
          executed.push("write");
          return { kind: "result", text: "不应执行" };
        },
      }),
      emit: () => undefined,
      newRunId: () => "r10",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
      beforeToolCallPause: async () => ({
        pause: false,
        outcome: { kind: "result", text: "参数缺失", isError: true },
      }),
    }).promise;
    expect(result).toEqual({ kind: "finished", text: "收到引导" });
    expect(executed).toEqual([]); // handler 未执行
  });

  test("防火墙前置拒（pause:false + terminate）：零入账 + run 错误收口（assistant toolCall 不进窗口）", async () => {
    const recorded: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream([{ kind: "toolCall", id: "c1", name: "write", args: {} }]),
      registry: registryWith({
        write: async () => ({ kind: "result", text: "x" }),
      }),
      emit: () => undefined,
      newRunId: () => "r11",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
      beforeToolCallPause: async () => ({
        pause: false,
        outcome: { kind: "terminate", reason: "目标不存在——拒绝" },
      }),
      onNewMessage: async (m) => {
        recorded.push(m);
      },
    }).promise;
    expect(result).toEqual({ kind: "error", message: "目标不存在——拒绝" });
    expect(recorded).toEqual([]); // 与管家迁移前行为严格等价：KV 无痕
  });
});

describe("LoopEngine：abort（signal 只作用于 LLM 流式段）", () => {
  test("streaming 中 abort → aborted 判别收口（streamFn 返回 aborted 而非 throw）", async () => {
    const controller = new AbortController();
    const engine = new LoopEngine({
      streamFn: async (_input, callbacks) => {
        controller.abort("superseded");
        expect(callbacks?.signal?.aborted).toBe(true);
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r12",
    });
    const result = await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
      signal: controller.signal,
    }).promise;
    expect(result).toEqual({ kind: "aborted" });
  });

  test("工具执行段不打断：abort 到达时工具挂起 → 工具收尾入账后下一轮前退出（duplex §6.2）", async () => {
    const controller = new AbortController();
    let releaseTool: (() => void) | undefined;
    const toolResults: LoopMessage[] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream([{ kind: "toolCall", id: "c1", name: "slow", args: {} }, { kind: "text", text: "不应到达" }]),
      registry: registryWith({
        slow: async () => {
          await new Promise<void>((resolve) => {
            releaseTool = resolve;
          });
          return { kind: "result", text: "慢工具完成" };
        },
      }),
      emit: () => undefined,
      newRunId: () => "r13",
    });
    const run = engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      maxRounds: 6,
      signal: controller.signal,
      onNewMessage: async (m) => {
        toolResults.push(m);
      },
    });
    const pending = run.promise;
    await new Promise((r) => setTimeout(r, 5)); // 工具挂起中
    controller.abort("superseded"); // abort 到达（工具执行段）
    await new Promise((r) => setTimeout(r, 5));
    expect(releaseTool).toBeDefined();
    releaseTool!(); // 工具收尾
    const result = await pending;
    expect(result).toEqual({ kind: "aborted" });
    // 工具结果已完整入账（toolCall/toolResult 恒成对——原子性）
    expect(toolResults.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });
});

describe("LoopEngine：消息窗口快照（防引用泄漏回归锚）", () => {
  test("streamFn 收到的 messages 是快照拷贝——后续轮 push 不泄漏进已记录引用", async () => {
    const seen: LoopMessage[][] = [];
    const engine = new LoopEngine({
      streamFn: fakeStream(
        [
          { kind: "text", text: "第一答" },
          { kind: "text", text: "第二答" },
        ],
        { onCall: (m) => seen.push([...m]) },
      ),
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r14",
    });
    await engine.startRun({ systemPrompt: "s", messages: [{ role: "user", text: "一" }], tools: [], maxRounds: 6 }).promise;
    await engine.startRun({
      systemPrompt: "s",
      messages: [{ role: "user", text: "二" }],
      tools: [],
      maxRounds: 6,
    }).promise;
    // run2 的窗口只含 run2 的消息（run1 的 assistant 不泄漏）
    expect(seen[1]!.map((m) => (m as { text?: string }).text)).toEqual(["二"]);
  });
});

describe("ToolRegistry", () => {
  test("llmTools 投影排除 hidden（steward_confirm 面）+ dispatch 按 name 执行 + 后注册者胜", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "a",
      description: "A",
      parameters: {},
      handler: async () => ({ kind: "result", text: "第一" }),
    });
    registry.register({
      name: "hidden_tool",
      description: "面板原语",
      parameters: {},
      hiddenFromLlm: true,
      handler: async () => ({ kind: "result", text: "hidden" }),
    });
    registry.register({
      name: "a",
      description: "A2",
      parameters: {},
      handler: async () => ({ kind: "result", text: "覆盖" }),
    });
    expect(registry.llmTools().map((t) => t.name)).toEqual(["a"]);
    expect(registry.names()).toEqual(["a", "hidden_tool"]);
    const dispatched = await registry.dispatch("a", {}, { runId: "r", toolCallId: "c", toolName: "a", args: {} });
    expect(dispatched.ok && dispatched.outcome).toEqual({ kind: "result", text: "覆盖" });
    const unknown = await registry.dispatch("nope", {}, { runId: "r", toolCallId: "c", toolName: "nope", args: {} });
    expect(unknown.ok).toBe(false);
  });
});

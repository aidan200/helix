import { describe, expect, test } from "bun:test";
import type {
  LoopEvent,
  LoopMessage,
  LoopStreamFn,
  LoopStreamResult,
  LoopToolOutcome,
} from "../../src/domain/loop";
import { ToolRegistry, loopBlocksText } from "../../src/domain/loop";
import { InjectionQueue } from "../../src/domain/loop/runtime";
import { LoopAgent } from "../../src/domain/loop/runtime";
import type { LoopInjection } from "../../src/domain/loop/runtime";

/**
 * helix-loop Phase 2 运行时层单测（runtime/LoopAgent + InjectionQueue）。
 *
 * 语义准绳：docs/temp/loop-interleaving-semantics.md（定稿 R2/R3/R7 + G 族总则）
 * ——本文件取 Phase 2 相关切片，单工具批（N=1）下可执行形态：
 * - InjectionQueue：steer/followUp 双队列、one-at-a-time（R2.3）、followUp
 *   深度上限（D4）、clear；
 * - LoopAgent 七面：start（G-A 单写者守卫）/ steer（R3.4 idle 触发）/ followUp
 *   / abort（R4.9 队列不清 + 幂等）/ continueRun（R3.5 P3 序 + P0 撤销）
 *   / waitForIdle / isStreaming / reset；
 * - UC 边界用例：UC-03（工具在飞 steer 排队→轮边界投递）、UC-04（两条 steer
 *   逐轮各投一条）、UC-05（终答轮 steer 不收口续跑）、UC-06（followUp 接管
 *   起新 run）、UC-07（steer 优先于 followUp）、UC-16（暂停期 steer 只入队）、
 *   UC-18 变体（熔断零吞队列）、UC-19（continueRun P3 序 + P0 撤销）、
 *   UC-20（压缩不吞 steer——轮首序 R7.4）。
 */

/** transcript 行摘要（Phase 1 块模型：assistant 无顶层 text——自块集拼接）。 */
function summarize(m: LoopMessage): string {
  if (m.role === "assistant") return `assistant:${loopBlocksText(m.content)}`;
  return `${m.role}:${(m as { text?: string }).text ?? ""}`;
}

function textResult(text: string): LoopStreamResult {
  return { kind: "blocks", blocks: [{ type: "text", text }], stopReason: "stop" };
}

function toolCallResult(id: string, name: string, args: Record<string, unknown>): LoopStreamResult {
  return { kind: "blocks", blocks: [{ type: "toolCall", id, name, args }], stopReason: "toolUse" };
}

function fakeStream(script: readonly LoopStreamResult[], hooks?: { onCall?: (messages: readonly LoopMessage[]) => void }): LoopStreamFn {
  let round = 0;
  return async (input, callbacks) => {
    hooks?.onCall?.(input.messages);
    const next = script[round];
    round += 1;
    if (next === undefined) throw new Error("剧本耗尽");
    if (next.kind === "blocks" && next.blocks.some((b) => b.type === "text") && callbacks?.onDelta !== undefined) {
      callbacks.onDelta("段1");
    }
    return next;
  };
}

/** 挂起可控 streamFn（指定轮次流式中挂起——模拟 LLM streaming 窗口；release
 *  一次后续直通）。缺省挂首轮。 */
function gatedStream(
  script: readonly LoopStreamResult[],
  opts: { hangRounds?: readonly number[]; onCall?: (messages: readonly LoopMessage[]) => void } = {},
): {
  fn: LoopStreamFn;
  release: () => void;
} {
  const hangRounds = opts.hangRounds ?? [1];
  let round = 0;
  let releaseGate: (() => void) | undefined;
  const fn: LoopStreamFn = async (input, callbacks) => {
    opts.onCall?.(input.messages);
    const next = script[round];
    round += 1;
    if (next === undefined) throw new Error("剧本耗尽");
    if (hangRounds.includes(round)) {
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    }
    if (next.kind === "blocks" && next.blocks.some((b) => b.type === "text") && callbacks?.onDelta !== undefined) {
      callbacks.onDelta("段1");
    }
    return next;
  };
  return {
    fn,
    release: () => releaseGate?.(), // 一次性：只释放当前挂起轮
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

/** 可挂起的工具（release 前 handler 不返回——模拟工具在飞窗口；release 后
 *  后续调用直通，多次工具轮不死锁）。 */
function gatedTool(): { register: (registry: ToolRegistry, name: string) => void; release: () => void } {
  let releaseTool: (() => void) | undefined;
  let bypass = false;
  const register = (registry: ToolRegistry, name: string): void => {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      handler: () =>
        new Promise<LoopToolOutcome>((resolve) => {
          if (bypass) {
            resolve({ kind: "result", text: `${name} 完成` });
            return;
          }
          releaseTool = () => resolve({ kind: "result", text: `${name} 完成` });
        }),
    });
  };
  return {
    register,
    release: () => {
      bypass = true;
      releaseTool?.();
    },
  };
}

describe("InjectionQueue：双队列与 one-at-a-time", () => {
  test("steer drain 逐条取最老（one-at-a-time R2.3）；followUp FIFO；互不串队", () => {
    const queue = new InjectionQueue();
    queue.pushSteer({ text: "s1" });
    queue.pushSteer({ text: "s2" });
    queue.pushFollowUp({ text: "f1" });
    expect(queue.drainSteer()?.text).toBe("s1");
    expect(queue.drainFollowUp()?.text).toBe("f1");
    expect(queue.drainSteer()?.text).toBe("s2");
    expect(queue.drainSteer()).toBeUndefined();
    expect(queue.drainFollowUp()).toBeUndefined();
  });

  test("followUp 深度上限（D4 缺省 3）：第 4 条拒绝并携带上限值", () => {
    const queue = new InjectionQueue();
    expect(queue.pushFollowUp({ text: "f1" })).toEqual({ ok: true, position: 1 });
    expect(queue.pushFollowUp({ text: "f2" })).toEqual({ ok: true, position: 2 });
    expect(queue.pushFollowUp({ text: "f3" })).toEqual({ ok: true, position: 3 });
    const rejected = queue.pushFollowUp({ text: "f4" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe("queueFull");
    expect(rejected.limit).toBe(3);
  });

  test("followUpLimit 可注入覆盖；steer 无上限（pi 同族）；clear 清双队列", () => {
    const queue = new InjectionQueue({ followUpLimit: 1 });
    expect(queue.pushFollowUp({ text: "f1" }).ok).toBe(true);
    expect(queue.pushFollowUp({ text: "f2" }).ok).toBe(false);
    for (let i = 0; i < 5; i += 1) expect(queue.pushSteer({ text: `s${i}` }).ok).toBe(true);
    queue.clear();
    expect(queue.pendingCounts()).toEqual({ steer: 0, followUp: 0 });
  });

  test("steerLimit 可注入（防御位——缺省无限）：超限拒绝同形回执", () => {
    const queue = new InjectionQueue({ steerLimit: 2 });
    expect(queue.pushSteer({ text: "s1" }).ok).toBe(true);
    expect(queue.pushSteer({ text: "s2" }).ok).toBe(true);
    const rejected = queue.pushSteer({ text: "s3" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe("queueFull");
    expect(rejected.limit).toBe(2);
  });
});

describe("LoopAgent：七面基础语义", () => {
  test("start：直答收口 + transcript 累积 + isStreaming 忙闲翻转 + waitForIdle 即回", async () => {
    const events: LoopEvent[] = [];
    const agent = new LoopAgent({
      streamFn: fakeStream([textResult("答")]),
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      newRunId: () => "r1",
      systemPrompt: "s",
      maxRounds: 6,
    });
    expect(agent.isStreaming()).toBe(false);
    const result = await agent.start("问");
    expect(result).toEqual({ kind: "finished", blocks: [{ type: "text", text: "答" }] });
    expect(agent.isStreaming()).toBe(false);
    expect(agent.messages().map(summarize)).toEqual(["user:问", "assistant:答"]);
    await agent.waitForIdle();
    expect(events.at(-1)?.type).toBe("loop.run.finished");
  });

  test("G-A 单写者：在飞 start 抛「already processing」同族守卫", async () => {
    const gated = gatedStream([textResult("答")]);
    const agent = new LoopAgent({
      streamFn: gated.fn,
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r2",
      systemPrompt: "s",
      maxRounds: 6,
    });
    const first = agent.start("第一问");
    await new Promise((r) => setTimeout(r, 5)); // streamFn 进入 gate（在飞窗口）
    expect(agent.isStreaming()).toBe(true);
    expect(() => agent.start("第二问")).toThrow(/already processing/i);
    gated.release();
    expect((await first).kind).toBe("finished");
  });

  test("steer（R3.4）：idle 时触发新 run（s 为输入，P0 撤销防双投递）；在飞时只入队待 P1（R2.5）", async () => {
    const gated = gatedStream([textResult("流中答"), textResult("二轮答"), textResult("三轮答")], { hangRounds: [1, 2] });
    const agent = new LoopAgent({
      streamFn: gated.fn,
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r3",
      systemPrompt: "s",
      maxRounds: 6,
    });
    // idle 触发面：无 run 且无挂起 run 时 steer 直接触发新 run（s 作输入入账）
    const pushed = agent.steer({ text: "idle 补充" });
    expect(pushed.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5)); // 触发的 run 进入流式 gate
    expect(agent.isStreaming()).toBe(true);
    gated.release();
    await agent.waitForIdle();
    expect(agent.messages().map(summarize)).toEqual(["user:idle 补充", "assistant:流中答"]);
    // 在飞面：run2 流式段（P0 已过）steer 只入队——终答轮后 R2.5 不收口续跑消费
    const p2 = agent.start("第二问");
    await new Promise((r) => setTimeout(r, 5)); // run2 进入第二轮流式 gate
    const pushed2 = agent.steer({ text: "在飞补充" });
    expect(pushed2.ok).toBe(true);
    gated.release(); // run2 终答轮收口 → 队列非空 → R2.5 续跑注入 → 第三轮终答
    const r2 = await p2;
    expect(r2.kind).toBe("finished");
    expect(agent.pendingCounts().steer).toBe(0); // 已被 P1 消费（run2 内续跑）
    expect(agent.messages().map(summarize).slice(-2)).toEqual(["user:在飞补充", "assistant:三轮答"]);
  });

  test("abort：signal 传播收口 aborted + steer 不清（R4.9）+ followUp 接管不丢 + 幂等", async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    let calls = 0;
    const agent = new LoopAgent({
      streamFn: async (_input, callbacks) => {
        calls += 1;
        seenSignals.push(callbacks?.signal);
        if (calls > 1) return { kind: "aborted" }; // followUp 接管 run（新 signal 未 abort，模拟立即失败收口）
        await new Promise<void>((resolve) => {
          const onAbort = () => resolve();
          callbacks?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        return { kind: "aborted" };
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r4",
      systemPrompt: "s",
      maxRounds: 6,
    });
    const p = agent.start("问");
    await new Promise((r) => setTimeout(r, 5));
    expect(agent.abort("打断")).toBe(true);
    agent.steer({ text: "s1" });
    agent.followUp({ text: "f1" });
    const result = await p;
    expect(result.kind).toBe("aborted");
    // G-G/R4.9：abort 不清 steer 队列（steer 不触发接管——留待下一次显式 run）
    expect(agent.pendingCounts().steer).toBe(1);
    // followUp 不丢的更强形态：aborted 收口后接管（E-197 打断后 queued 不丢同构）
    await agent.waitForIdle();
    expect(agent.pendingCounts().followUp).toBe(0);
    expect(calls).toBe(2); // 接管 run 确实发起
    // 幂等：接管链 settle 后无在飞 run
    expect(agent.abort("再打")).toBe(false);
    expect(seenSignals[0]?.aborted).toBe(true);
  });

  test("reset：清双队列 + 替换 transcript（恢复回填面）", async () => {
    const agent = new LoopAgent({
      streamFn: fakeStream([textResult("答")]),
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r5",
      systemPrompt: "s",
      maxRounds: 6,
    });
    agent.followUp({ text: "f1" }); // followUp 入队不触发 run（steer 的 R3.4 触发由专测覆盖）
    agent.reset([{ role: "user", text: "回填" }]);
    expect(agent.pendingCounts()).toEqual({ steer: 0, followUp: 0 });
    expect(agent.messages().length).toBe(1);
    const result = await agent.continueRun(); // 末 user → context-only 续跑
    expect(result.kind).toBe("finished");
    expect(agent.messages().map(summarize)).toEqual(["user:回填", "assistant:答"]);
  });

  test("continueRun：末 assistant 且双队列皆空 → 报错（R3.5）", async () => {
    const agent = new LoopAgent({
      streamFn: fakeStream([textResult("答")]),
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r6",
      systemPrompt: "s",
      maxRounds: 6,
    });
    await agent.start("问");
    expect(agent.continueRun()).rejects.toThrow(/不能从 assistant 收口续跑/);
  });
});

describe("LoopAgent：UC 边界用例（Phase 2 切片，单工具形态）", () => {
  test("UC-03 工具在飞 steer 到达 → 排队，轮边界投递（注入位恒在 toolResult 之后 R2.4）", async () => {
    const windows: LoopMessage[][] = [];
    const slow = gatedTool();
    const registry = new ToolRegistry();
    slow.register(registry, "slow");
    const agent = new LoopAgent({
      streamFn: fakeStream([toolCallResult("c1", "slow", {}), textResult("结论")], { onCall: (m) => windows.push([...m]) }),
      registry,
      emit: () => undefined,
      newRunId: () => "r7",
      systemPrompt: "s",
      maxRounds: 6,
    });
    const p = agent.start("查");
    await new Promise((r) => setTimeout(r, 5)); // 工具在飞
    agent.steer({ text: "先看下结果" });
    slow.release();
    const final = await p;
    expect(final.kind).toBe("finished");
    // 第 2 轮窗口：user(查) → assistant(toolCall) → toolResult → user(steer)
    const w2 = windows[1]!;
    expect(w2.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect((w2[3] as { text: string }).text).toBe("先看下结果");
  });

  test("UC-04 两条 steer → one-at-a-time 逐轮各投一条（s2 不进 T+1 轮）", async () => {
    const windows: LoopMessage[][] = [];
    const slow = gatedTool();
    const registry = new ToolRegistry();
    slow.register(registry, "slow");
    const agent = new LoopAgent({
      streamFn: fakeStream(
        [toolCallResult("c1", "slow", {}), toolCallResult("c2", "slow", {}), textResult("终答")],
        { onCall: (m) => windows.push([...m]) },
      ),
      registry,
      emit: () => undefined,
      newRunId: () => "r8",
      systemPrompt: "s",
      maxRounds: 6,
    });
    const p = agent.start("查");
    await new Promise((r) => setTimeout(r, 5)); // 工具在飞（G-C：只入队）
    agent.steer({ text: "s1" });
    agent.steer({ text: "s2" });
    slow.release();
    const result = await p;
    expect(result.kind).toBe("finished");
    const w2 = windows[1]!.map((m) => (m as { text?: string }).text ?? m.role);
    const w3 = windows[2]!.map((m) => (m as { text?: string }).text ?? m.role);
    expect(w2).toContain("s1");
    expect(w2).not.toContain("s2");
    expect(w3).toContain("s2");
  });

  test("UC-05 流式段 steer + 本轮 text 终答 → run 不收口，继续新 turn 消费（R2.5）", async () => {
    const events: LoopEvent[] = [];
    const gated = gatedStream([textResult("答一"), textResult("答二")]);
    const agent = new LoopAgent({
      streamFn: gated.fn,
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      newRunId: () => "r9",
      systemPrompt: "s",
      maxRounds: 6,
    });
    const p = agent.start("第一问");
    await new Promise((r) => setTimeout(r, 5)); // 首轮流式中
    agent.steer({ text: "追加" });
    gated.release();
    const result = await p;
    expect(result).toEqual({ kind: "finished", blocks: [{ type: "text", text: "答二" }] });
    // run 不收口：单 run 内两 turn（run.started 仅 1 次）
    expect(events.filter((e) => e.type === "loop.run.started").length).toBe(1);
    expect(events.filter((e) => e.type === "loop.turn.started").length).toBe(2);
    expect(agent.messages().map(summarize)).toEqual([
      "user:第一问",
      "assistant:答一",
      "user:追加",
      "assistant:答二",
    ]);
  });

  test("UC-06 followUp 接管：run 终态后 followUp 非空 → 起新 run（rounds 重置）", async () => {
    const events: LoopEvent[] = [];
    const agent = new LoopAgent({
      streamFn: fakeStream([textResult("答一"), textResult("答二")]),
      registry: new ToolRegistry(),
      emit: (e) => events.push(e),
      newRunId: (() => {
        let seq = 0;
        return () => `r10-${++seq}`;
      })(),
      systemPrompt: "s",
      maxRounds: 6,
    });
    const p = agent.start("第一问");
    const pushed = agent.followUp({ text: "跟进" });
    expect(pushed).toEqual({ ok: true, position: 1 });
    const r1 = await p;
    expect(r1.kind).toBe("finished"); // start 返回本轮结果（不含接管链）
    await agent.waitForIdle();
    expect(events.filter((e) => e.type === "loop.run.started").length).toBe(2);
    expect(agent.messages().map(summarize)).toEqual([
      "user:第一问",
      "assistant:答一",
      "user:跟进",
      "assistant:答二",
    ]);
  });

  test("UC-07 steer 优先于 followUp：P1 先投 s1；followUp 仅在「本要停」时接管", async () => {
    const gated = gatedStream([textResult("答一"), textResult("答二"), textResult("答三")]);
    const agent = new LoopAgent({
      streamFn: gated.fn,
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: (() => {
        let seq = 0;
        return () => `r11-${++seq}`;
      })(),
      systemPrompt: "s",
      maxRounds: 6,
    });
    const p = agent.start("第一问");
    await new Promise((r) => setTimeout(r, 5)); // 流式段（P0 已过——steer 留待 P1）
    agent.steer({ text: "s1" });
    agent.followUp({ text: "f1" });
    gated.release();
    await p;
    await agent.waitForIdle();
    // 序：run1（q → 答一 → P1 drain s1 → 答二 → P1 空 → 终态）→ followUp f1 接管 run2（答三）
    expect(agent.messages().map(summarize)).toEqual([
      "user:第一问",
      "assistant:答一",
      "user:s1",
      "assistant:答二",
      "user:f1",
      "assistant:答三",
    ]);
  });

  test("UC-16 暂停期 steer 只入队：resume 续跑完成本 turn 后在边界投递（R6.8/G-C）", async () => {
    const agent = new LoopAgent({
      streamFn: fakeStream([toolCallResult("c1", "write", {}), textResult("完成")]),
      registry: registryWith({ write: async () => ({ kind: "result", text: "已执行" }) }),
      emit: () => undefined,
      newRunId: () => "r12",
      systemPrompt: "s",
      maxRounds: 6,
      prepareRun: () => ({ beforeToolCallPause: async () => ({ pause: true }) }),
    });
    const p = agent.start("写");
    const paused = await p;
    expect(paused.kind).toBe("paused");
    expect(agent.isStreaming()).toBe(false); // paused settle = 写者释放（R6.3 现役契约）
    const steerResult = agent.steer({ text: "暂停期补充" }); // 只入队——不触发新 run（挂起 run 未终态）
    expect(steerResult.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(agent.messages().length).toBe(2); // user + assistant(toolCall)——s 未被投递
    if (paused.kind !== "paused") throw new Error("应 paused");
    const resumed = await paused.resumeWith({ kind: "approve" });
    expect(resumed.kind).toBe("finished");
    // resume 续跑：工具执行 → 轮边界 P1 → 注入 s1 → 终答
    expect(agent.messages().map(summarize)).toEqual([
      "user:写",
      "assistant:",
      "toolResult:已执行",
      "user:暂停期补充",
      "assistant:完成",
    ]);
  });

  test("UC-18 变体 熔断零吞队列：roundLimit 收口时 steer 原样保留（drain 在熔断检查后）", async () => {
    const slow = gatedTool();
    const registry = new ToolRegistry();
    slow.register(registry, "slow");
    const agent = new LoopAgent({
      streamFn: fakeStream(Array.from({ length: 5 }, (_, i) => toolCallResult(`c${i}`, "slow", {}))),
      registry,
      emit: () => undefined,
      newRunId: () => "r13",
      systemPrompt: "s",
      maxRounds: 1,
    });
    const p = agent.start("无限工具");
    await new Promise((r) => setTimeout(r, 5)); // 首轮工具在飞（G-C：steer 只入队）
    agent.steer({ text: "s1" });
    slow.release();
    const result = await p;
    expect(result.kind).toBe("roundLimit");
    // G-G/R7.4：熔断收口零消费——队列原样保留（供下一次显式 run/continueRun 消费）；
    // 消费链验证见 UC-19（continueRun P3 drain 保留 steer 作新 run 输入）
    expect(agent.pendingCounts()).toEqual({ steer: 1, followUp: 0 });
  });

  test("UC-19 末 assistant 后 steer 接续：R3.4 触发新 run 以 s1 为输入 + P0 撤销一次（P3 等价面，防同轮双投递）", async () => {
    const windows: LoopMessage[][] = [];
    const gated = gatedStream(
      [textResult("答一"), toolCallResult("c1", "t", {}), textResult("答三")],
      { hangRounds: [2], onCall: (m) => windows.push([...m]) },
    );
    const agent = new LoopAgent({
      streamFn: gated.fn,
      registry: registryWith({ t: async () => ({ kind: "result", text: "ok" }) }),
      emit: () => undefined,
      newRunId: (() => {
        let seq = 0;
        return () => `r14-${++seq}`;
      })(),
      systemPrompt: "s",
      maxRounds: 6,
    });
    const first = agent.start("第一问");
    await first; // run1 终态（末 assistant）——此刻 idle
    const triggered = agent.steer({ text: "s1" }); // R3.4 触发新 run：drain s1 作输入 + P0 撤销（P3 等价）
    expect(triggered.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5)); // 触发 run 进入第二轮剧本挂起（在飞）
    agent.steer({ text: "s2" }); // 在飞入队——P0 已撤销，留待 P1
    gated.release();
    await agent.waitForIdle();
    // 触发 run：轮 1 窗口末 = s1（作输入）；P0 撤销——s2 不进首轮
    const w1 = windows[1]!.map((m) => (m as { text?: string }).text ?? m.role);
    expect(w1.at(-1)).toBe("s1");
    expect(w1).not.toContain("s2");
    // 第二轮轮边界 P1 正常 drain s2（one-at-a-time 逐轮一条）
    const w2 = windows[2]!.map((m) => (m as { text?: string }).text ?? m.role);
    expect(w2).toContain("s2");
    expect(agent.messages().map(summarize)).toEqual([
      "user:第一问",
      "assistant:答一",
      "user:s1",
      "assistant:",
      "toolResult:ok",
      "user:s2",
      "assistant:答三",
    ]);
  });

  test("UC-20 压缩不吞 steer：轮首序 = abort → rounds 熔断 → 压缩 → turn.started → drain+注入 → streamFn（R7.4/R2.8）", async () => {
    const compactSeen: LoopMessage[][] = [];
    const windows: LoopMessage[][] = [];
    const slow = gatedTool();
    const registry = new ToolRegistry();
    slow.register(registry, "slow");
    const agent = new LoopAgent({
      streamFn: fakeStream([toolCallResult("c1", "slow", {}), textResult("结论")], { onCall: (m) => windows.push([...m]) }),
      registry,
      emit: () => undefined,
      newRunId: () => "r15",
      systemPrompt: "s",
      maxRounds: 6,
      compactStep: async (state) => {
        compactSeen.push([...state.messages]);
      },
    });
    const p = agent.start("查");
    await new Promise((r) => setTimeout(r, 5));
    agent.steer({ text: "s1" });
    slow.release();
    const result = await p;
    expect(result.kind).toBe("finished");
    // 压缩看到的窗口不含 s1（drain 在压缩之后）——s1 永不进压缩窗
    const compactAtR2 = compactSeen[0]!;
    expect(compactAtR2.some((m) => m.role === "user" && m.text === "s1")).toBe(false);
    // streamFn 第 2 轮窗口含 s1（压缩后注入）
    const w2 = windows[1]!;
    expect(w2.some((m) => m.role === "user" && m.text === "s1")).toBe(true);
  });

  test("轮首序 R7.4：熔断轮不压缩（rounds 检查先于 compactStep）", async () => {
    let compactCalls = 0;
    const agent = new LoopAgent({
      streamFn: fakeStream([toolCallResult("c1", "t", {})]),
      registry: registryWith({ t: async () => ({ kind: "result", text: "ok" }) }),
      emit: () => undefined,
      newRunId: () => "r16",
      systemPrompt: "s",
      maxRounds: 1,
      compactStep: async () => {
        compactCalls += 1;
      },
    });
    const result = await agent.start("q");
    expect(result.kind).toBe("roundLimit"); // 轮1 工具轮 → 轮2 rounds=2>1 熔断
    expect(compactCalls).toBe(1); // 轮 1 压缩照常；熔断轮（轮 2）零压缩——rounds 检查先于 compactStep
  });
});

describe("LoopAgent：onNewMessage / prepareRun / onRunSettled 接缝", () => {
  test("start 与接管轮的注入消息都过 onNewMessage（transcript 与应用投影同源）", async () => {
    const recorded: LoopMessage[] = [];
    const phases: string[] = [];
    const agent = new LoopAgent({
      streamFn: fakeStream([textResult("答一"), textResult("答二")]),
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r17",
      systemPrompt: "s",
      maxRounds: 6,
      onNewMessage: async (m) => {
        recorded.push(m);
      },
      prepareRun: ({ phase }) => {
        phases.push(phase);
        return {};
      },
      onRunSettled: (result, { phase }) => {
        phases.push(`settled:${phase}:${result.kind}`);
      },
    });
    const p = agent.start("第一问");
    agent.followUp({ text: "跟进" });
    await p;
    await agent.waitForIdle();
    // user 消息（start 输入 + followUp 接管输入）与 assistant 都经 onNewMessage
    expect(recorded.map(summarize)).toEqual([
      "user:第一问",
      "assistant:答一",
      "user:跟进",
      "assistant:答二",
    ]);
    expect(phases).toEqual(["start", "settled:start:finished", "followUp", "settled:followUp:finished"]);
  });

  test("steer 注入消息经 onNewMessage（轮边界注入入账同源）", async () => {
    const recorded: LoopMessage[] = [];
    const gated = gatedStream([textResult("答一"), textResult("答二")]);
    const agent = new LoopAgent({
      streamFn: gated.fn,
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r18",
      systemPrompt: "s",
      maxRounds: 6,
      onNewMessage: async (m) => {
        recorded.push(m);
      },
    });
    const p = agent.start("第一问");
    await new Promise((r) => setTimeout(r, 5));
    agent.steer({ text: "追加" });
    gated.release();
    await p;
    expect(recorded.map(summarize)).toEqual([
      "user:第一问",
      "assistant:答一",
      "user:追加",
      "assistant:答二",
    ]);
  });

  test("prepareRun 抛错 → start promise 拒绝且写者不泄漏（可再次 start）", async () => {
    let boom = true;
    const agent = new LoopAgent({
      streamFn: fakeStream([textResult("答")]),
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r19",
      systemPrompt: "s",
      maxRounds: 6,
      prepareRun: () => {
        if (boom) throw new Error("装配失败");
        return {};
      },
    });
    await expect(agent.start("问")).rejects.toThrow("装配失败");
    expect(agent.isStreaming()).toBe(false); // 失败不占写者
    boom = false;
    const second = await agent.start("再问");
    expect(second.kind).toBe("finished");
  });

  test("transcript 快照拷贝：messages() 返回拷贝，外泄引用不反向污染", async () => {
    const agent = new LoopAgent({
      streamFn: fakeStream([textResult("答")]),
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r20",
      systemPrompt: "s",
      maxRounds: 6,
    });
    await agent.start("问");
    const leaked = agent.messages() as LoopMessage[];
    (leaked as unknown as { push: (m: LoopMessage) => number }).push({ role: "user", text: "污染" });
    expect(agent.messages().length).toBe(2);
  });
});

/**
 * R5.4 LoopAgent 面收紧（Phase 5；CAND-551 申报面）：
 * - LoopRunResult.error 结构化 terminate 判别——防火墙 error（cause:"terminate"）
 *   与普通 error（LLM 失败等）可区分；
 * - terminate 收口的 run 不被 followUp 复活（对照 Phase 2「任何 settle 消费
 *   followUp」口径收紧；普通 error 仍接管——E-197 现役管家口径保持）；
 * - LoopAgent.abort 在 paused 态接线（R4.8/R6.3：写者已释放但 kernel 直持
 *   signal——挂闸可打断、后台续链合成配对收口 aborted、resumeWith 惰性化）。
 */
describe("LoopAgent：R5.4 terminate 判别与 paused abort 接线（Phase 5）", () => {
  test("UC-11 变体：全批 terminate → error{cause:terminate}；followUp 不接管、steer 队列保留（G-G）", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "toolA",
      description: "toolA",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ kind: "terminate", reason: "A 防火墙终止" }),
    });
    registry.register({
      name: "toolB",
      description: "toolB",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ kind: "terminate", reason: "B 防火墙终止" }),
    });
    let streamCalls = 0;
    const agent = new LoopAgent({
      streamFn: async () => {
        streamCalls += 1;
        if (streamCalls === 1) {
          return toolCallResult("ca", "toolA", {});
        }
        return toolCallResult("cb", "toolB", {});
      },
      registry,
      emit: () => undefined,
      newRunId: () => "r54a",
      systemPrompt: "s",
      maxRounds: 6,
    });
    agent.followUp({ text: "f1" }); // 收口前入队（R3.1「本要停」时接管——terminate 例外）
    const result = await agent.start("问");
    // 结构化判别：防火墙 error 携 cause:"terminate"（普通 error 无此位）
    expect(result.kind).toBe("error");
    expect((result as { cause?: string }).cause).toBe("terminate");
    // R5.4：followUp 不被 terminate 复活（对照 UC-06/abort 用例的接管形态）
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.pendingCounts().followUp).toBe(1);
    expect(streamCalls).toBe(2); // 仅 run1 两轮（批 A、批 B），零接管 run
    // waitForIdle 在 terminate 挂起 followUp 下不悬挂（run 链已终态）
    await agent.waitForIdle();
    // 队列保留（G-G）：下一次显式 run 消费
    const second = await agent.start("再问");
    expect(second.kind).toBe("finished");
    expect(agent.pendingCounts().followUp).toBe(0);
  });

  test("对照：普通 error（LLM 失败）settle 后 followUp 仍接管（E-197 口径不变）", async () => {
    let calls = 0;
    const agent = new LoopAgent({
      streamFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider 5xx");
        return textResult("接管答");
      },
      registry: new ToolRegistry(),
      emit: () => undefined,
      newRunId: () => "r54b",
      systemPrompt: "s",
      maxRounds: 6,
    });
    agent.followUp({ text: "f1" });
    const result = await agent.start("问");
    expect(result.kind).toBe("error");
    expect((result as { cause?: string }).cause).toBeUndefined(); // 普通错误无 terminate 判别
    await agent.waitForIdle();
    expect(agent.pendingCounts().followUp).toBe(0); // 接管发生
    expect(calls).toBe(2);
    expect(agent.messages().map(summarize).slice(-1)).toEqual(["assistant:接管答"]);
  });

  test("terminate 挂起后 steer 到达：只入队不触发暗跑（挂起 followUp 待显式 run 消费）", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "fw",
      description: "fw",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ kind: "terminate", reason: "防火墙" }),
    });
    let calls = 0;
    const agent = new LoopAgent({
      streamFn: async () => {
        calls += 1;
        return calls === 1 ? toolCallResult("c1", "fw", {}) : textResult("答");
      },
      registry,
      emit: () => undefined,
      newRunId: () => "r54c",
      systemPrompt: "s",
      maxRounds: 6,
    });
    agent.followUp({ text: "f1" });
    await agent.start("问"); // terminate 收口，followUp f1 挂起
    const pushed = agent.steer({ text: "s1" }); // R3.4 idle 触发：新 run（显式输入面——挂起 followUp 不复活、由本 run settle 消费）
    expect(pushed.ok).toBe(true);
    await agent.waitForIdle();
    expect(agent.pendingCounts()).toEqual({ steer: 0, followUp: 0 });
    expect(calls).toBe(3);
    // run2 以 s1 为输入（steer 优先）；f1 由 run2 settle 后的接管链消费（run3）
    expect(agent.messages().map(summarize)).toEqual([
      "user:问",
      "user:f1",
      "user:s1",
      "assistant:答",
      "user:f1",
      "assistant:答",
    ]);
  });

  test("paused 态 abort 接线：返回 true、挂闸枚合成配对收口 aborted、resumeWith 幂等、steer 保留", async () => {
    const events: LoopEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "slow",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ kind: "result", text: "slow 完成" }),
    });
    const agent = new LoopAgent({
      streamFn: async () => toolCallResult("c1", "slow", {}),
      registry,
      emit: (e) => events.push(e),
      newRunId: () => "r54d",
      systemPrompt: "s",
      maxRounds: 6,
      prepareRun: () => ({ beforeToolCallPause: async () => ({ pause: true }) }),
    });
    const p = agent.start("问");
    const paused = await p;
    expect(paused.kind).toBe("paused");
    expect(agent.isStreaming()).toBe(false); // R6.3：paused 态非 streaming
    // R5.4 接线：paused 态 abort 可达 kernel 直持 signal（现返 false → 收紧为 true）
    const aborted = agent.abort("用户中止");
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // 后台续链收口（事件异步到达）
    const types = events.map((e) => e.type);
    expect(types).toContain("loop.run.interrupted");
    expect(types[types.length - 1]).toBe("loop.run.finished");
    expect(types.filter((t) => t === "loop.run.finished")).toHaveLength(1);
    // D5 惰性化：abort 后 resumeWith 幂等 aborted、零执行零新事件
    const afterCount = events.length;
    const resumed = await (paused as { resumeWith: (d: { kind: "approve" }) => Promise<{ kind: string }> }).resumeWith({ kind: "approve" });
    expect(resumed.kind).toBe("aborted");
    await new Promise((r) => setTimeout(r, 5));
    expect(events.length).toBe(afterCount); // 零新事件
    // 挂闸枚合成配对（I1）：toolResult 在 transcript（中断回执文案）
    const toolResult = agent.messages().find((m) => m.role === "toolResult") as { text: string } | undefined;
    expect(toolResult?.text).toContain("已中断");
    // waitForIdle 不悬挂（挂起簿记随 abort 解除）
    await agent.waitForIdle();
  });

  test("paused 态 abort 幂等：二次 abort 返回 false（挂闸已解锁）", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "slow",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ kind: "result", text: "done" }),
    });
    const agent = new LoopAgent({
      streamFn: async () => toolCallResult("c1", "slow", {}),
      registry,
      emit: () => undefined,
      newRunId: () => "r54e",
      systemPrompt: "s",
      maxRounds: 6,
      prepareRun: () => ({ beforeToolCallPause: async () => ({ pause: true }) }),
    });
    const paused = await agent.start("问");
    expect(paused.kind).toBe("paused");
    expect(agent.abort()).toBe(true);
    expect(agent.abort()).toBe(false); // 幂等：挂闸已解锁、无在飞 run
    await new Promise((r) => setTimeout(r, 5));
    await agent.waitForIdle();
  });
});

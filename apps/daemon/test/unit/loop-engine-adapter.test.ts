import { describe, expect, test } from "bun:test";
import type {
  AgentEngineEvent,
  AgentEngineListener,
} from "../../src/application/ports/outbound/AgentEnginePort";
import { LoopAgentEngineAdapter } from "../../src/adapters/driven/loop/LoopAgentEngineAdapter";
import type { LoopStreamFn, LoopStreamResult, LoopToolOutcome } from "../../src/domain/loop";
import { ToolRegistry } from "../../src/domain/loop";
import type { LoopToolRegistration } from "../../src/domain/loop/kernel/ToolRegistry";

/**
 * LoopAgentEngineAdapter —— AgentEnginePort 的 helix-loop 实现契约用例
 * （Phase 5；设计 §7.2/§7.4）。时序契约锚 = AgentEnginePort §5 注释 +
 * FakeAgentEngine（pi 侧镜像）——本套件钉 loop 通道投影形状：
 * - 事件投影：LoopEvent → AgentEngineEvent（run/turn/message/tool 族 +
 *   engine_paused additive 面）；
 * - user 消息事件（prompt/steer-drain/followUp 输入）自 transcript 单写面
 *   （onNewMessage）合成——首条 prompt 缓冲至 run 首个 turn.started 后（pi
 *   序：turn_start → message_start(user)）；
 * - toolResult 消息事件按源序在 loop.turn.finished 收口批发射（pi parallel
 *   形态对齐：完成序 end → 源序 toolResult message → turn_end）；
 * - steer：在飞只入队（G-C）；idle 暂存至下一 start 的 P0 投递（pi 对齐，
 *   防无 listener 暗跑 run）；
 * - abort：在飞/暂停双态可达；abort 非销毁（之后再 start 可用）；
 * - 契约缺口钉子：message_end(assistant) 无 usage（LoopStreamResult 无
 *   usage 位——Phase 6 翻默认前必修项，findings 申报）。
 */

function textResult(text: string): LoopStreamResult {
  return { kind: "blocks", blocks: [{ type: "text", text }], stopReason: "stop" };
}

function batchResult(
  calls: readonly { id: string; name: string; args?: Record<string, unknown> }[],
): LoopStreamResult {
  return {
    kind: "blocks",
    blocks: calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, args: c.args ?? {} })),
    stopReason: "toolUse",
  };
}

/** 剧本驱动 mock streamFn（文本轮驱一次 onDelta——delta 累积面）。 */
function scriptStream(script: readonly LoopStreamResult[]): LoopStreamFn {
  let round = 0;
  return async (_input, callbacks) => {
    const next = script[round];
    round += 1;
    if (next === undefined) throw new Error("剧本耗尽");
    if (next.kind === "blocks") {
      for (const block of next.blocks) {
        if (block.type === "text" && block.text !== "" && callbacks?.onDelta !== undefined) {
          callbacks.onDelta(block.text);
        }
        callbacks?.onBlockEnd?.(block);
      }
    }
    return next;
  };
}

/** 挂起流（指定轮次悬挂——abort 时窗；signal 置位即收口 aborted，真桥同构）。 */
function gatedStream(script: readonly LoopStreamResult[], hangRounds: readonly number[] = [1]): {
  fn: LoopStreamFn;
  release: () => void;
} {
  let round = 0;
  let releaseGate: (() => void) | undefined;
  const fn: LoopStreamFn = async (_input, callbacks) => {
    const next = script[round];
    round += 1;
    if (next === undefined) throw new Error("剧本耗尽");
    if (hangRounds.includes(round)) {
      // 注：bun 转译器对 new Promise<T> 泛型参内的 as const 误解析——用显式变量避坑
      const abortResult: LoopStreamResult = { kind: "aborted" };
      const aborted = new Promise<LoopStreamResult>((resolve) => {
        callbacks?.signal?.addEventListener("abort", () => resolve(abortResult), { once: true });
      });
      const released = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const winner = await Promise.race([released.then(() => "released"), aborted.then(() => "aborted")]);
      if (winner === "aborted") return abortResult;
    }
    if (next.kind === "blocks") {
      for (const block of next.blocks) {
        if (block.type === "text" && block.text !== "" && callbacks?.onDelta !== undefined) {
          callbacks.onDelta(block.text);
        }
        callbacks?.onBlockEnd?.(block);
      }
    }
    return next;
  };
  return { fn, release: () => releaseGate?.() };
}

interface ToolSpec {
  readonly name: string;
  readonly handler: (args: Record<string, unknown>) => Promise<LoopToolOutcome>;
  readonly executionMode?: "parallel" | "sequential";
}

function registryWith(tools: readonly ToolSpec[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of tools) {
    const reg: LoopToolRegistration = {
      name: t.name,
      description: t.name,
      parameters: { type: "object", properties: {} },
      handler: async (args) => t.handler(args),
      ...(t.executionMode !== undefined ? { executionMode: t.executionMode } : {}),
    };
    registry.register(reg);
  }
  return registry;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function recorder(): { events: AgentEngineEvent[]; listener: AgentEngineListener } {
  const events: AgentEngineEvent[] = [];
  return { events, listener: (e) => events.push(e) };
}

/** 事件骨架（断言可读面：type + 关键载荷位）。 */
function skeletons(events: readonly AgentEngineEvent[]): unknown[] {
  return events.map((e) => {
    switch (e.type) {
      case "message_start":
        return `message_start:${e.role}:${e.source}`;
      case "message_end":
        return `message_end:${e.role}:${e.text}:${e.stopReason ?? "-"}`;
      case "message_update":
        return `message_update:${e.delta}`;
      case "tool_execution_start":
        return `tool_start:${e.toolCallId}:${e.toolName}`;
      case "tool_execution_end":
        return `tool_end:${e.toolCallId}:${e.isError}:${e.result}`;
      case "turn_end":
        return `turn_end:${e.toolResultCount}`;
      case "agent_end":
        return `agent_end:${e.messageCount}`;
      case "engine_paused":
        return `engine_paused:${e.toolName}`;
      case "engine_error":
        return `engine_error:${e.message}`;
      default:
        return e.type;
    }
  });
}

describe("LoopAgentEngineAdapter：AgentEnginePort 契约（loop 通道）", () => {
  test("纯文本轮事件序：agent_start → turn_start → user(prompt) → assistant 流式 → turn_end{0} → agent_end", async () => {
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([textResult("答一")]),
      registry: new ToolRegistry(),
    });
    const rec = recorder();
    await engine.start("问一", rec.listener);
    expect(skeletons(rec.events)).toEqual([
      "agent_start",
      "turn_start",
      "message_start:user:prompt",
      "message_end:user:问一:-",
      "message_start:assistant:prompt",
      "message_update:答一",
      "message_end:assistant:答一:stop",
      "turn_end:0",
      "agent_end:2",
    ]);
    expect(engine.isStreaming()).toBe(false);
  });

  test("工具批投影：started 源序 → end 完成序 → toolResult 消息源序批收口 → turn_end{N}（D6/pi parallel 形态）", async () => {
    const registry = registryWith([
      {
        name: "toolA",
        handler: async () => {
          await delay(12); // A 慢——完成序 B → A
          return { kind: "result", text: "A 的结果" };
        },
      },
      {
        name: "toolB",
        handler: async () => ({ kind: "result", text: "B 的结果" }),
      },
    ]);
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([batchResult([{ id: "ca", name: "toolA" }, { id: "cb", name: "toolB" }]), textResult("结论")]),
      registry,
    });
    const rec = recorder();
    await engine.start("查一下", rec.listener);
    expect(skeletons(rec.events)).toEqual([
      "agent_start",
      "turn_start",
      "message_start:user:prompt",
      "message_end:user:查一下:-",
      "message_start:assistant:prompt",
      "message_end:assistant::toolUse",
      "tool_start:ca:toolA",
      "tool_start:cb:toolB",
      "tool_end:cb:false:B 的结果",
      "tool_end:ca:false:A 的结果",
      "message_start:toolResult:prompt",
      "message_end:toolResult:A 的结果:-",
      "message_start:toolResult:prompt",
      "message_end:toolResult:B 的结果:-",
      "turn_end:2",
      "turn_start",
      "message_start:assistant:prompt",
      "message_update:结论",
      "message_end:assistant:结论:stop",
      "turn_end:0",
      "agent_end:5",
    ]);
  });

  test("tool_execution_start 携 args 对象、tool_execution_end 携全文 result（载荷 additive 位）", async () => {
    const registry = registryWith([
      { name: "echo", handler: async () => ({ kind: "result", text: "很长的结果".repeat(60) }) },
    ]);
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([batchResult([{ id: "c1", name: "echo", args: { x: 1 } }]), textResult("好")]),
      registry,
    });
    const rec = recorder();
    await engine.start("q", rec.listener);
    const start = rec.events.find((e) => e.type === "tool_execution_start");
    expect(start).toMatchObject({ toolCallId: "c1", toolName: "echo", args: { x: 1 } });
    const end = rec.events.find((e) => e.type === "tool_execution_end");
    expect(end?.result).toBe("很长的结果".repeat(60)); // 全文（非 200 字截断摘要）
  });

  test("在飞 steer：批执行期只入队，轮边界 drain → message_start(user, steer-drain)", async () => {
    const registry = registryWith([
      {
        name: "slow",
        handler: async () => {
          await delay(15);
          return { kind: "result", text: "slow 完成" };
        },
      },
    ]);
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([batchResult([{ id: "c1", name: "slow" }]), textResult("第一答"), textResult("第二答")]),
      registry,
    });
    const rec = recorder();
    const runP = engine.start("问", rec.listener);
    // 工具在飞窗口注入（事件触发：首个 tool_execution_start 后）
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (rec.events.some((e) => e.type === "tool_execution_start")) {
          clearInterval(timer);
          resolve();
        }
      }, 1);
    });
    engine.steer("先看下输出");
    await runP;
    expect(skeletons(rec.events)).toContain("message_start:user:steer-drain");
    expect(skeletons(rec.events)).toContain("message_end:user:先看下输出:-");
    // steer 消费轮：turn_end{1} 后新 turn 首条 user = 注入（G-C/R2.4）
    const idx = skeletons(rec.events).indexOf("turn_end:1");
    expect(skeletons(rec.events).slice(idx + 1, idx + 5)).toEqual([
      "turn_start",
      "message_start:user:steer-drain",
      "message_end:user:先看下输出:-",
      "message_start:assistant:prompt",
    ]);
  });

  test("idle steer：暂存不暗跑（pi 对齐）——下一 start 的 P0 投递为首 turn 第二条 user", async () => {
    const registry = new ToolRegistry();
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([textResult("答一"), textResult("答二"), textResult("答三")]),
      registry,
    });
    const first = recorder();
    await engine.start("第一问", first.listener);
    engine.steer("闲时补充"); // idle：无 run——暂存（不触发暗跑）
    expect(engine.isStreaming()).toBe(false);
    const second = recorder();
    await engine.start("第二问", second.listener);
    expect(skeletons(second.events).slice(0, 6)).toEqual([
      "agent_start",
      "turn_start",
      "message_start:user:prompt",
      "message_end:user:第二问:-",
      "message_start:user:steer-drain",
      "message_end:user:闲时补充:-",
    ]);
  });

  test("abort 在飞：run 收口（agent_end 到达）+ abort 非销毁（可再 start）", async () => {
    const gated = gatedStream([textResult("答"), textResult("答")], [1]); // 首轮悬挂，次轮供再跑
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: gated.fn,
      registry: new ToolRegistry(),
    });
    const rec = recorder();
    const runP = engine.start("问", rec.listener);
    await delay(5); // 流式悬挂窗口
    expect(engine.isStreaming()).toBe(true);
    engine.abort();
    await runP;
    const types = rec.events.map((e) => e.type);
    expect(types[types.length - 1]).toBe("agent_end");
    // 再跑一轮（abort 非销毁）
    const rec2 = recorder();
    await engine.start("再问", rec2.listener);
    expect(skeletons(rec2.events)).toContain("message_end:assistant:答:stop");
  });

  test("pause additive 面：engine_paused 事件 + resume(approve) 续跑收口（start promise 不悬）", async () => {
    const executed: string[] = [];
    const registry = registryWith([
      { name: "ask", handler: async () => ({ kind: "result", text: "已执行" }) },
    ]);
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([batchResult([{ id: "c1", name: "ask" }]), textResult("收尾")]),
      registry,
      beforeToolCallPause: async () => ({ pause: true }),
    });
    const rec = recorder();
    const runP = engine.start("确认一下", rec.listener);
    await runP; // paused settle 即 resolve（R6.3——start promise 不悬）
    expect(engine.isStreaming()).toBe(false);
    const pausedEvent = rec.events.find((e) => e.type === "engine_paused");
    expect(pausedEvent).toMatchObject({ toolCallId: "c1", toolName: "ask" });
    const token = pausedEvent !== undefined && pausedEvent.type === "engine_paused" ? pausedEvent.pauseToken : "";
    await engine.resume?.(token, { kind: "approve" });
    executed.push("approved");
    const types = rec.events.map((e) => e.type);
    expect(types[types.length - 1]).toBe("agent_end");
    expect(skeletons(rec.events)).toContain("tool_end:c1:false:已执行");
    expect(skeletons(rec.events)).toContain("message_end:assistant:收尾:stop");
  });

  test("terminate 防火墙：engine_error 事件 + agent_end；之后的 steer/start 正常（队列不复活由 R5.4 承接）", async () => {
    const registry = registryWith([
      { name: "fw", handler: async () => ({ kind: "terminate", reason: "被拒" }) },
    ]);
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([batchResult([{ id: "c1", name: "fw" }])]),
      registry,
    });
    const rec = recorder();
    await engine.start("问", rec.listener);
    expect(skeletons(rec.events)).toContain("engine_error:被拒");
    const types = rec.events.map((e) => e.type);
    expect(types[types.length - 1]).toBe("agent_end");
    expect(engine.isStreaming()).toBe(false);
    // 非销毁：新 start 可用
    const engine2 = engine;
    const rec2 = recorder();
    await expect(engine2.start("再问", rec2.listener)).resolves.toBeUndefined();
  });

  test("契约缺口钉子：message_end(assistant) 不携带 usage（LoopStreamResult 无 usage 位——Phase 6 前必修项）", async () => {
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([textResult("答")]),
      registry: new ToolRegistry(),
    });
    const rec = recorder();
    await engine.start("问", rec.listener);
    const end = rec.events.find((e) => e.type === "message_end" && e.role === "assistant");
    expect(end !== undefined && end.type === "message_end" ? end.usage : "absent").toBeUndefined();
  });

  test("setSystemPrompt / setTools：下一 run 生效（in-flight 不变）", async () => {
    const seen: { systemPrompt: string; tools: string[] }[] = [];
    const streamFn: LoopStreamFn = async (input) => {
      seen.push({ systemPrompt: input.systemPrompt, tools: input.tools.map((t) => t.name) });
      return textResult("答");
    };
    const registry = registryWith([
      { name: "alpha", handler: async () => ({ kind: "result", text: "a" }) },
      { name: "beta", handler: async () => ({ kind: "result", text: "b" }) },
    ]);
    const engine = new LoopAgentEngineAdapter({ systemPrompt: "旧提示", streamFn, registry });
    await engine.start("一", () => undefined);
    expect(seen[0]).toEqual({ systemPrompt: "旧提示", tools: ["alpha", "beta"] });
    engine.setSystemPrompt?.("新提示");
    engine.setTools?.(["beta"]);
    expect(() => engine.setTools?.(["ghost"])).toThrow(); // 未知名 fail-fast（pi resolveTools 同构）
    await engine.start("二", () => undefined);
    expect(seen[1]).toEqual({ systemPrompt: "新提示", tools: ["beta"] });
  });

  test("currentModel/setModel：经 modelRef 委托（可观测面）", async () => {
    const holder = { current: "fake/model-a" };
    const engine = new LoopAgentEngineAdapter({
      systemPrompt: "s",
      streamFn: scriptStream([textResult("答")]),
      registry: new ToolRegistry(),
      modelRef: {
        get: () => holder.current,
        set: (id) => {
          holder.current = id;
        },
      },
    });
    expect(engine.currentModel?.()).toBe("fake/model-a");
    engine.setModel?.("fake/model-b");
    expect(engine.currentModel?.()).toBe("fake/model-b");
  });

  test("图片上行：start(images) → streamFn 窗口首条 user 携 images（data/mimeType）", async () => {
    const seenImages: unknown[] = [];
    const streamFn: LoopStreamFn = async (input) => {
      const first = input.messages.find((m) => m.role === "user");
      if (first !== undefined && first.role === "user") seenImages.push(first.images);
      return textResult("看过了");
    };
    const engine = new LoopAgentEngineAdapter({ systemPrompt: "s", streamFn, registry: new ToolRegistry() });
    await engine.start("看图", () => undefined, ["data:image/png;base64,aGk="]);
    expect(seenImages).toEqual([[{ data: "aGk=", mimeType: "image/png" }]]);
  });
});

describe("engine flag（HELIX_AGENT_ENGINE）：缺省 pi 现役零漂移", () => {
  test("agentEngineFromEnv：缺省/非法值回落 pi；显式 loop 开启验证通道", async () => {
    const { agentEngineFromEnv } = await import("../../src/infrastructure/assembly/sessionEngineFactory");
    expect(agentEngineFromEnv({})).toBe("pi"); // 缺省 pi（现役零漂移——不翻默认值）
    expect(agentEngineFromEnv({ HELIX_AGENT_ENGINE: "pi" })).toBe("pi");
    expect(agentEngineFromEnv({ HELIX_AGENT_ENGINE: "loop" })).toBe("loop"); // 显式开启
    expect(agentEngineFromEnv({ HELIX_AGENT_ENGINE: "ghost" })).toBe("pi"); // 非法值回落不告警
  });
});

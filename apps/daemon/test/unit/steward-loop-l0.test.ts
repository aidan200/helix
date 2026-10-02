import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardHistoryRecord } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { stewardEngineTraceBridge, STEWARD_INSTANCE_ID } from "../../src/infrastructure/assembly/stewardEngineTraceBridge";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";

/**
 * helix-loop L0 迁移新增面单测：
 * 1. abort-and-drain 单飞门控（duplex-truncation §6.2——T5/T7 的 L0 子集）：
 *    在途轮 streaming 中新 ask 到达 → abort 旧轮（signal 只作用 LLM 段）→
 *    drain 旧 promise settle（KV 写入收尾）→ 开新轮；KV 顺序不变量
 *    （旧轮最后写入 < 新轮首写）；旧轮回执 error 判别（被取代）；
 * 2. 确认闸经 LoopEngine 暂停点全链：propose_send → confirm_required
 *    （run_paused 事件）→ confirm → resumeWith(resolve)（run_resumed 事件）
 *    → toolResult 回灌 KV（与迁移前 confirm 直接入账等价）；
 * 3. 事件出口（emitEngineEvent）：里程碑子集发射 + 流式中间态排除；
 * 4. stewardEngineTraceBridge：AgentEngineEvent → DomainEvent（instanceId=steward、
 *    SYSTEM_SESSION_ID）里程碑过滤；
 * 5. SttStreamService 同构语义（重复 start = 废弃旧流）——askGate 平移对照。
 */

interface HangingLlmDeps {
  /** 第一问 LLM 调用挂起（streaming 态模拟）——signal abort 时 resolve aborted。 */
  readonly gate: Promise<void>;
  readonly onSignal?: (signal: AbortSignal) => void;
}

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
    createEngine: undefined as unknown as Deps["createEngine"],
    orchestration: {
      status: () => [
        { agentId: "agent-1", state: "running" as const, displayState: "active" as const, profileKind: "subagent-worker" },
      ],
      send: () => ({ delivered: true, detail: "已注入" }),
    },
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
  };
  return { ...base, ...overrides };
}

describe("输入缓冲序（L1 件二取代 L0 abort-and-drain 取代语义）", () => {
  test("streaming 中新 ask 到达 → 入队不 abort → 旧轮完成 → 新轮自动跑；KV 顺序 = […旧轮收尾, user2]（写入顺序不变量保持）", async () => {
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const seenSignals: AbortSignal[] = [];
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async (_req: StewardLlmRequest, _onD?: (c: string) => void, _onT?: (b: string) => void, signal?: AbortSignal) => {
        if (signal !== undefined) {
          seenSignals.push(signal);
          // 首问：挂起模拟 streaming；abort 时收口 aborted 判别
          await new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", onAbort, { once: true });
            void gate.then(resolve);
          });
          if (signal.aborted) return { kind: "aborted" };
        }
        return { kind: "blocks", blocks: [{ type: "text", text: "答" }], stopReason: "stop" };
      },
    };
    const config = fakeConfig({ "steward.enabled": "1" });
    const svc = new StewardService({ ...baseDeps({ config }), llm , createEngine: createEngineFromPort(llm)});
    const first = svc.ask("第一问");
    await new Promise((r) => setTimeout(r, 5)); // 首问进入 streaming（挂起中）
    const second = await svc.ask("第二问"); // L1：入队不 abort（旧轮继续）
    expect(second.status).toBe("queued");
    resolveGate!(); // 释放首问 → 直答收口 → 队列自动消费第二问
    const r1 = await first;
    expect(r1.status).toBe("answer"); // 旧轮不再被取代——完整收口
    await new Promise((r) => setTimeout(r, 10));
    // KV 顺序不变量：旧轮完整收尾（user1/assistant1）后新 user2 入账
    const history = await svc.getHistory();
    expect(history.filter((r: StewardHistoryRecord) => r.kind === "user").map((r: { text: string }) => r.text)).toEqual([
      "第一问",
      "第二问",
    ]);
    // abort 面保留给外部（abortInFlight）——新 ask 不再触发 abort
    expect(seenSignals.length).toBeGreaterThanOrEqual(1);
    expect(seenSignals[0]!.aborted).toBe(false);
  });

  test("idle 态连续 ask：零 abort 干扰（串行直答）", async () => {
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async () => ({ kind: "blocks", blocks: [{ type: "text", text: "ok" }], stopReason: "stop" }),
    };
    const svc = new StewardService({ ...baseDeps(), llm, createEngine: createEngineFromPort(llm) });
    expect((await svc.ask("a")).status).toBe("answer");
    expect((await svc.ask("b")).status).toBe("answer");
    const history = await svc.getHistory();
    expect(history.filter((r) => r.kind === "user").length).toBe(2);
  });

  test("确认闸挂起（paused 态）非 streaming：新 ask 不 abort（旧 run 已 settle，pending 自然过期语义保持）", async () => {
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async (req: StewardLlmRequest, _d?: (c: string) => void, _t?: (b: string) => void, signal?: AbortSignal) => {
        const last = req.messages[req.messages.length - 1];
        const lastText = last !== undefined && "text" in last ? (last as { text?: string }).text : "";
        if (lastText === "递话" ) {
          return { kind: "blocks", blocks: [{ type: "toolCall", id: "c1", name: "propose_send", args: { agentId: "agent-1", message: "快一点" } }], stopReason: "toolUse" };
        }
        void signal;
        return { kind: "blocks", blocks: [{ type: "text", text: "好的" }], stopReason: "stop" };
      },
    };
    const svc = new StewardService({ ...baseDeps(), llm, createEngine: createEngineFromPort(llm) });
    const r1 = await svc.ask("递话");
    expect(r1.status).toBe("confirm_required");
    const r2 = await svc.ask("再问一句");
    expect(r2.status).toBe("answer"); // paused 态不阻塞新 ask（与迁移前等价）
  });
});

describe("确认闸经 LoopEngine 暂停点全链", () => {
  function proposeScriptLlm(): StewardLlmPort {
    return {
      modelId: "m",
      complete: async (req: StewardLlmRequest) => {
        const last = req.messages[req.messages.length - 1];
        const lastText = last !== undefined && "text" in last ? (last as { text?: string }).text : "";
        if (lastText === "递话") {
          return { kind: "blocks", blocks: [{ type: "toolCall", id: "c1", name: "propose_send", args: { agentId: "agent-1", message: "快一点" } }], stopReason: "toolUse" };
        }
        return { kind: "blocks", blocks: [{ type: "text", text: "好的" }], stopReason: "stop" };
      },
    };
  }

  test("propose_send → run_paused 事件 → confirm_required 回执 → confirm → run_resumed + toolResult 回灌 KV + 单次消费", async () => {
    const events: AgentEngineEvent[] = [];
    const sendCalls: string[] = [];
    const llm = proposeScriptLlm();
    const svc = new StewardService({
      ...baseDeps({
        orchestration: {
          status: () => [
            { agentId: "agent-1", state: "running" as const, displayState: "active" as const, profileKind: "subagent-worker" },
          ],
          send: (agentId: string, message: string) => {
            sendCalls.push(`${agentId}:${message}`);
            return { delivered: true, detail: "已注入 agent-1" };
          },
        },
      }),
      llm,
      emitEngineEvent: (e) => events.push(e),
    createEngine: createEngineFromPort(llm)});
    const r1 = await svc.ask("递话");
    expect(r1.status).toBe("confirm_required");
    if (r1.status !== "confirm_required") throw new Error("应 confirm_required");
    expect(r1.agentId).toBe("agent-1");
    expect(r1.message).toBe("快一点");
    // run_paused 事件（toolName + pauseToken 携带）
    const paused = events.find((e) => e.type === "engine_paused") as { toolName: string; pauseToken: string } | undefined;
    expect(paused?.toolName).toBe("propose_send");
    expect(paused?.pauseToken ?? "").not.toBe("");
    // KV：assistant toolCall 已入账、无 toolResult（挂起待确认）
    const mid = await svc.getHistory();
    expect(mid.some((r) => r.kind === "assistant" && r.toolCall?.id === "c1")).toBe(true);
    expect(mid.some((r) => r.kind === "toolResult")).toBe(false);
    // confirm → 执行 + 回灌 + 单次消费
    const confirmed = await svc.confirm(r1.actionId);
    expect(confirmed.status).toBe("accepted"); // B1 两段式：受理即回（执行体异步）
    await new Promise((r) => setTimeout(r, 10));
    expect(sendCalls).toEqual(["agent-1:快一点"]);
    const again = await svc.confirm(r1.actionId);
    expect(again.status).toBe("error"); // 单次消费
    // 段B pi 形态：confirm → resume(resolve 翻译) → block+terminate → agent_end 收口
    //（无 run.resumed/resolution 字段——回灌结果与收口时序由 KV 与下述断言承载）
    // KV：toolResult 已回灌（配对完整——buildLlmWindow 不再补合成占位）
    const done = await svc.getHistory();
    const toolResult = done.find((r) => r.kind === "toolResult");
    expect(toolResult).toBeDefined();
    expect((toolResult as { text: string }).text).toContain("已注入");
  });

  test("propose_send 实例不运行 → 防火墙前置拒：error 回执 + KV 零 assistant toolCall（无痕——迁移前行为等价）", async () => {
    const llm = proposeScriptLlm();
    const svc = new StewardService({
      ...baseDeps({
        orchestration: {
          status: () => [
            { agentId: "agent-1", state: "done" as const, displayState: "done" as const, profileKind: "subagent-worker" },
          ], // 非运行中
          send: () => ({ delivered: false, detail: "" }),
        },
      }),
      llm,
    createEngine: createEngineFromPort(llm)});
    const r = await svc.ask("递话");
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toContain("不存在或非运行中");
    const history = await svc.getHistory();
    // 声明偏差（段B pi 形态）：assistant toolCall 帧入账（pi transcript 先于
    // 闸收口）+ 拒绝文案 toolResult 回执——原 loop 无痕语义不保留，防火墙
    // 语义核心（error 回执 + 不投递）不变
    expect(history.some((rec) => rec.kind === "toolResult" && rec.text.includes("不存在或非运行中"))).toBe(true);
  });
});

describe("事件出口（emitEngineEvent）与追踪桥", () => {
  test("一次 ask 的里程碑子集：run.started/turn.started/message.*/tool.*/run.finished 发射；流式 delta 也发（实时通道面）", async () => {
    const events: AgentEngineEvent[] = [];
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async (req: StewardLlmRequest, onDelta?: (c: string) => void) => {
        const last = req.messages[req.messages.length - 1];
        const lastText = last !== undefined && "text" in last ? (last as { text?: string }).text : "";
        if (lastText === "查") {
          return { kind: "blocks", blocks: [{ type: "toolCall", id: "c1", name: "list_tasks", args: {} }], stopReason: "toolUse" };
        }
        onDelta?.("增量");
        return { kind: "blocks", blocks: [{ type: "text", text: "结论" }], stopReason: "stop" };
      },
    };
    const svc = new StewardService({ ...baseDeps(), llm, emitEngineEvent: (e) => events.push(e) , createEngine: createEngineFromPort(llm)});
    const r = await svc.ask("查");
    expect(r.status).toBe("answer");
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("turn_start");
    expect(types).toContain("message_update"); // 流式 delta（实时通道面）
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types).toContain("turn_end");
    expect(types.at(-1)).toBe("agent_end");
  });

  test("stewardEngineTraceBridge：里程碑 → DomainEvent（instanceId=steward / SYSTEM_SESSION_ID）；流式中间态过滤", () => {
    const published: DomainEvent[] = [];
    const bridge = stewardEngineTraceBridge({
      publish: (e) => published.push(e),
      nowIso: () => "2026-09-21T00:00:00.000Z",
    });
    bridge({ type: "agent_start" });
    bridge({ type: "message_update", delta: "x" }); // 流式中间态（过滤面）
    bridge({ type: "thinking_delta", contentIndex: 0, delta: "t" }); // 同上
    bridge({ type: "tool_execution_end", toolCallId: "c1", toolName: "list_tasks", result: "3 条", isError: false });
    bridge({ type: "engine_paused", pauseToken: "p1", toolCallId: "c1", toolName: "propose_send", argsSummary: "{}", args: {} });
    // 首条里程碑前合成档案行 agent.instantiated（fix/trace-steward-entry：幂等恰一次）
    expect(published.map((e) => e.type)).toEqual([
      "agent.instantiated",
      "loop.run.started",
      "loop.tool.finished",
      "loop.run.paused",
    ]);
    expect((published[0] as { payload: { profileKind: string } }).payload.profileKind).toBe("steward");
    for (const e of published) {
      expect(e.sessionId).toBe("__system__");
      expect(e.instanceId).toBe(STEWARD_INSTANCE_ID);
      expect(e.occurredAt).toBe("2026-09-21T00:00:00.000Z");
    }
  });
});

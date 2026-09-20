import { describe, expect, test } from "bun:test";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardHistoryRecord } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import type { LoopEvent } from "../../src/domain/loop";
import { stewardLoopTraceBridge, STEWARD_INSTANCE_ID } from "../../src/infrastructure/assembly/stewardLoopTraceBridge";
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
 * 3. 事件出口（emitLoopEvent）：里程碑子集发射 + 流式中间态排除；
 * 4. stewardLoopTraceBridge：LoopEvent → DomainEvent（instanceId=steward、
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

describe("abort-and-drain：steward.ask 单飞门控（L0 子集）", () => {
  test("streaming 中新 ask 到达 → abort 旧轮 + drain + 开新轮；KV 顺序 = […旧轮收尾, user2]（写入顺序不变量）", async () => {
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
        return { kind: "text", text: "答" };
      },
    };
    const config = fakeConfig({ "steward.enabled": "1" });
    const svc = new StewardService({ ...baseDeps({ config }), llm });
    const first = svc.ask("第一问");
    await new Promise((r) => setTimeout(r, 5)); // 首问进入 streaming（挂起中）
    const second = svc.ask("第二问");
    resolveGate!(); // 释放（若门控缺位会双跑交错——drain 门控保证第二问等首问收口）
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe("error"); // 被取代收口
    if (r1.status === "error") expect(r1.reason).toContain("已被新请求取代");
    expect(r2.status).toBe("answer");
    if (r2.status !== "answer") throw new Error("r2 应为 answer");
    expect(r2.text).toBe("答");
    // KV 顺序不变量：旧轮收尾（无 partial 入账——L0 无清洗器）后新 user 入账；
    // 新轮直答完成（第二问 run 正常收口）
    const history = await svc.getHistory();
    expect(history.filter((r: StewardHistoryRecord) => r.kind === "user").map((r: { text: string }) => r.text)).toEqual([
      "第一问",
      "第二问",
    ]);
    expect(seenSignals.length).toBeGreaterThanOrEqual(1);
    expect(seenSignals[0]!.aborted).toBe(true);
  });

  test("idle 态连续 ask：零 abort 干扰（串行直答）", async () => {
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async () => ({ kind: "text", text: "ok" }),
    };
    const svc = new StewardService({ ...baseDeps(), llm });
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
          return { kind: "toolCall", id: "c1", name: "propose_send", args: { agentId: "agent-1", message: "快一点" } };
        }
        void signal;
        return { kind: "text", text: "好的" };
      },
    };
    const svc = new StewardService({ ...baseDeps(), llm });
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
          return { kind: "toolCall", id: "c1", name: "propose_send", args: { agentId: "agent-1", message: "快一点" } };
        }
        return { kind: "text", text: "好的" };
      },
    };
  }

  test("propose_send → run_paused 事件 → confirm_required 回执 → confirm → run_resumed + toolResult 回灌 KV + 单次消费", async () => {
    const events: LoopEvent[] = [];
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
      emitLoopEvent: (e) => events.push(e),
    });
    const r1 = await svc.ask("递话");
    expect(r1.status).toBe("confirm_required");
    if (r1.status !== "confirm_required") throw new Error("应 confirm_required");
    expect(r1.agentId).toBe("agent-1");
    expect(r1.message).toBe("快一点");
    // run_paused 事件（toolName + pauseToken 携带）
    const paused = events.find((e) => e.type === "loop.run.paused") as { toolName: string; pauseToken: string } | undefined;
    expect(paused?.toolName).toBe("propose_send");
    expect(paused?.pauseToken).toContain("pause-");
    // KV：assistant toolCall 已入账、无 toolResult（挂起待确认）
    const mid = await svc.getHistory();
    expect(mid.some((r) => r.kind === "assistant" && r.toolCall?.id === "c1")).toBe(true);
    expect(mid.some((r) => r.kind === "toolResult")).toBe(false);
    // confirm → 执行 + 回灌 + 单次消费
    const confirmed = await svc.confirm(r1.actionId);
    expect(confirmed.status).toBe("ok");
    if (confirmed.status !== "ok") throw new Error("应 ok");
    expect(confirmed.agentId).toBe("agent-1");
    expect(sendCalls).toEqual(["agent-1:快一点"]);
    const again = await svc.confirm(r1.actionId);
    expect(again.status).toBe("error"); // 单次消费
    // 事件链：run.resumed(decision=resolve) + tool.finished + run.finished(resolved)
    expect((events.find((e) => e.type === "loop.run.resumed") as { decision: string } | undefined)?.decision).toBe("resolve");
    expect((events.find((e) => e.type === "loop.run.finished") as { resolution: string } | undefined)?.resolution).toBe("resolved");
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
    });
    const r = await svc.ask("递话");
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toContain("不存在或非运行中");
    const history = await svc.getHistory();
    expect(history.some((rec) => rec.kind === "assistant")).toBe(false); // 零入账
  });
});

describe("事件出口（emitLoopEvent）与追踪桥", () => {
  test("一次 ask 的里程碑子集：run.started/turn.started/message.*/tool.*/run.finished 发射；流式 delta 也发（实时通道面）", async () => {
    const events: LoopEvent[] = [];
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async (req: StewardLlmRequest, onDelta?: (c: string) => void) => {
        const last = req.messages[req.messages.length - 1];
        const lastText = last !== undefined && "text" in last ? (last as { text?: string }).text : "";
        if (lastText === "查") {
          return { kind: "toolCall", id: "c1", name: "list_tasks", args: {} };
        }
        onDelta?.("增量");
        return { kind: "text", text: "结论" };
      },
    };
    const svc = new StewardService({ ...baseDeps(), llm, emitLoopEvent: (e) => events.push(e) });
    const r = await svc.ask("查");
    expect(r.status).toBe("answer");
    const types = events.map((e) => e.type);
    expect(types).toContain("loop.run.started");
    expect(types).toContain("loop.turn.started");
    expect(types).toContain("loop.message.delta");
    expect(types).toContain("loop.tool.started");
    expect(types).toContain("loop.tool.finished");
    expect(types).toContain("loop.turn.finished");
    expect(types.at(-1)).toBe("loop.run.finished");
    expect((events.at(-1) as { resolution: string }).resolution).toBe("answer");
    // run.started 携 promptSummary（行为历史检索面）
    expect((events[0] as { promptSummary: string }).promptSummary).toBe("查");
  });

  test("stewardLoopTraceBridge：里程碑 → DomainEvent（instanceId=steward / SYSTEM_SESSION_ID）；流式中间态过滤", () => {
    const published: DomainEvent[] = [];
    const bridge = stewardLoopTraceBridge({
      publish: (e) => published.push(e),
      nowIso: () => "2026-09-21T00:00:00.000Z",
    });
    bridge({ type: "loop.run.started", runId: "r1", promptSummary: "问" });
    bridge({ type: "loop.message.delta", runId: "r1", turn: 1, delta: "x" }); // 流式中间态
    bridge({ type: "loop.message.started", runId: "r1", turn: 1 }); // 同上
    bridge({ type: "loop.tool.finished", runId: "r1", toolCallId: "c1", toolName: "list_tasks", isError: false, resultSummary: "3 条" });
    bridge({ type: "loop.run.paused", runId: "r1", pauseToken: "p1", toolCallId: "c1", toolName: "propose_send", argsSummary: "{}" });
    bridge({ type: "loop.duplex.wake", source: "vad" }); // L2 占位型（不落库）
    expect(published.map((e) => e.type)).toEqual(["loop.run.started", "loop.tool.finished", "loop.run.paused"]);
    for (const e of published) {
      expect(e.sessionId).toBe("__system__");
      expect(e.instanceId).toBe(STEWARD_INSTANCE_ID);
      expect(e.occurredAt).toBe("2026-09-21T00:00:00.000Z");
    }
  });
});

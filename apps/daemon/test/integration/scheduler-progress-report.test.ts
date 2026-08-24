import { afterEach, describe, expect, test } from "bun:test";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { AgentOrchestrationPort } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/**
 * T3-A 周期进展报告（机械 Δ，daemon 侧 per-instance 定时器）：
 * ① spawn reportIntervalMs=20 → 信封周期注入（injectClosure 同 closure 通道），
 *    格式一行机械数据：`[agent-N 进展报告 #k] 状态=running 静默=<idleMs>ms
 *    Δ工具调用=+x Δ输出=+y字符 Δ轮次=+z`；
 * ② Δ 正确性：两报告之间驱动引擎事件（tool_execution_end×2 / message_update
 *    5 字符 / turn_end）→ 下一封 Δ=+2/+5/+1；
 * ③ 终态（done/killed）清定时器——收口后信封数冻结；
 * ④ reportIntervalMs 缺省 0 / 负数 / NaN → 不报告；
 * ⑤ stop() 清全部报告定时器；
 * ⑥ 注入失败（会话 stopped 等）不影响调度——吞进 engine.error 可观测，定时器继续；
 * ⑦ 全链路透传：agent_spawn 工具 schema → AgentOrchestrationPort.spawn →
 *    SchedulerService.spawn 第五参。
 */

const SESSION_ID = "s-t3-progress";
const FIXED_NOW = "2026-08-23T00:00:00.000Z";

/** 可注射引擎事件的挂起 runner（closure 由测试驱动）。 */
class DrivenRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  readonly launched: string[] = [];
  setCallbacks(cb: InstanceRunnerCallbacks): void {
    this.callbacks = cb;
  }
  launch(instance: { instanceId: string }): void {
    this.launched.push(instance.instanceId);
  }
  /** 引擎事件到达（payload 透传 translator）。 */
  emit(instanceId: string, event: AgentEngineEvent): void {
    this.callbacks?.onInstanceEvent(instanceId, event);
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    if (this.closed.has(instanceId)) return;
    this.closed.add(instanceId);
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

interface Harness {
  scheduler: SchedulerService;
  runner: DrivenRunner;
  events: DomainEvent[];
  envelopes: string[];
  /** T11a：每次 injectClosure 调用的来源标记（进展报告="progress"，closure="closure"）。 */
  sources: ("closure" | "progress" | undefined)[];
  dispose(): void;
}

function makeHarness(options?: { injectThrows?: boolean }): Harness {
  const events: DomainEvent[] = [];
  const publisher: EventPublisherPort = { publish: (e) => void events.push(e), publishDelta: () => undefined };
  const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.now() };
  const runner = new DrivenRunner();
  const envelopes: string[] = [];
  const sources: ("closure" | "progress" | undefined)[] = [];
  let thrown = false;
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy(),
    runner,
    events: publisher,
    repository: new InMemorySessionRepository(),
    clock,
    stalledPollMs: 60_000, // 本测试不触 stalled 轮询
    injectClosure: (_agentId, message, source) => {
      if (options?.injectThrows === true && !thrown) {
        thrown = true;
        throw new Error("会话已停止（注入失败注入点）");
      }
      envelopes.push(message);
      sources.push(source);
    },
  });
  return {
    scheduler,
    runner,
    events,
    envelopes,
    sources,
    dispose: () => scheduler.stop(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等信封数到达 n（超时即返回当前值，断言侧判定）。 */
async function waitEnvelopes(envelopes: string[], n: number, timeoutMs = 500): Promise<void> {
  const t0 = Date.now();
  while (envelopes.length < n && Date.now() - t0 < timeoutMs) await sleep(5);
}

const doneOutcome = (summary = "完成"): InstanceClosureOutcome => ({
  result: "done",
  closure: { status: "done", summary, reportPath: null, findings: null, taskId: null },
});

describe("T3-A 周期进展报告（机械 Δ）", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.dispose();
    h = undefined;
  });

  test("① reportIntervalMs=20 → 信封周期注入，一行机械数据格式 + 序号递增", async () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "长任务", undefined, undefined, 20);
    expect(out.status).toBe("run");
    const agentId = (out as { agentId: string }).agentId;

    await waitEnvelopes(h.envelopes, 2);
    expect(h.envelopes.length).toBeGreaterThanOrEqual(2);
    // 无事件驱动 → 基线全零 Δ；静默时长为真实毫秒数
    expect(h.envelopes[0]).toMatch(
      new RegExp(`^\\[${agentId} 进展报告 #1\\] 状态=running 静默=\\d+ms Δ工具调用=\\+0 Δ输出=\\+0字符 Δ轮次=\\+0$`),
    );
    expect(h.envelopes[1]).toContain(`[${agentId} 进展报告 #2]`);
    // T11a：进展报告注入来源 = progress（与 closure 注入区分）
    expect(h.sources).toEqual(["progress", "progress"]);
    // 单行：信封无换行（一行机械数据，不嵌 findings/markdown）
    for (const env of h.envelopes) expect(env).not.toMatch(/[\r\n]/);
  });

  test("② Δ 正确性：两报告间 2 工具完成 + 5 字符输出 + 1 轮次 → 下一封 Δ=+2/+5/+1", async () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "长任务", undefined, undefined, 20);
    const agentId = (out as { agentId: string }).agentId;
    await waitEnvelopes(h.envelopes, 1);
    expect(h.envelopes).toHaveLength(1);

    // 同步驱动一批引擎事件（单线程不与小定时器交错——整批落入同一窗口）
    h.runner.emit(agentId, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
    h.runner.emit(agentId, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: "ok" });
    h.runner.emit(agentId, { type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} });
    h.runner.emit(agentId, { type: "tool_execution_end", toolCallId: "t2", toolName: "read", isError: false, result: "ok" });
    h.runner.emit(agentId, { type: "message_start", role: "assistant", source: "prompt" });
    h.runner.emit(agentId, { type: "message_update", delta: "abcde" });
    h.runner.emit(agentId, { type: "message_end", role: "assistant", text: "abcde" });
    h.runner.emit(agentId, { type: "turn_end", toolResultCount: 2 });

    const before = h.envelopes.length;
    await waitEnvelopes(h.envelopes, before + 1);
    const next = h.envelopes[h.envelopes.length - 1];
    expect(next).toContain("Δ工具调用=+2");
    expect(next).toContain("Δ输出=+5字符");
    expect(next).toContain("Δ轮次=+1");
  });

  test("③ 终态清定时器：done 收口后信封数冻结", async () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "长任务", undefined, undefined, 20);
    const agentId = (out as { agentId: string }).agentId;
    await waitEnvelopes(h.envelopes, 1);
    h.runner.forceClosure(agentId, doneOutcome());
    const frozen = h.envelopes.length;
    // T11a：closure 注入来源 = closure（进展报告之后收口链同通道不同源）
    expect(h.sources.at(-1)).toBe("closure");
    await sleep(70);
    expect(h.envelopes.length).toBe(frozen);
  });

  test("③b kill 收口同样清定时器", async () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "长任务", undefined, undefined, 20);
    const agentId = (out as { agentId: string }).agentId;
    await waitEnvelopes(h.envelopes, 1);
    h.scheduler.kill(agentId);
    const frozen = h.envelopes.length;
    await sleep(70);
    expect(h.envelopes.length).toBe(frozen);
  });

  test("④ 缺省 0 / 负数 / NaN → 不报告", async () => {
    h = makeHarness();
    h.scheduler.spawn(SESSION_ID, "a"); // 缺省
    h.scheduler.spawn(SESSION_ID, "b", undefined, undefined, -5); // 负数视为 0
    h.scheduler.spawn(SESSION_ID, "c", undefined, undefined, Number.NaN); // NaN 视为 0
    await sleep(70);
    expect(h.envelopes).toHaveLength(0);
  });

  test("⑤ stop() 清全部报告定时器", async () => {
    h = makeHarness();
    h.scheduler.spawn(SESSION_ID, "长任务", undefined, undefined, 20);
    await waitEnvelopes(h.envelopes, 1);
    h.scheduler.stop();
    const frozen = h.envelopes.length;
    await sleep(70);
    expect(h.envelopes.length).toBe(frozen);
  });

  test("⑤b stop() 同段清三计数 Map（reportIntervals/reportSeqs/lastReportedMetrics → size 0）", async () => {
    h = makeHarness();
    h.scheduler.spawn(SESSION_ID, "长任务", undefined, undefined, 20);
    await waitEnvelopes(h.envelopes, 1);
    // T8-M2 断言面：报告面四个私有 Map（运行时可达；与 clearProgressReporting 全清语义对齐）
    const internals = h.scheduler as unknown as {
      reportIntervals: Map<string, number>;
      reportTimers: Map<string, unknown>;
      reportSeqs: Map<string, number>;
      lastReportedMetrics: Map<string, unknown>;
    };
    // 前置：定时器建立后四面均非空
    expect(internals.reportIntervals.size).toBe(1);
    expect(internals.reportTimers.size).toBe(1);
    expect(internals.reportSeqs.size).toBe(1);
    expect(internals.lastReportedMetrics.size).toBe(1);

    h.scheduler.stop();

    expect(internals.reportTimers.size).toBe(0);
    expect(internals.reportIntervals.size).toBe(0);
    expect(internals.reportSeqs.size).toBe(0);
    expect(internals.lastReportedMetrics.size).toBe(0);
  });

  test("⑥ 注入失败吞进 engine.error 可观测，定时器继续", async () => {
    h = makeHarness({ injectThrows: true });
    const out = h.scheduler.spawn(SESSION_ID, "长任务", undefined, undefined, 20);
    const agentId = (out as { agentId: string }).agentId;
    // 第一次注入抛错 → engine.error 事件可观测；后续信封照常到达
    await waitEnvelopes(h.envelopes, 1);
    const engineErrors = h.events.filter((e) => e.type === "engine.error" && e.instanceId === agentId);
    expect(engineErrors.length).toBeGreaterThanOrEqual(1);
    expect(h.envelopes.length).toBeGreaterThanOrEqual(1);
  });

  test("⑦ 全链路透传：agent_spawn 工具 schema → port.spawn 第三参 → scheduler 第五参", async () => {
    h = makeHarness();
    const seen: { task: string; profileKind?: string; reportIntervalMs?: number }[] = [];
    const orchestration: AgentOrchestrationPort = {
      spawn: (task, profileKind, reportIntervalMs) => {
        seen.push({ task, profileKind, reportIntervalMs });
        return h!.scheduler.spawn(SESSION_ID, task, profileKind, undefined, reportIntervalMs);
      },
      send: (agentId, message) => h!.scheduler.send(agentId, message),
      status: (agentId) => h!.scheduler.status(agentId),
      kill: (agentId) => h!.scheduler.kill(agentId),
      inspect: (agentId) => h!.scheduler.inspect(agentId),
    };
    const executor = new CoreToolExecutor({ cwd: "/tmp", orchestration });
    const result = await executor.execute({
      toolCallId: "tc-1",
      toolName: "agent_spawn",
      args: { task: "长任务", reportIntervalMs: 20 },
      signal: undefined,
    });
    expect(result.isError).not.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reportIntervalMs).toBe(20); // port 第三参透传
    // scheduler 侧生效：定时器真实建立（信封到达即证第五参落地）
    await waitEnvelopes(h.envelopes, 1);
    expect(h.envelopes.length).toBeGreaterThanOrEqual(1);
  });
});

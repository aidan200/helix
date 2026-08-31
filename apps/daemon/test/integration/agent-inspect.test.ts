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
 * T3-B agent_inspect 工具（核实死循环：进展报告连续零增量时 MainAgent 核实
 * 真实执行轨迹，确无进展可 kill 重派——系统只送达信息，永不自动终止）：
 * ① 轨迹环缓冲：per-instance 最近 20 条（tool_execution_end → {kind:"tool",name}
 *    / message_end(assistant) 非空文本 → {kind:"assistant",text 尾部 200 字}），
 *    溢出逐最旧（保留最近 20 条，时间序）；
 * ② inspect 返回形状：{instanceId, state, task, startedAt, lastEventAt, idleMs,
 *    toolCalls 累计, trace[...]}；idleMs = now − lastEventAt；
 * ③ 不存在实例 → null（与 status 空数组同族的空值语义）；
 * ④ 工具注册：agent_inspect 经 CoreToolExecutor 装配/执行（与 agent_status 同构）；
 * ⑤ 终态清理：onClosureCleanup 清空轨迹（迟到事件不再残留轨迹）。
 */

const SESSION_ID = "s-t3-inspect";
const FIXED_NOW = "2026-08-23T00:00:00.000Z";
const BASE_MS = 1_700_000_000_000;

class DrivenRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  setCallbacks(cb: InstanceRunnerCallbacks): void {
    this.callbacks = cb;
  }
  launch(): void {}
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
  executor: CoreToolExecutor;
  /** 可控时钟前进（idleMs 确定性断言）。 */
  advance(ms: number): void;
  dispose(): void;
}

function makeHarness(): Harness {
  const publisher: EventPublisherPort = { publish: () => undefined, publishDelta: () => undefined };
  let nowMs = BASE_MS;
  const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => nowMs };
  const runner = new DrivenRunner();
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy(),
    runner,
    events: publisher,
    repository: new InMemorySessionRepository(),
    clock,
    stalledPollMs: 60_000,
  });
  const orchestration: AgentOrchestrationPort = {
    spawn: (task, profileKind, reportIntervalMs) =>
      scheduler.spawn(SESSION_ID, task, profileKind, undefined, reportIntervalMs),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
    inspect: (agentId) => scheduler.inspect(agentId),
      park: (agentId) => scheduler.park(agentId),
      resume: (agentId) => scheduler.resume(agentId),
  };
  const executor = new CoreToolExecutor({ cwd: "/tmp", orchestration });
  return {
    scheduler,
    runner,
    executor,
    advance: (ms) => {
      nowMs += ms;
    },
    dispose: () => scheduler.stop(),
  };
}

/** 一次工具调用完成事件对。 */
function emitTool(h: Harness, agentId: string, name: string): void {
  h.runner.emit(agentId, { type: "tool_execution_start", toolCallId: `tc-${name}`, toolName: name, args: {} });
  h.runner.emit(agentId, { type: "tool_execution_end", toolCallId: `tc-${name}`, toolName: name, isError: false, result: "ok" });
}

/** 一条 assistant 消息完成（非空文本，无流式分片）。 */
function emitAssistant(h: Harness, agentId: string, text: string): void {
  h.runner.emit(agentId, { type: "message_start", role: "assistant", source: "prompt" });
  h.runner.emit(agentId, { type: "message_end", role: "assistant", text });
}

describe("T3-B agent_inspect（死循环核实）", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.dispose();
    h = undefined;
  });

  test("② inspect 返回形状：状态/任务/起止/idleMs/累计工具数/轨迹", () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "死循环嫌疑任务");
    const agentId = (out as { agentId: string }).agentId;

    emitTool(h, agentId, "bash");
    h.advance(5_000); // 最后事件后静默 5s

    const view = h.scheduler.inspect(agentId);
    expect(view).not.toBeNull();
    expect(view!.instanceId).toBe(agentId);
    expect(view!.state).toBe("running");
    expect(view!.task).toBe("死循环嫌疑任务");
    expect(view!.startedAt).toBe(FIXED_NOW);
    expect(view!.lastEventAt).toBe(BASE_MS); // emit 时刻（advance 前）
    expect(view!.idleMs).toBe(5_000);
    expect(view!.toolCalls).toBe(1);
    expect(view!.trace).toHaveLength(1);
    expect(view!.trace[0]).toEqual({ t: FIXED_NOW, kind: "tool", name: "bash" });
  });

  test("③ 不存在实例 → null（空值语义与 status 空数组同族）", () => {
    h = makeHarness();
    expect(h.scheduler.inspect("agent-999")).toBeNull();
  });

  test("① 环缓冲：25 条事件 → 保留最近 20 条（最旧 5 条逐出，时间序）", () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "长任务");
    const agentId = (out as { agentId: string }).agentId;

    for (let i = 1; i <= 12; i++) emitTool(h, agentId, `tool-${i}`);
    for (let i = 1; i <= 13; i++) emitAssistant(h, agentId, `msg-${i}`);

    const view = h.scheduler.inspect(agentId)!;
    expect(view.trace).toHaveLength(20);
    // 最旧 5 条（tool-1..tool-5）逐出；窗口 = tool-6..tool-12 + msg-1..msg-13（到达序）
    expect(view.trace[0]).toEqual({ t: FIXED_NOW, kind: "tool", name: "tool-6" });
    expect(view.trace[6]).toEqual({ t: FIXED_NOW, kind: "tool", name: "tool-12" });
    expect(view.trace[7]).toEqual({ t: FIXED_NOW, kind: "assistant", text: "msg-1" });
    expect(view.trace[19]).toEqual({ t: FIXED_NOW, kind: "assistant", text: "msg-13" });
    expect(view.toolCalls).toBe(12); // 累计不受环缓冲窗口影响
  });

  test("①b assistant 轨迹项只留文本尾部 200 字", () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "长任务");
    const agentId = (out as { agentId: string }).agentId;
    const long = "x".repeat(250) + "TAIL";
    emitAssistant(h, agentId, long);
    const view = h.scheduler.inspect(agentId)!;
    expect(view.trace).toHaveLength(1);
    const item = view.trace[0]!;
    expect(item.kind).toBe("assistant");
    expect(item.text).toHaveLength(200);
    expect(item.text!.endsWith("TAIL")).toBe(true);
  });

  test("⑤ 终态清理：onClosureCleanup 清空轨迹与计数观测面", () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "长任务");
    const agentId = (out as { agentId: string }).agentId;
    emitTool(h, agentId, "bash");
    h.runner.forceClosure(agentId, {
      result: "done",
      closure: { status: "done", summary: "完成", reportPath: null, findings: null, taskId: null },
    });
    const view = h.scheduler.inspect(agentId)!;
    expect(view.state).toBe("done");
    expect(view.trace).toHaveLength(0);
    expect(view.toolCalls).toBe(0); // 计数器随清理序列清空
    expect(view.lastEventAt).toBeNull(); // lastEventAt 不再观测（终态）
    expect(view.idleMs).toBeNull();
  });

  test("④ 工具注册：agent_inspect 装配进 resolveTools + 执行返回 inspect JSON", async () => {
    h = makeHarness();
    const out = h.scheduler.spawn(SESSION_ID, "死循环嫌疑任务");
    const agentId = (out as { agentId: string }).agentId;
    emitTool(h, agentId, "bash");

    // resolveTools 装配面（MainAgent profile 声明名可解析）
    const resolved = h.executor.resolveTools(["agent_inspect"]);
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as { name: string }).name).toBe("agent_inspect");

    // 执行面：JSON 即 port.inspect 同形状
    const result = await h.executor.execute({
      toolCallId: "tc-1",
      toolName: "agent_inspect",
      args: { agentId },
      signal: undefined,
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.instanceId).toBe(agentId);
    expect(parsed.state).toBe("running");
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.trace).toHaveLength(1);

    // 不存在实例 → null JSON
    const missing = await h.executor.execute({
      toolCallId: "tc-2",
      toolName: "agent_inspect",
      args: { agentId: "agent-999" },
      signal: undefined,
    });
    expect(JSON.parse(missing.content)).toBeNull();
  });
});

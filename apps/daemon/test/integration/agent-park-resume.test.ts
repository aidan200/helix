import { afterEach, describe, expect, test } from "bun:test";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { PARK_INSTRUCTION_TEXT, RESUME_INSTRUCTION_TEXT } from "../../src/application/services/scheduler/parkProtocol";
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
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SubAgentKgWriterProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import { OrchestratorProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/**
 * ⑤ 链 C：chat 域挂起/恢复工具面（agent_park / agent_resume，P1 裁决
 * 专用工具仅 Main）。工具 → AgentOrchestrationPort → SchedulerService.
 * park/resume 透传（reason="user"）；挂起原语/协议/预算语义的调度器级
 * 单点验证在 scheduler-park.test（T5），本文件只验工具面：
 *
 * - 注册面：仅 MainSessionProfile 声明双工具（SubAgent/Orchestrator/
 *   kg-writer 均不声明——专用工具不进子进程/编排会话生效集）；
 * - 全链：agent_park → {parked:true} + 协议指令经 steer 通道注入 →
 *   parked 上行确认 → agent_status 见 parked（reason=user）→ agent_resume
 *   → {resumed:true} + RESUME 指令注入 → running；
 * - 错误径（族内既有形态：JSON outcome 携可读中文 error——与 agent_send
 *   的 {delivered:false, detail} 同构）：实例不存在 / 终态 / 未挂起拒绝。
 */

const SESSION_ID = "s-chainc-park";
const FIXED_NOW = "2026-08-31T00:00:00.000Z";

/** 挂起语义 runner（T5 同款替身：send 记录 + parked/closure 由测试显式驱动）。 */
class ParkToolRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  readonly sent: { instanceId: string; text: string }[] = [];
  readonly launched: string[] = [];
  setCallbacks(cb: InstanceRunnerCallbacks): void {
    this.callbacks = cb;
  }
  launch(instance: { instanceId: string }): void {
    this.launched.push(instance.instanceId);
  }
  send(instanceId: string, text: string): void {
    this.sent.push({ instanceId, text });
  }
  reportParked(instanceId: string, summary: { progress: string; next: string }): void {
    this.callbacks?.onInstanceParked?.(instanceId, summary);
  }
  reportClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    if (this.closed.has(instanceId)) return;
    this.closed.add(instanceId);
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

interface Harness {
  scheduler: SchedulerService;
  runner: ParkToolRunner;
  executor: CoreToolExecutor;
  dispose(): void;
}

function makeHarness(): Harness {
  const events: DomainEvent[] = [];
  const publisher: EventPublisherPort = { publish: (e) => void events.push(e), publishDelta: () => undefined };
  const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.parse(FIXED_NOW) };
  const runner = new ParkToolRunner();
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
  return { scheduler, runner, executor, dispose: () => scheduler.stop() };
}

let tcSeq = 0;
function runTool(h: Harness, toolName: string, args: unknown) {
  return h.executor.execute({ toolCallId: `tc-${++tcSeq}`, toolName, args, signal: undefined });
}

const DONE_CLOSURE = (summary: string) => ({
  status: "done" as const,
  summary,
  reportPath: null,
  findings: null,
  taskId: null,
});

/** spawn 一个实例并驱动到 parked（park 工具 + 子进程 parked 上行确认）。 */
async function spawnParked(h: Harness, task = "链 C 挂起任务"): Promise<string> {
  const spawned = JSON.parse((await runTool(h, "agent_spawn", { task })).content) as { agentId: string };
  const park = JSON.parse((await runTool(h, "agent_park", { instanceId: spawned.agentId })).content);
  if (!park.parked) throw new Error(`park 被拒：${park.error}`);
  h.runner.reportParked(spawned.agentId, { progress: "做到一半", next: "继续实现" });
  return spawned.agentId;
}

let current: Harness | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("① 注册面：agent_park/agent_resume 仅 MainSessionProfile 生效集（P1）", () => {
  test("Main 声明双工具；SubAgent/Orchestrator/kg-writer 均不声明", () => {
    expect(MainSessionProfile.tools).toContain("agent_park");
    expect(MainSessionProfile.tools).toContain("agent_resume");
    expect(SubAgentProfile.tools).not.toContain("agent_park");
    expect(SubAgentProfile.tools).not.toContain("agent_resume");
    expect(SubAgentKgWriterProfile.tools).not.toContain("agent_park");
    expect(SubAgentKgWriterProfile.tools).not.toContain("agent_resume");
    expect(OrchestratorProfile.tools).not.toContain("agent_park");
    expect(OrchestratorProfile.tools).not.toContain("agent_resume");
  });

  test("装配面：resolveTools 双名可解析（orchestration 注入即注册）", () => {
    const h = (current = makeHarness());
    const resolved = h.executor.resolveTools(["agent_park", "agent_resume"]);
    expect(resolved.map((t) => (t as { name: string }).name)).toEqual(["agent_park", "agent_resume"]);
  });
});

describe("② 工具全链：agent_park → parked → agent_status 可见 → agent_resume → running", () => {
  test("四段闭环：挂起受理+协议指令注入 → 上行确认 parked（reason=user）→ 状态可见 → 恢复受理+RESUME 注入", async () => {
    const h = (current = makeHarness());
    const spawned = JSON.parse((await runTool(h, "agent_spawn", { task: "用户要求暂停的工作" })).content) as {
      agentId: string;
    };
    const agentId = spawned.agentId;

    // park 工具：秒回受理（不等待子进程确认——协议=完成当前工具调用后挂起）
    const park = await runTool(h, "agent_park", { instanceId: agentId });
    expect(park.isError).not.toBe(true);
    expect(JSON.parse(park.content)).toEqual({ parked: true });
    // 协议指令经既有 steer 通道注入（文本 = 协议单点常量）
    expect(h.runner.sent.at(-1)).toEqual({ instanceId: agentId, text: PARK_INSTRUCTION_TEXT });
    expect(h.scheduler.instance(agentId)?.state).toBe("running"); // 确认前仍 running

    // 子进程 PARK 确认上行 → parked（chat 域 reason=user）
    h.runner.reportParked(agentId, { progress: "调研完成", next: "写实现" });
    expect(h.scheduler.instance(agentId)?.state).toBe("parked");

    // agent_status 可见挂起中实例（恢复入口的前置读面）
    const status = JSON.parse((await runTool(h, "agent_status", { agentId })).content);
    expect(status[0]).toMatchObject({ agentId, state: "parked", parkedReason: "user" });

    // resume 工具：同实例同会话从断点继续
    const resume = await runTool(h, "agent_resume", { instanceId: agentId });
    expect(resume.isError).not.toBe(true);
    expect(JSON.parse(resume.content)).toEqual({ resumed: true, queued: false });
    expect(h.scheduler.instance(agentId)?.state).toBe("running");
    expect(h.runner.sent.at(-1)).toEqual({ instanceId: agentId, text: RESUME_INSTRUCTION_TEXT });
    // 恢复后观测字段清除（status 不再携带 parkedReason）
    const status2 = JSON.parse((await runTool(h, "agent_status", { agentId })).content);
    expect(status2[0]).toMatchObject({ agentId, state: "running" });
    expect(status2[0].parkedReason).toBeUndefined();
  });

  test("幂等：parked 后重复 agent_park 为 no-op；重复 agent_resume 未挂起被拒", async () => {
    const h = (current = makeHarness());
    const agentId = await spawnParked(h);

    const again = await runTool(h, "agent_park", { instanceId: agentId });
    expect(JSON.parse(again.content)).toEqual({ parked: true }); // 已挂起 no-op
    expect(h.runner.sent.filter((s) => s.text === PARK_INSTRUCTION_TEXT)).toHaveLength(1); // 不重发

    const resume = await runTool(h, "agent_resume", { instanceId: agentId });
    expect(JSON.parse(resume.content)).toEqual({ resumed: true, queued: false });
    const resumeAgain = JSON.parse((await runTool(h, "agent_resume", { instanceId: agentId })).content);
    expect(resumeAgain.resumed).toBe(false); // running 未挂起，无需 resume
  });
});

describe("③ 错误径：族内形态（JSON outcome 携可读中文 error）", () => {
  test("实例不存在：park/resume 均拒绝且附原因", async () => {
    const h = (current = makeHarness());
    const park = JSON.parse((await runTool(h, "agent_park", { instanceId: "agent-不存在" })).content);
    expect(park.parked).toBe(false);
    expect(park.error).toContain("不存在");
    const resume = JSON.parse((await runTool(h, "agent_resume", { instanceId: "agent-不存在" })).content);
    expect(resume.resumed).toBe(false);
    expect(resume.error).toContain("不存在");
  });

  test("终态实例：park 作废（终态赢）+ 终态不可复活", async () => {
    const h = (current = makeHarness());
    const agentId = await spawnParked(h);
    // parked 期间自然收口（防御位/竞态终态赢）：终态后 park/resume 均拒
    h.runner.reportClosure(agentId, { result: "done", closure: DONE_CLOSURE("挂起后自然完成") });
    expect(h.scheduler.instance(agentId)?.state).toBe("done");

    const park = JSON.parse((await runTool(h, "agent_park", { instanceId: agentId })).content);
    expect(park.parked).toBe(false);
    expect(park.error).toContain("已终态");
    const resume = JSON.parse((await runTool(h, "agent_resume", { instanceId: agentId })).content);
    expect(resume.resumed).toBe(false);
    expect(resume.error).toContain("终态");
  });

  test("未挂起实例：resume 拒绝（无需 resume）", async () => {
    const h = (current = makeHarness());
    const spawned = JSON.parse((await runTool(h, "agent_spawn", { task: "正常运行中" })).content) as {
      agentId: string;
    };
    const resume = JSON.parse((await runTool(h, "agent_resume", { instanceId: spawned.agentId })).content);
    expect(resume.resumed).toBe(false);
    expect(resume.error).toContain("未挂起");
  });
});

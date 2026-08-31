import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { InstanceRunner, InstanceRunnerCallbacks, InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import type { AgentOrchestrationPort } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/**
 * T2.3 编排三工具 integration（test-design §2.1 F1.5 + §4.1）：
 * ① agent_spawn 秒回（<100ms，不等 closure——FakeAgentEngine 量级）；
 * ② agent_send 经 SchedulerService.send → transport → 子进程 stdin →
 *    Agent.steer()（与 T2.2 子进程 integration 衔接，真 Bun.spawn）；
 * ③ agent_status 无参全量/有参单实例（状态/位次/摘要）；
 * ④ 队列满 agent_spawn 报错回 LLM（T2.1 reject 通路汇流，isError）。
 */

const SESSION_ID = "s-t23-tools";
const FIXED_NOW = "2026-08-16T00:00:00.000Z";

/** 离线 fake 模型（同 T2.2 子进程测试口径，无网络）。 */
const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const closureBlock = (summary: string, status: "done" | "failed" = "done") =>
  `<<<CLOSURE\n${JSON.stringify({ status, summary, reportPath: null, findings: [], taskId: null })}\nCLOSURE>>>`;

/** 挂起 runner（closure 由测试驱动；秒回断言的“永不收口”侧）。 */
class HangRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  readonly launched: { instanceId: string; task: string }[] = [];
  readonly sends: { instanceId: string; text: string }[] = [];
  readonly kills: string[] = [];
  setCallbacks(cb: InstanceRunnerCallbacks): void {
    this.callbacks = cb;
  }
  launch(instance: { instanceId: string }, task: string): void {
    this.launched.push({ instanceId: instance.instanceId, task });
  }
  send(instanceId: string, text: string): void {
    this.sends.push({ instanceId, text });
  }
  kill(instanceId: string): void {
    this.kills.push(instanceId);
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    if (this.closed.has(instanceId)) return;
    this.closed.add(instanceId);
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

interface ToolHarness {
  executor: CoreToolExecutor;
  scheduler: SchedulerService;
  runner: HangRunner;
  events: DomainEvent[];
}

function makeToolHarness(policy?: SchedulingPolicy): ToolHarness {
  const events: DomainEvent[] = [];
  const publisher: EventPublisherPort = { publish: (e) => void events.push(e), publishDelta: () => undefined };
  const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.parse(FIXED_NOW) };
  const runner = new HangRunner();
  const scheduler = new SchedulerService({
    policy: policy ?? new SchedulingPolicy(),
    runner,
    events: publisher,
    repository: new InMemorySessionRepository(),
    clock,
  });
  // T2.2 多会话：spawn 携带会话归属（工具经会话绑定门面回口调度器）
  const orchestration: AgentOrchestrationPort = {
    spawn: (task, profileKind, reportIntervalMs) => scheduler.spawn(SESSION_ID, task, profileKind, undefined, reportIntervalMs),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
    inspect: (agentId) => scheduler.inspect(agentId),
    park: (agentId) => scheduler.park(agentId),
    resume: (agentId) => scheduler.resume(agentId),
  };
  const executor = new CoreToolExecutor({ cwd: tmpdir(), orchestration });
  return { executor, scheduler, runner, events };
}

/** 工具执行便利（toolCallId 自增）。 */
let tcSeq = 0;
function runTool(h: ToolHarness, toolName: string, args: unknown) {
  return h.executor.execute({ toolCallId: `tc-${++tcSeq}`, toolName, args, signal: undefined });
}

function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`until 超时：${label}（${timeoutMs}ms）`));
      }
    }, 5);
  });
}

describe("① agent_spawn 秒回（不挂起 turn，不等 closure）", () => {
  test("工具执行 <100ms 返回 {agentId, spawned}；实例已 launch、无终态事件", async () => {
    const h = makeToolHarness();
    const t0 = Date.now();
    const result = await runTool(h, "agent_spawn", { task: "长调研任务" });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(100); // 秒回（FakeAgentEngine 量级；closure 永不到达）
    expect(result.isError).toBe(false);
    const spawned = JSON.parse(result.content) as { agentId: string; spawned: boolean; queued: boolean };
    expect(spawned.agentId).toMatch(/^agent-[0-9a-f]+$/); // T10a：agent-<唯一串>
    expect(spawned).toMatchObject({ spawned: true, queued: false });
    const agentId = spawned.agentId;
    expect(h.runner.launched).toEqual([{ instanceId: agentId, task: "长调研任务" }]);
    // 不等收口：无任何终态事件，实例 running
    expect(h.events.filter((e) => /agent\.(completed|failed|killed)/.test(e.type))).toEqual([]);
    expect(h.scheduler.instance(agentId)?.state).toBe("running");
  });

  test("入队路径返回 {agentId, spawned, queued:true, position}", async () => {
    const h = makeToolHarness();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) ids.push(JSON.parse((await runTool(h, "agent_spawn", { task: `t${i}` })).content).agentId);
    const result = await runTool(h, "agent_spawn", { task: "第 4 个" });
    const fourth = JSON.parse(result.content) as { agentId: string; spawned: boolean; queued: boolean; position: number };
    expect(fourth.agentId).toMatch(/^agent-[0-9a-f]+$/); // T10a：agent-<唯一串>
    expect(new Set([...ids, fourth.agentId]).size).toBe(4); // 连续 spawn 互异
    expect(fourth).toMatchObject({ spawned: true, queued: true, position: 1 });
  });
});

describe("③ agent_status 两形态（状态/位次/摘要）", () => {
  test("无参全量 + 有参单实例；终态后携带 summary", async () => {
    const h = makeToolHarness();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) ids.push(JSON.parse((await runTool(h, "agent_spawn", { task: `任务${i}` })).content).agentId);
    ids.push(JSON.parse((await runTool(h, "agent_spawn", { task: "排队任务" })).content).agentId); // queued pos 1

    const all = JSON.parse((await runTool(h, "agent_status", {})).content);
    expect(all).toHaveLength(4);
    expect(all[0]).toMatchObject({ agentId: ids[0], state: "running", task: "任务1", profileKind: "subagent-worker" });
    expect(all[3]).toMatchObject({ agentId: ids[3], state: "queued", position: 1 });
    expect(all[0].summary).toBeUndefined(); // 运行中无摘要

    const one = JSON.parse((await runTool(h, "agent_status", { agentId: ids[3] })).content);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ agentId: ids[3], state: "queued", position: 1 });

    // 终态后：单实例查询携带 closure.summary
    h.runner.forceClosure(ids[0]!, {
      result: "done",
      closure: { status: "done", summary: "任务1 完成", reportPath: null, findings: null, taskId: null },
    });
    const done = JSON.parse((await runTool(h, "agent_status", { agentId: ids[0] })).content);
    expect(done[0]).toMatchObject({ agentId: ids[0], state: "done", summary: "任务1 完成" });

    // 未知实例 → 空数组（工具结果可读，非报错）
    expect(JSON.parse((await runTool(h, "agent_status", { agentId: "agent-999" })).content)).toEqual([]);
  });
});

describe("④ 队列满 agent_spawn 报错回 LLM（reject 通路汇流）", () => {
  test("预算耗尽 → isError + 调度器中文错误说明；daemon 不崩（status 仍可用）", async () => {
    const h = makeToolHarness(new SchedulingPolicy({ maxConcurrent: 1, maxQueued: 0 }));
    const first = await runTool(h, "agent_spawn", { task: "占住预算" });
    const firstId = JSON.parse(first.content).agentId as string;
    expect(firstId).toMatch(/^agent-[0-9a-f]+$/); // T10a：agent-<唯一串>

    const rejected = await runTool(h, "agent_spawn", { task: "第二个" });
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain("maxConcurrent");
    expect(rejected.content).toMatch(/[\u4e00-\u9fa5]/);

    // 不崩：status 可查、spawn 的实例不受影响
    expect(JSON.parse((await runTool(h, "agent_status", {})).content)).toHaveLength(1);
    expect(h.scheduler.instance(firstId)?.state).toBe("running");
  });
});

describe("② agent_send 经 SchedulerService.send → 子进程 stdin → Agent.steer()（真 Bun.spawn）", () => {
  test("port.send delivered → 子进程 drain 注入为新 turn → closure 回传 → agent.completed", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t23-send-"));
    const scriptPath = path.join(home, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        replies: [
          "第一答：" + "分".repeat(200), // ~1s 流式窗口供注入
          `已按注入调整完成。${closureBlock("send 转投链路验证完成", "done")}`,
        ],
        chunkDelayMs: 5,
      }),
    );
    const writeQueue = new WriteQueue(path.join(home, "helix.db"));
    const events: DomainEvent[] = [];
    const publisher: EventPublisherPort = { publish: (e) => void events.push(e), publishDelta: () => undefined };
    const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.parse(FIXED_NOW) };
    const lines: { instanceId: string; line: ChildOutboundLine }[] = [];
    const launcher = new SubagentLauncher({
      profile: SubAgentProfile,
      model: fakeModel,
      apiKeys: { fake: "explicit-key" },
      toolCwd: home,
      fakeEngineScript: scriptPath,
      onLine: (instanceId, line) => lines.push({ instanceId, line }),
    });
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy(),
      runner: launcher,
      events: publisher,
      repository: new SqliteSessionRepository(writeQueue),
      clock,
      });
    // T3-A：spawn 为 sessionId 前置形态——经会话绑定门面适配 Port（结构性不再可直赋）
    const sessionOrchestration: AgentOrchestrationPort = {
      spawn: (task, profileKind, reportIntervalMs) => scheduler.spawn(SESSION_ID, task, profileKind, undefined, reportIntervalMs),
      send: (agentId, message) => scheduler.send(agentId, message),
      status: (agentId) => scheduler.status(agentId),
      kill: (agentId) => scheduler.kill(agentId),
      inspect: (agentId) => scheduler.inspect(agentId),
      park: (agentId) => scheduler.park(agentId),
      resume: (agentId) => scheduler.resume(agentId),
    };
    const executor = new CoreToolExecutor({ cwd: home, orchestration: sessionOrchestration });
    try {
      // spawn（经工具链路：agent_spawn → port → scheduler → 真子进程）
      const spawnResult = await executor.execute({
        toolCallId: "tc-send-1",
        toolName: "agent_spawn",
        args: { task: "send 链路验证任务" },
        signal: undefined,
      });
      const agentId = JSON.parse(spawnResult.content).agentId as string;
      expect(agentId).toMatch(/^agent-[0-9a-f]+$/); // T10a：agent-<唯一串>

      // 等子进程流式开始（stdin send 需在进程启动后）
      await until(
        () => lines.some((l) => l.line.type === "event" && l.line.event.type === "message_update"),
        8000,
        "子进程流式开始",
      );

      // agent_send 工具 → port.send → runner.send → stdin send 行
      const sendResult = await executor.execute({
        toolCallId: "tc-send-2",
        toolName: "agent_send",
        args: { agentId, message: "补充指示：请直接收口" },
        signal: undefined,
      });
      expect(JSON.parse(sendResult.content)).toEqual({ delivered: true, detail: expect.stringContaining(agentId) });

      // 子进程 Agent.steer() 消费注入：source=steer-drain 的新 turn
      await until(
        () =>
          lines.some(
            (l) =>
              l.line.type === "event" &&
              l.line.event.type === "message_start" &&
              (l.line.event as { source?: string }).source === "steer-drain",
          ),
        8000,
        "注入经 stdin→Agent.steer() drain 为新 turn",
      );

      // closure 回传 → agent.completed（经调度收口链）
      await until(() => events.some((e) => e.type === "agent.completed"), 15000, "agent.completed");
      const completed = events.find((e) => e.type === "agent.completed")!;
      expect((completed.payload as { closure: { summary: string } }).closure.summary).toBe("send 转投链路验证完成");

      // 不可注入形态：终态后 send → delivered=false + 中文原因（工具结果回 LLM）
      const lateSend = await executor.execute({
        toolCallId: "tc-send-3",
        toolName: "agent_send",
        args: { agentId, message: "迟到消息" },
        signal: undefined,
      });
      expect(JSON.parse(lateSend.content)).toEqual({
        delivered: false,
        detail: expect.stringContaining("已终态"),
      });
      const unknownSend = await executor.execute({
        toolCallId: "tc-send-4",
        toolName: "agent_send",
        args: { agentId: "agent-404", message: "未知实例" },
        signal: undefined,
      });
      expect(JSON.parse(unknownSend.content)).toEqual({ delivered: false, detail: expect.stringContaining("不存在") });
    } finally {
      scheduler.stop();
      await launcher.dispose();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});

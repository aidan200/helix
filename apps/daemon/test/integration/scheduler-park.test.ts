import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { PARK_INSTRUCTION_TEXT, RESUME_INSTRUCTION_TEXT } from "../../src/application/services/scheduler/parkProtocol";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../src/application/services/InstanceRunner";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";

/**
 * ⑤ park/resume 批 T5：调度器挂起/恢复原语 integration（替身 runner——
 * send 通道记录 + 测试显式驱动 parked 上行/收口，状态机与预算语义单点验证）。
 *
 * - 状态机：park（指令经 steer 通道注入）→ parked 上行确认 → parked 非终态
 *   （无 closure/无收口链/不注入主线）→ resume → running；
 * - 预算释放（P3）：parked 不占 maxConcurrent；resume 等价新派发——预算满则
 *   与重派同队排队，空位释放后恢复（**不重新 launch**——执行载体还活着）；
 * - 挂起期 steer 暂存（send 直达子进程 steer 队列，resume 时送达）；
 * - 竞态：park 与自然收口竞态 = 终态赢（park 迟到作废幂等）；parked 期间
 *   kill 正常（→failed 终态）；
 * - 观测面：agent_status parked 状态 + 原因 + parkedAt；agent.parked/resumed
 *   领域事件；agent_lifecycle parked/running 行。
 */

const SESSION_ID = "s-park";
const FIXED_NOW_MS = 1_800_000_000_000;

/** 挂起语义 runner：send 记录 + parked/closure 由测试显式驱动。 */
class ParkRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly sent: { instanceId: string; text: string }[] = [];
  readonly launched: string[] = [];
  readonly killed: string[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
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
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

interface Harness {
  scheduler: SchedulerService;
  runner: ParkRunner;
  events: DomainEvent[];
  writeQueue: WriteQueue;
  dispose(): Promise<void>;
}

function makeHarness(policy?: SchedulingPolicy, clock?: ClockPort): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "helix-park-sched-"));
  const writeQueue = new WriteQueue(path.join(home, "helix.db"));
  const repository = new SqliteSessionRepository(writeQueue);
  const events: DomainEvent[] = [];
  const publisher: EventPublisherPort = {
    publish: (e) => {
      events.push(e);
      void writeQueue.appendEvent(e);
    },
    publishDelta: () => undefined,
  };
  const fixedClock: ClockPort = {
    now: () => new Date(FIXED_NOW_MS).toISOString(),
    nowMs: () => FIXED_NOW_MS,
  };
  const runner = new ParkRunner();
  const scheduler = new SchedulerService({
    policy: policy ?? new SchedulingPolicy({ maxConcurrent: 3 }),
    runner,
    events: publisher,
    repository,
    clock: clock ?? fixedClock,
    stalledPollMs: 60_000, // 挂起语义面不涉 stalled：长轮询避免测试窗口噪音
  });
  return {
    scheduler,
    runner,
    events,
    writeQueue,
    dispose: async () => {
      scheduler.stop();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function spawnId(h: Harness, task = "任务"): string {
  const outcome = h.scheduler.spawn(SESSION_ID, task);
  if (outcome.status === "rejected") throw new Error(`spawn 被拒：${outcome.error}`);
  return outcome.agentId;
}

/** 驱动到 parked：park 请求 + 子进程 parked 上行。 */
function parkTo(h: Harness, agentId: string, reason: "user" | "taskPause" = "user"): void {
  const outcome = h.scheduler.park(agentId, reason);
  if (!outcome.parked) throw new Error(`park 被拒：${outcome.error}`);
  h.runner.reportParked(agentId, { progress: "做到一半", next: "继续实现" });
}

const DONE_CLOSURE = (summary: string) => ({
  status: "done" as const,
  summary,
  reportPath: null,
  findings: null,
  taskId: null,
});

function payloadsOf(h: Harness, type: string, agentId?: string): unknown[] {
  return h.events
    .filter((e) => e.type === type && (agentId === undefined || e.instanceId === agentId))
    .map((e) => e.payload);
}

async function lifecycleRows(h: Harness): Promise<{ instanceId: string; state: string }[]> {
  await h.writeQueue.flush();
  return h.writeQueue.database
    .prepare("SELECT instance_id AS instanceId, state FROM agent_lifecycle WHERE session_id = ?")
    .all(SESSION_ID) as { instanceId: string; state: string }[];
}

let current: Harness | undefined;
afterEach(async () => {
  if (current) {
    await current.dispose();
    current = undefined;
  }
});

describe("① park → parked（非终态：不写 closure、不收口、不注入主线）", () => {
  test("park 请求经 steer 通道注入协议指令；parked 上行后状态 parked + 事件 + 投影行", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    expect(h.scheduler.instance(a1)?.state).toBe("running");

    const outcome = h.scheduler.park(a1, "taskPause");
    expect(outcome).toEqual({ parked: true });
    // 指令经既有 steer 通道（runner.send）注入，文本 = 协议单点常量
    expect(h.runner.sent).toEqual([{ instanceId: a1, text: PARK_INSTRUCTION_TEXT }]);
    expect(h.scheduler.instance(a1)?.state).toBe("running"); // 确认前仍 running（占用预算）

    h.runner.reportParked(a1, { progress: "已调研依赖", next: "写实现" });
    expect(h.scheduler.instance(a1)?.state).toBe("parked");
    // 非终态：无任何收口链产物（closure 事件零、SteerQueue 注入零）
    expect(h.events.some((e) => /agent\.(completed|failed|killed)/.test(e.type))).toBe(false);
    expect(payloadsOf(h, "agent.parked", a1)).toEqual([
      {
        agentId: a1,
        reason: "taskPause",
        parkedAt: new Date(FIXED_NOW_MS).toISOString(),
        summary: { progress: "已调研依赖", next: "写实现" },
      },
    ]);
  });

  test("agent_lifecycle 投影补 parked 行（park/resume 状态落盘）", async () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    parkTo(h, a1);
    const rows = await lifecycleRows(h);
    expect(rows).toContainEqual({ instanceId: a1, state: "parked" });
  });

  test("park 幂等：pending 期重复请求不重发指令；已 parked 再 park 为 no-op", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    expect(h.scheduler.park(a1)).toEqual({ parked: true });
    expect(h.scheduler.park(a1)).toEqual({ parked: true });
    expect(h.runner.sent).toHaveLength(1); // 不重发
    h.runner.reportParked(a1, { progress: "", next: "" });
    expect(h.scheduler.park(a1)).toEqual({ parked: true }); // 已挂起 no-op
    expect(h.runner.sent).toHaveLength(1);
    expect(payloadsOf(h, "agent.parked", a1)).toHaveLength(1); // 状态守卫幂等（重复上行忽略）
    h.runner.reportParked(a1, { progress: "", next: "" });
    expect(payloadsOf(h, "agent.parked", a1)).toHaveLength(1);
  });

  test("park 拒绝面：未知/排队中/终态/主会话 kind", () => {
    const h = (current = makeHarness());
    expect(h.scheduler.park("agent-不存在").parked).toBe(false);

    const policy = new SchedulingPolicy({ maxConcurrent: 1, maxQueued: 4 });
    const h2 = (current = makeHarness(policy));
    spawnId(h2, "任务A");
    const second = h2.scheduler.spawn(SESSION_ID, "任务B");
    if (second.status !== "queued") throw new Error("预期 queued");
    expect(h2.scheduler.park(second.agentId).parked).toBe(false); // 排队中无执行载体

    const h3 = (current = makeHarness());
    const a = spawnId(h3);
    h3.runner.reportClosure(a, { result: "done", closure: DONE_CLOSURE("完成") });
    expect(h3.scheduler.park(a).parked).toBe(false); // 终态：park 迟到作废（终态赢）
  });
});

describe("② resume → running（预算满则排队，空位后恢复不重新 launch）", () => {
  test("预算内：parked → running + agent.resumed + RESUME 指令注入 + 投影行", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    parkTo(h, a1);
    const outcome = h.scheduler.resume(a1);
    expect(outcome).toEqual({ resumed: true, queued: false });
    expect(h.scheduler.instance(a1)?.state).toBe("running");
    expect(h.runner.sent.at(-1)).toEqual({ instanceId: a1, text: RESUME_INSTRUCTION_TEXT });
    expect(payloadsOf(h, "agent.resumed", a1)).toEqual([{ agentId: a1 }]);
  });

  test("预算释放（P3）：3 running 挂起 1 个后第 4 个 spawn 直跑", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h, "任务1");
    spawnId(h, "任务2");
    spawnId(h, "任务3");
    parkTo(h, a1); // 释放一个运行位
    const fourth = h.scheduler.spawn(SESSION_ID, "任务4");
    expect(fourth.status).toBe("run"); // parked 不占 maxConcurrent
  });

  test("resume 预算满：与重派同队排队（状态保持 parked）+ 位次；空位释放后恢复而非重新 launch", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h, "挂起者");
    spawnId(h, "任务2");
    spawnId(h, "任务3");
    parkTo(h, a1); // 释放 1 位
    spawnId(h, "任务4"); // 补占释放的位——3 位重新满
    const outcome = h.scheduler.resume(a1);
    expect(outcome).toEqual({ resumed: true, queued: true, position: 1 });
    expect(h.scheduler.instance(a1)?.state).toBe("parked"); // 排队期间仍 parked
    expect(h.scheduler.status(a1)[0]).toMatchObject({ state: "parked", position: 1 });

    // 空位释放（任务2 自然收口）→ a1 恢复：RESUME 注入而非 runner.launch
    const launchedBefore = h.runner.launched.length;
    h.runner.reportClosure(
      h.runner.launched[1]!,
      { result: "done", closure: DONE_CLOSURE("任务2 完成") },
    );
    expect(h.scheduler.instance(a1)?.state).toBe("running");
    expect(payloadsOf(h, "agent.resumed", a1)).toEqual([{ agentId: a1 }]);
    expect(h.runner.sent.at(-1)).toEqual({ instanceId: a1, text: RESUME_INSTRUCTION_TEXT });
    expect(h.runner.launched).toHaveLength(launchedBefore); // 不重新 launch（执行载体还活着）
  });

  test("resume 拒绝面：未挂起实例 / 未知 / 终态", () => {
    const h = (current = makeHarness());
    expect(h.scheduler.resume("agent-不存在").resumed).toBe(false);
    const a1 = spawnId(h);
    expect(h.scheduler.resume(a1).resumed).toBe(false); // running 未挂起
    parkTo(h, a1);
    h.runner.reportClosure(a1, { result: "done", closure: DONE_CLOSURE("自然收口") });
    expect(h.scheduler.resume(a1).resumed).toBe(false); // 终态不可复活
  });
});

describe("③ 挂起期语义（steer 暂存 / 收口竞态 / parked kill）", () => {
  test("挂起期 steer 照常投递（子进程 steer 队列暂存，resume 时送达）", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    parkTo(h, a1);
    const outcome = h.scheduler.send(a1, "补充指示：改用方案 B");
    expect(outcome.delivered).toBe(true);
    expect(outcome.detail).toContain("挂起");
    expect(h.runner.sent.at(-1)).toEqual({ instanceId: a1, text: "补充指示：改用方案 B" });
  });

  test("收口竞态：closure 先到 → 终态赢，迟到 parked 上行作废（幂等）", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    expect(h.scheduler.park(a1)).toEqual({ parked: true }); // 指令已注入
    // 子进程自然收口（PARK 输出竞态输了）：closure 先到
    h.runner.reportClosure(a1, { result: "done", closure: DONE_CLOSURE("已按任务完成") });
    expect(h.scheduler.instance(a1)?.state).toBe("done");
    // 迟到 parked 上行：忽略
    h.runner.reportParked(a1, { progress: "迟到的挂起", next: "无效" });
    expect(h.scheduler.instance(a1)?.state).toBe("done");
    expect(payloadsOf(h, "agent.parked", a1)).toHaveLength(0);
  });

  test("防御位：parked 后到达 done 收口不崩（补记 running 再收口，任意序列无非法半态）", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    parkTo(h, a1);
    h.runner.reportClosure(a1, { result: "done", closure: DONE_CLOSURE("挂起后仍自然完成") });
    expect(h.scheduler.instance(a1)?.state).toBe("done");
    expect(h.scheduler.status(a1)[0]).toMatchObject({ summary: "挂起后仍自然完成" });
  });

  test("parked 期间 kill 正常：failed 终态 + killed 收口链", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    parkTo(h, a1);
    const outcome = h.scheduler.kill(a1);
    expect(outcome).toEqual({ killed: true });
    expect(h.scheduler.instance(a1)?.state).toBe("failed");
    expect(h.events.some((e) => e.type === "agent.killed" && e.instanceId === a1)).toBe(true);
    // parked 观测字段随终态清理
    expect(h.scheduler.status(a1)[0]).not.toHaveProperty("parkedReason");
  });
});

describe("④ 观测面：agent_status parked 状态 + 原因 + parkedAt", () => {
  test("parked 实例输出 parkedReason/parkedAt；resume 后清除", () => {
    const h = (current = makeHarness());
    const a1 = spawnId(h);
    parkTo(h, a1, "user");
    expect(h.scheduler.status(a1)[0]).toMatchObject({
      agentId: a1,
      state: "parked",
      parkedReason: "user",
      parkedAt: new Date(FIXED_NOW_MS).toISOString(),
    });
    h.scheduler.resume(a1);
    expect(h.scheduler.status(a1)[0]).toMatchObject({ state: "running" });
    expect(h.scheduler.status(a1)[0]).not.toHaveProperty("parkedReason");
  });
});

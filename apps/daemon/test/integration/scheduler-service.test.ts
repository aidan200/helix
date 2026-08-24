import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
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
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T2.1 SchedulerService integration（test-design §1.1 integration-① + §2.1 F1.3/F1.9）：
 * 真 SQLite（tmp home）+ FakeAgentEngine 驱动的 InstanceRunner 替身。
 *
 * ① 3 并发内直跑 + agent.spawned/started；② 第 4 个入队 queued{position:1}
 * + 位次递减重发；③ 队列满 reject（3 running + 8 queued）daemon 不崩；
 * ④ 收口释放空位队首自动出队（agent.started）+ agent_lifecycle 落盘；
 * ⑤ stalled 小阈值警示可重复且实例仍 running（不自动杀）；
 * ⑥ spawn 秒回不等 closure；K4：maxConcurrent/maxQueued 经 tmp home config 覆写生效；
 * F1.9 乱序：queued 直接收口 failed / 收口后同任务新 id 重派 / 多实例事件交织
 * / kill 与迟到收口竞态幂等。
 */

const SESSION_ID = "s-t21";
const FIXED_NOW = "2024-01-01T00:00:00.000Z";
/** 挂起时长：长工具执行使实例保持 running（测试窗口内等价"永不自动收口"）。 */
const HANG_MS = 5_000;

interface Harness {
  scheduler: SchedulerService;
  runner: EngineInstanceRunner;
  events: DomainEvent[];
  writeQueue: WriteQueue;
  dispose(): Promise<void>;
}

/** FakeAgentEngine 驱动的 InstanceRunner 替身（T2.2 子进程真体的接缝面）。 */
class EngineInstanceRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly engines = new Map<string, FakeAgentEngine>();
  private readonly forced = new Set<string>();
  private disposed = false;
  readonly launched: { instanceId: string; task: string }[] = [];

  constructor(private readonly hangMs: number) {}

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  launch(instance: { instanceId: string }, task: string): void {
    this.launched.push({ instanceId: instance.instanceId, task });
    const engine = new FakeAgentEngine({
      // 挂起剧本：一个长工具执行（期间无事件增量——stalled 判定输入）
      replies: [{ text: `${task} 的结果`, toolCalls: [{ toolName: "work", durationMs: this.hangMs }] }],
    });
    this.engines.set(instance.instanceId, engine);
    void engine
      .start(task, () => {
        this.callbacks?.onInstanceEvent(instance.instanceId);
      })
      .then(() => {
        // 外力收口（forceClosure/dispose）后引擎自然结束：跳过（迟到收口由
        // SchedulerService 幂等挡住，替身侧先去重避免噪音）
        if (this.forced.has(instance.instanceId) || this.disposed) return;
        this.callbacks?.onInstanceClosure(instance.instanceId, {
          result: "done",
          closure: {
            status: "done",
            summary: `${task} 完成`,
            reportPath: null,
            findings: null,
            taskId: null,
          },
        });
      });
  }

  // ── 测试驱动面（模拟子进程事件/收口到达） ────────────────

  /** 引擎事件增量到达（刷新 lastEventAt）。 */
  emitEvent(instanceId: string): void {
    this.callbacks?.onInstanceEvent(instanceId);
  }

  /** 外力收口（done/failed/killed），同时终止挂起剧本防迟到双报。 */
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    this.forced.add(instanceId);
    this.engines.get(instanceId)?.abort();
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }

  /** 测试收尾：终止全部挂起引擎（不回发收口）。 */
  dispose(): void {
    this.disposed = true;
    for (const e of this.engines.values()) e.abort();
  }
}

function makeHarness(options: {
  policy?: SchedulingPolicy;
  hangMs?: number;
  clock?: ClockPort;
}): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t21-sched-"));
  const writeQueue = new WriteQueue(path.join(home, "helix.db"));
  const repository = new SqliteSessionRepository(writeQueue);
  const events: DomainEvent[] = [];
  // 与 container 生产 wiring 同构：fan-out 目标含「内存采集 + WriteQueue 持久化」
  const publisher: EventPublisherPort = {
    publish: (e) => {
      events.push(e);
      void writeQueue.appendEvent(e);
    },
    publishDelta: () => undefined,
  };
  const clock: ClockPort = options.clock ?? { now: () => FIXED_NOW, nowMs: () => Date.now() };
  const runner = new EngineInstanceRunner(options.hangMs ?? HANG_MS);
  const scheduler = new SchedulerService({
    policy: options.policy ?? new SchedulingPolicy(),
    runner,
    events: publisher,
    repository,
    clock,
    stalledPollMs: 40, // 小轮询：stalled 测试可控（K1 阈值注入配套）
  });
  return {
    scheduler,
    runner,
    events,
    writeQueue,
    dispose: async () => {
      scheduler.stop();
      runner.dispose();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 某实例某类型事件的载荷序列（时间序）。 */
function payloadsOf(events: DomainEvent[], type: string, agentId?: string): unknown[] {
  return events
    .filter((e) => e.type === type && (agentId === undefined || e.instanceId === agentId))
    .map((e) => e.payload);
}

function agentEvents(events: DomainEvent[], agentId: string): string[] {
  return events.filter((e) => e.instanceId === agentId).map((e) => e.type);
}

/** 读 agent_lifecycle 投影行（flush 后；列名 alias 对齐驼峰读法）。 */
async function lifecycleRows(h: Harness): Promise<{ instanceId: string; state: string }[]> {
  await h.writeQueue.flush();
  return h.writeQueue.database
    .prepare("SELECT instance_id AS instanceId, state FROM agent_lifecycle WHERE session_id = ? ORDER BY instance_id")
    .all(SESSION_ID) as { instanceId: string; state: string }[];
}

const DONE_CLOSURE = (summary: string) => ({
  status: "done" as const,
  summary,
  reportPath: null,
  findings: null,
  taskId: null,
});


/** T10a：spawn id = agent-<唯一串>（非序号基线）——测试经本帮助器捕获实际 id。 */
function spawnId(h: Harness, task: string, profileKind?: string): string {
  const outcome = h.scheduler.spawn(SESSION_ID, task, profileKind);
  if (outcome.status === "rejected") throw new Error(`spawn 被拒：${outcome.error}`);
  return outcome.agentId;
}

let current: Harness | undefined;
afterEach(async () => {
  if (current) {
    await current.dispose();
    current = undefined;
  }
});

describe("① 预算内直跑 + ⑥ spawn 秒回（F1.3/F1.5）", () => {
  test("spawn 同步返回 run；spawned/started 事件即时发出；closure 未到（不等待）", () => {
    const h = (current = makeHarness({}));
    const t0 = Date.now();
    const outcome = h.scheduler.spawn(SESSION_ID, "调研调度器现状");
    expect(Date.now() - t0).toBeLessThan(50); // 秒回：不等 closure（挂起剧本 5s）

    expect(outcome.status).toBe("run");
    if (outcome.status === "rejected") throw new Error(`spawn 被拒：${outcome.error}`);
    const a1 = outcome.agentId;
    expect(a1).toMatch(/^agent-/); // T10a：agent-<唯一串>
    expect(a1).not.toMatch(/^agent-\d+$/); // 非纯数字序号形态
    expect(payloadsOf(h.events, "agent.spawned", a1)).toEqual([
      { agentId: a1, task: "调研调度器现状", profileKind: "subagent-worker" },
    ]);
    expect(payloadsOf(h.events, "agent.started", a1)).toEqual([{ agentId: a1 }]);
    // 秒回语义：返回时无任何终态事件，实例 running
    expect(h.events.some((e) => e.type.startsWith("agent.") && /completed|failed|killed/.test(e.type))).toBe(false);
    expect(h.scheduler.instance(a1)?.state).toBe("running");
    expect(h.runner.launched).toEqual([{ instanceId: a1, task: "调研调度器现状" }]);
  });

  test("profileKind 可指定（spawn 第二参）", () => {
    const h = (current = makeHarness({}));
    const a1 = spawnId(h, "任务", "subagent-researcher");
    expect(payloadsOf(h.events, "agent.spawned", a1)[0]).toMatchObject({
      profileKind: "subagent-researcher",
    });
  });
});

describe("② 第 4 个入队 + 位次递减重发（F1.3）", () => {
  test("3 running 后第 4 个 queued{position:1}；出队后位次整体递减且队首 started", () => {
    const h = (current = makeHarness({}));
    const a1 = spawnId(h, "任务1");
    spawnId(h, "任务2");
    spawnId(h, "任务3");
    const fourth = h.scheduler.spawn(SESSION_ID, "任务4");
    expect(fourth.status).toBe("queued");
    if (fourth.status !== "queued") throw new Error("预期 queued");
    const a4 = fourth.agentId;
    expect(fourth.position).toBe(1);
    expect(payloadsOf(h.events, "agent.queued", a4)).toEqual([
      { agentId: a4, position: 1 },
    ]);
    const fifth = h.scheduler.spawn(SESSION_ID, "任务5");
    expect(fifth.status).toBe("queued");
    if (fifth.status !== "queued") throw new Error("预期 queued");
    const a5 = fifth.agentId;
    expect(fifth.position).toBe(2);

    // 收口释放空位 → 队首出队 started；剩余位次递减重发（仅出队触发）
    h.runner.forceClosure(a1, { result: "done", closure: DONE_CLOSURE("任务1 完成") });
    expect(payloadsOf(h.events, "agent.started", a4)).toEqual([{ agentId: a4 }]);
    expect(payloadsOf(h.events, "agent.queued", a5)).toEqual([
      { agentId: a5, position: 2 },
      { agentId: a5, position: 1 }, // 递减重发
    ]);
    expect(h.scheduler.instance(a5)?.state).toBe("queued");
    expect(h.scheduler.instance(a4)?.state).toBe("running");
  });
});

describe("③ 队列满 reject（预算真实耗尽）", () => {
  test("3 running + 8 queued 后第 12 个 spawn 返回错误字符串；daemon 不崩且调度仍可用", () => {
    const h = (current = makeHarness({}));
    const ids = Array.from({ length: 11 }, (_, i) => spawnId(h, `任务${i + 1}`));
    expect(h.scheduler.instance(ids[10]!)?.state).toBe("queued");

    const rejected = h.scheduler.spawn(SESSION_ID, "任务12");
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      expect(rejected.error).toContain("maxConcurrent");
      expect(rejected.error).toMatch(/[\u4e00-\u9fa5]/); // 中文错误说明（回 LLM）
    }
    // reject 不建实例、不发 spawned
    expect(h.events.some((e) => e.type === "agent.spawned" && e.payload instanceof Object && (e.payload as { task: string }).task === "任务12")).toBe(false);
    expect(h.scheduler.instance("agent-12")).toBeUndefined();

    // daemon 不崩：收口后调度继续（队首 ids[3] 出队）
    h.runner.forceClosure(ids[0]!, { result: "done", closure: DONE_CLOSURE("ok") });
    expect(payloadsOf(h.events, "agent.started", ids[3])).toEqual([{ agentId: ids[3] }]);
  });
});

describe("④ 收口事件 + agent_lifecycle 落盘（F1.8）", () => {
  test("done/failed 收口发 completed/failed 事件（closure 全字段）+ 生命周期行落盘", async () => {
    const h = (current = makeHarness({}));
    const a1 = spawnId(h, "任务1");
    const a2 = spawnId(h, "任务2");
    const a3 = spawnId(h, "任务3");
    const a4 = spawnId(h, "任务4"); // queued

    // 收口前读：queued 态投影已落盘（AD-10 指队列数据不落盘；生命周期行含 queued 投影）
    const beforeRows = await lifecycleRows(h);
    expect(new Map(beforeRows.map((r) => [r.instanceId, r.state])).get(a4)).toBe("queued");

    h.runner.forceClosure(a1, { result: "done", closure: DONE_CLOSURE("任务1 完成") });
    h.runner.forceClosure(a2, {
      result: "failed",
      error: "引擎崩溃",
      closure: { status: "failed", summary: "引擎崩溃", reportPath: null, findings: null, taskId: null },
    });

    expect(payloadsOf(h.events, "agent.completed", a1)).toEqual([
      { agentId: a1, closure: DONE_CLOSURE("任务1 完成") },
    ]);
    expect(payloadsOf(h.events, "agent.failed", a2)).toEqual([
      { agentId: a2, error: "引擎崩溃", closure: { status: "failed", summary: "引擎崩溃", reportPath: null, findings: null, taskId: null } },
    ]);

    const rows = await lifecycleRows(h);
    const byId = new Map(rows.map((r) => [r.instanceId, r.state]));
    expect(byId.get(a1)).toBe("done");
    expect(byId.get(a2)).toBe("failed");
    expect(byId.get(a3)).toBe("running");
    expect(byId.get(a4)).toBe("running"); // a1 收口释放空位 → 出队 started
  });

  test("领域事件行落 domain_events 且挂实例维（四维可查）", async () => {
    const h = (current = makeHarness({}));
    const a1 = spawnId(h, "任务1");
    h.runner.forceClosure(a1, { result: "done", closure: DONE_CLOSURE("ok") });
    await h.writeQueue.flush();
    const rows = h.writeQueue.database
      .prepare("SELECT agent_instance_id, type FROM domain_events WHERE session_id = ? ORDER BY id")
      .all(SESSION_ID) as { agent_instance_id: string; type: string }[];
    expect(rows.map((r) => r.type)).toEqual(["agent.spawned", "agent.started", "agent.completed"]);
    expect(rows.every((r) => r.agent_instance_id === a1)).toBe(true);
  });
});

describe("⑤ stalled 警示（不自动杀，可重复推）", () => {
  test("阈值 100ms：idle 实例收到 stalled（≥2 次可重复）、状态仍 running、无终止动作", async () => {
    const h = (current = makeHarness({
      policy: new SchedulingPolicy({ stalledThresholdMs: 100 }),
      hangMs: 5_000,
    }));
    const a1 = spawnId(h, "长任务");
    await sleep(260); // 轮询 40ms × 数轮：launch 后长工具静默 → idle 持续超阈值
    const stalled = payloadsOf(h.events, "agent.stalled", a1) as { agentId: string; idleMs: number }[];
    expect(stalled.length).toBeGreaterThanOrEqual(2); // 可重复推（§8.3）
    expect(stalled[0]?.agentId).toBe(a1);
    for (const s of stalled) expect(s.idleMs).toBeGreaterThan(100);
    // 非状态迁移：实例仍 running、无任何终止事件/动作
    expect(h.scheduler.instance(a1)?.state).toBe("running");
    expect(agentEvents(h.events, a1)).not.toContain("agent.completed");
    expect(agentEvents(h.events, a1)).not.toContain("agent.failed");
    expect(agentEvents(h.events, a1)).not.toContain("agent.killed");
    expect(h.runner.launched.length).toBe(1); // 无重派/无终止副作用

    // 恢复语义：事件增量刷新后不再推（引擎事件到达）
    h.runner.emitEvent(a1);
    const countAfterRefresh = payloadsOf(h.events, "agent.stalled", a1).length;
    await sleep(90); // < 阈值窗口
    expect(payloadsOf(h.events, "agent.stalled", a1).length).toBe(countAfterRefresh);
  });
  test("双时间源统一（T1.3）：stalled 判定走注入时钟 nowMs——时钟推进超阈即警示，idleMs 精确、无需真实等待", async () => {
    // 注入可变时钟：lastEventAt 记录与 stalled 判定全部读 clock.nowMs()（非 Date.now）——
    // idleMs = 注入时钟差值，确定可断（真实墙钟则为 ~1.7e12 epoch，一眼可辨）
    let ms = 1_000_000;
    const h = (current = makeHarness({
      policy: new SchedulingPolicy({ stalledThresholdMs: 100 }),
      hangMs: 5_000,
      clock: { now: () => FIXED_NOW, nowMs: () => ms },
    }));
    const a1 = spawnId(h, "注入时钟长任务"); // startInstance → lastEventAt = 1_000_000
    ms += 150; // 时钟推进超阈（150 > 100），真实墙钟零流逝
    await waitForCondition(() => payloadsOf(h.events, "agent.stalled", a1).length >= 1);

    const stalled = payloadsOf(h.events, "agent.stalled", a1) as { agentId: string; idleMs: number }[];
    expect(stalled[0]!.idleMs).toBe(150); // 注入时钟差值（非 Date.now epoch）
    expect(h.scheduler.instance(a1)?.state).toBe("running"); // 警示非迁移

    // 事件增量刷新后基准重置：推进 30ms（< 阈值）不再推；再推 150ms 复现
    h.runner.emitEvent(a1); // → lastEventAt = 1_000_150
    const base = payloadsOf(h.events, "agent.stalled", a1).length;
    ms += 30;
    await sleep(60);
    expect(payloadsOf(h.events, "agent.stalled", a1).length).toBe(base);
    ms += 150;
    await waitForCondition(
      () => payloadsOf(h.events, "agent.stalled", a1).length >= base + 1,
    );
    const refreshed = payloadsOf(h.events, "agent.stalled", a1) as { agentId: string; idleMs: number }[];
    expect(refreshed[refreshed.length - 1]!.idleMs).toBe(180); // 自刷新基准（1_000_150 → 1_000_330）
  });
});

describe("K4：maxConcurrent/maxQueued 经 tmp home config.json 覆写生效", () => {
  test("2/4 覆写：第 3 个入队、2 running + 4 queued 后 reject", () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t21-cfg-home-"));
    try {
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ model: "anthropic/claude-sonnet-4-5", maxConcurrent: 2, maxQueued: 4 }),
        "utf8",
      );
      // 动态 import 避免与本文件顶部静态导入顺序耦合
      const { loadConfig } = require("../../src/infrastructure/config");
      const cfg = loadConfig(path.join(home, "config.json")).config; // T2.3：{config, legacy} 形态
      expect(cfg.maxConcurrent).toBe(2);
      expect(cfg.maxQueued).toBe(4);

      const h = (current = makeHarness({
        policy: new SchedulingPolicy({ maxConcurrent: cfg.maxConcurrent!, maxQueued: cfg.maxQueued! }),
      }));
      expect(h.scheduler.spawn(SESSION_ID, "a").status).toBe("run");
      expect(h.scheduler.spawn(SESSION_ID, "b").status).toBe("run");
      const third = h.scheduler.spawn(SESSION_ID, "c");
      expect(third.status).toBe("queued");
      if (third.status !== "queued") throw new Error("预期 queued");
      expect(third.agentId).toMatch(/^agent-/); // T10a：agent-<唯一串>（非 agent-3 序号）
      expect(third.position).toBe(1);
      for (let i = 4; i <= 6; i++) expect(h.scheduler.spawn(SESSION_ID, `t${i}`).status).toBe("queued");
      expect(h.scheduler.spawn(SESSION_ID, "g").status).toBe("rejected"); // 2 running + 4 queued
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("F1.9 非线性红线：乱序/交织/幂等", () => {
  test("queued 直接收口 failed：摘队、位次递减、不释放空位（仍 3 running）", () => {
    const h = (current = makeHarness({}));
    for (let i = 1; i <= 3; i++) spawnId(h, `任务${i}`);
    const a4 = spawnId(h, "任务4"); // pos 1
    const a5 = spawnId(h, "任务5"); // pos 2

    h.runner.forceClosure(a4, {
      result: "failed",
      error: "排队期间被判定不可执行",
      closure: { status: "failed", summary: "排队期间失败", reportPath: null, findings: null, taskId: null },
    });
    expect(h.scheduler.instance(a4)?.state).toBe("failed");
    expect(payloadsOf(h.events, "agent.failed", a4).length).toBe(1);
    expect(payloadsOf(h.events, "agent.queued", a5)).toEqual([
      { agentId: a5, position: 2 },
      { agentId: a5, position: 1 }, // 摘队递减
    ]);
    // 未释放空位：a5 不被错误拉起（running 仍 3 满）
    expect(agentEvents(h.events, a5)).not.toContain("agent.started");
  });

  test("running 收口后同任务新 id 重派：新实例新 id，终态实例不复活", () => {
    const h = (current = makeHarness({}));
    const a1 = spawnId(h, "同任务");
    spawnId(h, "同任务");
    spawnId(h, "同任务");
    h.runner.forceClosure(a1, { result: "done", closure: DONE_CLOSURE("第一轮完成") });

    const re = h.scheduler.spawn(SESSION_ID, "同任务");
    expect(re.status).toBe("run"); // 新 id（重派 = 新实例，第 4 次 spawn）
    if (re.status === "rejected") throw new Error(`spawn 被拒：${re.error}`);
    const a4 = re.agentId;
    expect(a4).not.toBe(a1); // T10a：重派必为新唯一串 id
    expect(h.scheduler.instance(a4)?.state).toBe("running");
    expect(h.scheduler.instance(a1)?.state).toBe("done"); // 终态保持

    // 终态幂等：对已收口实例的迟到 closure 不产生新事件/状态变更
    const eventsBefore = h.events.length;
    h.runner.forceClosure(a1, { result: "done", closure: DONE_CLOSURE("迟到") });
    h.runner.emitEvent(a1);
    expect(h.events.length).toBe(eventsBefore);
    expect(h.scheduler.instance(a1)?.state).toBe("done");
  });

  test("kill 路径：running kill 收口 killed（closure failed）+ 释放空位；迟到自然收口幂等", () => {
    const h = (current = makeHarness({}));
    spawnId(h, "任务1");
    const a2 = spawnId(h, "任务2");
    spawnId(h, "任务3");
    const a4 = spawnId(h, "任务4"); // queued

    h.scheduler.kill(a2);
    expect(payloadsOf(h.events, "agent.killed", a2).length).toBe(1);
    expect(h.scheduler.instance(a2)?.state).toBe("failed"); // kill 收口 failed（单一终态语义）
    expect(agentEvents(h.events, a2)).toContain("agent.started");
    // 空位释放 → 队首出队
    expect(agentEvents(h.events, a4)).toContain("agent.started");

    // 迟到的引擎自然收口：幂等 no-op（无第二个终态事件）
    const killedEvents = payloadsOf(h.events, "agent.killed", a2).length;
    h.runner.forceClosure(a2, { result: "done", closure: DONE_CLOSURE("迟到完成") });
    expect(payloadsOf(h.events, "agent.killed", a2).length).toBe(killedEvents);
    expect(payloadsOf(h.events, "agent.completed", a2).length).toBe(0);
  });

  test("kill 非线性边界：queued 可 kill（摘队）；未知 id/已终态 kill 幂等不崩", async () => {
    const h = (current = makeHarness({}));
    const a1 = spawnId(h, "任务1");
    spawnId(h, "任务2");
    spawnId(h, "任务3");
    const a4 = spawnId(h, "任务4");
    const a5 = spawnId(h, "任务5");

    h.scheduler.kill(a4); // queued 状态被销毁
    expect(h.scheduler.instance(a4)?.state).toBe("failed");
    expect(payloadsOf(h.events, "agent.queued", a5)).toEqual([
      { agentId: a5, position: 2 },
      { agentId: a5, position: 1 },
    ]);

    const before = h.events.length;
    h.scheduler.kill(a4); // 已终态：幂等
    h.scheduler.kill("agent-999"); // 未知：不崩
    expect(h.events.length).toBe(before);

    h.runner.forceClosure(a1, { result: "done", closure: DONE_CLOSURE("ok") });
    expect(agentEvents(h.events, a5)).toContain("agent.started"); // 调度仍正常
    const rows = await lifecycleRows(h);
    expect(new Map(rows.map((r) => [r.instanceId, r.state])).get(a4)).toBe("failed");
  });

  test("多实例事件交织：事件增量/收口交错不崩、无非法半态、每实例恰一个终态", () => {
    const h = (current = makeHarness({}));
    const a1 = spawnId(h, "任务1");
    const a2 = spawnId(h, "任务2");
    const a3 = spawnId(h, "任务3");
    const a4 = spawnId(h, "任务4");

    // 交织：running 实例事件增量交错 + 部分收口 + 排队实例事件（防御：未知/终态忽略）
    h.runner.emitEvent(a1);
    h.runner.emitEvent(a3);
    h.runner.forceClosure(a3, { result: "failed", error: "e", closure: { status: "failed", summary: "e", reportPath: null, findings: null, taskId: null } });
    h.runner.emitEvent(a3); // 终态后事件：不崩不计数
    h.runner.emitEvent(a4); // queued 实例事件（乱序到达）：不崩
    h.runner.forceClosure(a1, { result: "done", closure: DONE_CLOSURE("ok") });
    h.runner.emitEvent(a2);

    expect(h.scheduler.instance(a1)?.state).toBe("done");
    expect(h.scheduler.instance(a2)?.state).toBe("running");
    expect(h.scheduler.instance(a3)?.state).toBe("failed");
    expect(h.scheduler.instance(a4)?.state).toBe("running"); // 两次收口各释放一位 → a4 出队
    // 每实例恰一个终态事件
    for (const id of [a1, a3]) {
      const terminal = agentEvents(h.events, id).filter((t) => t !== "agent.spawned" && t !== "agent.started");
      expect(terminal.length).toBe(1);
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立（测试侧墙钟；超时地 2s）。 */
async function waitForCondition(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitForCondition 超时");
    await sleep(10);
  }
}

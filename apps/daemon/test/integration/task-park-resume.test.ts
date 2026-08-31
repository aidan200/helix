import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import {
  withOrchestratorEnv,
  insertBatchEntry,
  spawnEntry,
  dispatchEntry,
  type ScriptEntry,
  type OrchestratorEnv,
} from "../helpers/orchestrator-fixtures";
import type { InstanceClosureOutcome, InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";

/**
 * ⑤ 链 A（任务域 park/resume 接线）integration（真 SchedulerService +
 * ParkRunner——send 记录 + 测试显式驱动 parked 上行/收口，scheduler-park.test
 * 同构；编排会话 = 剧本化 withOrchestratorEnv）：
 *
 * - pause → parkAll：编排 loop 挂起（wake 暂存，不驱动编排回合）+ 全部
 *   running 批次实例 scheduler.park(reason="taskPause")；
 * - 挂起期 closure 唤醒暂存（机械判定照常落库：终态赢）+ 已 failed 批次
 *   不重派（派发闸既有行为保持）；
 * - resume → resumeAll 先行：parked 实例同会话复活（RESUME 注入、不重新
 *   launch）+ 暂存唤醒回放 + 派发闸恢复（sweepRetries 补派暂停期失败批次）。
 */

const BRIEF = "## 任务目标\n探索模块并产出节点。";

/** park 语义 runner：send 记录 + parked/closure 测试显式驱动。 */
class ParkRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly sent: { instanceId: string; text: string }[] = [];
  readonly launched: string[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  launch(instance: { instanceId: string }): void {
    this.launched.push(instance.instanceId);
  }

  send(instanceId: string, text: string): void {
    this.sent.push({ instanceId, text });
  }

  reportParked(instanceId: string): void {
    this.callbacks?.onInstanceParked?.(instanceId, { progress: "做到一半", next: "继续实现" });
  }

  reportClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

const DONE_CLOSURE = (summary: string) => ({
  status: "done" as const,
  summary,
  reportPath: null,
  findings: null,
  taskId: null,
});

const FAILED_CLOSURE = (summary: string) => ({
  status: "failed" as const,
  summary,
  reportPath: null,
  findings: null,
  taskId: null,
});

interface ChainAEnv extends OrchestratorEnv {
  readonly scheduler: SchedulerService;
  readonly runner: ParkRunner;
  /** park/resume 原语调用记录（orchestrator → scheduler 面断言）。 */
  readonly parkCalls: { agentId: string; reason: string }[];
  readonly resumeCalls: string[];
}

/** 装配：真 SQLite + 真 SchedulerService（ParkRunner）+ 剧本化编排会话。 */
async function withChainAEnv(
  script: readonly ScriptEntry[],
  fn: (env: ChainAEnv) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-chaina-"));
  const queue = new WriteQueue(path.join(home, "helix.db"));
  const events: DomainEvent[] = [];
  const publisher: EventPublisherPort = { publish: (e) => void events.push(e), publishDelta: () => undefined };
  const clock: ClockPort = { now: () => "2026-08-29T00:00:00.000Z", nowMs: () => Date.now() };
  const runner = new ParkRunner();
  // closure 路由晚绑（生产同构：buildSessionStack injectClosure → taskClosureSink
  // → TaskOrchestratorService.handleInstanceClosure）
  let orchestratorRef: { handleInstanceClosure(agentId: string): void } | undefined;
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy({ maxConcurrent: 3, maxQueued: 8 }),
    runner,
    events: publisher,
    repository: new SqliteSessionRepository(queue),
    clock,
    stalledPollMs: 60_000,
    injectClosure: (agentId) => orchestratorRef?.handleInstanceClosure(agentId),
  });
  const parkCalls: { agentId: string; reason: string }[] = [];
  const resumeCalls: string[] = [];

  try {
    await withOrchestratorEnv(
      {
        script,
        rawSpawn: (sessionId, task, profileKind) => scheduler.spawn(sessionId, task, profileKind),
        instanceOutcome: (agentId) => {
          const hit = scheduler.status(agentId)[0];
          return hit === undefined ? undefined : { state: hit.state, ...(hit.summary !== undefined ? { summary: hit.summary } : {}) };
        },
        parkInstance: (agentId, reason) => {
          parkCalls.push({ agentId, reason });
          return scheduler.park(agentId, reason);
        },
        resumeInstance: (agentId) => {
          resumeCalls.push(agentId);
          return scheduler.resume(agentId);
        },
      },
      async (env) => {
        orchestratorRef = env.orchestrator;
        await fn({ ...env, scheduler, runner, parkCalls, resumeCalls });
      },
    );
  } finally {
    scheduler.stop();
    await queue.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** 便捷剧本：划 1 批 + spawn + 派发 + 收口等待（首轮 kickoff drive）。 */
function oneBatchScript(): ScriptEntry[] {
  return [
    insertBatchEntry(1, "批次 1"),
    spawnEntry(BRIEF),
    dispatchEntry(0, 1),
    { kind: "reply", text: "已派发，等待收口。" },
  ];
}

/** 等待批次派发完成（行 running + 实例 launch）。 */
async function untilDispatched(env: ChainAEnv, jobId: string): Promise<string> {
  await env.until(
    () => env.runner.launched.length === 1 && env.store.getBatches(jobId, 1)[0]?.status === "running",
  );
  return env.store.getBatches(jobId, 1)[0]!.instanceId!;
}

/** 编排会话驱动静默等待（fire-and-forget drive 回收完后再收尾——避免 teardown 后 pending 驱动撞已关库）。 */
async function untilSessionQuiescent(env: ChainAEnv, stableMs = 120): Promise<void> {
  let last = -1;
  let stableAt = 0;
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const n = env.sessionLog.length;
    if (n !== last) {
      last = n;
      stableAt = Date.now();
    } else if (Date.now() - stableAt >= stableMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("⑤ 链 A：pause → 编排器挂起 + 批次实例 parked", () => {
  test("pause 落库后 parkAll：loop 挂起 + 实例 park 指令（taskPause）+ parked 确认后实例 parked、批次行保持 running", async () => {
    await withChainAEnv(oneBatchScript(), async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      const agentId = await untilDispatched(env, jobId);
      const drivesAtPause = env.sessionLog.filter((e) => e.kind === "drive").length;

      await env.engine.pause(jobId);
      // park 原语调用：全部 running 批次实例、reason=taskPause
      expect(env.parkCalls).toEqual([{ agentId, reason: "taskPause" }]);
      // park 指令经 steer 通道注入（调度器 → 子进程协议指令）
      expect(env.runner.sent.some((s) => s.instanceId === agentId)).toBe(true);

      env.runner.reportParked(agentId);
      await env.until(() => env.scheduler.status(agentId)[0]?.state === "parked");
      // 实例观测面：parked + 原因 taskPause
      expect(env.scheduler.status(agentId)[0]).toMatchObject({ state: "parked", parkedReason: "taskPause" });
      // 批次行状态保持 running（实例级 parked 态经可见性面展示，链 A 设计）
      expect(env.store.getBatches(jobId, 1)[0]?.status).toBe("running");
      expect(env.store.getBatches(jobId, 1)[0]?.instanceId).toBe(agentId);
      // loop 已挂起：挂起期间零新编排回合
      expect(env.sessionLog.filter((e) => e.kind === "drive").length).toBe(drivesAtPause);
      await untilSessionQuiescent(env);
    });
  });
});

describe("⑤ 链 A：挂起期 closure 唤醒暂存（机械判定照常，编排回合不触发）", () => {
  test("park 请求在途时自然收口（终态赢）：批次照常落库 done + 收口唤醒暂存；迟到 parked 上行被忽略", async () => {
    await withChainAEnv(oneBatchScript(), async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      const agentId = await untilDispatched(env, jobId);
      const drivesAtPause = env.sessionLog.filter((e) => e.kind === "drive").length;

      await env.engine.pause(jobId);
      // park 指令在途（确认前）实例自然收口 done——closure 先到终态赢
      const ledger = env.childLedger();
      await ledger.insertItems(agentId, [{ seq: 1, content: "探索模块" }]);
      await ledger.updateItem(agentId, 1, "done", "产物指针：node-1");
      env.runner.reportClosure(agentId, { result: "done", closure: DONE_CLOSURE("收口先于挂起确认") });
      // 机械判定照常落库：批次 done（O-2 pause 下在跑批次照常收口）
      await env.until(() => env.store.getBatches(jobId, 1)[0]?.status === "done");
      // 迟到 parked 上行被调度器忽略（终态赢幂等）
      env.runner.reportParked(agentId);
      expect(env.scheduler.status(agentId)[0]?.state).toBe("done");
      // 收口唤醒被暂存：编排器零新回合
      expect(env.sessionLog.filter((e) => e.kind === "drive").length).toBe(drivesAtPause);
      await untilSessionQuiescent(env);
    });
  });

  test("挂起期失败批次不重派（派发闸）：closure failed → 批次 failed（不重试不推进）零新 spawn", async () => {
    await withChainAEnv(oneBatchScript(), async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      const agentId = await untilDispatched(env, jobId);

      await env.engine.pause(jobId);
      env.runner.reportClosure(agentId, { result: "failed", closure: FAILED_CLOSURE("子进程异常退出") });
      await env.until(() => env.store.getBatches(jobId, 1)[0]?.status === "failed");
      // 派发闸：paused 下零自动重派（无新 launch）
      expect(env.runner.launched).toHaveLength(1);
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.retryCount).toBe(1);
      expect(batch.retryNote).toContain("failed");
      await untilSessionQuiescent(env);
    });
  });
});

describe("⑤ 链 A：resume → 实例复活（同会话续跑）+ 暂存唤醒回放 + 派发闸恢复", () => {
  test("pause（2 批：1 parked + 1 挂起期自然收口）→ resume：parked 实例 RESUME 复活不重新 launch + 收口唤醒回放驱动编排", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1"),
      insertBatchEntry(1, "批次 2"),
      spawnEntry(BRIEF),
      spawnEntry(BRIEF),
      dispatchEntry(0, 2),
      dispatchEntry(1, 3),
      { kind: "reply", text: "两批已派发。" },
      // resume 回放 + RESUME_NOTICE 后的收口等待轮（剧本尾）
      { kind: "reply", text: "收到收口通知与恢复通知，继续等待。" },
    ];
    await withChainAEnv(script, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(
        () => env.runner.launched.length === 2 && env.store.getBatches(jobId, 1).every((b) => b.status === "running"),
      );
      const batches = env.store.getBatches(jobId, 1);
      const parkedId = batches[0]!.instanceId!;
      const closerId = batches[1]!.instanceId!;
      const launchedAtPause = env.runner.launched.length;
      const drivesAtPause = env.sessionLog.filter((e) => e.kind === "drive").length;

      await env.engine.pause(jobId);
      // 批次 2 挂起期自然收口 done（终态赢）；批次 1 确认挂起
      const ledger = env.childLedger();
      await ledger.insertItems(closerId, [{ seq: 1, content: "探索模块" }]);
      await ledger.updateItem(closerId, 1, "done", "产物指针：node-1");
      env.runner.reportClosure(closerId, { result: "done", closure: DONE_CLOSURE("收口先于挂起确认") });
      await env.until(() => env.store.getBatches(jobId, 1)[1]?.status === "done");
      env.runner.reportParked(parkedId);
      await env.until(() => env.scheduler.status(parkedId)[0]?.state === "parked");
      expect(env.sessionLog.filter((e) => e.kind === "drive").length).toBe(drivesAtPause); // 暂存断言

      // resume：引擎序 = 落库 running → resumeAll（先复活实例）→ startOrchestrator（kick）
      await env.engine.resume(jobId);
      expect(env.store.getJob(jobId)?.status).toBe("running");
      // 实例复活：同 agentId、RESUME 指令注入、不重新 launch（执行载体驻留）；
      // 挂起期已自然收口的批次（行 done）被过滤——只复活仍在跑的 parked 实例
      expect(env.resumeCalls).toEqual([parkedId]);
      expect(env.scheduler.status(parkedId)[0]?.state).toBe("running");
      expect(env.runner.sent.at(-1)?.instanceId).toBe(parkedId);
      expect(env.runner.launched).toHaveLength(launchedAtPause); // 零重新 launch
      // 暂存唤醒回放：批次 2 收口通知驱动编排回合（drive 增加）
      await env.until(() => env.sessionLog.filter((e) => e.kind === "drive").length > drivesAtPause);
      const replayDrive = env.sessionLog.filter((e) => e.kind === "drive").find((e) => e.text.includes("批次收口"));
      expect(replayDrive).toBeDefined();
      // 批次 1 行保持 running + 同实例（同会话续跑）
      expect(env.store.getBatches(jobId, 1)[0]?.status).toBe("running");
      expect(env.store.getBatches(jobId, 1)[0]?.instanceId).toBe(parkedId);
      await untilSessionQuiescent(env);
    });
  });

  test("派发闸恢复：暂停期失败批次（retry 有余量）在 resume 后 sweepRetries 补派新实例", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1"),
      spawnEntry(BRIEF),
      dispatchEntry(0, 1),
      { kind: "reply", text: "已派发。" },
      { kind: "reply", text: "补派批次在跑，等待收口。" },
    ];
    await withChainAEnv(script, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      const first = await untilDispatched(env, jobId);

      await env.engine.pause(jobId);
      env.runner.reportClosure(first, { result: "failed", closure: FAILED_CLOSURE("子进程异常退出") });
      await env.until(() => env.store.getBatches(jobId, 1)[0]?.status === "failed");

      await env.engine.resume(jobId);
      // sweepRetries 补派：新实例 launch + 批次行 failed→running 换新 instanceId
      await env.until(() => env.runner.launched.length === 2 && env.store.getBatches(jobId, 1)[0]?.status === "running");
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.instanceId).not.toBe(first);
      expect(batch.retryCount).toBe(1);
      await untilSessionQuiescent(env);
    });
  });
});

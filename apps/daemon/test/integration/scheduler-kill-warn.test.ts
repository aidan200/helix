import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
} from "../../src/application/services/InstanceRunner";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";

/**
 * T1.3 integration（TP-1.3a #3）：SchedulerService.ts:403 kill 终止信号
 * 吞错可观测（源 R-2.3——`void Promise.resolve(stopping).catch(() =>
 * undefined)` 吞掉 runner.kill 异步拒绝，子进程终止失败零日志）。
 *
 * runner.kill 返回 rejecting promise（注入失败形态）→ scheduler.kill：
 * ① warn 含 [scheduler] 定位 + 实例 id + 错误信息；
 * ② 收口流程继续（KillOutcome.killed = true——「runner 异常不阻断收口」
 *    设计意图保持，错误可观测但流程不崩）。
 *
 * spy logger 是观察面非替身（TP-1.3c）；被测单元 SchedulerService 不 mock
 * （真 SQLite closure 落盘链）。
 */

const SESSION_ID = "s-t13";
const FIXED_NOW = "2026-08-21T00:00:00.000Z";

/** kill 通道注入失败形态的挂起 runner（launch 挂起不自动收口）。 */
class FailingKillRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly kills: string[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(): void {
    // 挂起语义：不自动收口（closure 由 scheduler.kill 驱动）
  }
  kill(instanceId: string): Promise<unknown> {
    this.kills.push(instanceId);
    return Promise.reject(new Error("终止信号发送失败（注入）"));
  }
}

interface Harness {
  scheduler: SchedulerService;
  runner: FailingKillRunner;
  warns: string[];
  dispose(): Promise<void>;
}

function makeHarness(): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t13-sched-"));
  const writeQueue = new WriteQueue(path.join(home, "helix.db"));
  const repository = new SqliteSessionRepository(writeQueue);
  const publisher: EventPublisherPort = {
    publish: () => undefined,
    publishDelta: () => undefined,
  };
  const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.parse(FIXED_NOW) };
  const runner = new FailingKillRunner();
  const warns: string[] = [];
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy(),
    runner,
    events: publisher,
    repository,
    clock,
    logger: { warn: (m) => warns.push(m) },
  });
  return {
    scheduler,
    runner,
    warns,
    dispose: async () => {
      scheduler.stop();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

let current: Harness | undefined;
afterEach(async () => {
  if (current) {
    await current.dispose();
    current = undefined;
  }
});

describe("TP-1.3a #3 scheduler.kill 终止信号异步失败 → logger.warn", () => {
  test("runner.kill reject → warn 含 [scheduler] + 实例 id + 错误信息；收口继续（killed=true）", async () => {
    const h = (current = makeHarness());
    const spawnOutcome = h.scheduler.spawn(SESSION_ID, "可被 kill 的任务");
    expect(spawnOutcome.status).toBe("run");

    const outcome = h.scheduler.kill("agent-1");
    expect(outcome.killed).toBe(true); // 收口不因 runner 异常阻断（不崩语义保持）
    expect(h.runner.kills).toEqual(["agent-1"]);

    // 终止信号 catch 的 warn 在微任务上到达
    await new Promise((r) => setTimeout(r, 20));
    const msg = h.warns.find((m) => m.includes("[scheduler]"));
    expect(msg).toBeDefined();
    expect(msg!.includes("agent-1")).toBe(true);
    expect(msg!.includes("终止信号发送失败（注入）")).toBe(true);
  });
});

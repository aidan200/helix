import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";

/**
 * T2 CDP 地基组合根接线（integration）：
 * ① BrowserPort 单例经 Daemon.browser 暴露，未连接时 idle；
 * ② shutdown 链挂 browserPort.stop()（未连接 = 安全 no-op，优雅退出不炸）；
 * ③ SchedulerService 终态钩子 onInstanceTerminal 在实例收口时触发
 *    （组合根接 browserPort.reclaimOwner 的接缝面）。
 */

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-daemon-t2-"));
}

describe("T2 组合根：BrowserPort 装配", () => {
  test("daemon.browser 单例暴露 + idle 初始态 + shutdown 经 stop() 安全收尾", async () => {
    const home = tmpHome();
    try {
      const daemon = await createTestDaemon({
        home,
        engine: new FakeAgentEngine({ replies: [{ text: "ok" }] }),
        skipConfig: true,
        port: 0,
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
      });

      expect(daemon.browser.getStatus()).toEqual({ state: "idle", tabCount: 0 });

      // 订阅面可用（T4 消费接缝）；退订函数返回
      const seen: string[] = [];
      const unsub = daemon.browser.onStatusChange((s) => seen.push(s.state));
      expect(typeof unsub).toBe("function");
      unsub();

      // shutdown 链含 browserPort.stop()（未连接 no-op 不阻塞优雅退出）
      await daemon.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("T2 SchedulerService 终态钩子（owner 回收接缝）", () => {
  const noopEvents: EventPublisherPort = { publish: () => undefined, publishDelta: () => undefined };
  const clock = { now: () => "2024-01-01T00:00:00.000Z", nowMs: () => 1_000_000 };

  function makeRunner(): { runner: InstanceRunner; fire: (id: string) => void } {
    let callbacks: InstanceRunnerCallbacks | undefined;
    return {
      runner: {
        setCallbacks: (cb) => (callbacks = cb),
        launch: () => undefined,
      },
      fire: (id) =>
        callbacks?.onInstanceClosure(id, {
          result: "done",
          closure: { status: "done", summary: "完成", reportPath: null, findings: null },
        }),
    };
  }

  test("实例收口 → onInstanceTerminal(agentId) 恰好一次（迟到收口幂等不重复）", async () => {
    const { runner, fire } = makeRunner();
    const reclaimed: string[] = [];
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy({ maxConcurrent: 3, maxQueued: 8 }),
      runner,
      events: noopEvents,
      repository: new InMemorySessionRepository(),
      clock,
      onInstanceTerminal: (agentId) => reclaimed.push(agentId),
    });
    try {
      const outcome = scheduler.spawn("s-t2", "任务", "subagent-worker");
      expect(outcome.status).toBe("run");
      if (outcome.status === "rejected") return;

      fire(outcome.agentId);
      expect(reclaimed).toEqual([outcome.agentId]);

      fire(outcome.agentId); // 迟到收口：幂等吞，不重复回收
      expect(reclaimed).toEqual([outcome.agentId]);
    } finally {
      scheduler.stop();
    }
  });

  test("未注入 onInstanceTerminal：收口链不受影响（可选依赖）", async () => {
    const { runner, fire } = makeRunner();
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy({ maxConcurrent: 3, maxQueued: 8 }),
      runner,
      events: noopEvents,
      repository: new InMemorySessionRepository(),
      clock,
    });
    try {
      const outcome = scheduler.spawn("s-t2", "任务", "subagent-worker");
      expect(outcome.status).toBe("run");
      if (outcome.status === "rejected") return;
      fire(outcome.agentId); // 不抛错
      expect(scheduler.status(outcome.agentId)[0]!.state).toBe("done");
    } finally {
      scheduler.stop();
    }
  });
});

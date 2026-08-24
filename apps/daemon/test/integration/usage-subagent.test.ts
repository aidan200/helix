import { describe, expect, test } from "bun:test";
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
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { DomainEvent, UsageRecordedPayload } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T3.2 RED：SubAgent 实例 turn usage 入账（T2.2 子进程事件上行链路）——
 * runner 上行的 message_end(assistant, usage) 由 SchedulerService 转
 * usage.recorded 领域事件（instanceId=agent-N，source=turn），挂实例维
 * 落盘/广播；不进主线 Session 聚合（AD-8 铁律——主线 entries 不变）。
 * 剧本 runner = FakeAgentEngine 驱动、逐事件全量转发（与 SubagentLauncher
 * 的 line.event 上行同构）。
 */

const SESSION_ID = "s-t32-usage";

/** 剧本 runner：引擎事件全量上行（T2.2 SubagentLauncher onChildLine 同构）。 */
class ScriptedEventRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly events: DomainEvent[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  launch(instance: { instanceId: string }, task: string): void {
    void (async () => {
      const engine = new FakeAgentEngine({
        replies: [
          {
            text: `<<<CLOSURE {"status":"done","summary":"${task} 完成"} CLOSURE>>>`,
            usage: { input: 111, output: 22, reasoning: 3, totalTokens: 136, cost: 0.02 },
          },
        ],
      });
      const forward = (e: AgentEngineEvent) => this.callbacks?.onInstanceEvent(instance.instanceId, e);
      await engine.start(task, forward);
      this.callbacks?.onInstanceClosure(instance.instanceId, {
        result: "done",
        closure: { status: "done", summary: `${task} 完成`, reportPath: null, findings: null, taskId: null },
      });
    })();
  }
}

describe("T3.2 SubAgent turn usage 入账（T2.2 上行链路）", () => {
  test("message_end(usage) → usage.recorded(instanceId, source=turn) 落盘四维 + 主线聚合不受污染", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t32-usage-"));
    const writeQueue = new WriteQueue(path.join(home, "helix.db"));
    const repository = new SqliteSessionRepository(writeQueue);
    const runner = new ScriptedEventRunner();
    const domainEvents: DomainEvent[] = [];
    // 与 container 生产 wiring 同构：内存采集 + WriteQueue 持久化双目标
    const publisher: EventPublisherPort = {
      publish: (e) => {
        domainEvents.push(e);
        void writeQueue.appendEvent(e, e.instanceId !== undefined && e.instanceId !== "main" ? "subagent" : "main");
      },
      publishDelta: () => undefined,
    };
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy({ maxConcurrent: 2, maxQueued: 4 }),
      runner,
      events: publisher,
      repository,
      clock: { now: () => new Date(0).toISOString(), nowMs: () => 0 },
      });
    try {
      const outcome = scheduler.spawn(SESSION_ID, "统计一下文件数");
      expect(outcome.status).toBe("run");
      if (outcome.status !== "run") throw new Error("unreachable");
      const agentId = outcome.agentId; // T10a：spawn id = agent-<唯一串>，捕获而非硬编码
      expect(agentId).toMatch(/^agent-[0-9a-f]+$/);
      // 剧本 runner 异步驱动：轮询至实例收口
      await waitFor(() => scheduler.status(agentId)![0]!.state === "done", 2000);

      const usageEvents = domainEvents.filter((e) => e.type === "usage.recorded") as (DomainEvent & {
        payload: UsageRecordedPayload;
      })[];
      expect(usageEvents).toHaveLength(1); // 剧本终条 message_end 恰一条（工具批/用户消息不入账）
      expect(usageEvents[0]!.instanceId).toBe(agentId); // envelope 实例维（四维落列）
      expect(usageEvents[0]!.payload).toEqual({
        instanceId: agentId,
        source: "turn",
        usage: {
          input: 111,
          output: 22,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 3,
          totalTokens: 136,
          cost: 0.02,
        },
      });

      // 落盘四维可查：按 instance 维过滤账目事件行
      await writeQueue.flush();
      const rows = repository.queryEvents({ sessionId: SESSION_ID, instanceId: agentId, type: "usage.recorded" });
      expect(rows).toHaveLength(1);
      expect((rows[0]!.payload as UsageRecordedPayload).usage.input).toBe(111);
    } finally {
      scheduler.stop();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10000);
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

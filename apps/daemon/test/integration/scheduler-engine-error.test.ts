import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
} from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";

/**
 * T1.1（F1.1 / AD-1 事件数据面半边）：SubAgent 子进程上行的 engine_error
 * 不再被 SchedulerService.onInstanceEvent 静默吞掉——
 * ① 转为挂 instanceId 的 engine.error 领域事件（fanout 可观测，mirror 主线
 *    ChatService.ts:515-518；不落 Entry、不动投影）；
 * ② 经 WriteQueue 落 domain_events（agent_kind=subagent，payload 含 provider
 *    原文——trace 数据面可查，F1.1 锚 4）；
 * ③ 负例：非 engine_error 事件路径（message_end → usage.recorded）产出不变；
 * ④ 迟到/终态实例的 engine_error 不产出（既有 :404-408 防护不破）。
 * WS 帧抑制面（AF-1：SubAgent 帧不广播、主线帧不变）在
 * test/unit/ws-dto-mapper.test.ts 单测承载。
 */

/** provider 原文（透传断言锚）。 */
const ERR_MSG = "429: 限额已满（provider 原文透传）";
/** SubAgent turn 用量（message_end 回归面）。 */
const USUB = { input: 1, output: 2, reasoning: 0, totalTokens: 3, cost: 0.001 };

/** 剧本 runner：launch 即上行 engine_error → message_end(usage) → done 收口。 */
class EngineErrorRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }): void {
    const errorEvent: AgentEngineEvent = { type: "engine_error", message: ERR_MSG };
    this.callbacks?.onInstanceEvent(instance.instanceId, errorEvent);
    const endEvent: AgentEngineEvent = {
      type: "message_end",
      role: "assistant",
      text: `<<<CLOSURE {"status":"done","summary":"done"} CLOSURE>>>`,
      stopReason: "stop",
      usage: { cacheRead: 0, cacheWrite: 0, ...USUB },
    };
    this.callbacks?.onInstanceEvent(instance.instanceId, endEvent);
    this.callbacks?.onInstanceClosure(instance.instanceId, {
      result: "done",
      closure: { status: "done", summary: "任务完成", reportPath: null, findings: null, taskId: null },
    });
  }
}

/** 剧本 runner：先 failed 收口（实例进终态），再上行迟到 engine_error。 */
class LateErrorRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }): void {
    this.callbacks?.onInstanceClosure(instance.instanceId, {
      result: "failed",
      error: "子进程崩溃",
      closure: { status: "failed", summary: "子进程崩溃", reportPath: null, findings: null, taskId: null },
    });
    const lateError: AgentEngineEvent = { type: "engine_error", message: ERR_MSG };
    this.callbacks?.onInstanceEvent(instance.instanceId, lateError);
  }
}

async function createTestDaemon(home: string, runner: InstanceRunner): Promise<ReturnType<typeof createDaemon>> {
  return createDaemon({
    home,
    engine: new FakeAgentEngine({ replies: [{ text: "收口回执。" }] }),
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    subagentRunner: runner,
  });
}

/** 轮询等待主线回 idle（closure 注入触发的内部 turn 收口）。 */
async function awaitIdle(d: { system: { getStatus(): { agentState: string } } }, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (d.system.getStatus().agentState !== "idle") {
    if (Date.now() - t0 > timeoutMs) throw new Error("awaitIdle 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("T1.1 engine_error 透传（container 级）", () => {
  test("注入 engine_error → 挂 instanceId 的领域事件 + 落 domain_events（subagent 行，原文）；message_end 路径不变", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t11-engerr-"));
    try {
      const d = await createTestDaemon(home, new EngineErrorRunner());
      const sessionId = d.system.getStatus().sessionId;

      // 订阅面（SessionService.notify ← fan-out，与落盘/WS 同源）
      const engineErrors: DomainEvent[] = [];
      const usageEvents: DomainEvent[] = [];
      d.session.subscribe((event) => {
        if ("type" in event && event.type === "engine.error") engineErrors.push(event as DomainEvent);
        if ("type" in event && event.type === "usage.recorded") usageEvents.push(event as DomainEvent);
      });

      const outcome = d.orchestration.spawn("会触发引擎错误的任务");
      expect(outcome.status).toBe("run");
      await awaitIdle(d); // closure 注入 → 内部 turn 收口

      // ① 不再静默：engine.error 领域事件挂 agent-1，payload.message = provider 原文
      expect(engineErrors).toHaveLength(1);
      expect(engineErrors[0]!.instanceId).toBe("agent-1");
      expect((engineErrors[0]!.payload as { message: string }).message).toBe(ERR_MSG);

      // ③ 回归：message_end(usage) 路径产出不变（usage.recorded 照常入账）
      expect(usageEvents).toHaveLength(1);

      await d.shutdown(); // drain 写队列（domain_events 落账）

      // ② trace 数据面：domain_events 四维可查（agent_kind=subagent 行 + 原文）
      const readQueue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(readQueue);
      const rows = repo.queryEvents({ sessionId, instanceId: "agent-1", type: "engine.error" });
      expect(rows).toHaveLength(1);
      expect((rows[0]!.payload as { message: string }).message).toBe(ERR_MSG);
      expect(repo.queryEvents({ sessionId, agentKind: "subagent", type: "engine.error" })).toHaveLength(1);
      expect(repo.queryEvents({ sessionId, agentKind: "main", type: "engine.error" })).toHaveLength(0);
      await readQueue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("迟到/终态实例的 engine_error → 不产出（既有防护不破）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t11-late-"));
    try {
      const d = await createTestDaemon(home, new LateErrorRunner());
      const sessionId = d.system.getStatus().sessionId;

      const engineErrors: DomainEvent[] = [];
      const failedEvents: DomainEvent[] = [];
      d.session.subscribe((event) => {
        if ("type" in event && event.type === "engine.error") engineErrors.push(event as DomainEvent);
        if ("type" in event && event.type === "agent.failed") failedEvents.push(event as DomainEvent);
      });

      const outcome = d.orchestration.spawn("先收口后迟到错误的任务");
      expect(outcome.status).toBe("run");
      await awaitIdle(d);

      expect(failedEvents).toHaveLength(1); // 收口确实发生（实例已终态）
      expect(engineErrors).toHaveLength(0); // 迟到 engine_error 被终态防护吞掉（不崩不计）

      await d.shutdown();
      const readQueue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(readQueue);
      expect(repo.queryEvents({ sessionId, type: "engine.error" })).toHaveLength(0);
      await readQueue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});

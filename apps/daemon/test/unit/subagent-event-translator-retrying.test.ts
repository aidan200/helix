import { describe, expect, test } from "bun:test";
import { SubagentEventTranslator } from "../../src/application/services/scheduler/SubagentEventTranslator";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";

/**
 * P2 ⑦ 网络重试批：SubAgent 实例上行的 engine_retrying 事件 → 挂
 * instanceId 的 engine.retrying 领域事件（mirror 主线 ChatService 同口径；
 * WS 帧抑制面在 test/unit/ws-dto-mapper.test.ts 承载）。
 */

class RecordingPublisher implements EventPublisherPort {
  readonly events: DomainEvent[] = [];
  publish(event: DomainEvent): void {
    this.events.push(event);
  }
  publishDelta(_delta: StreamDelta): void {}
}

class FixedClock {
  now(): string {
    return "2026-08-31T00:00:00.000Z";
  }
  nowMs(): number {
    return 0;
  }
}

function makeInstance(): AgentInstance {
  return AgentInstance.create({
    instanceId: "agent-7",
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "sess-1",
    state: "running",
    createdAt: "2026-08-31T00:00:00.000Z",
  });
}

describe("SubagentEventTranslator engine_retrying 镜像", () => {
  test("engine_retrying → 挂 instanceId 的 engine.retrying 领域事件（载荷逐字段）", () => {
    const publisher = new RecordingPublisher();
    const translator = new SubagentEventTranslator({ events: publisher, clock: new FixedClock() });

    translator.onInstanceEvent(makeInstance(), {
      type: "engine_retrying",
      attempt: 2,
      totalAttempts: 3,
      waitMs: 30_000,
      message: "ECONNRESET",
    });

    expect(publisher.events).toHaveLength(1);
    const e = publisher.events[0]!;
    expect(e.type).toBe("engine.retrying");
    expect(e.instanceId).toBe("agent-7");
    expect(e.sessionId).toBe("sess-1");
    expect(e.payload).toEqual({ attempt: 2, totalAttempts: 3, waitMs: 30_000, message: "ECONNRESET" });
  });

  test("负例：message_update 等其余事件不产 engine.retrying（既有路径不变）", () => {
    const publisher = new RecordingPublisher();
    const translator = new SubagentEventTranslator({ events: publisher, clock: new FixedClock() });

    translator.onInstanceEvent(makeInstance(), { type: "message_update", delta: "文本" });
    translator.onInstanceEvent(makeInstance(), { type: "turn_end", toolResultCount: 0 });

    expect(publisher.events.filter((e) => e.type === "engine.retrying")).toEqual([]);
  });
});

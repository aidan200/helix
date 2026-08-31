import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type {
  AgentEngineListener,
  AgentEnginePort,
} from "../../src/application/ports/outbound/AgentEnginePort";

/**
 * P2 ⑦ 网络重试批：ChatService 消费 engine_retrying 引擎事件 → 发布
 * engine.retrying 领域事件（chat 可见反馈链路的 daemon 侧半边；
 * WS 帧/前端消费在 shell 侧承载）。
 */

class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
  }
  publishDelta(_delta: StreamDelta): void {}
}

class FixedClock {
  private t = 0;
  now(): string {
    return new Date(this.t++).toISOString();
  }
  nowMs(): number {
    return this.t++;
  }
}

/** 最小引擎桩：run 内先发 engine_retrying（重试等待），再正常收口一轮回复。 */
class RetryingStubEngine implements AgentEnginePort {
  async start(_input: string, listener: AgentEngineListener): Promise<void> {
    listener({
      type: "engine_retrying",
      attempt: 1,
      totalAttempts: 3,
      waitMs: 10_000,
      message: "fetch failed",
    });
    listener({ type: "message_start", role: "assistant", source: "prompt" });
    listener({ type: "message_update", delta: "恢复后的回答" });
    listener({ type: "message_end", role: "assistant", text: "恢复后的回答", stopReason: "stop" });
    listener({ type: "turn_end", toolResultCount: 0 });
    listener({ type: "agent_end", messageCount: 1 });
  }
  steer(): void {}
  abort(): void {}
  isStreaming(): boolean {
    return false;
  }
}

describe("ChatService engine_retrying 消费（P2 ⑦）", () => {
  test("engine_retrying → engine.retrying 领域事件（载荷逐字段；既有时序事件不变）", async () => {
    const publisher = new RecordingPublisher();
    const chat = new ChatService({ engine: new RetryingStubEngine(), events: publisher, clock: new FixedClock() });

    await chat.sendMessage("你好");

    const retrying = publisher.domainEvents.find((e) => e.type === "engine.retrying");
    expect(retrying).toBeDefined();
    expect(retrying!.payload).toEqual({
      attempt: 1,
      totalAttempts: 3,
      waitMs: 10_000,
      message: "fetch failed",
    });
    // 既有链路不受影响：turn 事件与 assistant 回复照常落账
    expect(publisher.domainEvents.some((e) => e.type === "turn.started")).toBe(true);
    expect(publisher.domainEvents.some((e) => e.type === "message.completed")).toBe(true);
  });
});

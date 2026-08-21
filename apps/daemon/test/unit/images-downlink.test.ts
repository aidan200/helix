import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import { SessionProjection } from "../../src/application/services/SessionProjection";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/**
 * T9 图片下行（工具截图展示）：
 * ① FakeAgentEngine tool_execution_end 携带 images → ToolCallRecord 落 images
 *    + tool.call.result 领域事件载荷 images；
 * ② 投影持久化 toolCalls 行含 images（重启恢复源）；
 * ③ 不带 images 的工具结果零变更（缺省不带字段）。
 */

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  private readonly targets: EventPublisherPort[] = [];
  addTarget(target: EventPublisherPort): void {
    this.targets.push(target);
  }
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
    for (const t of this.targets) t.publish(event);
  }
  publishDelta(delta: StreamDelta): void {
    void delta;
  }
}

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const repo = new InMemorySessionRepository();
  const chat = new ChatService({
    engine,
    events: publisher,
    clock: { now: () => new Date(0).toISOString(), nowMs: () => 0 },
  });
  const projection = new SessionProjection({
    repository: repo,
    getSession: () => chat.sessionView,
    getMainState: () => ({ agentState: chat.agentState, toolCalls: chat.toolCallData }),
  });
  publisher.addTarget(projection);
  return { chat, publisher, repo };
}

describe("T9 图片下行：工具结果 images 全链", () => {
  test("tool_execution_end 携带 images → 记录/事件/持久化三处不丢", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        {
          text: "截图完成。",
          toolCalls: [{ toolName: "browser", args: { action: "screenshot" }, result: '{"saved":"/tmp/s.png"}', images: [TINY_PNG] }],
        },
      ],
    });
    const { chat, publisher, repo } = makeChat(engine);
    await chat.sendMessage("截个图");

    // ① 领域事件载荷携带 images（EnvelopeMapper → tool.call.result entry.images 源）
    const result = publisher.domainEvents.find((e) => e.type === "tool.call.result");
    expect((result?.payload as { images?: string[] }).images).toEqual([TINY_PNG]);

    // ② ToolCallRecord 落 images（观测面）
    const record = chat.toolCallData.find((t) => t.toolName === "browser");
    expect(record?.images).toEqual([TINY_PNG]);

    // ③ 投影持久化 toolCalls 含 images（重启恢复源）
    const state = await repo.restore(chat.sessionId);
    const persisted = state?.toolCalls.find((t) => t.toolName === "browser");
    expect(persisted?.images).toEqual([TINY_PNG]);
  });

  test("不带 images 的工具结果零变更（字段缺省不带）", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        {
          text: "好了。",
          toolCalls: [{ toolName: "bash", args: { command: "echo hi" }, result: "hi" }],
        },
      ],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("跑个命令");
    const result = publisher.domainEvents.find((e) => e.type === "tool.call.result");
    expect((result?.payload as { images?: string[] }).images).toBeUndefined();
    const record = chat.toolCallData.find((t) => t.toolName === "bash");
    expect(record && "images" in record ? record.images : undefined).toBeUndefined();
  });
});

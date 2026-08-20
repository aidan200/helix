import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { AgentEnginePort } from "../../src/application/ports/outbound/AgentEnginePort";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * M6 T2 ChatService state 直改入口（set_model 六层链同构，per-session 会话维）：
 * - setTools/setSystemPrompt 直达 AgentEnginePort（引擎缺实现 → 中文报错不静默）；
 * - FakeAgentEngine 为该可选面的契约等价 mock（记录 last 值供断言）。
 */

const noopPublisher: EventPublisherPort = {
  publish: (_event: DomainEvent) => undefined,
  publishDelta: (_delta: StreamDelta) => undefined,
};
const fixedClock = { now: () => "2026-08-20T00:00:00.000Z", nowMs: () => 0 };

describe("ChatService state 直改（setTools/setSystemPrompt，M6 T2）", () => {
  test("① 直达引擎：setSystemPrompt/setTools 后引擎观测到新值", () => {
    const engine = new FakeAgentEngine();
    const chat = new ChatService({ engine, events: noopPublisher, clock: fixedClock });
    chat.setSystemPrompt("三段组装后的提示");
    chat.setTools(["bash", "read"]);
    expect(engine.lastSystemPrompt).toBe("三段组装后的提示");
    expect(engine.lastTools).toEqual(["bash", "read"]);
  });

  test("② 引擎未实现直改接口 → 中文报错（不静默吞，调用方可观测）", () => {
    // 最小引擎：只实现必选四面（缺 setTools/setSystemPrompt）
    const bare: AgentEnginePort = {
      start: async () => undefined,
      steer: () => undefined,
      abort: () => undefined,
      isStreaming: () => false,
    };
    const chat = new ChatService({ engine: bare, events: noopPublisher, clock: fixedClock });
    expect(() => chat.setTools(["bash"])).toThrow(/未实现.*setTools/);
    expect(() => chat.setSystemPrompt("p")).toThrow(/未实现.*setSystemPrompt/);
  });
});

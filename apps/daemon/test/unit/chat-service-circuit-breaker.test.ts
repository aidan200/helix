import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { AgentEngineListener, AgentEnginePort } from "../../src/application/ports/outbound/AgentEnginePort";

/**
 * P0 截断风暴熔断（2026-11-11 会话 087cc66e 事故回归锚）：模型单轮输出撞
 * token 上限进入病态重复——pi failToolCallsFromTruncatedMessage 硬编码
 * terminate:false 且无 hook 面，3513 条「未执行」失败结果 4 分钟内灌满
 * 上下文（input 9万→24万）+ 事件风暴打爆会话投影写放大（disk I/O error）。
 *
 * 熔断语义：轮内连续 N 条截断失败（pi 固定文案子串匹配）→ abort 本轮
 * （复用 abort 宽限收口链）+ onCircuitBreak 回调（组合根接 SessionRegistry
 * unload——软重置 = 冷恢复同款 seedMessagesOf 正文种子）+ 用户可见告警。
 *
 * 用例锚定四层：
 * 1. 阈值触发：连续 20 条截断失败 → abort + onCircuitBreak 恰一次 + 告警；
 * 2. 阈值下不误伤：19 条截断失败 → 不熔断；
 * 3. 连击打断归零：失败-成功-失败交错 → 永不熔断；
 * 4. 文案甄别：普通工具错误（非截断文案）连续 20 条 → 不熔断。
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

/** 风暴引擎：start 挂起不收口（run 持续 running），listener 由测试注入事件。 */
class StormEngine implements AgentEnginePort {
  listener: AgentEngineListener | null = null;
  abortCalls = 0;
  async start(_input: string, listener: AgentEngineListener): Promise<void> {
    this.listener = listener;
    await new Promise<never>(() => {}); // 挂起：轮不收口（风暴进行中形态）
  }
  steer(): void {}
  abort(): void {
    this.abortCalls++;
  }
  isStreaming(): boolean {
    return true;
  }
}

/** pi agent-loop.js failToolCallsFromTruncatedMessage 的固定文案（1.3.0 实证）。 */
const TRUNCATED_MSG =
  'Tool call "bash" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.';

function emitTruncated(engine: StormEngine, i: number): void {
  engine.listener?.({
    type: "tool_execution_end",
    toolCallId: `tc-${i}`,
    toolName: "bash",
    isError: true,
    result: TRUNCATED_MSG,
  });
}

function emitSuccess(engine: StormEngine, i: number): void {
  engine.listener?.({
    type: "tool_execution_end",
    toolCallId: `tc-ok-${i}`,
    toolName: "bash",
    isError: false,
    result: "done",
  });
}

function makeChat(
  engine: AgentEnginePort,
  publisher: RecordingPublisher,
  onCircuitBreak?: () => void,
): ChatService {
  return new ChatService({
    engine,
    events: publisher,
    clock: new FixedClock(),
    abortGraceMs: 10,
    ...(onCircuitBreak !== undefined ? { onCircuitBreak } : {}),
  } as never);
}

function engineErrorMessages(publisher: RecordingPublisher): string[] {
  return publisher.domainEvents
    .filter((e) => e.type === "engine.error")
    .map((e) => String((e.payload as { message?: string } | undefined)?.message ?? ""));
}

describe("ChatService 截断风暴熔断（P0 熔断闸）", () => {
  test("连续 20 条截断失败 → abort + onCircuitBreak 恰一次 + 用户可见告警", async () => {
    const engine = new StormEngine();
    const publisher = new RecordingPublisher();
    let breakCalls = 0;
    const chat = makeChat(engine, publisher, () => breakCalls++);
    void chat.sendMessage("继续调 UI");
    await new Promise((r) => setTimeout(r, 0)); // start 挂起后 listener 已就位

    for (let i = 0; i < 20; i++) emitTruncated(engine, i);

    expect(engine.abortCalls).toBe(1);
    expect(breakCalls).toBe(1);
    const alerts = engineErrorMessages(publisher).filter((m) => m.includes("熔断"));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  test("19 条截断失败（阈值下）→ 不熔断不误伤", async () => {
    const engine = new StormEngine();
    const publisher = new RecordingPublisher();
    let breakCalls = 0;
    const chat = makeChat(engine, publisher, () => breakCalls++);
    void chat.sendMessage("继续调 UI");
    await new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < 19; i++) emitTruncated(engine, i);

    expect(engine.abortCalls).toBe(0);
    expect(breakCalls).toBe(0);
    expect(engineErrorMessages(publisher).filter((m) => m.includes("熔断"))).toHaveLength(0);
  });

  test("连击被成功结果打断归零：10 失败 + 1 成功 + 10 失败 → 不熔断", async () => {
    const engine = new StormEngine();
    const publisher = new RecordingPublisher();
    let breakCalls = 0;
    const chat = makeChat(engine, publisher, () => breakCalls++);
    void chat.sendMessage("继续调 UI");
    await new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < 10; i++) emitTruncated(engine, i);
    emitSuccess(engine, 0);
    for (let i = 10; i < 20; i++) emitTruncated(engine, i);

    expect(engine.abortCalls).toBe(0);
    expect(breakCalls).toBe(0);
  });

  test("普通工具错误（非截断文案）连续 20 条 → 不熔断（文案甄别）", async () => {
    const engine = new StormEngine();
    const publisher = new RecordingPublisher();
    let breakCalls = 0;
    const chat = makeChat(engine, publisher, () => breakCalls++);
    void chat.sendMessage("继续调 UI");
    await new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < 20; i++) {
      engine.listener?.({
        type: "tool_execution_end",
        toolCallId: `tc-err-${i}`,
        toolName: "bash",
        isError: true,
        result: `Command failed with exit code 1: ...（第 ${i} 次普通失败）`,
      });
    }

    expect(engine.abortCalls).toBe(0);
    expect(breakCalls).toBe(0);
  });
});

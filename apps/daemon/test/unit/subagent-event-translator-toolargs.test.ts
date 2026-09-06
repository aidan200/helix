import { describe, expect, test } from "bun:test";
import { SubagentEventTranslator } from "../../src/application/services/scheduler/SubagentEventTranslator";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { DomainEvent, ToolResultPayload } from "../../src/domain/events/DomainEvent";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";

/**
 * F3 修复面：SubagentEventTranslator.subToolArgs 键型 —— 裸 toolCallId →
 * per-instance 嵌套 Map。并发 SubAgent 各自子进程 toolCallId 可重号，
 * 裸键下 tool.call.result 的 args 回填串号或丢失（start→end 驻留互相覆盖）。
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
    return "2026-09-07T00:00:00.000Z";
  }
  nowMs(): number {
    return 0;
  }
}

function makeInstance(instanceId: string): AgentInstance {
  return AgentInstance.create({
    instanceId,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "sess-1",
    state: "running",
    createdAt: "2026-09-07T00:00:00.000Z",
  });
}

function toolResultsOf(events: readonly DomainEvent[]): { instanceId: string; payload: ToolResultPayload }[] {
  return events
    .filter((e) => e.type === "tool.call.result")
    .map((e) => ({ instanceId: e.instanceId!, payload: e.payload as ToolResultPayload }));
}

describe("SubagentEventTranslator subToolArgs 并发实例键隔离（F3）", () => {
  test("两实例同 toolCallId：result 的 args 各回填本实例 start 值，不串号不丢失", () => {
    const publisher = new RecordingPublisher();
    const translator = new SubagentEventTranslator({ events: publisher, clock: new FixedClock() });
    const a = makeInstance("agent-1");
    const b = makeInstance("agent-2");

    translator.onInstanceEvent(a, { type: "tool_execution_start", toolCallId: "tc-1", toolName: "grep", args: { pattern: "A" } });
    translator.onInstanceEvent(b, { type: "tool_execution_start", toolCallId: "tc-1", toolName: "grep", args: { pattern: "B" } });
    // 裸键下：B 的 start 覆盖 A 的驻留 args；A 的 end 删除唯一键 → B 的 end 丢失回填
    translator.onInstanceEvent(a, { type: "tool_execution_end", toolCallId: "tc-1", toolName: "grep", isError: false, result: "命中A" });
    translator.onInstanceEvent(b, { type: "tool_execution_end", toolCallId: "tc-1", toolName: "grep", isError: false, result: "命中B" });

    const results = toolResultsOf(publisher.events);
    expect(results).toHaveLength(2);
    const ra = results.find((r) => r.instanceId === "agent-1")!;
    const rb = results.find((r) => r.instanceId === "agent-2")!;
    expect(ra.payload.args).toEqual({ pattern: "A" });
    expect(ra.payload.result).toBe("命中A");
    expect(rb.payload.args).toEqual({ pattern: "B" });
    expect(rb.payload.result).toBe("命中B");
  });

  test("onClosureCleanup 清理本实例驻留 args：终态后迟到 end 不回填（且不波及他实例）", () => {
    const publisher = new RecordingPublisher();
    const translator = new SubagentEventTranslator({ events: publisher, clock: new FixedClock() });
    const a = makeInstance("agent-1");
    const b = makeInstance("agent-2");

    translator.onInstanceEvent(a, { type: "tool_execution_start", toolCallId: "tc-1", toolName: "grep", args: { pattern: "A" } });
    translator.onInstanceEvent(b, { type: "tool_execution_start", toolCallId: "tc-1", toolName: "grep", args: { pattern: "B" } });
    translator.onClosureCleanup("agent-1");
    translator.onInstanceEvent(a, { type: "tool_execution_end", toolCallId: "tc-1", toolName: "grep", isError: false, result: "命中A" });
    translator.onInstanceEvent(b, { type: "tool_execution_end", toolCallId: "tc-1", toolName: "grep", isError: false, result: "命中B" });

    const results = toolResultsOf(publisher.events);
    const ra = results.find((r) => r.instanceId === "agent-1")!;
    const rb = results.find((r) => r.instanceId === "agent-2")!;
    expect(ra.payload.args).toBeUndefined(); // 本实例驻留已清
    expect(rb.payload.args).toEqual({ pattern: "B" }); // 他实例不受影响
  });
});

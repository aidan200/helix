/**
 * code-review M：EventStream 工具起点复合键 + 实例分仓清理。
 * 缺陷现场：toolStartedAt 键 `${sessionId}:${toolCallId}` 不含 instanceId——
 * 并发 SubAgent 同会话 toolCallId 可重号互踩（起点覆盖致 durationMs 错算）；
 * turn.completed/interrupted 按会话前缀清键会清掉同会话其他实例在飞工具起点
 * （durationMs 缺席）。修复：键加实例段，收口清理按实例分仓。
 */
import { describe, expect, test } from "bun:test";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";

const T = (ms: number) => new Date(ms).toISOString();

function ev(type: DomainEvent["type"], instanceId: string | undefined, payload: unknown, at: number): DomainEvent {
  return { type, sessionId: "s1", instanceId, payload, occurredAt: T(at) };
}

describe("code-review M：EventStream 工具起点按实例分仓", () => {
  test("并发 SubAgent 同 toolCallId 互不覆盖 + 主实例 turn 收口不清 SubAgent 在飞起点", () => {
    const es = new EventStream();
    const frames: { type: string; payload: unknown }[] = [];
    es.attach((f) => frames.push(f as { type: string; payload: unknown }), "s1");

    // 两实例同号 toolCallId 同时起步（并发重号现场）
    es.publish(ev("tool.call.started", "agent-x", { toolCallId: "tc-1", toolName: "read", args: {} }, 1000));
    es.publish(ev("tool.call.started", "agent-y", { toolCallId: "tc-1", toolName: "grep", args: {} }, 2000));
    // 主实例 turn 收口——不得清掉 agent-x/agent-y 的在飞工具起点
    es.publish(ev("turn.completed", undefined, { reason: "done", replyEntryId: undefined }, 3000));
    // agent-x 结果到达：durationMs 应 = 3000ms（起点 1000 → 4000）
    es.publish(
      ev("tool.call.result", "agent-x", { toolCallId: "tc-1", toolName: "read", args: {}, isError: false, result: "r" }, 4000),
    );

    const resultFrame = frames.find((f) => f.type === "tool.call.result");
    expect(resultFrame).toBeDefined();
    // 现行行为红①：主实例 turn 收口按会话前缀清键 → agent-x 起点被误清 → durationMs 缺席；
    // 红②（无收口干扰时）：agent-y 起点覆盖 agent-x → durationMs 错算（4000-2000=2000）
    const entryOf = (f: { payload: unknown }) => (f.payload as { entry: { durationMs?: number } }).entry;
    expect(entryOf(resultFrame!).durationMs).toBe(3000);

    // agent-y 的结果仍可取到正确 durationMs（4000-2000=2000，起点未被 agent-x 消费）
    es.publish(
      ev("tool.call.result", "agent-y", { toolCallId: "tc-1", toolName: "grep", args: {}, isError: false, result: "r" }, 4000),
    );
    const yFrame = frames.filter((f) => f.type === "tool.call.result")[1];
    expect(entryOf(yFrame!).durationMs).toBe(2000);
  });
});

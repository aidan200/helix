/**
 * code-review M：replaySubAgentHistory 复合键（${instanceId}:${toolCallId}）。
 * 缺陷现场：重放工具记录用裸 toolCallId 键（knownToolIds/replayedTools 同）——
 * 并发 SubAgent 实例各自子进程 toolCallId 可重号（pi 每会话从 1 起），恢复
 * 重放时互相覆盖/错配；SessionProjection.ts F3 复合键修复（${instanceId}:
 * ${toolCallId}）未覆盖恢复重放路径。本用例：两实例同 toolCallId "tc-1"，
 * 恢复后两条记录都应在册且各自归属不错配。
 */
import { describe, expect, test } from "bun:test";
import { RestoreService } from "../../src/application/services/RestoreService";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { ToolCallPayload, ToolResultPayload } from "../../src/domain/events/DomainEvent";

const T0 = new Date(0).toISOString();

function ev<P>(type: DomainEvent["type"], instanceId: string, payload: P, at: number): DomainEvent<P> {
  return { type, sessionId: "s1", instanceId, payload, occurredAt: new Date(at).toISOString() };
}

describe("code-review M：恢复重放工具记录复合键（并发 SubAgent toolCallId 重号不错配）", () => {
  test("两实例同 toolCallId 各自 started+result → 两条记录各自归属、结果不回填错实例", async () => {
    const repo = new InMemorySessionRepository();
    await repo.save({
      session: {
        sessionId: "s1",
        createdAt: T0,
        mainInstanceId: "agent-main-1",
        entries: [],
        turns: [],
        pendingSteer: [],
      },
      agentState: "idle",
      toolCalls: [],
    });
    repo.pushEvents([
      ev<ToolCallPayload>("tool.call.started", "agent-aaa", { toolCallId: "tc-1", toolName: "read", args: { path: "a" } }, 1),
      ev<ToolCallPayload>("tool.call.started", "agent-bbb", { toolCallId: "tc-1", toolName: "grep", args: { pattern: "b" } }, 2),
      ev<ToolResultPayload>("tool.call.result", "agent-aaa", { toolCallId: "tc-1", toolName: "read", args: { path: "a" }, isError: false, result: "AAA 结果" }, 3),
      ev<ToolResultPayload>("tool.call.result", "agent-bbb", { toolCallId: "tc-1", toolName: "grep", args: { pattern: "b" }, isError: true, result: "BBB 失败" }, 4),
    ]);

    const svc = new RestoreService({ repository: repo, clock: { now: () => T0, nowMs: () => 0 } });
    const out = await svc.restore("s1");
    expect(out).toBeDefined();

    // 现行行为红：裸 toolCallId 键互踩——replayedTools 只剩末条（agent-bbb 覆盖
    // agent-aaa），agent-aaa 的记录与 "AAA 结果" 永久丢失/错配
    const subs = out!.toolCalls.filter((t) => t.id === "tc-1");
    expect(subs).toHaveLength(2);
    const aaa = subs.find((t) => t.instanceId === "agent-aaa");
    const bbb = subs.find((t) => t.instanceId === "agent-bbb");
    expect(aaa?.toolName).toBe("read");
    expect(aaa?.status).toBe("completed");
    expect(aaa?.result).toBe("AAA 结果");
    expect(bbb?.toolName).toBe("grep");
    expect(bbb?.status).toBe("failed");
  });
});

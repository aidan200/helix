/**
 * CoordinationService 行为测试（U4 占用协调）。
 *
 * 覆盖面：claim 幂等/冲突面、release、undeclared 自动补登（置信门槛/
 * 去重/覆盖刷新）、轮末机械对账（plan 全 resolve + 本轮无新写 → settled；
 * 台账未结/本轮有写 → 保持 active）、subagent settle（isolated 租约
 * 执行者清空即释放）、会话销毁全释放、sweep（settled TTL 物理删 +
 * ghost 降级不阻塞）。
 */

import { describe, expect, test } from "bun:test";
import { CoordinationService } from "../../src/application/services/CoordinationService";
import { WriteFactRegistry } from "../../src/application/services/WriteFactRegistry";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { WriteFact } from "../../src/domain/writefact/types";

const WS = "/ws";
const PROJ_A = "/ws/projA";
const PROJ_B = "/ws/projB";

function fact(path: string, at: number, confidence: WriteFact["confidence"] = "precise", sessionId = "sess-a"): WriteFact {
  return { instanceId: `${sessionId}-main`, sessionId, path, at, confidence };
}

function harness(opts?: {
  resolved?: boolean;
  settleTtlMs?: number;
  ghostAfterMs?: number;
}) {
  const events: DomainEvent[] = [];
  const writeFacts = new WriteFactRegistry({ workspaceRoot: () => WS, now: () => 1000 });
  let now = 1000;
  const service = new CoordinationService({
    publish: (e) => events.push(e),
    writeFacts,
    planReaderFor: () => ({
      isFullyResolved: () => ({ resolved: opts?.resolved ?? true, unresolved: opts?.resolved === false ? [{ seq: 1, status: "in_progress" }] : [] }),
    }),
    workspaceRoot: () => WS,
    now: () => now,
    ...(opts?.settleTtlMs !== undefined ? { settleTtlMs: opts.settleTtlMs } : {}),
    ...(opts?.ghostAfterMs !== undefined ? { ghostAfterMs: opts.ghostAfterMs } : {}),
  });
  return {
    events,
    writeFacts,
    service,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function turnCompleted(h: ReturnType<typeof harness>, sessionId: string, startedAt: number): void {
  h.service.onDomainEvent({ type: "turn.started", sessionId, payload: {}, occurredAt: new Date(startedAt).toISOString() });
  h.service.onDomainEvent({ type: "turn.completed", sessionId, payload: { reason: "done" }, occurredAt: new Date(startedAt + 5000).toISOString() });
}

describe("CoordinationService：claim/release/conflicts", () => {
  test("claim → active + coord.claimed 事件；幂等重入不重复发事件", () => {
    const h = harness();
    const r1 = h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "改调度器" });
    expect(r1.lease.status).toBe("active");
    expect(r1.conflicts).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "coord.claimed")).toHaveLength(1);
    const r2 = h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "继续" });
    expect(r2.deduplicated).toBe(true);
    expect(r2.lease.leaseId).toBe(r1.lease.leaseId);
    expect(h.events.filter((e) => e.type === "coord.claimed")).toHaveLength(1);
  });

  test("跨会话同项目 claim → 冲突面返回 + 双租约并存（永不拒绝）", () => {
    const h = harness();
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "A 的意图" });
    const rb = h.service.claim({ ownerSessionId: "b", ownerAgentId: "b-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "B 的意图" });
    expect(rb.conflicts).toHaveLength(1);
    expect(rb.conflicts[0]!.ownerSessionId).toBe("a");
    expect(rb.lease.status).toBe("active"); // 永不拒绝
    expect(h.service.leases().length).toBe(2);
  });

  test("不同项目不冲突；project/paths 前缀相交冲突；release 按范围", () => {
    const h = harness();
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "x" });
    const other = h.service.claim({ ownerSessionId: "b", ownerAgentId: "b-main", scope: { kind: "project", projectRoot: PROJ_B }, intent: "y" });
    expect(other.conflicts).toHaveLength(0);
    const sub = h.service.claim({
      ownerSessionId: "c",
      ownerAgentId: "c-main",
      scope: { kind: "paths", patterns: [`${PROJ_A}/src`] },
      intent: "z",
    });
    expect(sub.conflicts).toHaveLength(1); // paths ⊂ project 前缀相交
    const { released } = h.service.release({ ownerSessionId: "a", scope: { kind: "project", projectRoot: PROJ_A } });
    expect(released).toBe(1);
    expect(h.events.some((e) => e.type === "coord.released")).toBe(true);
  });
});

describe("CoordinationService：undeclared 自动补登", () => {
  test("precise 写无租约覆盖 → 自动补登（项目范围）；同项目再写 → 刷新不重复", () => {
    const h = harness();
    h.service.onWriteFact(fact(`${PROJ_A}/src/a.ts`, 1100));
    const leases = h.service.leases();
    expect(leases).toHaveLength(1);
    expect(leases[0]!.source).toBe("undeclared");
    expect(leases[0]!.scope).toEqual({ kind: "project", projectRoot: PROJ_A });
    expect(h.events.some((e) => e.type === "coord.undeclared")).toBe(true);
    h.service.onWriteFact(fact(`${PROJ_A}/src/b.ts`, 1200));
    expect(h.service.leases()).toHaveLength(1);
    expect(h.service.leases()[0]!.lastActivityAt).toBe(1200);
  });

  test("uncertain 写不触发；已有租约覆盖 → 刷新活跃时刻不新建", () => {
    const h = harness();
    h.service.onWriteFact(fact(`${PROJ_A}/x.ts`, 1100, "uncertain"));
    expect(h.service.leases()).toHaveLength(0);
    h.service.claim({ ownerSessionId: "sess-a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "声明" });
    h.service.onWriteFact(fact(`${PROJ_A}/y.ts`, 1300));
    expect(h.service.leases()).toHaveLength(1);
    expect(h.service.leases()[0]!.source).toBe("claimed");
    expect(h.service.leases()[0]!.lastActivityAt).toBe(1300);
  });

  test("inferred 写（bash 感知）触发补登", () => {
    const h = harness();
    h.service.onWriteFact(fact(`${PROJ_B}/main.ts`, 1100, "inferred"));
    expect(h.service.leases()).toHaveLength(1);
  });
});

describe("CoordinationService：轮末机械对账", () => {
  test("plan 全 resolve + 本轮无新写 → settled + coord.settled 事件", () => {
    const h = harness({ resolved: true });
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "改" });
    turnCompleted(h, "a", 900); // 写时刻 0（无写史）< turn 起点
    expect(h.service.leases({ includeSettled: true })[0]!.status).toBe("settled");
    expect(h.events.some((e) => e.type === "coord.settled")).toBe(true);
  });

  test("台账未结 → 保持 active（系统只记事实）", () => {
    const h = harness({ resolved: false });
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "改" });
    turnCompleted(h, "a", 900);
    expect(h.service.leases()[0]!.status).toBe("active");
  });

  test("本轮有新写（写入事实）→ 保持 active", () => {
    const h = harness({ resolved: true });
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "改" });
    h.writeFacts.record(fact(`${PROJ_A}/src/new.ts`, 1200, "precise", "a")); // turn 起点 900 之后
    turnCompleted(h, "a", 900);
    expect(h.service.leases()[0]!.status).toBe("active");
  });

  test("settled 不阻塞：后来者 claim 同范围无冲突；TTL 过期物理删", () => {
    const h = harness({ resolved: true, settleTtlMs: 10_000 });
    const r1 = h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "改" });
    turnCompleted(h, "a", 900);
    const rb = h.service.claim({ ownerSessionId: "b", ownerAgentId: "b-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "接手" });
    expect(rb.conflicts).toHaveLength(0); // settled 不构成冲突面
    h.advance(20_000);
    h.service.leases(); // 触发 sweep
    expect(h.service.leases().some((l) => l.leaseId === r1.lease.leaseId)).toBe(false); // 物理删
  });
});

describe("CoordinationService：生命周期四口", () => {
  test("isolated 租约：worktree 登记 → 终态摘执行者 → 清空即释放", () => {
    const h = harness();
    h.service.onWorktree({ sessionId: "a", executorId: "agent-1", worktreeRoot: "/ws/.worktrees/projA-x1" });
    expect(h.service.leases()).toHaveLength(1);
    expect(h.service.leases()[0]!.source).toBe("isolated");
    h.service.onSubagentSettled("agent-1");
    expect(h.service.leases()).toHaveLength(0);
    expect(h.events.some((e) => e.type === "coord.released")).toBe(true);
  });

  test("agent 终态事件（fanout coord-bridge 兜底）同款摘除", () => {
    const h = harness();
    h.service.onWorktree({ sessionId: "a", executorId: "agent-1", worktreeRoot: "/ws/.worktrees/projA-x1" });
    h.service.onDomainEvent({
      type: "agent.completed",
      sessionId: "a",
      instanceId: "agent-1",
      payload: { agentId: "agent-1", closure: { status: "done", summary: "" } },
      occurredAt: new Date(1500).toISOString(),
    });
    expect(h.service.leases()).toHaveLength(0);
  });

  test("agent.stalled → 该执行者租约标 stale（仍阻塞但可见闲置）", () => {
    const h = harness();
    h.service.onWorktree({ sessionId: "a", executorId: "agent-1", worktreeRoot: "/ws/.worktrees/projA-x1" });
    h.service.onDomainEvent({
      type: "agent.stalled",
      sessionId: "a",
      instanceId: "agent-1",
      payload: { agentId: "agent-1", idleMs: 600000 },
      occurredAt: new Date(1500).toISOString(),
    });
    expect(h.service.leases()[0]!.status).toBe("stale");
  });

  test("会话销毁 → 该会话租约全释放", () => {
    const h = harness();
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "x" });
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_B }, intent: "y" });
    h.service.onSessionGone("a");
    expect(h.service.leases()).toHaveLength(0);
  });

  test("超长闲置 → ghost 降级（不阻塞后来者）", () => {
    const h = harness({ ghostAfterMs: 1000 });
    h.service.claim({ ownerSessionId: "a", ownerAgentId: "a-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "x" });
    h.advance(5000);
    const rb = h.service.claim({ ownerSessionId: "b", ownerAgentId: "b-main", scope: { kind: "project", projectRoot: PROJ_A }, intent: "接手" });
    expect(rb.conflicts).toHaveLength(0); // ghost 不阻塞
  });
});

describe("OccupancyLease 纯函数", () => {
  test("/private 前缀折叠与路径归一", async () => {
    const { normalizeScopePath, scopesOverlap, scopeCoversPath } = await import("../../src/domain/agent/OccupancyLease");
    expect(normalizeScopePath("/private/var/tmp/")).toBe("/var/tmp");
    expect(normalizeScopePath("/ws//a/")).toBe("/ws/a");
    expect(scopesOverlap({ kind: "project", projectRoot: "/var/folders/x" }, { kind: "project", projectRoot: "/private/var/folders/x" })).toBe(true);
    expect(scopeCoversPath({ kind: "project", projectRoot: "/ws/projA" }, "/ws/projA/src/a.ts")).toBe(true);
    expect(scopeCoversPath({ kind: "project", projectRoot: "/ws/projA" }, "/ws/projAB/c.ts")).toBe(false);
    expect(scopesOverlap({ kind: "paths", patterns: ["/ws/a/src"] }, { kind: "project", projectRoot: "/ws/a" })).toBe(true);
    expect(scopesOverlap({ kind: "paths", patterns: ["/ws/a"] }, { kind: "paths", patterns: ["/ws/b"] })).toBe(false);
  });
});

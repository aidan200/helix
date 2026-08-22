import { describe, expect, test } from "bun:test";
// T3.1 投影收敛：normalize/分页常量单源 @helix/protocol projection（原
// domain TraceQuery 迁出——仅 import 换源，期望值零改动）；assemble* 仍在 domain。
import {
  TRACE_PAGE_DEFAULT,
  TRACE_PAGE_MAX,
  hasMoreBefore,
  normalizeTraceQuery,
} from "@helix/protocol";
import {
  assembleExecutionContext,
  assembleInstancePanel,
  type InstanceAggregateRow,
  type TraceEventRowData,
} from "../../src/domain/trace/TraceQuery";

/**
 * domain/trace（unit，契约 v0.4 + architecture.md §3.5b 伪代码级设计）：
 * ① normalizeTraceQuery（T3.1 起单源 @helix/protocol projection，此处经
 *    协议包引用保持同等价对账）：必填缺失 / limit 鉗制 / timeRange 矛盾拒绝；
 * ② assembleExecutionContext：instantiated + model.changed + compaction 序列 fold；
 *    无 instantiated → snapshotMissing；单发 Sub 无变更 → 纯快照；
 * ③ assembleInstancePanel：主 + 多 Sub 混合 → InstanceRecord 字段齐全
 *    （status/起止/eventCount/snapshot）；无 instantiated 退化首事件 ts；
 * ④ hasMoreBefore：rows.length === limit 即可能还有更早页。
 */

function row(partial: Partial<TraceEventRowData> & Pick<TraceEventRowData, "id" | "type">): TraceEventRowData {
  return {
    ts: `2026-08-19T00:00:${String(partial.id).padStart(2, "0")}.000Z`,
    sessionId: "s1",
    instanceId: "main",
    agentKind: "main",
    payload: {},
    ...partial,
  };
}

const MAIN_SNAPSHOT = {
  systemPrompt: "你是 helix 的主会话助手。（全文）",
  tools: ["bash", "read"],
  model: "zhipu/glm-4.6",
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
};

describe("① normalizeTraceQuery 校验与缺省", () => {
  test("sessionId 必填：缺失/空串/非 string 一律拒绝", () => {
    expect(() => normalizeTraceQuery({})).toThrow(/sessionId/);
    expect(() => normalizeTraceQuery({ sessionId: "" })).toThrow(/sessionId/);
    expect(() => normalizeTraceQuery({ sessionId: 42 })).toThrow(/sessionId/);
    expect(() => normalizeTraceQuery(null)).toThrow(/sessionId/);
  });

  test("全缺省 → 归一形态（null 缺省维 + limit 50 + beforeId null）", () => {
    expect(normalizeTraceQuery({ sessionId: "s1" })).toEqual({
      sessionId: "s1",
      instanceIds: null,
      agentKind: null,
      types: null,
      timeRange: null,
      page: { limit: TRACE_PAGE_DEFAULT, beforeId: null },
    });
  });

  test("limit 鉗制：>200 鉗到 200；非正整数/非整数拒绝；缺省 50", () => {
    expect(normalizeTraceQuery({ sessionId: "s1", page: { limit: 500 } }).page.limit).toBe(TRACE_PAGE_MAX);
    expect(normalizeTraceQuery({ sessionId: "s1", page: { limit: 1 } }).page.limit).toBe(1);
    expect(() => normalizeTraceQuery({ sessionId: "s1", page: { limit: 0 } })).toThrow(/limit/);
    expect(() => normalizeTraceQuery({ sessionId: "s1", page: { limit: -3 } })).toThrow(/limit/);
    expect(() => normalizeTraceQuery({ sessionId: "s1", page: { limit: 1.5 } })).toThrow(/limit/);
    expect(() => normalizeTraceQuery({ sessionId: "s1", page: { limit: "50" } })).toThrow(/limit/);
  });

  test("beforeId 游标：正整数合法；非正整数拒绝", () => {
    expect(normalizeTraceQuery({ sessionId: "s1", page: { beforeId: 428 } }).page.beforeId).toBe(428);
    expect(() => normalizeTraceQuery({ sessionId: "s1", page: { beforeId: 0 } })).toThrow(/beforeId/);
    expect(() => normalizeTraceQuery({ sessionId: "s1", page: { beforeId: -1 } })).toThrow(/beforeId/);
  });

  test("timeRange 含起含止：from > to 矛盾拒绝；单边窗合法", () => {
    expect(() =>
      normalizeTraceQuery({
        sessionId: "s1",
        timeRange: { from: "2026-08-19T02:00:00.000Z", to: "2026-08-19T01:00:00.000Z" },
      }),
    ).toThrow(/timeRange|时间/);
    const half = normalizeTraceQuery({ sessionId: "s1", timeRange: { from: "2026-08-19T01:00:00.000Z" } });
    expect(half.timeRange).toEqual({ from: "2026-08-19T01:00:00.000Z", to: null });
  });

  test("instanceIds/types：空数组 = 空结果（显式保留不展开）；非 string 元素拒绝", () => {
    const empty = normalizeTraceQuery({ sessionId: "s1", instanceIds: [], types: [] });
    expect(empty.instanceIds).toEqual([]);
    expect(empty.types).toEqual([]);
    expect(() => normalizeTraceQuery({ sessionId: "s1", instanceIds: ["main", 7] })).toThrow(/instanceIds/);
    expect(() => normalizeTraceQuery({ sessionId: "s1", types: "message.completed" })).toThrow(/types/);
  });

  test("agentKind 目录外值拒绝", () => {
    expect(normalizeTraceQuery({ sessionId: "s1", agentKind: "subagent" }).agentKind).toBe("subagent");
    expect(() => normalizeTraceQuery({ sessionId: "s1", agentKind: "bot" })).toThrow(/agentKind/);
  });
});

describe("② assembleExecutionContext 纯 fold", () => {
  test("instantiated + model.changed×2 + compaction → 快照/时间线升序/当前值/里程碑", () => {
    const ctx = assembleExecutionContext([
      row({ id: 1, type: "agent.instantiated", payload: { instanceId: "main", profileKind: "main-session", profileSnapshot: MAIN_SNAPSHOT } }),
      row({ id: 5, type: "agent.model.changed", payload: { instanceId: "main", from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat" } }),
      row({ id: 3, type: "agent.model.changed", payload: { instanceId: "main", from: "a/a", to: "zhipu/glm-4.6" } }), // id 乱序：按 ts 排（id3 的 ts 早于 id5）
      row({ id: 8, type: "compaction.completed", payload: { entry: { tokensBefore: 96412, tokensAfter: 38200 } } }),
    ]);
    expect(ctx.snapshotMissing).toBe(false);
    expect(ctx.snapshot?.systemPrompt).toBe(MAIN_SNAPSHOT.systemPrompt);
    expect(ctx.modelTimeline.map((c) => [c.from, c.to])).toEqual([
      ["a/a", "zhipu/glm-4.6"],
      ["zhipu/glm-4.6", "deepseek/deepseek-chat"],
    ]);
    expect(ctx.currentModel).toBe("deepseek/deepseek-chat"); // 末条 to
    expect(ctx.compactionMilestones).toEqual([
      { at: "2026-08-19T00:00:08.000Z", tokensBefore: 96412, tokensAfter: 38200 },
    ]);
  });

  test("无 instantiated → snapshotMissing=true 不 throw；currentModel 退化时间线末条", () => {
    const ctx = assembleExecutionContext([
      row({ id: 2, type: "agent.model.changed", payload: { instanceId: "main", from: "a/a", to: "b/b" } }),
    ]);
    expect(ctx.snapshotMissing).toBe(true);
    expect(ctx.snapshot).toBeUndefined();
    expect(ctx.currentModel).toBe("b/b");
  });

  test("单发 Sub 无变更 → 纯快照（时间线空、currentModel = 快照 model）", () => {
    const ctx = assembleExecutionContext([
      row({
        id: 1,
        type: "agent.instantiated",
        instanceId: "agent-1",
        agentKind: "subagent",
        payload: { instanceId: "agent-1", profileKind: "subagent-worker", profileSnapshot: { systemPrompt: "sub", tools: ["bash"], model: "zai/glm-5.3" } },
      }),
    ]);
    expect(ctx.snapshotMissing).toBe(false);
    expect(ctx.modelTimeline).toEqual([]);
    expect(ctx.currentModel).toBe("zai/glm-5.3");
    expect(ctx.compactionMilestones).toEqual([]);
  });

  test("空事件流 → snapshotMissing + 全空", () => {
    const ctx = assembleExecutionContext([]);
    expect(ctx.snapshotMissing).toBe(true);
    expect(ctx.modelTimeline).toEqual([]);
    expect(ctx.currentModel).toBeUndefined();
  });
});

describe("③ assembleInstancePanel 面板 fold", () => {
  const aggregates: InstanceAggregateRow[] = [
    { instanceId: "main", agentKind: "main", firstTs: "2026-08-19T00:00:01.000Z", lastTs: "2026-08-19T00:00:30.000Z", eventCount: 12 },
    { instanceId: "agent-1", agentKind: "subagent", firstTs: "2026-08-19T00:00:05.000Z", lastTs: "2026-08-19T00:00:20.000Z", eventCount: 7 },
    { instanceId: "agent-2", agentKind: "subagent", firstTs: "2026-08-19T00:00:06.000Z", lastTs: "2026-08-19T00:00:25.000Z", eventCount: 3 },
  ];
  const lifecycle: TraceEventRowData[] = [
    row({ id: 1, type: "agent.instantiated", payload: { instanceId: "main", profileKind: "main-session", profileSnapshot: MAIN_SNAPSHOT } }),
    row({ id: 5, type: "agent.spawned", instanceId: "agent-1", agentKind: "subagent", payload: { agentId: "agent-1", task: "任务一", profileKind: "subagent-worker", model: "zai/glm-5.3" } }),
    row({ id: 6, type: "agent.instantiated", instanceId: "agent-1", agentKind: "subagent", payload: { instanceId: "agent-1", profileKind: "subagent-worker", profileSnapshot: { systemPrompt: "sub", tools: ["bash"], model: "zai/glm-5.3" } } }),
    row({ id: 20, type: "agent.completed", instanceId: "agent-1", agentKind: "subagent", payload: { agentId: "agent-1", closure: { status: "done" } } }),
    row({ id: 7, type: "agent.spawned", instanceId: "agent-2", agentKind: "subagent", payload: { agentId: "agent-2", task: "任务二", profileKind: "phase-coder" } }),
    row({ id: 25, type: "agent.killed", instanceId: "agent-2", agentKind: "subagent", payload: { agentId: "agent-2", closure: { status: "failed" } } }),
    row({ id: 28, type: "agent.model.changed", payload: { instanceId: "main", from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat" } }),
  ];

  test("主 + 多 Sub 混合：字段齐全（status/起止/eventCount/snapshot/task/时间线）", () => {
    const panel = assembleInstancePanel(aggregates, lifecycle);
    expect(panel.map((r) => r.instanceId)).toEqual(["main", "agent-1", "agent-2"]); // main 优先 + 启动序

    const main = panel[0]!;
    expect(main.status).toBe("running"); // 无终态事件
    expect(main.profileKind).toBe("main-session");
    expect(main.snapshotMissing).toBe(false);
    expect(main.snapshot?.model).toBe("zhipu/glm-4.6");
    expect(main.eventCount).toBe(12);
    expect(main.startedAt).toBe("2026-08-19T00:00:01.000Z"); // instantiated ts
    expect(main.endedAt).toBeUndefined();
    expect(main.modelTimeline?.map((c) => c.to)).toEqual(["deepseek/deepseek-chat"]);
    expect(main.currentModel).toBe("deepseek/deepseek-chat");

    const sub1 = panel[1]!;
    expect(sub1.status).toBe("completed");
    expect(sub1.endedAt).toBe("2026-08-19T00:00:20.000Z");
    expect(sub1.task).toBe("任务一");
    expect(sub1.snapshot?.systemPrompt).toBe("sub");
    expect(sub1.eventCount).toBe(7);

    const sub2 = panel[2]!;
    expect(sub2.status).toBe("killed");
    expect(sub2.task).toBe("任务二");
    expect(sub2.profileKind).toBe("phase-coder"); // spawned 载荷退化
    expect(sub2.snapshotMissing).toBe(true); // 无 instantiated
    expect(sub2.snapshot).toBeUndefined();
    expect(sub2.startedAt).toBe("2026-08-19T00:00:07.000Z"); // spawned ts（id7 → ts 07 秒）
  });

  test("无 instantiated 无 spawned（历史遗留行）→ 退化首事件 ts + 缺省 profileKind", () => {
    const panel = assembleInstancePanel(
      [{ instanceId: "main", agentKind: "main", firstTs: "2026-08-10T00:00:00.000Z", lastTs: "2026-08-10T01:00:00.000Z", eventCount: 4 }],
      [],
    );
    expect(panel[0]).toMatchObject({
      instanceId: "main",
      agentKind: "main",
      profileKind: "main-session", // 主实例缺省
      status: "running",
      startedAt: "2026-08-10T00:00:00.000Z",
      eventCount: 4,
      snapshotMissing: true,
    });
  });

  test("failed 终态映射 + model 退化 spawn 透传值（无快照时）", () => {
    const panel = assembleInstancePanel(
      [{ instanceId: "agent-9", agentKind: "subagent", firstTs: "2026-08-19T00:00:01.000Z", lastTs: "2026-08-19T00:00:09.000Z", eventCount: 5 }],
      [
        row({ id: 1, type: "agent.spawned", instanceId: "agent-9", agentKind: "subagent", ts: "2026-08-19T00:00:01.000Z", payload: { agentId: "agent-9", task: "t", profileKind: "subagent-worker", model: "zai/glm-5.3" } }),
        row({ id: 9, type: "agent.failed", instanceId: "agent-9", agentKind: "subagent", ts: "2026-08-19T00:00:09.000Z", payload: { agentId: "agent-9", error: "boom", closure: { status: "failed" } } }),
      ],
    );
    expect(panel[0]?.status).toBe("failed");
    expect(panel[0]?.model).toBe("zai/glm-5.3"); // spawn 透传退化
    expect(panel[0]?.currentModel).toBe("zai/glm-5.3");
  });
});

describe("④ hasMoreBefore 判据", () => {
  test("rows.length === limit 即可能还有更早页；不足 limit 收口", () => {
    expect(hasMoreBefore(50, 50)).toBe(true);
    expect(hasMoreBefore(49, 50)).toBe(false);
    expect(hasMoreBefore(0, 50)).toBe(false);
  });
});

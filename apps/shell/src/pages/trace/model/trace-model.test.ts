/**
 * P-1 TracePage 页面私有状态模型纯单测（CL-5；T2.2 RED）。
 *
 * 测试点映射（task-T2.2-brief RED 清单 1-6）：
 * 1. 五态互斥转换 + 新查询清旧态（loading/error/empty/success + devForce 覆盖；
 *    断连 overlay 正交 = conn 不进本 reducer，由组件从会话门面派生）；
 * 2. 组合过滤交集语义（类型类目 toggle 映射）+ 单飞 filterEcho 迟到结果丢弃；
 * 3. 分页游标步进 / hasMore 收口 / 筛选变更重置（游标 + 展开态 + 提示词折叠）；
 * 4. 手风琴单开（openId 单值）；
 * 5. 上下文卡纯函数：变更轨迹 fold（modelTimeline + compaction 里程碑合并
 *    升序、当前模型高亮）、单发 Sub 退化（无变更 = 空轨迹）、快照降级字段透传；
 * 6. 实例面板 fold：名称（主=mainName / Sub=task 截断 / 缺 task 退化 id）、
 *    起止时间结构、状态类目、计数汇总。
 * 纯函数纪律（AG-14 同规）：无 IO / 无 Date.now（参考零点与 now 均由调用方注入）。
 */
import { describe, expect, it } from "vitest";
import type {
  TraceEventRow,
  TraceInstanceRecord,
  TraceQueryFilterEcho,
} from "@helix/protocol";
import {
  ALL_TRACE_TYPES,
  TRACE_PAGE_SIZE,
  TRACE_TYPE_CATEGORIES,
  buildTimelineRows,
  buildTraceQuery,
  categoryOfType,
  createTracePageState,
  echoMatches,
  instanceTimes,
  instanceDisplayName,
  isCategoryOn,
  selectTraceView,
  summarizeTraceEvent,
  toggleTypeCategory,
  traceReducer,
  type TraceFilter,
  type TracePageState,
} from "./trace-model";

// ── fixtures ────────────────────────────────────────────────

const TS0 = Date.parse("2026-08-19T14:00:00.000+08:00");

function mkRow(id: number, over: Partial<TraceEventRow> = {}): TraceEventRow {
  return {
    id,
    ts: new Date(TS0 + id * 1000).toISOString(),
    sessionId: "ses_a",
    instanceId: "main",
    agentKind: "main",
    type: "message.completed",
    payload: { role: "assistant", text: `m${id}` },
    ...over,
  };
}

function mkInstance(over: Partial<TraceInstanceRecord> = {}): TraceInstanceRecord {
  return {
    instanceId: "main",
    agentKind: "main",
    profileKind: "main-session",
    model: "zhipu/glm-4.6",
    status: "running",
    startedAt: new Date(TS0).toISOString(),
    eventCount: 3,
    snapshotMissing: false,
    ...over,
  };
}

const BASE_FILTER: TraceFilter = {
  sessionId: "ses_a",
  instanceId: null,
  types: null,
  rangeSec: null,
};

function startQuery(s: TracePageState, filter: TraceFilter = BASE_FILTER, scope: "session" | "filter" = "filter") {
  const { echo } = buildTraceQuery(filter, s.latestEventTs, null);
  return traceReducer(s, { type: "query-started", filter, echo, scope });
}

function feedResult(
  s: TracePageState,
  over: { rows?: TraceEventRow[]; total?: number; hasMore?: boolean; echo?: TraceQueryFilterEcho; instances?: TraceInstanceRecord[] } = {},
) {
  const echo = over.echo ?? s.pending!;
  return traceReducer(s, {
    type: "query-result",
    echo,
    instances: over.instances ?? [mkInstance()],
    rows: over.rows ?? [mkRow(3), mkRow(2), mkRow(1)],
    page: { loaded: (over.rows ?? [1]).length, total: over.total ?? 3, hasMore: over.hasMore ?? false },
  });
}

// ── 1. 五态互斥 + 新查询清旧态 ──────────────────────────────

describe("1. 五态互斥转换与新查询清旧态", () => {
  it("初始 idle → query-started → loading（清 errorReason/分页/展开/提示词）", () => {
    const s0 = createTracePageState();
    expect(selectTraceView(s0)).toBe("idle");
    const dirty: TracePageState = {
      ...s0,
      view: "error",
      errorReason: "boom",
      events: [mkRow(1)],
      openId: 1,
      promptOpen: true,
      hasMore: true,
    };
    const s1 = traceReducer(dirty, {
      type: "query-started",
      filter: BASE_FILTER,
      echo: buildTraceQuery(BASE_FILTER, null, null).echo,
      scope: "filter",
    });
    expect(s1.view).toBe("loading");
    expect(s1.errorReason).toBeNull();
    expect(s1.events).toEqual([]);
    expect(s1.openId).toBeNull();
    expect(s1.promptOpen).toBe(false);
    expect(s1.hasMore).toBe(false);
    expect(s1.pending).not.toBeNull();
  });

  it("loading + 结果 rows>0 → success（互斥：error/empty 不同时成立）", () => {
    const s = feedResult(startQuery(createTracePageState()));
    expect(s.view).toBe("success");
    expect(s.events.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(s.total).toBe(3);
    expect(s.errorReason).toBeNull();
    expect(s.pending).toBeNull();
  });

  it("loading + total=0 无筛选 echo → empty / flavor=session；带筛选 echo → flavor=filtered", () => {
    const s1 = feedResult(startQuery(createTracePageState()), { rows: [], total: 0 });
    expect(s1.view).toBe("empty");
    expect(s1.emptyFlavor).toBe("session");

    const filtered: TraceFilter = { ...BASE_FILTER, types: ["engine.error"] };
    const s2 = feedResult(startQuery(createTracePageState(), filtered), { rows: [], total: 0 });
    expect(s2.view).toBe("empty");
    expect(s2.emptyFlavor).toBe("filtered");
  });

  it("loading + query-failed → error（reason 记录）；再次 query-started 清 error 回 loading", () => {
    const s1 = traceReducer(startQuery(createTracePageState()), {
      type: "query-failed",
      reason: "trace.query: SQLITE_BUSY",
    });
    expect(s1.view).toBe("error");
    expect(s1.errorReason).toBe("trace.query: SQLITE_BUSY");
    expect(s1.pending).toBeNull();
    const s2 = startQuery(s1);
    expect(s2.view).toBe("loading");
    expect(s2.errorReason).toBeNull();
  });

  it("dev-set-view 覆盖 selectTraceView；null 解除（演示控制台门控面）", () => {
    const s0 = feedResult(startQuery(createTracePageState()));
    const s1 = traceReducer(s0, { type: "dev-set-view", view: "loading" });
    expect(selectTraceView(s1)).toBe("loading");
    expect(s1.view).toBe("success"); // 底层态不被演示控件污染
    const s2 = traceReducer(s1, { type: "dev-set-view", view: null });
    expect(selectTraceView(s2)).toBe("success");
  });
});

// ── 2. 单飞 filterEcho + 组合过滤交集 ──────────────────────

describe("2. 单飞 filterEcho 迟到结果丢弃 + 类型类目交集", () => {
  it("echoMatches：全维相等（types 顺序不敏感）；任一维不同即不匹配", () => {
    const a = buildTraceQuery(BASE_FILTER, null, null).echo;
    expect(echoMatches(a, { ...a })).toBe(true);
    expect(echoMatches(a, { ...a, sessionId: "ses_b" })).toBe(false);
    expect(echoMatches(a, { ...a, instanceIds: ["main"] })).toBe(false);
    expect(echoMatches(a, { ...a, types: ["engine.error"] })).toBe(false);
    expect(echoMatches(a, { ...a, page: { limit: TRACE_PAGE_SIZE, beforeId: 42 } })).toBe(false);
    const t1 = buildTraceQuery({ ...BASE_FILTER, types: ["engine.error", "message.completed"] }, null, null).echo;
    const t2 = buildTraceQuery({ ...BASE_FILTER, types: ["message.completed", "engine.error"] }, null, null).echo;
    expect(echoMatches(t1, t2)).toBe(true); // 集合语义：顺序漂移不构成不匹配
  });

  it("单飞：A 在途时发起 B → A 的迟到结果被丢弃（状态保持 B 的 loading）", () => {
    const s1 = startQuery(createTracePageState());
    const pendingA = s1.pending!;
    const fB: TraceFilter = { ...BASE_FILTER, instanceId: "main" };
    const s2 = startQuery(s1, fB);
    const s3 = feedResult(s2, { echo: pendingA }); // A 迟到
    expect(s3.view).toBe("loading");
    expect(s3.events).toEqual([]);
    expect(s3.pending).toBe(s2.pending);
  });

  it("无在途查询时的结果帧丢弃（pending null）", () => {
    const s0 = feedResult(startQuery(createTracePageState()));
    const again = feedResult(s0, { echo: buildTraceQuery(BASE_FILTER, null, null).echo, rows: [mkRow(9)], total: 9 });
    expect(again.events.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("类型类目 toggle：null（全选）关一类目 → 具体清单减除；全部类目在 → 归一 null；空集保留（契约空数组=空结果）", () => {
    const tool = TRACE_TYPE_CATEGORIES.find((c) => c.key === "tool")!;
    const off = toggleTypeCategory(null, tool);
    expect(off).not.toBeNull();
    expect(off!.some((t) => tool.types.includes(t))).toBe(false);
    expect(off!.length).toBe(ALL_TRACE_TYPES.length - tool.types.length);
    const back = toggleTypeCategory(off, tool);
    expect(back).toBeNull(); // 全量归一 null（缺省 = 全部类型）
    expect(isCategoryOn(null, tool)).toBe(true);
    expect(isCategoryOn(off, tool)).toBe(false);
    // 逐类关闭直到空集
    let cur: string[] | null = null;
    for (const c of TRACE_TYPE_CATEGORIES) cur = toggleTypeCategory(cur, c);
    expect(cur).toEqual([]);
  });

  it("buildTraceQuery：instanceId/types/timeRange 三维下推 + echo 归一（缺省维 null）", () => {
    const latest = new Date(TS0).toISOString();
    const f: TraceFilter = { sessionId: "ses_a", instanceId: "agt_X", types: ["engine.error"], rangeSec: 300 };
    const { payload, echo } = buildTraceQuery(f, latest, null);
    expect(payload.instanceIds).toEqual(["agt_X"]);
    expect(payload.types).toEqual(["engine.error"]);
    expect(payload.timeRange).toEqual({
      from: new Date(TS0 - 300_000).toISOString(),
      to: latest, // 参考零点 = 会话最新事件 ts（含起含止下推）
    });
    expect(payload.page).toEqual({ limit: TRACE_PAGE_SIZE });
    expect(echo.page).toEqual({ limit: TRACE_PAGE_SIZE, beforeId: null });
    expect(echo.timeRange).toEqual(payload.timeRange);
    expect(echo.agentKind).toBeNull();
    // rangeSec 设定但 latestEventTs 未知（尚无全量结果）→ 不下推时间窗
    const noRef = buildTraceQuery(f, null, null);
    expect(noRef.payload.timeRange).toBeUndefined();
    expect(noRef.echo.timeRange).toBeNull();
  });
});

// ── 3. 分页游标步进 / 收口 / 筛选重置 ──────────────────────

describe("3. 分页（beforeId 游标步进 / hasMore 收口 / 筛选变更重置）", () => {
  it("page-started → 追加结果（按 id 去重拼接）；hasMore=false 收口", () => {
    const rows1 = [mkRow(100), mkRow(99), mkRow(98)];
    let s = feedResult(startQuery(createTracePageState()), { rows: rows1, total: 6, hasMore: true });
    expect(s.hasMore).toBe(true);
    const cursor = s.events[s.events.length - 1]!.id; // 98
    const { echo } = buildTraceQuery(BASE_FILTER, s.latestEventTs, cursor);
    s = traceReducer(s, { type: "page-started", echo });
    expect(s.loadingMore).toBe(true);
    expect(s.view).toBe("success"); // 追加不中断 success 态
    s = traceReducer(s, {
      type: "query-result",
      echo,
      instances: s.instances,
      rows: [mkRow(98), mkRow(97), mkRow(96)], // 98 重复（防御性去重）
      page: { loaded: 3, total: 6, hasMore: false },
    });
    expect(s.events.map((r) => r.id)).toEqual([100, 99, 98, 97, 96]);
    expect(s.hasMore).toBe(false);
    expect(s.loadingMore).toBe(false);
  });

  it("追加页 echo 不匹配（维度已变）→ 丢弃不追加", () => {
    let s = feedResult(startQuery(createTracePageState()), { hasMore: true, total: 9 });
    const { echo } = buildTraceQuery(BASE_FILTER, s.latestEventTs, 1);
    s = traceReducer(s, { type: "page-started", echo });
    const stale = { ...echo, types: ["engine.error"] };
    const after = traceReducer(s, {
      type: "query-result",
      echo: stale,
      instances: s.instances,
      rows: [mkRow(0)],
      page: { loaded: 1, total: 9, hasMore: true },
    });
    expect(after.events.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(after.loadingMore).toBe(true); // 在途追加未被错误收口
  });

  it("追加失败（query-failed while loadingMore）→ 保持 success 与已加载事件，仅清在途", () => {
    let s = feedResult(startQuery(createTracePageState()), { hasMore: true, total: 9 });
    const { echo } = buildTraceQuery(BASE_FILTER, s.latestEventTs, 1);
    s = traceReducer(s, { type: "page-started", echo });
    s = traceReducer(s, { type: "query-failed", reason: "net" });
    expect(s.view).toBe("success");
    expect(s.events.length).toBe(3);
    expect(s.loadingMore).toBe(false);
    expect(s.pending).toBeNull();
  });

  it("筛选变更（query-started scope=filter）重置游标累积与展开态；会话变更（scope=session）连 instances/latestEventTs 一并清空", () => {
    let s = feedResult(startQuery(createTracePageState()), { hasMore: true, total: 9 });
    s = traceReducer(s, { type: "toggle-row", id: 2 });
    s = traceReducer(s, { type: "toggle-prompt" });
    s = startQuery(s, { ...BASE_FILTER, instanceId: "main" }, "filter");
    expect(s.events).toEqual([]);
    expect(s.openId).toBeNull();
    expect(s.promptOpen).toBe(false);
    expect(s.instances.length).toBe(1); // 同会话筛选变更保留面板（防闪烁）
    expect(s.latestEventTs).not.toBeNull();

    const s2 = feedResult(startQuery(createTracePageState()), { rows: [mkRow(5)], total: 1 });
    expect(s2.latestEventTs).toBe(mkRow(5).ts); // 无筛选 fresh 结果锚定参考零点
    const s3 = startQuery(s2, { ...BASE_FILTER, sessionId: "ses_b" }, "session");
    expect(s3.instances).toEqual([]);
    expect(s3.latestEventTs).toBeNull();
  });
});

// ── 4. 手风琴单开 ──────────────────────────────────────────

describe("4. 手风琴单开（openId 单值）", () => {
  it("开行 → 开另一行收前行 → 再点收当前", () => {
    let s = feedResult(startQuery(createTracePageState()));
    s = traceReducer(s, { type: "toggle-row", id: 3 });
    expect(s.openId).toBe(3);
    s = traceReducer(s, { type: "toggle-row", id: 2 });
    expect(s.openId).toBe(2);
    s = traceReducer(s, { type: "toggle-row", id: 2 });
    expect(s.openId).toBeNull();
  });
});

// ── 5. 上下文卡纯函数（变更轨迹 fold / 单发 Sub 退化 / 摘要）──

describe("5. 上下文卡（AD-6 双段数据源 fold）", () => {
  it("buildTimelineRows：modelTimeline + compaction 里程碑按 ts 升序合并；末条 model 变更标当前", () => {
    const rec = mkInstance({
      modelTimeline: [
        { from: "a/1", to: "b/2", at: new Date(TS0 + 10_000).toISOString() },
        { from: "b/2", to: "c/3", at: new Date(TS0 + 30_000).toISOString() },
      ],
      currentModel: "c/3",
    });
    const rows = buildTimelineRows(rec, [
      { at: new Date(TS0 + 20_000).toISOString(), tokensBefore: 96000, tokensAfter: 38000 },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["model", "compaction", "model"]);
    expect(rows[2]!.current).toBe(true);
    expect(rows[0]!.current).toBe(false);
    expect(rows[1]).toMatchObject({ tokensBefore: 96000, tokensAfter: 38000 });
  });

  it("单发 SubAgent（无 modelTimeline / 无 compaction 事件）→ 空轨迹（退化为纯快照）", () => {
    const sub = mkInstance({ instanceId: "agt_S", agentKind: "subagent", profileKind: "phase-coder" });
    expect(buildTimelineRows(sub, [])).toEqual([]);
  });

  it("summarizeTraceEvent：各类型摘要 + 类目映射", () => {
    expect(summarizeTraceEvent(mkRow(1))).toBe("assistant · m1");
    expect(summarizeTraceEvent(mkRow(1, { type: "tool.call.started", payload: { toolName: "read" } }))).toBe("call · read");
    expect(summarizeTraceEvent(mkRow(1, { type: "tool.call.result", payload: { toolName: "edit", isError: true } }))).toBe("result · edit · error");
    expect(summarizeTraceEvent(mkRow(1, { type: "engine.error", payload: { provider: "zai", model: "glm-5.3", status: 429, message: "quota" } }))).toBe("zai/glm-5.3 · 429 quota");
    expect(summarizeTraceEvent(mkRow(1, { type: "compaction.completed", payload: { tokensBefore: 96412, tokensAfter: 38200 } }))).toBe("compaction · 96,412 → 38,200 tok");
    expect(summarizeTraceEvent(mkRow(1, { type: "agent.model.changed", payload: { from: "a/1", to: "b/2" } }))).toBe("a/1 → b/2");
    expect(summarizeTraceEvent(mkRow(1, { type: "agent.instantiated", payload: { profileKind: "phase-coder" } }))).toBe("agent.instantiated · phase-coder");
    expect(summarizeTraceEvent(mkRow(1, { type: "turn.started", payload: {} }))).toBe("turn.started");
    expect(categoryOfType("engine.error")).toBe("engine.error");
    expect(categoryOfType("compaction.completed")).toBe("compaction");
    expect(categoryOfType("agent.model.changed")).toBe("model");
    expect(categoryOfType("tool.call.result")).toBe("tool");
    expect(categoryOfType("agent.spawned")).toBe("lifecycle");
  });

  it("快照降级：snapshotMissing=true 的记录 fold 不 throw（timeline/名称均可用）", () => {
    const legacy = mkInstance({ snapshotMissing: true, snapshot: undefined, model: undefined });
    expect(buildTimelineRows(legacy, [])).toEqual([]);
    expect(instanceDisplayName(legacy, "MAIN")).toBe("MAIN");
  });
});

// ── 6. 实例面板 fold ───────────────────────────────────────

describe("6. 实例面板 fold（名称 / 起止 / 类目）", () => {
  it("instanceDisplayName：主=mainName；Sub 有 task 截断 24 字符；无 task 退化 instanceId", () => {
    expect(instanceDisplayName(mkInstance(), "MAIN")).toBe("MAIN");
    const tasked = mkInstance({ instanceId: "agt_T", agentKind: "subagent", task: "x".repeat(40) });
    expect(instanceDisplayName(tasked, "MAIN")).toBe(`${"x".repeat(24)}…`);
    const bare = mkInstance({ instanceId: "agt_B", agentKind: "subagent" });
    expect(instanceDisplayName(bare, "MAIN")).toBe("agt_B");
  });

  it("instanceTimes：终态 = 起止 + 时长；running = 起点 + 相对参考点的已运行时长", () => {
    const done = mkInstance({
      status: "completed",
      startedAt: new Date(TS0).toISOString(),
      endedAt: new Date(TS0 + 65_000).toISOString(),
    });
    expect(instanceTimes(done, TS0 + 100_000)).toEqual({
      startMs: TS0,
      endMs: TS0 + 65_000,
      durationMs: 65_000,
    });
    const running = mkInstance({ status: "running", startedAt: new Date(TS0).toISOString() });
    expect(instanceTimes(running, TS0 + 30_000)).toEqual({
      startMs: TS0,
      endMs: null,
      durationMs: 30_000,
    });
  });
});

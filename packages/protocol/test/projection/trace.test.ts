import { describe, expect, test } from "bun:test";
import {
  TRACE_PAGE_DEFAULT,
  TRACE_PAGE_MAX,
  TraceQueryInvalidError,
  hasMoreBefore,
  normalizeTraceQuery,
  pageTraceEvents,
  type TraceEventRow,
} from "../../src/index";

/**
 * TP-3.1a trace 域纯函数单测（M4 投资批，iter-20260821-dg90 T3.1）。
 *
 * 期望值基线：
 * - normalizeTraceQuery/hasMoreBefore = daemon domain-trace.test.ts ①/④ 组
 *   （TraceQuery.ts 语义原样迁入；错误通道 = 协议自有 TraceQueryInvalidError，
 *   中文 message 与 daemon DomainError 版逐字保持——消费面 toThrow(/…/)
 *   正则断言零改动）；
 * - pageTraceEvents = fake-transport 过滤分页段语义（daemon SQL WHERE/ORDER
 *   BY id DESC/LIMIT 的内存等价：instanceIds includes / agentKind === /
 *   types includes / ts 含起含止字符串比较 / beforeId 严格小于 / slice
 *   limit / hasMore = paged.length === limit）。
 */

const iso = (offsetMs: number): string => new Date(Date.parse("2026-08-19T13:47:57.802+08:00") + offsetMs).toISOString();

function row(partial: Partial<TraceEventRow> & Pick<TraceEventRow, "id" | "type">): TraceEventRow {
  return {
    ts: iso(partial.id * 1000),
    sessionId: "s1",
    instanceId: "main",
    agentKind: "main",
    payload: {},
    ...partial,
  };
}

describe("trace 域：normalizeTraceQuery（基线 = daemon domain-trace.test.ts ①）", () => {
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

  test("校验失败抛协议自有 TraceQueryInvalidError（daemon 映射链消费：message 透传）", () => {
    try {
      normalizeTraceQuery({});
      expect.unreachable("sessionId 缺失应抛 TraceQueryInvalidError");
    } catch (err) {
      expect(err).toBeInstanceOf(TraceQueryInvalidError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("sessionId");
    }
  });
});

describe("trace 域：hasMoreBefore（基线 = daemon domain-trace.test.ts ④）", () => {
  test("loaded === limit 即可能还有更早页（恰整除边界多一次空载，契约记录在案）", () => {
    expect(hasMoreBefore(50, 50)).toBe(true);
    expect(hasMoreBefore(49, 50)).toBe(false);
    expect(hasMoreBefore(0, 50)).toBe(false);
  });
});

describe("trace 域：pageTraceEvents（基线 = fake-transport 过滤分页段语义）", () => {
  const events: TraceEventRow[] = [
    row({ id: 1, type: "agent.instantiated" }),
    row({ id: 2, type: "agent.spawned", instanceId: "agt-a", agentKind: "subagent" }),
    row({ id: 3, type: "message.completed", instanceId: "agt-a", agentKind: "subagent", ts: iso(12_000) }),
    row({ id: 4, type: "message.completed", instanceId: "agt-b", agentKind: "subagent", ts: iso(18_000) }),
    row({ id: 5, type: "usage.recorded" }),
    row({ id: 6, type: "agent.model.changed" }),
  ];

  test("agentKind 过滤维生效：rows 全为该 kind、total = 过滤后计数、id 降序", () => {
    const q = normalizeTraceQuery({ sessionId: "s1", agentKind: "subagent" });
    const page = pageTraceEvents(events, q);
    expect(page.total).toBe(3);
    expect(page.rows.map((e) => e.id)).toEqual([4, 3, 2]); // ORDER BY id DESC
    expect(page.rows.every((e) => e.agentKind === "subagent")).toBe(true);
  });

  test("timeRange 含起含止（ts 字符串比较）：[12s,18s] 恰含两端两事件", () => {
    const q = normalizeTraceQuery({ sessionId: "s1", timeRange: { from: iso(12_000), to: iso(18_000) } });
    const page = pageTraceEvents(events, q);
    expect(page.total).toBe(2);
    expect(page.rows.map((e) => e.id).sort()).toEqual([3, 4].sort());
  });

  test("beforeId 游标：严格小于 + slice limit + hasMore = paged.length === limit", () => {
    const q = normalizeTraceQuery({ sessionId: "s1", page: { limit: 2, beforeId: 5 } });
    const page = pageTraceEvents(events, q);
    expect(page.rows.map((e) => e.id)).toEqual([4, 3]);
    expect(page.total).toBe(6); // total 不含游标/限量维
    expect(page.hasMore).toBe(true); // 2 === 2
    const last = normalizeTraceQuery({ sessionId: "s1", page: { limit: 3, beforeId: 4 } });
    const lastPage = pageTraceEvents(events, last);
    expect(lastPage.rows.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(lastPage.hasMore).toBe(true); // 恰整除边界多一次空载
    const empty = normalizeTraceQuery({ sessionId: "s1", page: { beforeId: 1 } });
    expect(pageTraceEvents(events, empty).rows).toEqual([]);
    expect(pageTraceEvents(events, empty).hasMore).toBe(false);
  });

  test("instanceIds/types 空数组 = 空结果；includes 过滤；未登记 type 不拒绝（无成员枚举）", () => {
    const emptyIds = normalizeTraceQuery({ sessionId: "s1", instanceIds: [] });
    expect(pageTraceEvents(events, emptyIds).total).toBe(0);
    const emptyTypes = normalizeTraceQuery({ sessionId: "s1", types: [] });
    expect(pageTraceEvents(events, emptyTypes).total).toBe(0);
    const ids = normalizeTraceQuery({ sessionId: "s1", instanceIds: ["agt-a"] });
    expect(pageTraceEvents(events, ids).total).toBe(2);
    const types = normalizeTraceQuery({ sessionId: "s1", types: ["nonexistent.type"] });
    expect(pageTraceEvents(events, types).total).toBe(0); // 不拒绝（空结果语义）
    const both = normalizeTraceQuery({ sessionId: "s1", types: ["message.completed"] });
    expect(pageTraceEvents(events, both).total).toBe(2);
  });

  test("返回行不共享输入引用（rows = 过滤拷贝，帧侧可变形态安全）", () => {
    const q = normalizeTraceQuery({ sessionId: "s1", page: { limit: 1 } });
    const page = pageTraceEvents(events, q);
    expect(page.rows).not.toBe(events);
    page.rows[0]!.id = -1; // 突变返回值不影响输入
    expect(events[0]!.id).toBe(1);
  });
});

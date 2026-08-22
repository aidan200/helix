// @vitest-environment jsdom
/**
 * fake-transport mock 校验面单测（T2.4 新宿主，CL-2 / F(2).6 / F(2).7；AD-5④ / AD-1）。
 *
 * 宿主新立理由（brief 探查实证）：trace-model.test.ts 为纯模型单测（零
 * fake-transport import，不动）；e2e CL-5 spec 承载行为回归面——mock 校验
 * 分支对账（TR-TEST-3「不弱于、不私设」）在本文件承载。
 *
 * 驱动路径：生产接缝 createFakeTransport("1") → FakeSocket.send(trace.query)
 * → 120ms 延迟自动应答（loading 态触发面）→ 控制面 window.__helixMock.open()
 * 建连（jsdom 环境承接模块侧副作用挂载）。
 *
 * 三缺口 case 表（测试设计 §2.2.3）：
 * - agentKind 过滤：正向生效（过滤后集合 == mock 数据该 kind 实例集）+
 *   一致性（filterEcho 回显 == 实际生效值；实例面板不随过滤收窄——daemon
 *   assembleInstancePanel 会话级语义镜像）；
 * - 校验分支：负向拒绝（校验规则单源 @helix/protocol projection
 *   normalizeTraceQuery——T3.1 起 daemon domain 版退役，此处经协议包引用
 *   对账；失败一律 connection.error{code:"command.invalid_payload"}
 *   ——映射锚 handlers/trace.ts catch → WsServerAdapter.commandError）+
 *   正向生效（合法 timeRange 含起含止 / limit 鉗制 / beforeId 游标 /
 *   空数组显式空结果）+ 不私设证明（types 成员无枚举校验——合法但未登记的
 *   type 不拒绝，空结果语义）；
 * - agent.model.changed：payload 含 instanceId 且 == 所属实例（协议
 *   AgentModelChangedPayload.instanceId 必填）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, TraceQueryPayload, TraceQueryResultPayload } from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { Transport } from "./helix-ws";
import { createFakeTransport } from "./fake-transport";

// ── 场景镜像常量（traceScenario 确定性数据；e2e CL-5 同源）─────

const WS_URL = "ws://127.0.0.1:7777/helix";
/** fake-transport TRACE_MOCK_LATENCY_MS（trace.query 自动应答延迟）。 */
const REPLY_LATENCY_MS = 120;
/** fake-transport TRACE_MOCK_BASE_MS（场景时间零点）。 */
const BASE_MS = Date.parse("2026-08-19T13:47:57.802+08:00");

const MAIN = "main";
const SUB_A = "agt_F1X2E88DQ9LM"; // phase-coder · failed（engine.error 行）
const SUB_B = "agt_K65K629RNMQG"; // phase-explorer · completed · 快照缺失
const SUB_C = "agt_P70SC41BE0K2"; // phase-coder · completed · 纯快照面

/** 场景全集计数（主 70 + Sub 8；e2e「命中 78 条」同源）。 */
const TOTAL_ALL = 78;
const TOTAL_SUBAGENT = 8;
const TOTAL_MAIN = 70;
/** 零点后 12s 前的实例化/spawn 事件数（0/2/2.2/3/4/4.2s 各一条）。 */
const BEFORE_12S = 6;

function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** 建连 → 发 trace.query → 推进假时钟收自动应答（点对点单帧）。 */
async function queryTrace(payload: Record<string, unknown>): Promise<EventEnvelope> {
  const replies: EventEnvelope[] = [];
  const transport: Transport = createFakeTransport("1")(WS_URL, {
    onOpen: () => {},
    onMessage: (data) => replies.push(JSON.parse(data) as EventEnvelope),
    onClose: () => {},
    onError: () => {},
  });
  await window.__helixMock!.open();
  // 故意构造畸形 payload 正是负向 case 的目的——边界处显式断言越过窄化类型
  const frame = { v: PROTOCOL_VERSION, type: "trace.query", payload: payload as unknown as TraceQueryPayload };
  transport.send(JSON.stringify(frame));
  vi.advanceTimersByTime(REPLY_LATENCY_MS);
  expect(replies, "trace.query 自动应答应恰一帧（点对点回执）").toHaveLength(1);
  transport.close();
  return replies[0]!;
}

/** 校验失败回帧形状（协议 TraceQueryInvalidError → command.invalid_payload 映射锚同构）。 */
function expectInvalidPayload(reply: EventEnvelope): void {
  expect(reply).toMatchObject({
    v: PROTOCOL_VERSION,
    type: "connection.error",
    sessionId: SYSTEM_SESSION_ID, // 会话无关系统事件（notification 通道）
    channel: "notification",
    payload: { code: "command.invalid_payload" },
  });
  expect(typeof (reply.payload as { message?: unknown }).message).toBe("string");
}

function resultOf(reply: EventEnvelope): TraceQueryResultPayload {
  expect(reply.type).toBe("trace.query.result");
  expect(reply.channel).toBe("trace");
  return reply.payload as TraceQueryResultPayload;
}

// ── 缺口①：agentKind 过滤 ───────────────────────────────────

describe("fake-transport agentKind 过滤（缺口①；正向生效 + 回显一致）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("agentKind=subagent 正向生效：事件全为 subagent，实例集 == mock 数据三 Sub，计数 8", async () => {
    const result = resultOf(await queryTrace({ sessionId: "ses_a", agentKind: "subagent" }));
    expect(result.page.total).toBe(TOTAL_SUBAGENT);
    expect(result.events.every((e) => e.agentKind === "subagent")).toBe(true);
    expect(new Set(result.events.map((e) => e.instanceId))).toEqual(new Set([SUB_A, SUB_B, SUB_C]));
  });

  it("agentKind=main 正向生效：事件全为 main（首页 50），实例集 == {main}", async () => {
    const result = resultOf(await queryTrace({ sessionId: "ses_a", agentKind: "main" }));
    expect(result.page.total).toBe(TOTAL_MAIN);
    expect(result.events).toHaveLength(50); // 缺省 limit 50 首页
    expect(result.events.every((e) => e.agentKind === "main")).toBe(true);
    expect(new Set(result.events.map((e) => e.instanceId))).toEqual(new Set([MAIN]));
  });

  it("一致性：filterEcho.agentKind 回显 == 实际生效值；缺省归一 null；实例面板不随过滤收窄", async () => {
    const sub = resultOf(await queryTrace({ sessionId: "ses_a", agentKind: "subagent" }));
    expect(sub.filterEcho.agentKind).toBe("subagent"); // 回显 = 实际生效值
    expect(sub.instances).toHaveLength(4); // 面板 = 会话级全实例（daemon assembleInstancePanel 不受过滤维影响）

    const none = resultOf(await queryTrace({ sessionId: "ses_a" }));
    expect(none.filterEcho.agentKind).toBeNull(); // 缺省维归一 null（AF-5）
    expect(none.page.total).toBe(TOTAL_ALL);
  });
});

// ── 缺口②：校验分支对账（协议单源 @helix/protocol projection）──

describe("fake-transport 校验分支对账（缺口②；normalizeTraceQuery 协议单源，失败一律 command.invalid_payload）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["sessionId 缺失（:55-59）", { agentKind: "main" }],
    ["sessionId 空串（:55-59）", { sessionId: "" }],
    ["instanceIds 非数组（:60）", { sessionId: "s", instanceIds: "main" }],
    ["instanceIds 含空串成员（:60）", { sessionId: "s", instanceIds: [""] }],
    ["types 非数组（:61）", { sessionId: "s", types: 42 }],
    ["agentKind 非枚举值（:63-69）", { sessionId: "s", agentKind: "both" }],
    ["timeRange.from 非 ISO 文本（:72）", { sessionId: "s", timeRange: { from: "not-a-date" } }],
    ["timeRange.to 非 ISO 文本（:73）", { sessionId: "s", timeRange: { from: iso(0), to: 42 } }],
    ["timeRange 交叉矛盾 from 晚于 to（:74-76）", { sessionId: "s", timeRange: { from: iso(60_000), to: iso(0) } }],
    ["page.limit 非正整数 0（:87-91）", { sessionId: "s", page: { limit: 0 } }],
    ["page.limit 非整数 1.5（:87-91）", { sessionId: "s", page: { limit: 1.5 } }],
    ["page.beforeId 非正整数 0（:93-97）", { sessionId: "s", page: { beforeId: 0 } }],
  ])("负向拒绝：%s → connection.error{command.invalid_payload}", async (_name, payload) => {
    expectInvalidPayload(await queryTrace(payload as Record<string, unknown>));
  });

  it("正向生效：合法 timeRange 含起含止（[12s, 18s] 恰含两端两事件）且回显 == 输入", async () => {
    const result = resultOf(
      await queryTrace({ sessionId: "s", timeRange: { from: iso(12_000), to: iso(18_000) } }),
    );
    expect(result.page.total).toBe(2); // SUB_A message@12s + SUB_B message@18s（含起含止）
    expect(result.events.map((e) => e.instanceId).sort()).toEqual([SUB_B, SUB_A].sort());
    expect(result.filterEcho.timeRange).toEqual({ from: iso(12_000), to: iso(18_000) });
  });

  it("正向生效：单边时间窗 from=12s → 窗外 6 条实例化/spawn 事件被排除（total 72）", async () => {
    const result = resultOf(await queryTrace({ sessionId: "s", timeRange: { from: iso(12_000) } }));
    expect(result.page.total).toBe(TOTAL_ALL - BEFORE_12S);
    expect(result.events.every((e) => e.ts >= iso(12_000))).toBe(true);
  });

  it("正向生效：limit 超上限鉗制 200 不报错（filterEcho 回显鉗制后生效值）", async () => {
    const result = resultOf(await queryTrace({ sessionId: "s", page: { limit: 999 } }));
    expect(result.filterEcho.page.limit).toBe(200);
  });

  it("正向生效：beforeId 游标（beforeId=1 → 无更早事件；空数组 = 空结果语义合法）", async () => {
    const before = resultOf(await queryTrace({ sessionId: "s", page: { beforeId: 1 } }));
    expect(before.events).toEqual([]);
    expect(before.page).toEqual({ loaded: 0, total: TOTAL_ALL, hasMore: false });
    const empty = resultOf(await queryTrace({ sessionId: "s", instanceIds: [] }));
    expect(empty.page.total).toBe(0);
  });

  it("不私设证明：types 成员无枚举校验（daemon :61 仅校验数组性）——未登记 type 合法且空结果", async () => {
    const result = resultOf(await queryTrace({ sessionId: "s", types: ["nonexistent.type"] }));
    expect(result.page.total).toBe(0); // 不拒绝（daemon 无 types ∈ EVENT_TYPES 分支，mock 不私设）
  });
});

// ── 缺口③：agent.model.changed payload instanceId ───────────

describe("fake-transport agent.model.changed payload（缺口③；AgentModelChangedPayload.instanceId 必填）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("payload 含 instanceId 且 == 所属实例（main 换模事件）", async () => {
    const result = resultOf(await queryTrace({ sessionId: "s", types: ["agent.model.changed"] }));
    expect(result.events).toHaveLength(1);
    const row = result.events[0]!;
    expect(row.instanceId).toBe(MAIN);
    expect(row.payload).toMatchObject({
      instanceId: MAIN, // payload.instanceId == 所属实例（协议必填位）
      from: "zhipu/glm-4.6",
      to: "deepseek/deepseek-chat",
    });
  });
});

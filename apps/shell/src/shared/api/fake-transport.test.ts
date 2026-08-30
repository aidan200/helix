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
import { createFakeTransport, WORKSPACE_MOCK_ROOT } from "./fake-transport";

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

// ── workspace 门禁 mock 应答（W3；mock daemon 对齐新命令——否则 mock 模式
//    卡 connecting，dev/e2e 全量不可用）──────────────────────

describe("fake-transport workspace 族自动应答（W3 门禁读/写面 mock 镜像）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 建连 → 发命令 → 推进假时钟收自动应答（点对点单帧）。 */
  async function sendWorkspace(type: string, payload: Record<string, unknown> = {}): Promise<EventEnvelope> {
    const replies: EventEnvelope[] = [];
    const transport: Transport = createFakeTransport("1")(WS_URL, {
      onOpen: () => {},
      onMessage: (data) => replies.push(JSON.parse(data) as EventEnvelope),
      onClose: () => {},
      onError: () => {},
    });
    await window.__helixMock!.open();
    transport.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload }));
    vi.advanceTimersByTime(60);
    expect(replies, `${type} 自动应答应恰一帧（点对点回执）`).toHaveLength(1);
    transport.close();
    return replies[0]!;
  }

  it("workspace.get → get.result 预绑定（mock 直进主壳；e2e 跳过交互门禁语义）", async () => {
    const reply = await sendWorkspace("workspace.get");
    expect(reply).toMatchObject({
      v: PROTOCOL_VERSION,
      type: "workspace.get.result",
      sessionId: SYSTEM_SESSION_ID,
      channel: "workspace",
    });
    expect(reply.payload).toEqual({ current: { root: WORKSPACE_MOCK_ROOT }, recents: [] });
  });

  it("workspace.open → open.result { root, projects: [] }（mock 无校验，回显 root）", async () => {
    const reply = await sendWorkspace("workspace.open", { root: "/ws/mock" });
    expect(reply).toMatchObject({
      type: "workspace.open.result",
      sessionId: SYSTEM_SESSION_ID,
      channel: "workspace",
    });
    expect(reply.payload).toEqual({ root: "/ws/mock", projects: [] });
  });
});

// ── D-2：task 族连接级订阅簿记与 task.changed 过滤投递（task-api.md §3 推送面镜像）──

describe("fake-transport task 族订阅簿记（D-2；连接级订阅表 + changed 按订阅过滤投递）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** tasks mock 自动应答延迟（fake-transport TASKS_MOCK_LATENCY_MS）。 */
  const TASKS_LATENCY_MS = 60;

  /** 建连并返回发送/收帧面（replies 累计该连接全部下发帧）。 */
  async function setupSocket(): Promise<{ transport: Transport; replies: EventEnvelope[] }> {
    const replies: EventEnvelope[] = [];
    const transport: Transport = createFakeTransport("1")(WS_URL, {
      onOpen: () => {},
      onMessage: (data) => replies.push(JSON.parse(data) as EventEnvelope),
      onClose: () => {},
      onError: () => {},
    });
    await window.__helixMock!.open();
    return { transport, replies };
  }

  function sendTask(transport: Transport, type: string, payload: Record<string, unknown> = {}): void {
    transport.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload }));
  }

  const types = (replies: EventEnvelope[]): string[] => replies.map((f) => f.type);

  it("未订阅：生命周期成功仅回结果帧，task.changed 不下发（无过滤漂移修复前会下发）", async () => {
    const { transport, replies } = await setupSocket();
    sendTask(transport, "task.resume", { jobId: "job-71c4" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.resume.result"]); // changed 被订阅表拦截
    // 复原 store（paused）
    sendTask(transport, "task.pause", { jobId: "job-71c4" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.resume.result", "task.pause.result"]);
    transport.close();
  });

  it("subscribe{} 订阅全部 → changed 伴随下发；unsubscribe{} 清空订阅集 → 退订后不再收 changed 帧", async () => {
    const { transport, replies } = await setupSocket();
    sendTask(transport, "task.subscribe");
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.subscribe.result"]);
    expect(await window.__helixMock!.taskSubs()).toEqual(["*"]); // 控制面读面：订阅全部簿记

    sendTask(transport, "task.resume", { jobId: "job-71c4" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.subscribe.result", "task.resume.result", "task.changed"]);
    expect(replies[2]).toMatchObject({
      type: "task.changed",
      channel: "notification",
      sessionId: SYSTEM_SESSION_ID,
      payload: { jobId: "job-71c4", changed: "job", status: "running" },
    });

    sendTask(transport, "task.unsubscribe");
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(await window.__helixMock!.taskSubs()).toEqual([]); // 清空订阅集（对称语义）

    replies.length = 0;
    sendTask(transport, "task.pause", { jobId: "job-71c4" }); // 同时复原 store（paused）
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.pause.result"]); // 退订后不再收 changed 帧
    transport.close();
  });

  it("subscribe{jobId} 按 jobId 过滤：仅订阅任务的 changed 下发；unsubscribe{jobId} 解除该订阅", async () => {
    const { transport, replies } = await setupSocket();
    sendTask(transport, "task.subscribe", { jobId: "job-8f21" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(await window.__helixMock!.taskSubs()).toEqual(["job-8f21"]);

    // 未订阅的 job-71c4：changed 被拦（resume 后 pause 复原）
    sendTask(transport, "task.resume", { jobId: "job-71c4" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    sendTask(transport, "task.pause", { jobId: "job-71c4" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.subscribe.result", "task.resume.result", "task.pause.result"]);

    // 订阅的 job-8f21：changed 下发（pause 后 resume 复原）
    replies.length = 0;
    sendTask(transport, "task.pause", { jobId: "job-8f21" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    sendTask(transport, "task.resume", { jobId: "job-8f21" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.pause.result", "task.changed", "task.resume.result", "task.changed"]);

    // unsubscribe{jobId} 解除该订阅 → changed 不再下发（pause 后 resume 复原）
    replies.length = 0;
    sendTask(transport, "task.unsubscribe", { jobId: "job-8f21" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(await window.__helixMock!.taskSubs()).toEqual([]);
    sendTask(transport, "task.pause", { jobId: "job-8f21" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    sendTask(transport, "task.resume", { jobId: "job-8f21" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(replies)).toEqual(["task.unsubscribe.result", "task.pause.result", "task.resume.result"]);
    transport.close();
  });

  it("断连即清订阅表（TR-AD-23③ 镜像）：netClose 后新连接未订阅，changed 不下发", async () => {
    const first = await setupSocket();
    sendTask(first.transport, "task.subscribe");
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(await window.__helixMock!.taskSubs()).toEqual(["*"]);
    await window.__helixMock!.netClose(1006);

    const second = await setupSocket();
    expect(await window.__helixMock!.taskSubs()).toBeNull(); // 新连接零订阅
    sendTask(second.transport, "task.resume", { jobId: "job-71c4" });
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(second.replies)).toEqual(["task.resume.result"]);
    sendTask(second.transport, "task.pause", { jobId: "job-71c4" }); // 复原 store
    vi.advanceTimersByTime(TASKS_LATENCY_MS);
    expect(types(second.replies)).toEqual(["task.resume.result", "task.pause.result"]);
    second.transport.close();
  });
});

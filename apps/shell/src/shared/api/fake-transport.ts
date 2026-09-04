/**
 * fake transport 标准实现（T4.4；F 层 mock mode 唯一 mock 模块）。
 *
 * 装配路径：SessionProvider 按 fakeTransportScript()（env/URL 双形态）经
 * HelixWsClient 既有 TransportFactory 注入点动态 import 本模块——复用接缝
 * 不新开旁路；生产构建 define 摇除后本模块不进 bundle（T4.4 验收项）。
 *
 * 契约等价纪律（TR-TEST-5 既有）：
 * - fake 实例保留 WebSocket 静态常量（CONNECTING/OPEN/CLOSING/CLOSED），
 *   send 仅 OPEN 态透传（readyState 门控）；
 * - 非 daemon 地址（vite HMR 等）透传真实 browserTransportFactory；
 * - 帧结构由调用方（e2e/harness/protocol.ts）直引 @helix/protocol 构造，
 *   本模块零帧知识。
 *
 * 控制面 `window.__helixMock`：与首迭代 addInitScript 版（harness/mock-init.ts，
 * 现退役为兼容路径）API 完全一致（open/emit/emitAll/netClose/failHandshake/
 * clientFrames/activeCount），spec 经 page.evaluate 驱动剧本回放；连接状态机/
 * 退避/握手全部走生产 HelixWsClient 真实路径。T3.1 多会话寻址扩展：
 * activeSession（读/设连接 full 档会话）+ scenarioSession（emit 按信封
 * sessionId 路由的剧本会话台账）。v0.3（T3.2，契约 v0.3 §2）订阅簿记升级为
 * map<sessionId, tier>（取代单值）+ monitor 档白名单过滤模拟（TR-TEST-3
 * 契约等价：与 daemon EventStream MONITOR_TIER_EVENT_TYPES 同规 3 事件，
 * monitor 档会话的非白名单帧整帧丢弃不下发）；断连即清表（TR-AD-23③
 * daemon 不持跨连接状态的 mock 镜像）。
 *
 * 剧本模块（URL 形态）：`?fakeTransport=<module-url>` 时加载该 ES 模块，
 * default export 收到控制面 API（自动剧本驱动器；如 smoke 的 auto-connect）。
 *
 * trace.query 自动剧本（T2.2/CL-5 例外条款）：mock daemon 读面镜像——真实
 * daemon 恒应答 trace.query（点对点结果帧 / 校验失败 connection.error），
 * 故 fake 实例对 trace.query 命令自动回放确定性场景（主 + 多 Sub 实例、
 * engine.error 行、可翻页事件量）。T3.1（M4 投资批）：校验/过滤/分页改引
 * @helix/protocol projection 纯函数单源（normalizeTraceQuery /
 * pageTraceEvents——原 daemon 行为副本退役，TR-TEST-3 对账面不变）；agentKind
 * 过滤维生效，实例面板保持会话级不随过滤收窄；filterEcho/帧组装留本地
 *（帧知识豁免位）；支撑 T2.3 fidelity 五态触发面（success/empty 经过滤器、
 * error 经非法 payload、loading 经 120ms 延迟、断连经 netClose）。
 * task 族订阅簿记（D-2 修复）：task.subscribe/unsubscribe 连接级订阅表 +
 * task.changed 按订阅过滤投递（task-api.md §3 推送面镜像），与 session 族
 * sessionTiers 同轨（send 钩子簿记 + 断连即清）；控制面 taskSubs() 读面供
 * spec 断言簿记生效。
 *
 * 「本模块零帧知识」纪律的单一例外：帧类型直引 @helix/protocol（TR-TEST-3
 * 类型即守护），不引 daemon 代码。
 */
import type {
  CommandEnvelope,
  EventEnvelope,
  TraceEventRow,
  TraceInstanceRecord,
  TraceQueryFilterEcho,
  TraceQueryResultPayload,
} from "@helix/protocol";
import {
  PROTOCOL_VERSION,
  SYSTEM_SESSION_ID,
  TraceQueryInvalidError,
  normalizeTraceQuery,
  pageTraceEvents,
} from "@helix/protocol";
import { browserTransportFactory, type Transport, type TransportFactory, type TransportHandlers } from "./helix-ws";
import { isKgCommand, kgMockStore, KG_MOCK_LATENCY_MS } from "./kg-mock";
import { isTaskCommand, tasksMockStore, TASKS_MOCK_LATENCY_MS } from "./tasks-mock";

/** daemon 回环地址前缀（非该前缀 → 真实 WebSocket 透传，HMR 不受扰）。 */
const DAEMON_WS_PREFIX = "ws://127.0.0.1:";

/** 订阅档位（v0.3，契约 §2.1；与 protocol SessionSubscribePayload.tier 同义）。 */
type SubscriptionTier = "full" | "monitor";

/** monitor 档白名单（契约 v0.3 §2.2 机械定义；TR-TEST-3：与 daemon
 *  EventStream.MONITOR_TIER_EVENT_TYPES 同规 3 事件——shell 侧禁引 daemon
 *  代码，按契约镜像，漂移由契约评审收口）。 */
const MONITOR_TIER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "chat.turn.started",
  "chat.turn.completed",
  "chat.message.completed",
]);

// ── 控制面（window.__helixMock；API 与 mock-init 兼容路径逐字对齐）────

/** 剧本会话台账（按信封 sessionId 寻址；后台续跑剧本的活动断言面）。 */
export interface ScenarioSessionState {
  sessionId: string;
  /** 该会话累计下发事件数（后台执行/未读剧本的活动脉冲源） */
  eventCount: number;
}

export interface HelixMockApi {
  open(): Promise<void>;
  emit(frame: EventEnvelope): Promise<void>;
  emitAll(frames: EventEnvelope[]): Promise<void>;
  netClose(code?: number): Promise<void>;
  failHandshake(): Promise<void>;
  clientFrames(): (CommandEnvelope | null)[];
  activeCount(): number;
  /**
   * 按 sessionId 寻址（T3.1 多会话剧本；v0.3 重定义）：读 = 连接 full 档会话
   * （无则 null）；设 = 该会话升 full、其余降 monitor（客户端先升后降的
   * 结果面镜像）。客户端 session.subscribe/unsubscribe 命令自动跟随簿记。
   */
  activeSession(sessionId?: string): Promise<string | null>;
  /** 剧本会话台账读取（emit 按信封 sessionId 路由累计）。 */
  scenarioSession(sessionId: string): Promise<ScenarioSessionState | null>;
  /**
   * task 族连接级订阅簿记读面（D-2；spec 断言「页面连接已订阅」用）。
   * 返回订阅 jobId 列表（"*" = 订阅全部）；null = 从未订阅。
   */
  taskSubs(): Promise<string[] | null>;
  /**
   * 挂起 trace.query 自动应答（F 层确定性 gate）：置位后应答帧入队不回，
   * releaseTraceReplies() 放行。用于 spec 断言 skeleton 瞬态时钉住 loading
   * 态——慢机上 120ms 延迟窗小于断言往返时长会导致互斥采样劈叉（CI 慢机
   * 抖动，2026-09 e2e CI 收敛批次）。成对使用，勿跨连接悬挂。
   */
  holdTraceReply(): Promise<void>;
  /** 放行全部挂起的 trace.query 应答（对当前活跃实例直发；不复位将后续
   * 应答持续入队的 hold 位由本方法一并复位）。 */
  releaseTraceReplies(): Promise<void>;
}

interface ClientWaiter {
  type: string;
  resolve(frame: CommandEnvelope): void;
}

// ── trace.query 自动剧本（T2.2/CL-5；mock daemon 读面镜像，契约 v0.4 §1/§4）──

/** 查询应答延迟（loading 态触发面：真实请求有可观测在途窗）。 */
const TRACE_MOCK_LATENCY_MS = 120;
/** 场景时间零点（确定性：同剧本同帧序列，重放可比）。 */
const TRACE_MOCK_BASE_MS = Date.parse("2026-08-19T13:47:57.802+08:00");

// ── workspace 门禁 mock（W3；mock daemon 对齐新命令——否则 mock 模式下
//    workspace.get 无回执会卡 connecting，dev/e2e 全量不可用）──────

/** mock 预绑定根（get 恒回 bound——e2e/CI 无头场景跳过交互门禁语义，
 *  设计稿 §7 dev-desktop 旋钮降级同源；真实绑定路径 = e2e 预绑定通道 W5）。 */
export const WORKSPACE_MOCK_ROOT = "/workspace";
/** workspace 族自动应答延迟（kg 族同构）。 */
const WORKSPACE_MOCK_LATENCY_MS = 60;

/** workspace 命令自动应答（点对点回执；mock 无校验，open 回显 root）。 */
function workspaceMockReply(type: string, payload: unknown): EventEnvelope {
  if (type === "workspace.get") {
    return {
      v: PROTOCOL_VERSION, type: "workspace.get.result", sessionId: SYSTEM_SESSION_ID, channel: "workspace",
      payload: { current: { root: WORKSPACE_MOCK_ROOT }, recents: [] },
    } as EventEnvelope;
  }
  const root = typeof (payload as { root?: unknown } | undefined)?.root === "string"
    ? (payload as { root: string }).root
    : WORKSPACE_MOCK_ROOT;
  return {
    v: PROTOCOL_VERSION, type: "workspace.open.result", sessionId: SYSTEM_SESSION_ID, channel: "workspace",
    payload: { root, projects: [] },
  } as EventEnvelope;
}

const TRACE_MAIN_ID = "main";
const TRACE_SUB_A = "agt_F1X2E88DQ9LM"; // phase-coder · failed（engine.error 行）
const TRACE_SUB_B = "agt_K65K629RNMQG"; // phase-explorer · completed · 快照缺失降级面
const TRACE_SUB_C = "agt_P70SC41BE0K2"; // phase-coder · completed（单发 Sub 纯快照面）

const TRACE_MAIN_PROMPT = [
  "You are the main-session assistant of the helix workbench, running in the user's local workspace. The user issues engineering tasks through the chat UI; you understand intent, break down steps, invoke tools, and deliver results on the main line.",
  "",
  "How you work:",
  "- Scan the available skill list before every action; when one matches, use it; rigid skills are never shortcut, simplified, or skipped.",
  "- Use read for reading, edit for precise changes, write only for new files or full rewrites.",
  "- Compact automatically per compaction params when context nears the threshold; record key conclusions in docs before continuing.",
].join("\n");

const TRACE_SUB_PROMPT = [
  "You are a SubAgent dispatched by the main line, owning the single task assigned in your brief. You have an independent context and do not talk to the user directly: all of your output serves the MainAgent task closure.",
  "",
  "Closure protocol:",
  "- Call submit_result exactly once when done: status + summary + acceptance + findings.",
  "- Answer every acceptance criterion in acceptance; findings is required, an empty array explicitly declares no findings.",
].join("\n");

/** 确定性场景（主 + 三 Sub；事件量 > PAGE_SIZE 50 以支撑翻叶面）。 */
function traceScenario(sessionId: string): {
  instances: TraceInstanceRecord[];
  events: TraceEventRow[];
} {
  const events: TraceEventRow[] = [];
  let id = 0;
  const push = (
    offsetMs: number,
    instanceId: string,
    agentKind: "main" | "subagent",
    type: string,
    payload: unknown,
  ): void => {
    id += 1;
    events.push({
      id,
      ts: new Date(TRACE_MOCK_BASE_MS + offsetMs).toISOString(),
      sessionId,
      instanceId,
      agentKind,
      type,
      payload,
    });
  };

  const mainSnapshot = {
    systemPrompt: TRACE_MAIN_PROMPT,
    tools: ["read", "write", "edit", "bash", "grep", "find", "codegraph", "kg_query"],
    model: "zhipu/glm-4.6",
    compaction: { enabled: true, reserveTokens: 96000, keepRecentTokens: 32000 },
  };
  const subSnapshot = (model: string) => ({
    systemPrompt: TRACE_SUB_PROMPT,
    tools: ["read", "write", "edit", "bash", "grep", "find"],
    model,
  });

  // 实例化与 spawn 族（主 = 会话创建时；Sub = spawn 紧随其后）
  push(0, TRACE_MAIN_ID, "main", "agent.instantiated", { instanceId: TRACE_MAIN_ID, profileKind: "main-session", profileSnapshot: mainSnapshot });
  push(2_000, TRACE_MAIN_ID, "main", "agent.spawned", { instanceId: TRACE_SUB_A, profile: "phase-coder", model: "zai/glm-5.3" });
  push(2_200, TRACE_SUB_A, "subagent", "agent.instantiated", { instanceId: TRACE_SUB_A, profileKind: "phase-coder", profileSnapshot: subSnapshot("zai/glm-5.3") });
  push(3_000, TRACE_MAIN_ID, "main", "agent.spawned", { instanceId: TRACE_SUB_B, profile: "phase-explorer", model: "zhipu/glm-4.6" });
  push(4_000, TRACE_MAIN_ID, "main", "agent.spawned", { instanceId: TRACE_SUB_C, profile: "phase-coder", model: "zhipu/glm-4.6" });
  push(4_200, TRACE_SUB_C, "subagent", "agent.instantiated", { instanceId: TRACE_SUB_C, profileKind: "phase-coder", profileSnapshot: subSnapshot("zhipu/glm-4.6") });

  // 主线 8 轮对话（turn/message/thinking/tool/usage 全类覆盖）
  for (let turn = 1; turn <= 8; turn += 1) {
    const base = 10_000 + turn * 60_000;
    push(base, TRACE_MAIN_ID, "main", "turn.started", { turn });
    push(base + 100, TRACE_MAIN_ID, "main", "message.completed", { role: "user", text: `main turn ${turn} instruction`, turn });
    push(base + 400, TRACE_MAIN_ID, "main", "thinking.completed", { text: `turn ${turn} reasoning summary`, turn });
    push(base + 800, TRACE_MAIN_ID, "main", "tool.call.started", { toolName: "read", turn });
    push(base + 900, TRACE_MAIN_ID, "main", "tool.call.result", { toolName: "read", isError: false, turn });
    push(base + 1_500, TRACE_MAIN_ID, "main", "message.completed", { role: "assistant", text: `turn ${turn} delivery summary`, turn });
    push(base + 1_600, TRACE_MAIN_ID, "main", "usage.recorded", { input: 12_000 + turn * 640, output: 800 + turn * 32, cost: 0.012 * turn, turn });
    push(base + 1_700, TRACE_MAIN_ID, "main", "turn.completed", { turn });
  }

  // Sub 事件流（含 engine.error + 终态）
  push(12_000, TRACE_SUB_A, "subagent", "message.completed", { role: "assistant", text: "extend error schema variants" });
  push(18_000, TRACE_SUB_B, "subagent", "message.completed", { role: "assistant", text: "data-plane exploration findings" });
  push(420_000, TRACE_SUB_B, "subagent", "agent.completed", { reason: "closure submitted" });
  push(500_000, TRACE_SUB_C, "subagent", "agent.completed", { reason: "closure submitted" });
  push(1_800_000, TRACE_SUB_A, "subagent", "engine.error", { provider: "zai", model: "glm-5.3", status: 429, message: "account quota exhausted", retriable: false });
  push(1_800_100, TRACE_SUB_A, "subagent", "agent.failed", { reason: "engine: zai 429 account quota exhausted" });

  // 主实例变更轨迹数据源：compaction + model.changed（instanceId 必填位 = 所属实例）
  push(2_300_000, TRACE_MAIN_ID, "main", "compaction.completed", { tokensBefore: 96_412, tokensAfter: 38_200 });
  push(2_320_000, TRACE_MAIN_ID, "main", "agent.model.changed", { instanceId: TRACE_MAIN_ID, from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat" });

  const countOf = (iid: string) => events.filter((e) => e.instanceId === iid).length;
  const instances: TraceInstanceRecord[] = [
    {
      instanceId: TRACE_MAIN_ID,
      agentKind: "main",
      profileKind: "main-session",
      model: "zhipu/glm-4.6",
      status: "running",
      startedAt: new Date(TRACE_MOCK_BASE_MS).toISOString(),
      eventCount: countOf(TRACE_MAIN_ID),
      snapshot: mainSnapshot,
      snapshotMissing: false,
      modelTimeline: [
        { from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat", at: new Date(TRACE_MOCK_BASE_MS + 2_320_000).toISOString() },
      ],
      currentModel: "deepseek/deepseek-chat",
    },
    {
      instanceId: TRACE_SUB_A,
      agentKind: "subagent",
      profileKind: "phase-coder",
      model: "zai/glm-5.3",
      status: "failed",
      startedAt: new Date(TRACE_MOCK_BASE_MS + 2_200).toISOString(),
      endedAt: new Date(TRACE_MOCK_BASE_MS + 1_800_100).toISOString(),
      task: "Extend FakeEngineScript error variants in scriptedEngine, aligned with the main scenario.",
      eventCount: countOf(TRACE_SUB_A),
      snapshot: subSnapshot("zai/glm-5.3"),
      snapshotMissing: false,
    },
    {
      instanceId: TRACE_SUB_B,
      agentKind: "subagent",
      profileKind: "phase-explorer",
      status: "completed",
      startedAt: new Date(TRACE_MOCK_BASE_MS + 3_000).toISOString(),
      endedAt: new Date(TRACE_MOCK_BASE_MS + 420_000).toISOString(),
      eventCount: countOf(TRACE_SUB_B),
      snapshotMissing: true, // 降级面：本迭代前创建的历史实例（无 instantiated 快照）
    },
    {
      instanceId: TRACE_SUB_C,
      agentKind: "subagent",
      profileKind: "phase-coder",
      model: "zhipu/glm-4.6",
      status: "completed",
      startedAt: new Date(TRACE_MOCK_BASE_MS + 4_200).toISOString(),
      endedAt: new Date(TRACE_MOCK_BASE_MS + 500_000).toISOString(),
      task: "Contract v0.4 porting registry and anchor inventory.",
      eventCount: countOf(TRACE_SUB_C),
      snapshot: subSnapshot("zhipu/glm-4.6"),
      snapshotMissing: false,
    },
  ];
  return { instances, events };
}

// ── trace.query 应答（T3.1：校验/过滤/分页直引 @helix/protocol projection 单源；
//    原 daemon 副本段退役——normalize/鉗制常量/错误类型/过滤分页语义均协议包权威） ──

/** trace.query 应答组装（校验/过滤/分页/filterEcho 机械口径；失败回
 * connection.error{command.invalid_payload}——daemon 映射链同构：协议
 * TraceQueryInvalidError → 本层 catch → 错误回帧）。 */
function buildTraceReply(raw: unknown): EventEnvelope {
  let q: ReturnType<typeof normalizeTraceQuery>;
  try {
    q = normalizeTraceQuery(raw);
  } catch (err) {
    if (!(err instanceof TraceQueryInvalidError)) throw err;
    return {
      v: PROTOCOL_VERSION,
      type: "connection.error",
      sessionId: SYSTEM_SESSION_ID,
      channel: "notification",
      payload: { code: "command.invalid_payload", message: err.message },
    };
  }
  const { instances, events } = traceScenario(q.sessionId);

  const { rows: paged, total, hasMore } = pageTraceEvents(events, q);

  const filterEcho: TraceQueryFilterEcho = {
    sessionId: q.sessionId,
    instanceIds: q.instanceIds === null ? null : [...q.instanceIds],
    agentKind: q.agentKind, // 回显 = 实际生效值（校验后归一；readonly → 帧侧可变拷贝）
    types: q.types === null ? null : [...q.types],
    timeRange: q.timeRange === null ? null : { ...q.timeRange },
    page: { limit: q.page.limit, beforeId: q.page.beforeId },
  };
  const payload: TraceQueryResultPayload = {
    filterEcho,
    instances,
    events: paged.map((row) => ({ ...row })),
    page: { loaded: paged.length, total, hasMore },
  };
  return {
    v: PROTOCOL_VERSION,
    type: "trace.query.result",
    sessionId: q.sessionId,
    channel: "trace",
    payload,
  };
}


/** fake 实例（WebSocket 形状：readyState + 静态常量 + send 门控）。 */
class FakeSocket {
  /** WebSocket 静态常量必须保留：readyState 门控按此判（TR-TEST-5）。 */
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeSocket.CONNECTING;
  /**
   * task 族连接级订阅簿记（D-2 修复，契约 task-api.md §3 推送面镜像；
   * 与 sessionTiers 同轨——daemon EventStream 连接级订阅表语义）。
   * null = 从未订阅；"*" 成员 = 订阅全部（task.subscribe 缺省 jobId）；
   * 其余成员 = 按 jobId 订阅。断连即清（TR-AD-23③ 镜像，见 close/fireClose）。
   */
  private taskSubs: Set<string> | null = null;

  constructor(
    url: string,
    private readonly handlers: TransportHandlers,
    private readonly registry: Registry,
  ) {
    this.url = url;
  }

  /** 仅 OPEN 态透传（readyState 门控； CONNECTING 期帧按 WebSocket 语义丢弃）。 */
  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) return;
    let frame: CommandEnvelope | null = null;
    try {
      frame = JSON.parse(data) as CommandEnvelope;
    } catch {
      frame = null;
    }
    this.registry.clientFrames.push(frame);
    // 订阅簿记（v0.3 map<sessionId, tier>：daemon EventStream.sessionTiers
    // 语义镜像——subscribe 幂等覆盖（payload.tier 缺省 full）；unsubscribe 删档）
    if (frame?.type === "session.subscribe" && typeof frame.sessionId === "string" && frame.sessionId !== "") {
      const tierRaw = (frame.payload as { tier?: unknown } | undefined)?.tier;
      const tier: SubscriptionTier = tierRaw === "monitor" ? "monitor" : "full";
      this.registry.sessionTiers.set(frame.sessionId, tier);
      if (tier === "full") this.registry.lastFullSessionId = frame.sessionId;
    } else if (frame?.type === "session.unsubscribe" && typeof frame.sessionId === "string") {
      this.registry.sessionTiers.delete(frame.sessionId);
      if (this.registry.lastFullSessionId === frame.sessionId) this.registry.lastFullSessionId = null;
    }
    // task 族订阅簿记（D-2；task-api.md §3 连接级订阅表 + §2 payload 语义镜像）：
    // subscribe{jobId} 按 jobId 登记；subscribe{} 订阅全部（"*" 通配）；
    // unsubscribe{jobId} 移除该 jobId 并解除通配（退订意图优先，保守镜像）；
    // unsubscribe{} 清空订阅集（commands.ts「对称语义」）。
    if (frame?.type === "task.subscribe" || frame?.type === "task.unsubscribe") {
      const jobId = (frame.payload as { jobId?: unknown } | undefined)?.jobId;
      const specific = typeof jobId === "string" && jobId !== "" ? jobId : null;
      if (frame.type === "task.subscribe") {
        if (this.taskSubs === null) this.taskSubs = new Set();
        this.taskSubs.add(specific ?? "*");
      } else if (specific !== null) {
        this.taskSubs?.delete(specific);
        this.taskSubs?.delete("*");
      } else {
        this.taskSubs = new Set();
      }
    }
    const hit: ClientWaiter[] = [];
    const rest: ClientWaiter[] = [];
    for (const w of this.registry.commandWaiters) (w.type === frame?.type ? hit : rest).push(w);
    this.registry.commandWaiters = rest;
    for (const w of hit) w.resolve(frame!);
    // trace.query 自动应答（mock daemon 读面镜像；点对点回执，延迟 = loading 态触发面）
    if (frame?.type === "trace.query") {
      const reply = buildTraceReply(frame.payload);
      if (this.registry.traceHold) {
        this.registry.heldTraceReplies.push(reply); // gate：spec 断言 skeleton 瞬态期挂起
      } else {
        setTimeout(() => {
          if (this.readyState === FakeSocket.OPEN) this.fireMessage(reply);
        }, TRACE_MOCK_LATENCY_MS);
      }
    }
    // kg 族自动应答（T5.4；六命令 mock daemon 镜像，含 confirm 写与 rebuild 时基）
    if (frame !== null && isKgCommand(frame.type)) {
      const reply = kgMockStore.reply(frame.type, frame.payload);
      setTimeout(() => {
        if (this.readyState === FakeSocket.OPEN) this.fireMessage(reply);
      }, KG_MOCK_LATENCY_MS);
    }
    // task 族自动应答（T3.1；九命令 mock daemon 镜像——结果帧 + 生命周期
    // 成功伴发的 task.changed 广播，帧数组逐帧下发）
    if (frame !== null && isTaskCommand(frame.type)) {
      const frames = tasksMockStore.reply(frame.type, frame.payload);
      setTimeout(() => {
        if (this.readyState !== FakeSocket.OPEN) return;
        for (const f of frames) {
          // task.changed 按连接级订阅表过滤投递（D-2；契约 §3「仅推送给该
          // 连接已订阅的 jobId（或订阅全部时按连接过滤）」）；点对点结果帧
          // （*.result / connection.error）豁免——daemon sendNow 直发不过滤。
          if (f.type === "task.changed" && !this.taskChangedAllowed(f)) continue;
          this.fireMessage(f);
        }
      }, TASKS_MOCK_LATENCY_MS);
    }
    // workspace 族自动应答（W3 门禁；mock daemon 镜像，get 恒回预绑定）
    if (frame?.type === "workspace.get" || frame?.type === "workspace.open") {
      const reply = workspaceMockReply(frame.type, frame.payload);
      setTimeout(() => {
        if (this.readyState === FakeSocket.OPEN) this.fireMessage(reply);
      }, WORKSPACE_MOCK_LATENCY_MS);
    }
  }

  /** task.changed 投递准入（连接级订阅表：null=未订阅不投递；"*"=全部；否则按 jobId）。 */
  private taskChangedAllowed(frame: EventEnvelope): boolean {
    if (this.taskSubs === null) return false;
    const jobId = (frame.payload as { jobId?: unknown } | undefined)?.jobId;
    if (this.taskSubs.has("*")) return true;
    return typeof jobId === "string" && this.taskSubs.has(jobId);
  }

  /** 控制面读：连接 task 订阅簿记投影（spec 断言面；null=未订阅）。 */
  taskSubsSnapshot(): string[] | null {
    return this.taskSubs === null ? null : [...this.taskSubs];
  }

  /** 用户侧主动关闭（stop/retry）：不出网络事件（与 mock-init 口径一致）。 */
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.taskSubs = null; // 断连即清连接级订阅表（TR-AD-23③ 镜像）
  }

  // ── 控制面驱动（spec 侧）─────────────────────────────────

  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.handlers.onOpen();
  }

  fireMessage(frame: EventEnvelope): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }

  fireClose(code: number): void {
    this.readyState = FakeSocket.CLOSED;
    // 断连即清 tier 表（TR-AD-23③ daemon 不持跨连接状态的 mock 镜像）
    this.registry.sessionTiers.clear();
    this.registry.lastFullSessionId = null;
    this.taskSubs = null; // task 族连接级订阅表同规清除（D-2）
    this.handlers.onClose({ code, reason: "" });
  }

  fireError(): void {
    this.handlers.onError();
  }
}

/** 实例注册表（模块级单例：同页多连接尝试共享，控制面观测全部实例）。 */
class Registry {
  readonly instances: FakeSocket[] = [];
  readonly clientFrames: (CommandEnvelope | null)[] = [];
  commandWaiters: ClientWaiter[] = [];
  private instanceWaiters: ((inst: FakeSocket) => void)[] = [];
  /** 连接订阅簿记（v0.3：map<sessionId, tier>，取代单值 subscribedSessionId）。 */
  readonly sessionTiers = new Map<string, SubscriptionTier>();
  /** 最近升 full 的会话（activeSession 读面；瞬时双 full 窗口的消歧位）。 */
  lastFullSessionId: string | null = null;
  /** 剧本会话台账（emit 按信封 sessionId 路由累计；monitor 档被过滤帧不入账）。 */
  readonly scenarioSessions = new Map<string, ScenarioSessionState>();
  /** trace.query 应答挂起位（F 层确定性 gate；见 HelixMockApi.holdTraceReply）。 */
  traceHold = false;
  /** 挂起的 trace.query 应答队列（releaseTraceReplies 放行）。 */
  heldTraceReplies: EventEnvelope[] = [];

  /**
   * monitor 档白名单过滤（daemon EventStream.push 单点过滤的 mock 镜像，
   * TR-TEST-3 契约等价）：帧信封 sessionId 命中 monitor 档且类型不在白名单
   * → 整帧丢弃（不下发不入台账）。未订阅/full 档/系统帧照常放行；点对点
   * 回执（session.snapshot / *.result——daemon 走 sendNow 直发不过滤）豁免。
   */
  passTierFilter(frame: EventEnvelope): boolean {
    if (frame.type === "session.snapshot" || frame.type.endsWith(".result")) return true; // sendNow 点对点回执
    const sid = frame.sessionId;
    if (typeof sid !== "string" || sid === "" || sid === SYSTEM_SESSION_ID) return true;
    if (this.sessionTiers.get(sid) !== "monitor") return true;
    return MONITOR_TIER_EVENT_TYPES.has(frame.type);
  }

  activeInstance(): FakeSocket | null {
    const alive = this.instances.filter((i) => i.readyState !== FakeSocket.CLOSED);
    return alive.length ? alive[alive.length - 1]! : null;
  }

  nextActive(): Promise<FakeSocket> {
    return new Promise((resolve) => {
      const inst = this.activeInstance();
      if (inst) resolve(inst);
      else this.instanceWaiters.push(resolve);
    });
  }

  register(inst: FakeSocket): void {
    this.instances.push(inst);
    for (const w of this.instanceWaiters.splice(0)) w(inst);
  }

  /** emit 按信封 sessionId 路由到对应剧本会话台账（系统帧不入台账）。 */
  trackScenarioSession(frame: EventEnvelope): void {
    const sid = frame.sessionId;
    if (typeof sid !== "string" || sid === "" || sid === SYSTEM_SESSION_ID) return;
    const prev = this.scenarioSessions.get(sid);
    this.scenarioSessions.set(sid, { sessionId: sid, eventCount: (prev?.eventCount ?? 0) + 1 });
  }
}

// ── 模块入口（动态 import 消费）────────────────────────────

const registry = new Registry();

/** 剧本模块（URL 形态）懒加载：default export 收到控制面 API。 */
function loadDriverScript(script: string): void {
  if (script === "1") return; // 默认剧本：无外部驱动器，spec 手动驱动
  void import(/* @vite-ignore */ script)
    .then((m: { default?: (api: HelixMockApi) => void | Promise<void> }) => {
      if (typeof m.default === "function") void m.default(mockApi);
    })
    .catch(() => {
      // 剧本模块加载失败：控制面仍在（spec 手动驱动兜底），仅放弃自动剧本
    });
}

/** 控制面实例（挂 window + 供剧本模块消费）。 */
const mockApi: HelixMockApi = {
  async open() {
    (await registry.nextActive()).fireOpen();
  },
  async emit(frame) {
    if (!registry.passTierFilter(frame)) return; // monitor 档白名单过滤（契约 §2.2）
    registry.trackScenarioSession(frame);
    (await registry.nextActive()).fireMessage(frame);
  },
  async emitAll(frames) {
    const inst = await registry.nextActive();
    for (const f of frames) {
      if (!registry.passTierFilter(f)) continue; // monitor 档白名单过滤
      registry.trackScenarioSession(f);
      inst.fireMessage(f);
    }
  },
  async netClose(code) {
    (await registry.nextActive()).fireClose(code == null ? 1006 : code);
  },
  async failHandshake() {
    const inst = await registry.nextActive();
    inst.fireError();
    inst.fireClose(1006);
  },
  clientFrames() {
    return registry.clientFrames.slice();
  },
  activeCount() {
    return registry.instances.filter((i) => i.readyState !== FakeSocket.CLOSED).length;
  },
  async activeSession(sessionId) {
    if (sessionId !== undefined) {
      // 显式切换：目标升 full、其余降 monitor（先升后降结果面镜像）
      for (const [sid] of registry.sessionTiers) {
        if (sid !== sessionId) registry.sessionTiers.set(sid, "monitor");
      }
      registry.sessionTiers.set(sessionId, "full");
      registry.lastFullSessionId = sessionId;
    }
    // 读面 = 最近升 full 且仍为 full 的会话（瞬时双 full 窗口消歧）
    if (registry.lastFullSessionId !== null && registry.sessionTiers.get(registry.lastFullSessionId) === "full") {
      return registry.lastFullSessionId;
    }
    for (const [sid, tier] of registry.sessionTiers) {
      if (tier === "full") return sid;
    }
    return null;
  },
  async scenarioSession(sessionId) {
    return registry.scenarioSessions.get(sessionId) ?? null;
  },
  async taskSubs() {
    return (await registry.nextActive()).taskSubsSnapshot();
  },
  async holdTraceReply() {
    registry.traceHold = true;
  },
  async releaseTraceReplies() {
    registry.traceHold = false;
    const held = registry.heldTraceReplies.splice(0);
    const inst = registry.activeInstance();
    if (inst) for (const f of held) inst.fireMessage(f);
  },
};

declare global {
  interface Window {
    __helixMock?: HelixMockApi;
  }
}

if (typeof window !== "undefined") {
  window.__helixMock = mockApi;
}

let driverLoaded = false;

/**
 * fake transport 工厂（TransportFactory 形状，HelixWsClient 注入点消费）。
 *
 * @param script 剧本入口（"1" = 默认；否则剧本模块 URL，首次建连时加载）
 */
export function createFakeTransport(script: string): TransportFactory {
  return (url: string, handlers: TransportHandlers): Transport => {
    if (typeof url !== "string" || !url.startsWith(DAEMON_WS_PREFIX)) {
      // 非 daemon 地址透传真实 WebSocket（TR-TEST-5：HMR 等不受 mock 扰动）
      return browserTransportFactory(url, handlers);
    }
    if (!driverLoaded) {
      driverLoaded = true;
      loadDriverScript(script);
    }
    const socket = new FakeSocket(url, handlers, registry);
    registry.register(socket);
    return {
      connect() {
        /* 连接由剧本驱动：spec 经 __helixMock.open() 触发（或自动剧本模块） */
      },
      send(data) {
        socket.send(data);
      },
      close() {
        socket.close();
      },
    };
  };
}

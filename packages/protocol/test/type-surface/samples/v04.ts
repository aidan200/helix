import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  AgentInstantiatedEvent,
  AgentModelChangedEvent,
  CommandEnvelope,
  EventEnvelope,
  TraceQueryCommand,
  TraceQueryResultEvent,
} from "../../../src/index";

/**
 * v0.4 样例帧（trace.query 两形态/结果帧/agent 执行上下文两事件）
 * （T3.4 自 test/type-surface.test.ts 按版本批次归档迁出，批次身份保留；const 导出，语义随导出保留。）
 */
// ── v0.4 样例帧（契约 v0.4 §1/§2/§3；iter-20260819-erio T2.1；构造即类型检查） ──

/** trace.query：全过滤维形态 + 缺省形态（缺省 = 全部实例/全部类型/limit 50） */
export const traceQueryFull: TraceQueryCommand = {
  v: PROTOCOL_VERSION,
  type: "trace.query",
  payload: {
    sessionId: "sess-1",
    instanceIds: ["main", "agent-1"],
    agentKind: "main",
    types: ["message.completed", "agent.instantiated"],
    timeRange: { from: "2026-08-19T00:00:00.000Z", to: "2026-08-19T23:59:59.999Z" },
    page: { limit: 100, beforeId: 428 },
  },
};
export const traceQueryDefault: TraceQueryCommand = {
  v: PROTOCOL_VERSION,
  type: "trace.query",
  payload: { sessionId: "sess-1" }, // 全缺省（可选字段带缺省语义，TR-AD-18）
};

/** trace.query.result：点对点结果帧（filterEcho 缺省维归一 null；instances 面板块） */
export const traceQueryResult: TraceQueryResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "trace",
  type: "trace.query.result",
  payload: {
    filterEcho: {
      sessionId: "sess-1",
      instanceIds: null,
      agentKind: null,
      types: null,
      timeRange: null,
      page: { limit: 50, beforeId: null },
    },
    instances: [
      {
        instanceId: "main",
        agentKind: "main",
        profileKind: "main-session",
        model: "zhipu/glm-4.6",
        status: "running",
        startedAt: "2026-08-19T13:47:57.802Z",
        eventCount: 12,
        snapshot: {
          systemPrompt: "你是 helix 的主会话助手。",
          tools: ["bash", "read"],
          model: "zhipu/glm-4.6",
          compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        snapshotMissing: false,
        modelTimeline: [{ from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat", at: "2026-08-19T14:27:05.310Z" }],
        currentModel: "deepseek/deepseek-chat",
      },
    ],
    events: [
      {
        id: 428,
        ts: "2026-08-19T14:27:05.310Z",
        sessionId: "sess-1",
        instanceId: "main",
        agentKind: "main",
        type: "agent.model.changed",
        payload: { instanceId: "main", from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat" },
      },
    ],
    page: { loaded: 1, total: 12, hasMore: false },
  },
};

/** agent.instantiated：实例化快照（只落盘不广播；channel = agent 族，AF-6） */
export const agentInstantiated: AgentInstantiatedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.instantiated",
  instanceId: "agent-1",
  payload: {
    instanceId: "agent-1",
    profileKind: "subagent-worker",
    thinkingLevel: "medium", // v0.11 additive（thinking 批④；解析快照必填位）
    profileSnapshot: {
      systemPrompt: "你是 helix 的 SubAgent worker。",
      tools: ["bash", "read", "write", "edit", "grep"],
      model: "zai/glm-5.3", // 三级链解析结果（AD-3 联动，spawn 时刻求值）
    },
  },
};

/** agent.model.changed：模型时间线落盘（只落盘不广播；channel = agent 族） */
export const agentModelChanged: AgentModelChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.model.changed",
  instanceId: "main",
  payload: { instanceId: "main", from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat" },
};

export const v04Commands: CommandEnvelope[] = [traceQueryFull, traceQueryDefault];
export const v04Events: EventEnvelope[] = [traceQueryResult, agentInstantiated, agentModelChanged];

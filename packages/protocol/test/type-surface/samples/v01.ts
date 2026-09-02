import type {
  ClosureDto,
  CommandEnvelope,
  CompactionEntryDto,
  EventEnvelope,
  SessionSnapshotDto,
  ThinkingEntryDto,
  UsageDto,
} from "../../../src/index";

/**
 * v0.1 样例帧（closure/usage/thinking/compaction/编排命令/编排+通道事件/信封 instanceId/快照 additive）
 * （T3.4 自 test/type-surface.test.ts 按版本批次归档迁出，批次身份保留；const 导出，语义随导出保留。）
 */
// ── v0.1 样例帧（契约 protocol-v0.1.md §3–§6；构造即类型检查） ──

/** closure 样例：全字段必发纪律（缺失字段显式 null，契约 §5.3） */
export const sampleClosure: ClosureDto = {
  status: "done",
  summary: "任务收口：3 个守护断言已扩",
  reportPath: null,
  findings: null,
  taskId: null,
};

/** usage 样例：七字段防腐映射（pi Usage → 拍平 cost: number，契约 §6.2） */
export const sampleUsage: UsageDto = {
  input: 1_200,
  output: 340,
  cacheRead: 8_000,
  cacheWrite: 1_200,
  reasoning: 900,
  totalTokens: 11_640,
  cost: 0.0213,
};

export const thinkingEntry: ThinkingEntryDto = {
  kind: "thinking",
  id: "tk-1",
  instanceId: "main",
  text: "先查类型面，再扩事件目录",
  durationMs: 4_200,
  reasoningTokens: 900,
  createdAt: "2026-08-16T12:00:00.000Z",
};

export const compactionEntry: CompactionEntryDto = {
  kind: "compaction",
  id: "cp-1",
  instanceId: "main",
  tokensBefore: 340_000,
  tokensAfter: 20_000, // 原型「340k→20k」的 20k（压缩后上下文 tokens）
  summary: "会话前半程压缩摘要",
  usage: sampleUsage, // 摘要调用成本入账（AD-9③）
  createdAt: "2026-08-16T12:05:00.000Z",
};

export const v01Commands: CommandEnvelope[] = [
  { v: 0, type: "agent.kill", payload: { agentId: "agent-2" } },
  { v: 0, type: "agent.subscribe", payload: { agentId: "agent-2" } },
  { v: 0, type: "agent.unsubscribe", payload: { agentId: "agent-2" } },
];

export const v01Events: EventEnvelope[] = [
  // 编排生命周期族（7）
  {
    v: 0,
    type: "agent.spawned",
    payload: { agentId: "agent-1", task: "修协议守护测试", profileKind: "subagent-worker", model: "moonshot/kimi-k2" },
  },
  { v: 0, type: "agent.queued", payload: { agentId: "agent-1", position: 2 } },
  { v: 0, type: "agent.started", payload: { agentId: "agent-1", startedAtMs: 1_700_000_000_000 } },
  { v: 0, type: "agent.stalled", payload: { agentId: "agent-1", idleMs: 330_000 } },
  { v: 0, type: "agent.completed", payload: { agentId: "agent-1", closure: sampleClosure } },
  {
    v: 0,
    type: "agent.failed",
    payload: { agentId: "agent-1", error: "provider 5xx", closure: { ...sampleClosure, status: "failed" } },
  },
  {
    v: 0,
    type: "agent.killed",
    payload: { agentId: "agent-1", closure: { ...sampleClosure, status: "failed" } },
  },
  // 通道族（4）
  { v: 0, type: "thinking.stream.delta", payload: { instanceId: "agent-1", delta: "思考增量半句" } },
  { v: 0, type: "thinking.completed", payload: { entry: thinkingEntry } },
  { v: 0, type: "compaction.completed", payload: { entry: compactionEntry } },
  { v: 0, type: "usage.recorded", payload: { instanceId: "main", usage: sampleUsage, source: "turn" } },
];

/** 信封 instanceId（v0.1 新增可选，AD-3）：事件侧可携带；既有帧缺省 = 主实例 */
export const subAgentDelta: EventEnvelope = {
  v: 0,
  type: "chat.stream.delta",
  payload: { messageId: "e9", delta: "SubAgent 流式增量" },
  instanceId: "agent-1",
};

/** v0.1 快照 additive 字段样例：instances?（实例清单）+ usage?（账目聚合） */
export const snapshotV01: SessionSnapshotDto = {
  sessionId: "sess-1",
  model: "kimi-k2",
  agentState: "running",
  revision: 43,
  entries: [
    { kind: "message", id: "m1", role: "assistant", content: "委托完成", ts: 1760000100000, instanceId: "agent-1" },
    thinkingEntry,
    compactionEntry,
  ],
  instances: [
    { instanceId: "main", kind: "main", profileKind: "main-session", state: "running", createdAt: "2026-08-16T11:00:00.000Z" },
    {
      instanceId: "agent-0",
      kind: "subagent",
      profileKind: "subagent-worker",
      state: "done",
      task: "先修守护测试",
      model: "moonshot/kimi-k2",
      createdAt: "2026-08-16T11:30:00.000Z",
      closure: sampleClosure,
      usage: sampleUsage,
    },
    {
      instanceId: "agent-1",
      kind: "subagent",
      profileKind: "subagent-worker",
      state: "queued",
      task: "修协议守护测试",
      queuedPosition: 2, // 仅 state=queued
      createdAt: "2026-08-16T12:00:00.000Z",
    },
  ],
  usage: { total: sampleUsage, compaction: sampleUsage },
};

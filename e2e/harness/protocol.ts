/**
 * 协议 v0.1 帧构造器（e2e 剧本回放用；T4.4 扩：v0.1 事件/DTO 全集）。
 *
 * 全部形状直接 import @helix/protocol 源类型（AG-13 两端同源；契约等价
 * mock —— mock 帧与真实 daemon 帧不得漂移，TS 类型即守护；TR-TEST-3 纪律②）。
 */
import type {
  AgentInstanceDto,
  AgentStateDto,
  ChatRole,
  ClosureDto,
  CompactionEntryDto,
  EntryDto,
  EventEnvelope,
  MessageEntryDto,
  SessionSnapshotDto,
  SessionUsageDto,
  SteerState,
  ThinkingEntryDto,
  ToolCallEntryDto,
  ToolCallState,
  UsageDto,
} from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

/** 帧版本位单点（F-2⑭ 收口：v0.2 起改引协议常量，零字面量） */
const V = PROTOCOL_VERSION;

// ── entry 构造 ──────────────────────────────────────────────

export function msgEntry(
  id: string,
  role: ChatRole,
  content: string,
  opts: { ts?: number; steerState?: SteerState; instanceId?: string } = {},
): MessageEntryDto {
  return {
    kind: "message",
    id,
    role,
    content,
    ts: opts.ts ?? Date.now(),
    ...(opts.steerState ? { steerState: opts.steerState } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

export function toolEntry(
  id: string,
  name: string,
  args: string,
  state: ToolCallState,
  opts: { result?: string; durationMs?: number; ts?: number; instanceId?: string } = {},
): ToolCallEntryDto {
  return {
    kind: "tool-call",
    id,
    name,
    args,
    state,
    ts: opts.ts ?? Date.now(),
    ...(opts.result !== undefined ? { result: opts.result } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

// ── 事件帧构造（S→C）────────────────────────────────────────

export function welcome(
  opts: { sessionId?: string; model?: string; agentState?: AgentStateDto } = {},
): EventEnvelope {
  return {
    v: V,
    type: "connection.welcome",
    payload: {
      sessionId: opts.sessionId ?? "sess-e2e",
      model: opts.model ?? "claude-sonnet-4-5",
      agentState: opts.agentState ?? "idle",
    },
  };
}

export function snapshot(
  entries: EntryDto[],
  opts: {
    model?: string;
    agentState?: AgentStateDto;
    /** v0.1 additive：实例清单（卡片/channel/账目行重建） */
    instances?: AgentInstanceDto[];
    /** v0.1 additive：账目聚合（徽标/popover 重建权威） */
    usage?: SessionUsageDto;
  } = {},
): EventEnvelope {
  const snap: SessionSnapshotDto = {
    sessionId: "sess-e2e",
    model: opts.model ?? "claude-sonnet-4-5",
    agentState: opts.agentState ?? "idle",
    revision: entries.length,
    entries,
    ...(opts.instances !== undefined ? { instances: opts.instances } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
  return { v: V, type: "session.snapshot", payload: { snapshot: snap } };
}

export function streamDelta(
  messageId: string,
  delta: string,
  opts: { instanceId?: string } = {},
): EventEnvelope {
  return {
    v: V,
    type: "chat.stream.delta",
    payload: { messageId, delta },
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

export function messageCompleted(entry: MessageEntryDto, opts: { instanceId?: string } = {}): EventEnvelope {
  return {
    v: V,
    type: "chat.message.completed",
    payload: { entry },
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  };
}

export function steerQueued(entryId: string): EventEnvelope {
  return { v: V, type: "steer.queued", payload: { entryId } };
}

export function steerDrained(entryId: string): EventEnvelope {
  return { v: V, type: "steer.drained", payload: { entryId } };
}

export function toolStarted(entry: ToolCallEntryDto): EventEnvelope {
  return { v: V, type: "tool.call.started", payload: { entry } };
}

export function toolResult(entry: ToolCallEntryDto): EventEnvelope {
  return { v: V, type: "tool.call.result", payload: { entry } };
}

export function agentStateChanged(state: AgentStateDto): EventEnvelope {
  return { v: V, type: "agent.state.changed", payload: { state } };
}

// ── v0.1 DTO 构造（剧本数据纪律 test-design §4.3：全字段必发）────

/** ClosureDto 五字段（缺失字段显式 null，不省略 key）。 */
export function closure(
  status: "done" | "failed",
  summary: string,
  opts: { reportPath?: string | null; findings?: unknown[] | null; taskId?: string | null } = {},
): ClosureDto {
  return {
    status,
    summary,
    reportPath: opts.reportPath ?? null,
    findings: opts.findings ?? null,
    taskId: opts.taskId ?? null,
  };
}

/** UsageDto 七字段全发（cost 拍平 number；未指定字段缺省 0，key 不省略）。 */
export function usageDto(
  totalTokens: number,
  cost: number,
  opts: Partial<Omit<UsageDto, "totalTokens" | "cost">> = {},
): UsageDto {
  return {
    input: opts.input ?? 0,
    output: opts.output ?? 0,
    cacheRead: opts.cacheRead ?? 0,
    cacheWrite: opts.cacheWrite ?? 0,
    reasoning: opts.reasoning ?? 0,
    totalTokens,
    cost,
  };
}

/** ThinkingEntryDto（完成态全文；durationMs/reasoningTokens 驱动折叠条文案）。 */
export function thinkingEntry(
  id: string,
  text: string,
  opts: { instanceId?: string; durationMs?: number; reasoningTokens?: number; createdAt?: string } = {},
): ThinkingEntryDto {
  return {
    kind: "thinking",
    id,
    instanceId: opts.instanceId ?? "main",
    text,
    durationMs: opts.durationMs ?? 3_000,
    reasoningTokens: opts.reasoningTokens ?? 1_200,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/** CompactionEntryDto（usage 七字段必发；tokensBefore/After 驱动里程碑条文案）。 */
export function compactionEntry(
  id: string,
  opts: {
    instanceId?: string;
    tokensBefore?: number;
    tokensAfter?: number;
    summary?: string;
    usage?: UsageDto;
    createdAt?: string;
  } = {},
): CompactionEntryDto {
  return {
    kind: "compaction",
    id,
    instanceId: opts.instanceId ?? "main",
    tokensBefore: opts.tokensBefore ?? 340_000,
    tokensAfter: opts.tokensAfter ?? 20_000,
    summary: opts.summary ?? "会话上下文已压缩：保留最近任务的关键结论与工具产出。",
    usage: opts.usage ?? usageDto(1_800, 0.02),
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/** AgentInstanceDto（快照实例清单；main/subagent + 状态/账目/closure）。 */
export function agentInstance(
  instanceId: string,
  opts: {
    kind?: "main" | "subagent";
    profileKind?: string;
    state?: AgentInstanceDto["state"];
    task?: string;
    model?: string;
    queuedPosition?: number;
    closure?: ClosureDto;
    usage?: UsageDto;
  } = {},
): AgentInstanceDto {
  return {
    instanceId,
    kind: opts.kind ?? "subagent",
    profileKind: opts.profileKind ?? "subagent-worker",
    state: opts.state ?? "running",
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.queuedPosition !== undefined ? { queuedPosition: opts.queuedPosition } : {}),
    ...(opts.closure !== undefined ? { closure: opts.closure } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    createdAt: new Date().toISOString(),
  };
}

// ── v0.1 事件帧构造（编排生命周期族 + 通道族；契约 §5）──────

export function agentSpawned(
  agentId: string,
  task: string,
  opts: { profileKind?: string; model?: string } = {},
): EventEnvelope {
  return {
    v: V,
    type: "agent.spawned",
    payload: {
      agentId,
      task,
      profileKind: opts.profileKind ?? "subagent-worker",
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    },
  };
}

export function agentQueued(agentId: string, position: number): EventEnvelope {
  return { v: V, type: "agent.queued", payload: { agentId, position } };
}

export function agentStarted(agentId: string): EventEnvelope {
  return { v: V, type: "agent.started", payload: { agentId } };
}

export function agentStalled(agentId: string, idleMs: number): EventEnvelope {
  return { v: V, type: "agent.stalled", payload: { agentId, idleMs } };
}

export function agentCompleted(agentId: string, closureDto: ClosureDto): EventEnvelope {
  return { v: V, type: "agent.completed", payload: { agentId, closure: closureDto } };
}

export function agentFailed(agentId: string, error: string, closureDto: ClosureDto): EventEnvelope {
  return { v: V, type: "agent.failed", payload: { agentId, error, closure: closureDto } };
}

export function agentKilled(agentId: string, closureDto: ClosureDto): EventEnvelope {
  return { v: V, type: "agent.killed", payload: { agentId, closure: closureDto } };
}

export function thinkingDelta(instanceId: string, delta: string): EventEnvelope {
  return { v: V, type: "thinking.stream.delta", payload: { instanceId, delta } };
}

export function thinkingCompleted(entry: ThinkingEntryDto): EventEnvelope {
  return { v: V, type: "thinking.completed", payload: { entry } };
}

export function compactionCompleted(entry: CompactionEntryDto): EventEnvelope {
  return { v: V, type: "compaction.completed", payload: { entry } };
}

export function usageRecorded(
  instanceId: string,
  usage: UsageDto,
  source: "turn" | "compaction" = "turn",
): EventEnvelope {
  return { v: V, type: "usage.recorded", payload: { instanceId, usage, source } };
}

// ── C→S 命令帧形状（断言 hello / chat.send / chat.steer 用）────

export interface ClientFrame {
  v: number;
  type: string;
  payload: unknown;
}

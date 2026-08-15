/**
 * 协议 v0 帧构造器（e2e 剧本回放用）。
 *
 * 全部形状直接 import @helix/protocol 源类型（AG-13 两端同源；契约等价
 * mock —— mock 帧与真实 daemon 帧不得漂移，TS 类型即守护）。
 */
import type {
  AgentStateDto,
  ChatRole,
  EntryDto,
  EventEnvelope,
  MessageEntryDto,
  SteerState,
  ToolCallEntryDto,
  ToolCallState,
} from "../../packages/protocol/src/index";

const V = 0;

// ── entry 构造 ──────────────────────────────────────────────

export function msgEntry(
  id: string,
  role: ChatRole,
  content: string,
  opts: { ts?: number; steerState?: SteerState } = {},
): MessageEntryDto {
  return {
    kind: "message",
    id,
    role,
    content,
    ts: opts.ts ?? Date.now(),
    ...(opts.steerState ? { steerState: opts.steerState } : {}),
  };
}

export function toolEntry(
  id: string,
  name: string,
  args: string,
  state: ToolCallState,
  opts: { result?: string; durationMs?: number; ts?: number } = {},
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

export function snapshot(entries: EntryDto[], opts: { model?: string; agentState?: AgentStateDto } = {}): EventEnvelope {
  return {
    v: V,
    type: "session.snapshot",
    payload: {
      snapshot: {
        sessionId: "sess-e2e",
        model: opts.model ?? "claude-sonnet-4-5",
        agentState: opts.agentState ?? "idle",
        revision: entries.length,
        entries,
      },
    },
  };
}

export function streamDelta(messageId: string, delta: string): EventEnvelope {
  return { v: V, type: "chat.stream.delta", payload: { messageId, delta } };
}

export function messageCompleted(entry: MessageEntryDto): EventEnvelope {
  return { v: V, type: "chat.message.completed", payload: { entry } };
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

// ── C→S 命令帧形状（断言 hello / chat.send / chat.steer 用）────

export interface ClientFrame {
  v: number;
  type: string;
  payload: unknown;
}

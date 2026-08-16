import type { DomainEvent } from "../../../../domain/events/DomainEvent";
import type { AgentLifecycleState } from "../../../../domain/agent/AgentLifecycle";
// MAIN_INSTANCE_ID 改引协议导出（v0.2 OI 收口，F-2⑬；domain 定义保留 AG-02 例外）
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import type { ToolCallRecordData, ToolCallStatus } from "../../../../domain/tools/ToolCallRecord";
import type { SessionEntryData } from "../../../../domain/session/SessionSnapshot";
import type { PersistedDomainState } from "../../../../application/ports/outbound/SessionRepositoryPort";
import type {
  AgentLifecycleRow,
  DomainEventRow,
  SessionStateRow,
  SteerQueueRow,
  ToolCallRow,
} from "./Rows";

/**
 * RowMapper —— 充血聚合 ↔ 贫血行模型的转换（AD-17 第 4/5 条，TP-CL8-5）。
 * 转换归属本层：domain 不见行模型、行模型不见行为；序列化（JSON）在此收口。
 * updated_at 取映射时刻墙钟（投影元数据，非领域数据——不经 ClockPort）。
 */

// ── 领域事件 ↔ domain_events 行 ─────────────────────────────

export function domainEventToRow(event: DomainEvent, agentKind: string): DomainEventRow {
  return {
    session_id: event.sessionId,
    agent_kind: agentKind,
    // 缺省 = 主实例（契约 §1 同语义）；落盘列值显式化（trace 四维可查）
    agent_instance_id: event.instanceId ?? MAIN_INSTANCE_ID,
    type: event.type,
    payload: JSON.stringify(event.payload),
    ts: event.occurredAt,
  };
}

export function rowToDomainEvent(row: DomainEventRow): DomainEvent {
  return {
    type: row.type as DomainEvent["type"],
    sessionId: row.session_id,
    // 旧行兜底（TR-AD-14：列前时代的行/未回填连接读到的空值）——主实例语义
    instanceId: row.agent_instance_id ?? MAIN_INSTANCE_ID,
    payload: JSON.parse(row.payload) as unknown,
    occurredAt: row.ts,
  };
}

// ── 领域状态整体 ↔ 投影行 ───────────────────────────────────

export interface PersistedStateRows {
  readonly session: SessionStateRow;
  readonly lifecycle: AgentLifecycleRow;
  readonly steer: readonly SteerQueueRow[];
  readonly toolCalls: readonly ToolCallRow[];
}

export function persistedStateToRows(state: PersistedDomainState): PersistedStateRows {
  const now = new Date().toISOString();
  const sessionId = state.session.sessionId;
  return {
    session: {
      session_id: sessionId,
      created_at: state.session.createdAt,
      entries: JSON.stringify(state.session.entries),
      turns: JSON.stringify(state.session.turns),
      updated_at: now,
    },
    lifecycle: { session_id: sessionId, instance_id: MAIN_INSTANCE_ID, state: state.agentState, updated_at: now },
    steer: state.session.pendingSteer.map((item) => ({
      session_id: sessionId,
      entry_id: item.entryId,
      text: item.text,
    })),
    toolCalls: state.toolCalls.map((t) => ({
      id: t.id,
      session_id: sessionId,
      instance_id: MAIN_INSTANCE_ID, // 工具记录 domain 侧挂 id 归 T2.x；行级先落主实例
      tool_name: t.toolName,
      args: JSON.stringify(t.args ?? null),
      status: t.status,
      result: t.result ?? null,
      error: t.error ?? null,
      started_at: t.startedAt ?? null,
      ended_at: t.endedAt ?? null,
    })),
  };
}

export function rowsToPersistedState(
  session: SessionStateRow,
  lifecycle: AgentLifecycleRow | undefined,
  steer: readonly SteerQueueRow[],
  toolCalls: readonly ToolCallRow[],
): PersistedDomainState {
  return {
    session: {
      sessionId: session.session_id,
      createdAt: session.created_at,
      // 旧库 entries JSON 无 instanceId（列前时代）→ fromRow 兜底回填主实例（TR-AD-14）；
      // T3.1：entries 为 message/thinking/compaction 混排联合（kind 判别），三类都挂 instanceId
      entries: (JSON.parse(session.entries) as SessionEntryData[]).map((e) => ({
        ...e,
        instanceId: e.instanceId ?? MAIN_INSTANCE_ID,
      })),
      turns: JSON.parse(session.turns),
      pendingSteer: steer.map((s) => ({ entryId: s.entry_id, text: s.text })),
    },
    agentState: (lifecycle?.state ?? "idle") as AgentLifecycleState,
    toolCalls: toolCalls.map((t) => ({
      id: t.id,
      toolName: t.tool_name,
      args: JSON.parse(t.args),
      status: t.status as ToolCallStatus,
      result: t.result ?? undefined,
      error: t.error ?? undefined,
      startedAt: t.started_at ?? undefined,
      endedAt: t.ended_at ?? undefined,
    })) satisfies ToolCallRecordData[],
  };
}

import type { DomainEvent } from "../../../../domain/events/DomainEvent";
import type { AgentLifecycleState } from "../../../../domain/agent/AgentLifecycle";
import { LEGACY_MAIN_INSTANCE_ID } from "../../../../domain/agent/AgentInstance";
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
 * RowMapper —— 充血聚合 ↔ 贫血行模型的转换（AD-17 第 4/5 条）。
 * 转换归属本层：domain 不见行模型、行模型不见行为；序列化（JSON）在此收口。
 * session_state.updated_at = 会话真实活动时间（最后一条 entry 的 createdAt，
 * 空会话兜底 created_at）——清单排序键（listSessionMetadata ORDER BY updated_at
 * / metaFromRow lastActivityAt）。**不得取落盘墙钟**：sealAll（shutdown stopped
 * 里程碑）/空闲卸载等「非活动落盘」会把全部会话 updated_at 抹平成同一时刻，
 * 清单「最近使用」排序被打乱（F-会话排序乱 教训）。
 * lifecycle.updated_at 仍取映射时刻墙钟（状态行投影元数据，非排序键，不经 ClockPort）。
 */

// ── 领域事件 ↔ domain_events 行 ─────────────────────────────

export function domainEventToRow(event: DomainEvent, agentKind: string): DomainEventRow {
  return {
    session_id: event.sessionId,
    agent_kind: agentKind,
    // 缺省 = 主实例（契约 §1 同语义）；落盘列值显式化（trace 四维可查）
    agent_instance_id: event.instanceId ?? LEGACY_MAIN_INSTANCE_ID,
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
    instanceId: row.agent_instance_id ?? LEGACY_MAIN_INSTANCE_ID,
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
  const entries = state.session.entries;
  // 会话真实活动时间：entries 追加有序（append-only），末条即最新活动；空会话
  // （零条目草稿——理论不经 write-through 落库，防御兜底）取 created_at。
  const lastEntry = entries[entries.length - 1];
  const lastActivityAt = lastEntry !== undefined ? lastEntry.createdAt : state.session.createdAt;
  return {
    session: {
      session_id: sessionId,
      created_at: state.session.createdAt,
      entries: JSON.stringify(entries),
      turns: JSON.stringify(state.session.turns),
      updated_at: lastActivityAt,
      // T10a 方案 A：会话主实例 id 随状态行落盘（恢复重建 Session.mainInstanceId
      // 唯一事实源；旧聚合缺省 null = legacy "main"——理论不可达，新聚合恒携带）
      main_instance_id: state.session.mainInstanceId ?? null,
      // P1 T3：会话模式随状态行落盘（建会话定格；快照不携带（列前/缺省）
      // → null，读取侧键不携带——恢复链 RestoreService 归一 default）
      mode: state.session.mode ?? null,
    },
    lifecycle: { session_id: sessionId, instance_id: LEGACY_MAIN_INSTANCE_ID, state: state.agentState, updated_at: now },
    steer: state.session.pendingSteer.map((item) => ({
      session_id: sessionId,
      entry_id: item.entryId,
      text: item.text,
      // 注入来源列（T11a；缺省 null = 用户输入语义，旧形状兼容）
      source: item.source ?? null,
    })),
    toolCalls: state.toolCalls.map((t) => ({
      id: t.id,
      session_id: sessionId,
      // 行级归属透传（AD-3：SubAgent 工具行挂 agent-N；旧载荷
      // 无字段时回填主实例，TR-AD-14 前向兼容）
      instance_id: t.instanceId ?? LEGACY_MAIN_INSTANCE_ID,
      tool_name: t.toolName,
      args: JSON.stringify(t.args ?? null),
      status: t.status,
      result: t.result ?? null,
      error: t.error ?? null,
      // 下行：工具结果附带图片（data URL 数组 JSON 文本；缺省 null）
      images: t.images !== undefined && t.images.length > 0 ? JSON.stringify([...t.images]) : null,
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
      // T10a：主实例 id 列往返（列前时代旧行 NULL → 键不携带，恢复侧兜底
      // legacy "main"——与该会话历史行 instance_id="main" 自闭合）
      ...(session.main_instance_id !== null && session.main_instance_id !== undefined
        ? { mainInstanceId: session.main_instance_id }
        : {}),
      // P1 T3：mode 列往返（列前时代旧行 NULL → 键不携带，恢复侧
      // RestoreService 归一 default——旧行无值兼容）
      ...(session.mode !== null && session.mode !== undefined ? { mode: session.mode } : {}),
      // 旧库 entries JSON 无 instanceId（列前时代）→ fromRow 兜底回填该会话
      // 主实例 id（TR-AD-14；NULL 主 id 列 = legacy "main"）；entries 为
      // message/thinking/compaction 混排联合（kind 判别），三类都挂 instanceId
      entries: (JSON.parse(session.entries) as SessionEntryData[]).map((e) => ({
        ...e,
        instanceId: e.instanceId ?? session.main_instance_id ?? LEGACY_MAIN_INSTANCE_ID,
      })),
      turns: JSON.parse(session.turns),
      pendingSteer: steer.map((s) => ({
        entryId: s.entry_id,
        text: s.text,
        // source 列往返（T11a；旧行 NULL → 键不携带，缺省 user 语义）
        ...(s.source !== null && s.source !== undefined ? { source: s.source as "user" | "closure" | "progress" } : {}),
      })),
    },
    agentState: (lifecycle?.state ?? "idle") as AgentLifecycleState,
    toolCalls: toolCalls.map((t) => ({
      id: t.id,
      // 行级归属透传往返（AD-3：写入侧对称；主实例省略字段保持
      // v0/v0.1 载荷形状）
      ...(t.instance_id !== LEGACY_MAIN_INSTANCE_ID ? { instanceId: t.instance_id } : {}),
      toolName: t.tool_name,
      args: JSON.parse(t.args),
      status: t.status as ToolCallStatus,
      result: t.result ?? undefined,
      error: t.error ?? undefined,
      // 下行：图片列 JSON 往返（null/旧行无列值 → undefined 前向兼容）
      ...(t.images !== null && t.images !== undefined ? { images: JSON.parse(t.images) as string[] } : {}),
      startedAt: t.started_at ?? undefined,
      endedAt: t.ended_at ?? undefined,
    })) satisfies ToolCallRecordData[],
  };
}

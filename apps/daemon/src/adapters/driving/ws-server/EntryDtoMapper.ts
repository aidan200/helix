/**
 * EntryDtoMapper —— 条目级纯转换（domain 条目数据 → 协议 EntryDto 变体）
 * + 跨域共享辅助（thinkingEntryDto / compactionEntryDto / safeJson 被
 * EnvelopeMapper 与 SnapshotMapper 双域经 import 消费；isMainAxisEntry /
 * sessionEntryDto / toolCallEntryDto 供 SnapshotMapper 合并排序）。自
 * DtoMapper.ts 四域拆分落位（TR-AD-25④ 逐行搬移）。投影收敛后：
 * entrySortKey 已迁 @helix/protocol projection 单源（与 shell 侧同构收敛）。
 */
import type {
  EntryDto,
  MessageEntryDto,
  ThinkingEntryDto,
  CompactionEntryDto,
  ToolCallEntryDto,
} from "@helix/protocol";
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import type { EntryData } from "../../../domain/session/Entry";
import type { SessionEntryData } from "../../../domain/session/SessionSnapshot";
import type { ThinkingEntryData } from "../../../domain/session/ThinkingEntry";
import type { CompactionEntryData } from "../../../domain/session/CompactionEntry";
import type { ToolCallRecordData } from "../../../domain/tools/ToolCallRecord";

/**
 * 主轴归属判定（契约 v0.3 §3.2，Q-3a 双处可见的时间轴侧）：主实例条目
 * （instanceId 缺省/main）+ 定向 steer 干预条目（user + isSteer 且 instanceId=
 * 目标 SubAgent——干预消息一律落主时间轴，尾窗/翻页内自然渲染为定向细条；
 * 同一 entry 同时经 instanceChannels 进抽屉 feed 快照面，单事实源视图双投影）。
 */
export function isMainAxisEntry(entry: EntryDto): boolean {
  if ((entry.instanceId ?? MAIN_INSTANCE_ID) === MAIN_INSTANCE_ID) return true;
  return entry.kind === "message" && entry.role === "user" && entry.steerState !== undefined;
}

/** 单条 SessionEntryData → 对应 EntryDto（message/thinking/compaction
 *  分派；thinking/compaction 变体 createdAt 保持 ISO 字符串，契约 §6.1）。 */
export function sessionEntryDto(entry: SessionEntryData, queuedSteer: Set<string>): EntryDto[] {
  if ("kind" in entry) {
    return entry.kind === "thinking" ? [thinkingEntryDto(entry)] : [compactionEntryDto(entry)];
  }
  return messageEntryDto(entry, queuedSteer);
}

/** domain ThinkingEntryData → ThinkingEntryDto（全字段同形）。 */
export function thinkingEntryDto(entry: ThinkingEntryData): ThinkingEntryDto {
  return {
    kind: "thinking",
    id: entry.id,
    instanceId: entry.instanceId,
    text: entry.text,
    durationMs: entry.durationMs,
    reasoningTokens: entry.reasoningTokens,
    createdAt: entry.createdAt,
  };
}

/** domain CompactionEntryData → CompactionEntryDto（usage 七字段同形）。 */
export function compactionEntryDto(entry: CompactionEntryData): CompactionEntryDto {
  return {
    kind: "compaction",
    id: entry.id,
    instanceId: entry.instanceId,
    tokensBefore: entry.tokensBefore,
    tokensAfter: entry.tokensAfter,
    summary: entry.summary,
    usage: entry.usage,
    createdAt: entry.createdAt,
  };
}

/** 单条 EntryData → MessageEntryDto（tool 角色当前领域侧不产生，防御跳过）。
 * （AD-3）：SubAgent 条目携带 instanceId（前端 分流依据）；主实例
 *  省略（缺省 = main，线格式保持 v0/v0.1 形状）。 */
function messageEntryDto(entry: EntryData, queuedSteer: Set<string>): MessageEntryDto[] {
  if (entry.role !== "user" && entry.role !== "assistant") return [];
  const dto: MessageEntryDto = {
    kind: "message",
    id: entry.id,
    role: entry.role,
    content: entry.text,
    ts: Date.parse(entry.createdAt),
  };
  if (entry.role === "user" && entry.isSteer) {
    dto.steerState = queuedSteer.has(entry.id) ? "queued" : "drained";
  }
  if (entry.instanceId !== MAIN_INSTANCE_ID) dto.instanceId = entry.instanceId;
  // 图片下行：user 消息携带图片附件（快照投影重建同源；缺省不携带）
  if (entry.images !== undefined && entry.images.length > 0) dto.images = [...entry.images];
  return [dto];
}

/** 单条 ToolCallRecordData → ToolCallEntryDto（D-1：快照侧工具条目）。
 *  三态映射与事件侧（tool.call.started/result）口径一致；result 恒发、
 *  isError 区分——completed→result、failed→error 文案（无 error 回退
 *  result）、running 无；durationMs 仅起止齐备时携带。 */
export function toolCallEntryDto(record: ToolCallRecordData): ToolCallEntryDto {
  const dto: ToolCallEntryDto = {
    kind: "tool-call",
    id: record.id,
    name: record.toolName,
    args: safeJson(record.args),
    state: record.status === "completed" ? "done" : record.status === "failed" ? "error" : "running",
    ts: record.startedAt !== undefined
      ? Date.parse(record.startedAt)
      : record.endedAt !== undefined
        ? Date.parse(record.endedAt)
        : 0,
  };
  // 行级归属透传（SubAgent 工具卡归实例 channel；主实例省略；AD-3）
  if (record.instanceId !== undefined && record.instanceId !== MAIN_INSTANCE_ID) {
    dto.instanceId = record.instanceId;
  }
  // 图片下行：工具结果附带图片（快照/翻页工具卡缩略图数据源；缺省不带）
  if (record.images !== undefined && record.images.length > 0) dto.images = [...record.images];
  if (record.status === "completed") {
    if (record.result !== undefined) dto.result = record.result;
  } else if (record.status === "failed") {
    const result = record.error ?? record.result;
    if (result !== undefined) dto.result = result;
  }
  if (record.startedAt !== undefined && record.endedAt !== undefined) {
    dto.durationMs = Math.max(0, Date.parse(record.endedAt) - Date.parse(record.startedAt));
  }
  return dto;
}

/** args 序列化（undefined → "{}"；循环/异常值的兜底为字符串占位）。 */
export function safeJson(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args) ?? "{}";
  } catch {
    return String(args);
  }
}

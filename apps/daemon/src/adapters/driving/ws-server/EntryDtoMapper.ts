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
  ErrorEntryDto,
  ToolCallEntryDto,
} from "@helix/protocol";
import type { EntryData } from "../../../domain/session/Entry";
import type { SessionEntryData } from "../../../domain/session/SessionSnapshot";
import type { ThinkingEntryData } from "../../../domain/session/ThinkingEntry";
import type { CompactionEntryData } from "../../../domain/session/CompactionEntry";
import type { ErrorEntryData } from "../../../domain/session/ErrorEntry";
import type { ToolCallRecordData } from "../../../domain/tools/ToolCallRecord";

/**
 * wire 边界 legacy 主实例字面（"main"）：旧行/旧事件的只读兼容值 + 读侧
 * 缺省推断基准。与 domain WIRE_LEGACY_MAIN_ID 同值——AD-17.5 转换层
 * 对 domain 仅 type-only（无运行时耦合），值字面本层自持。
 */
export const WIRE_LEGACY_MAIN_ID = "main" as const;

/**
 * wire 边界主实例归属判别（T10a 方案 A）：id === 该会话主实例 id，或
 * legacy "main"（历史行只读兼容），或缺省（旧载荷省略 = main 推断，读侧保留）。
 * EnvelopeMapper/SnapshotMapper 同目录消费（条目归属编码/engine.error 抑制共用）。
 */
export function isWireMainAttribution(instanceId: string | undefined, mainInstanceId: string): boolean {
  return instanceId === undefined || instanceId === mainInstanceId || instanceId === WIRE_LEGACY_MAIN_ID;
}

/**
 * wire 边界实例归属编码（T10a 方案 A 最小面）：主实例归属（该会话主实例 id
 * / legacy "main" / 缺省）按旧线格式编码——message/tool 省略（读侧缺省=main
 * 推断保留），thinking/compaction 因协议类型必填位编码 legacy "main" 字面。
 * SubAgent 归属原样透传。全量显式携带的协议文档化决策归 T10b；本任务只保证
 * daemon 行为正确 + 读侧旧形状兼容（projection 锚扫描/主轴判别零漂移）。
 */
function wireMainAware(instanceId: string | undefined, mainInstanceId: string): boolean {
  return isWireMainAttribution(instanceId, mainInstanceId);
}

/**
 * 主轴归属判定（契约 v0.3 §3.2，Q-3a 双处可见的时间轴侧）：主实例条目
 * （instanceId 缺省/main）+ 定向 steer 干预条目（user + isSteer 且 instanceId=
 * 目标 SubAgent——干预消息一律落主时间轴，尾窗/翻页内自然渲染为定向细条；
 * 同一 entry 同时经 instanceChannels 进抽屉 feed 快照面，单事实源视图双投影）。
 */
export function isMainAxisEntry(entry: EntryDto): boolean {
  if ((entry.instanceId ?? WIRE_LEGACY_MAIN_ID) === WIRE_LEGACY_MAIN_ID) return true;
  return entry.kind === "message" && entry.role === "user" && entry.steerState !== undefined;
}

/** 单条 SessionEntryData → 对应 EntryDto（message/thinking/compaction/error
 *  分派；thinking/compaction/error 变体 createdAt 保持 ISO 字符串，契约 §6.1）。 */
export function sessionEntryDto(
  entry: SessionEntryData,
  queuedSteer: Set<string>,
  mainInstanceId: string = WIRE_LEGACY_MAIN_ID,
): EntryDto[] {
  if ("kind" in entry) {
    if (entry.kind === "thinking") return [thinkingEntryDto(entry, mainInstanceId)];
    if (entry.kind === "error") return [errorEntryDto(entry, mainInstanceId)];
    return [compactionEntryDto(entry, mainInstanceId)];
  }
  return messageEntryDto(entry, queuedSteer, mainInstanceId);
}

/** domain ThinkingEntryData → ThinkingEntryDto（全字段同形；实例归属经
 *  wire 边界编码——主实例编 legacy "main" 字面，协议类型必填位）。 */
export function thinkingEntryDto(
  entry: ThinkingEntryData,
  mainInstanceId: string = WIRE_LEGACY_MAIN_ID,
): ThinkingEntryDto {
  return {
    kind: "thinking",
    id: entry.id,
    instanceId: wireMainAware(entry.instanceId, mainInstanceId) ? WIRE_LEGACY_MAIN_ID : entry.instanceId,
    text: entry.text,
    durationMs: entry.durationMs,
    createdAt: entry.createdAt,
  };
}

/** domain ErrorEntryData → ErrorEntryDto（error entry 批：全字段同形；实例
 *  归属编码同 thinkingEntryDto——主实例编 legacy "main" 字面，协议类型必填位）。 */
export function errorEntryDto(
  entry: ErrorEntryData,
  mainInstanceId: string = WIRE_LEGACY_MAIN_ID,
): ErrorEntryDto {
  return {
    kind: "error",
    id: entry.id,
    instanceId: wireMainAware(entry.instanceId, mainInstanceId) ? WIRE_LEGACY_MAIN_ID : entry.instanceId,
    message: entry.message,
    turnId: entry.turnId,
    createdAt: entry.createdAt,
  };
}

/** domain CompactionEntryData → CompactionEntryDto（usage 七字段同形；实例
 *  归属编码同 thinkingEntryDto）。 */
export function compactionEntryDto(
  entry: CompactionEntryData,
  mainInstanceId: string = WIRE_LEGACY_MAIN_ID,
): CompactionEntryDto {
  return {
    kind: "compaction",
    id: entry.id,
    instanceId: wireMainAware(entry.instanceId, mainInstanceId) ? WIRE_LEGACY_MAIN_ID : entry.instanceId,
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
function messageEntryDto(
  entry: EntryData,
  queuedSteer: Set<string>,
  mainInstanceId: string,
): MessageEntryDto[] {
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
  if (!wireMainAware(entry.instanceId, mainInstanceId)) dto.instanceId = entry.instanceId;
  // 注入来源下行（T11a：closure/progress/user；缺省不携带——老快照前向兼容）
  if (entry.source !== undefined) dto.source = entry.source;
  // 所属轮次下行（轮末 token 用量显示面 additive）：turnId=null（SubAgent
  // 条目/恢复注入）不携带键——气泡按 turnId 查 turnUsage，缺省不显示
  if (entry.turnId !== null) dto.turnId = entry.turnId;
  // 图片下行：user 消息携带图片附件（快照投影重建同源；缺省不携带）
  if (entry.images !== undefined && entry.images.length > 0) dto.images = [...entry.images];
  return [dto];
}

/** 单条 ToolCallRecordData → ToolCallEntryDto（D-1：快照侧工具条目）。
 *  三态映射与事件侧（tool.call.started/result）口径一致；result 恒发、
 *  isError 区分——completed→result、failed→error 文案（无 error 回退
 *  result）、running 无；durationMs 仅起止齐备时携带。 */
export function toolCallEntryDto(
  record: ToolCallRecordData,
  mainInstanceId: string = WIRE_LEGACY_MAIN_ID,
): ToolCallEntryDto {
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
  // 行级归属透传（SubAgent 工具卡归实例 channel；主实例经 wire 边界编码省略；AD-3）
  if (record.instanceId !== undefined && !wireMainAware(record.instanceId, mainInstanceId)) {
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

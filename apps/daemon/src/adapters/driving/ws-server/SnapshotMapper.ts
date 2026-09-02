/**
 * SnapshotMapper —— 快照域（SessionStateView → SessionSnapshotDto /
 * loadHistory 分页 / 实例通道分组 / usage / sessionMetaDto）+ 尾窗分页常量
 * 与注入面接口（随域走，barrel re-export 保直接 import 面不变）。
 * 自 DtoMapper.ts 四域拆分落位（TR-AD-25④ 逐行搬移）。
 */
import type {
  AgentStateDto,
  AgentInstanceDto,
  EntryDto,
  InstanceChannelHistory,
  SessionSnapshotDto,
  SessionUsageDto,
  UsageDto,
} from "@helix/protocol";
import type { SessionMeta } from "@helix/protocol";
import type { SessionStateView, InstanceSnapshotEntry } from "../../../application/ports/inbound/SessionPort";
import type { SessionMetaView } from "../../../application/ports/inbound/SessionDirectoryPort";
import type { SessionUsageSummary, UsageSummary } from "../../../domain/session/SessionSnapshot";
import { isMainAxisEntry, sessionEntryDto, toolCallEntryDto, WIRE_LEGACY_MAIN_ID } from "./EntryDtoMapper";
// 投影收敛：entry 排序基元 + spawn 锚权威计算单源 @helix/protocol
// projection（原 EntryDtoMapper.entrySortKey / SpawnAnchor.ts 两纯函数迁出）
import { computeAnchorEntryId, entrySortKey } from "@helix/protocol";

// ── 尾窗/分页参数（G-1 钦死：契约 B §4；daemon 侧可注入） ───────────

/** 主时间轴尾窗大小（AD-1：默认 30 条，G-1）。 */
export const TAIL_WINDOW_SIZE = 30;
/** loadHistory 分页大小缺省（G-1）。 */
export const HISTORY_PAGE_DEFAULT = 50;
/** loadHistory 分页大小上限（防滥用）。 */
export const HISTORY_PAGE_MAX = 200;

/** 快照组装的尾窗参数（组合根/测试注入面）。 */
export interface SnapshotTailOptions {
  /** 主时间轴尾窗大小（缺省 TAIL_WINDOW_SIZE）。 */
  readonly tailSize?: number;
}

/** loadHistory 分页结果（契约 B §1.3；游标非法抛 Error 由调用方转 invalid_cursor）。 */
export interface HistoryPage {
  /** beforeEntryId 之前的更早历史（时间升序，至多 limit 条）。 */
  readonly entries: EntryDto[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

// ── 快照 ────────────────────────────────────────────────────

/**
 * SessionStateView（domain）→ SessionSnapshotDto（协议）。
 * D-1：消息条目与工具调用记录按 ts 时间序合并（重连/重启后工具卡随快照
 * 恢复，契约 §6）；revision 取合并后总条数（v0 无逐事件序号，以条目数为
 * 增量基线，单调且可复算——尾窗口径下仍取全量计数）；model/agentState
 * 来自组合根注入的 system 状态（domain 快照不含）。
 * instances/usage additive 装配（契约 §6.2）——视图携带才下发，
 * domain↔协议同构字段直映射（closure/usage 七字段不变形）。
 * SubAgent 过程历史按实例分组进 instances[].channels（AD-3）
 * （v0.2 additive）。
 * 主时间轴（主实例条目）只下发尾窗 tail（AD-1 尾窗口径，G-1=30）
 *（entries 同源）；**per-instance channel 分组完整保留不截断**（硬
 * 约束——不按全局时间序切尾）；totalEntries/tailStartCursor 分页指示。
 */
export function toSnapshotDto(
  view: SessionStateView,
  model: string,
  agentState: AgentStateDto,
  opts: SnapshotTailOptions = {},
): SessionSnapshotDto {
  const snapshot = view.session;
  // T10a：会话主实例 id（快照 mainInstanceId；旧快照缺省 = legacy "main"）——
  // wire 边界实例归属编码的判别基准
  const mainId = snapshot.mainInstanceId ?? WIRE_LEGACY_MAIN_ID;
  const queuedSteer = new Set(snapshot.pendingSteer.map((item) => item.entryId));
  // 升序稳定排序：时间并列保持组内原序（entries 原序 / toolCalls 迭代序）
  // entries 为 message/thinking/compaction 混排联合，各变体同表合并
  const merged: EntryDto[] = [
    ...snapshot.entries.flatMap((entry) => sessionEntryDto(entry, queuedSteer, mainId)),
    ...view.toolCalls.map((record) => toolCallEntryDto(record, mainId)),
  ].sort((a, b) => entrySortKey(a) - entrySortKey(b));
  // 主时间轴 = 主实例条目 + 定向 steer 干预条目（契约 v0.3 §3.2）；尾窗只作用于主轴（AD-1）
  const mainAxis = merged.filter(isMainAxisEntry);
  const tailSize = opts.tailSize ?? TAIL_WINDOW_SIZE;
  const tail = mainAxis.length > tailSize ? mainAxis.slice(mainAxis.length - tailSize) : mainAxis;
  return {
    sessionId: snapshot.sessionId,
    // P1 T3：会话模式定格值回带（快照携带才下发，additive——旧 daemon
    // 兼容；快照不携带 → 读侧按 default 兜底）
    ...(snapshot.mode !== undefined ? { mode: snapshot.mode } : {}),
    model,
    agentState,
    revision: merged.length,
    entries: tail, // v0.2 尾窗口径：entries 与 tail 同源（契约 B §2.2）
    tail,
    totalEntries: mainAxis.length,
    tailStartCursor: mainAxis.length > tail.length ? (tail[0]?.id ?? null) : null,
    // thinking 批③ wire 面（F-8 修复，v0.11 批内补登）：视图携带才下发（additive）
    ...(view.thinking !== undefined ? { thinking: view.thinking } : {}),
    ...(view.instances !== undefined
      ? {
          instances: view.instances.map((instance) =>
            instanceDto(instance, instanceChannels(merged, instance), computeAnchorEntryId(merged, instance)),
          ),
        }
      : {}),
    ...(view.usage !== undefined ? { usage: usageDto(view.usage) } : {}),
  };
}

/**
 * loadHistory 分页切取（契约 B §1.3，AD-1 向上回溯）：主时间轴在
 * beforeEntryId 之前的更早历史，升序至多 limit 条；hasMore/nextCursor 指示
 * 续拉。游标不在主轴内（SubAgent 条目/不存在）→ 抛错（调用方转
 * session.invalid_cursor）。
 */
export function historyPage(
  view: SessionStateView,
  beforeEntryId: string,
  limit: number = HISTORY_PAGE_DEFAULT,
): HistoryPage {
  const snapshot = view.session;
  const mainId = snapshot.mainInstanceId ?? WIRE_LEGACY_MAIN_ID;
  const queuedSteer = new Set(snapshot.pendingSteer.map((item) => item.entryId));
  const merged: EntryDto[] = [
    ...snapshot.entries.flatMap((entry) => sessionEntryDto(entry, queuedSteer, mainId)),
    ...view.toolCalls.map((record) => toolCallEntryDto(record, mainId)),
  ].sort((a, b) => entrySortKey(a) - entrySortKey(b));
  const mainAxis = merged.filter(isMainAxisEntry);
  const cursorIndex = mainAxis.findIndex((entry) => entry.id === beforeEntryId);
  if (cursorIndex < 0) {
    throw new Error(`游标 ${beforeEntryId} 不在会话 ${snapshot.sessionId} 主时间轴内`);
  }
  const earlier = mainAxis.slice(0, cursorIndex); // 严格早于游标（升序）
  const size = Math.min(Math.max(1, Math.floor(limit)), HISTORY_PAGE_MAX);
  const page = earlier.length > size ? earlier.slice(earlier.length - size) : earlier;
  const hasMore = earlier.length > page.length;
  return {
    entries: page,
    hasMore,
    nextCursor: hasMore ? (page[0]?.id ?? null) : null,
  };
}

/**
 * 实例通道历史分组（AD-3：SubAgent Entry 按实例归组——thinking/messages/
 * tools 三槽，契约 §6.2 InstanceChannelHistory）。主实例不分组（主时间轴
 * entries 全量即主实例历史；尾窗只作用于主时间轴）。
 */
function instanceChannels(entries: readonly EntryDto[], instance: InstanceSnapshotEntry): InstanceChannelHistory | undefined {
  if (instance.kind === "main") return undefined; // 主实例不分组（kind 判别，T10a）
  let channels: InstanceChannelHistory | undefined;
  for (const entry of entries) {
    if (entry.instanceId !== instance.instanceId) continue; // 主实例条目 wire 边界省略（undefined）天然跳过
    channels ??= {};
    if (entry.kind === "message") channels.messages = [...(channels.messages ?? []), entry];
    else if (entry.kind === "thinking") channels.thinking = [...(channels.thinking ?? []), entry];
    else if (entry.kind === "tool-call") channels.tools = [...(channels.tools ?? []), entry];
    // compaction：会话级里程碑（仅主实例产生），不进实例通道
  }
  return channels;
}

/** InstanceSnapshotEntry（domain）→ AgentInstanceDto（协议；task/closure/usage 同构直映射）。
 * channels 携带时附加（SubAgent 通道历史分组，AD-3/⑤）。
 * （契约 v0.3 §1，AD-5）：anchor 由 computeAnchorEntryId 权威计算后传入——
 *  undefined = 主实例不携带；null = 流首锚（有效值）。 */
function instanceDto(
  entry: InstanceSnapshotEntry,
  channels?: InstanceChannelHistory,
  anchor?: string | null,
): AgentInstanceDto {
  return {
    instanceId: entry.instanceId,
    kind: entry.kind,
    profileKind: entry.profileKind,
    state: entry.state,
    createdAt: entry.createdAt,
    ...(entry.elapsedMs !== undefined ? { elapsedMs: entry.elapsedMs } : {}),
    ...(entry.startedAtMs !== undefined ? { startedAtMs: entry.startedAtMs } : {}),
    ...(entry.task !== undefined ? { task: entry.task } : {}),
    ...(entry.usage !== undefined ? { usage: usageTotal(entry.usage) } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(anchor !== undefined ? { anchorEntryId: anchor } : {}),
    ...(entry.closure !== undefined
      ? {
          closure: {
            status: entry.closure.status,
            summary: entry.closure.summary,
            reportPath: entry.closure.reportPath ?? null,
            findings: entry.closure.findings ?? null,
            taskId: entry.closure.taskId ?? null,
          },
        }
      : {}),
  };
}

/** UsageSummary（domain 七字段）→ UsageDto（协议；cost 拍平同形）。 */
function usageTotal(u: UsageSummary): UsageDto {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    reasoning: u.reasoning,
    totalTokens: u.totalTokens,
    cost: u.cost,
  };
}

/** SessionMetaView（domain 侧）→ SessionMeta（协议；session.list 结果/list_changed 载荷同源）。 */
export function sessionMetaDto(meta: SessionMetaView): SessionMeta {
  return {
    sessionId: meta.sessionId,
    title: meta.title,
    lastActivityAt: meta.lastActivityAt,
    runState: meta.runState,
    loaded: meta.loaded,
  };
}

function usageDto(summary: SessionUsageSummary): SessionUsageDto {
  return { total: usageTotal(summary.total), compaction: usageTotal(summary.compaction) };
}

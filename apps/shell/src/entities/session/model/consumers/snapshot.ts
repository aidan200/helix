/**
 * snapshot 消费者 —— 快照重建（session.snapshot；C2 拆分，AD-3，T1.1；
 * v0.2 尾窗口径升级 T3.1）。
 *
 * 快照为落盘终态权威：entries 整体替换（重连恢复全量来自 daemon，无本地
 * 补齐）；F1.6 分流（main 条目 + compaction 归 main 流）；重连合入（事件流
 * 构建的 channel 保留，含 stalled 等仅存于事件流的行；快照未列实例的
 * channel 丢弃）；instances/usage additive 重建；流式中间态不落盘
 * （streaming/thinkingStreams/channelStreams 重建后清空）；nextChannelSeq
 * 重算（per-store 单调——T3.1 定稿：切换重建时从快照重算，旧 store 值
 * 不带入；React key 稳定前提在同一 store 内成立）。
 *
 * v0.2 尾窗字段升级（AD-1，契约 B §2.2）：
 * - view：快照到达即转 ready（P-1s 两阶段 success 位；首连/切换共用）；
 * - history：tailStartCursor 初始化向上分页游标（null/缺省 = 已含全部
 *   历史 → hasMore=false；旧快照无尾窗字段兼容同判）；
 * - instances[].channels：per-instance 完整历史分组重建 channel（F-14⑤
 *   硬约束：SubAgent 历史不随主时间轴尾窗截断）；无 channels 字段时回落
 *   entries 归组路径（v0/v0.1 旧快照兼容）。
 */
import type {
  AgentInstanceDto,
  CompactionEntryDto,
  EntryDto,
  EventEnvelope,
  MessageEntryDto,
  PendingSteerDto,
  SessionUsageDto,
  UsageDto,
} from "@helix/protocol";
import { entrySortKey } from "@helix/protocol"; // T3.1：条目排序基元单源 projection（原本地 entryTimelineKey 同构副本退役）
import { DEFAULT_MODE_ID } from "@helix/protocol";
import { lcItem } from "../channel";
import {
  isMainChannel,
  ZERO_USAGE,
  type ChannelItem,
  type InstanceCardState,
  type SessionState,
  type SessionUsageProjection,
  type SteerQueueDockItem,
  type ThinkingSlice,
} from "../state";
/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const SNAPSHOT_EVENT_TYPES = ["session.snapshot"] as const;

/** 快照 instances → 卡片重建（subagent 过滤；主实例非卡片；DTO 无摘要字段 → 空串复位）。
 *  锚点（CL-1 v0.3，契约 §1；Q-1c）：anchorEntryId 直读 DTO 为唯一权威——
 *  快照与 agent.spawned 帧均由 daemon 组装期计算下发，shell 零推导、无
 *  live 锚点双轨；null = 流首有效锚（显式保留，不回落）。 */
function instancesFromSnapshot(dtos: AgentInstanceDto[]): InstanceCardState[] {
  return dtos
    .filter((d) => d.kind === "subagent")
    .map((d) => ({
      instanceId: d.instanceId,
      state: d.state,
      task: d.task ?? "",
      profileKind: d.profileKind,
      ...(d.elapsedMs !== undefined ? { elapsedMs: d.elapsedMs } : {}),
      ...(d.startedAtMs !== undefined ? { startedAtMs: d.startedAtMs } : {}),
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(d.state === "queued" && d.queuedPosition !== undefined
        ? { queuedPosition: d.queuedPosition }
        : {}),
      ...(d.closure ? { closure: d.closure } : {}),
      streamSummary: "",
      // DTO 锚点直读（null 流首有效，不吞）；缺省不携带 = 主实例（已被过滤）
      anchorEntryId: d.anchorEntryId ?? null,
    }));
}

/** 快照 usage/instances → 账目重建（快照为权威；缺省 = 零账面/无实例，旧剧本兼容）。 */
function usageFromSnapshot(
  usageDto: SessionUsageDto | undefined,
  instances: AgentInstanceDto[] | undefined,
  /** main 实例 id（水位兑底写入键） */
  mainId: string,
  /** 快照全部条目（扫最后一条 compaction 兑底 main 水位） */
  entries: EntryDto[],
): SessionUsageProjection {
  const byInstance: Record<string, UsageDto> = {};
  for (const d of instances ?? []) {
    if (d.usage) byInstance[d.instanceId] = d.usage;
  }
  // 上下文水位（TR-59 观察面）：优先 daemon 账本重建值（usage.ctx——事件
  // 重放精确到终态实例，重启即准）；旧 daemon 未携带时兑底 main = 最后
  // 一条 compaction entry 的 tokensAfter（其后无新 turn 时即当前水位）
  const ctxByInstance: Record<string, number> = { ...(usageDto?.ctx ?? {}) };
  if (ctxByInstance[mainId] === undefined) {
    const lastCompact = [...entries].reverse().find((e): e is CompactionEntryDto => e.kind === "compaction");
    if (lastCompact) ctxByInstance[mainId] = lastCompact.tokensAfter;
  }
  if (!usageDto) return { total: ZERO_USAGE, compaction: ZERO_USAGE, byInstance, ctxByInstance };
  return { total: usageDto.total, compaction: usageDto.compaction, byInstance, ctxByInstance };
}

/** 快照 entries → 实例 channel 条目（user 消息 → steer 标记；compaction 不入 channel，M2 main 语义）。
 *  CL-3：定向 steer 干预条目（user + steerState + instanceId=本实例，契约 §3.2
 *  Q-3a 双投影）→ steer-directed 物种（与时间轴侧同构）；主线 agent_send
 *  转投回放（普通 user 无 steerState）→ 既有 steer 注入标记。 */
function entryToChannelItem(entry: EntryDto, seq: number): ChannelItem | null {
  switch (entry.kind) {
    case "message":
      if (entry.role === "user") {
        return entry.steerState !== undefined && entry.instanceId !== undefined
          ? { kind: "steer-directed", seq, text: entry.content, ts: entry.ts, target: entry.instanceId }
          : { kind: "steer", seq, text: entry.content, ts: entry.ts };
      }
      return { kind: "message", seq, text: entry.content, ts: entry.ts };
    case "tool-call":
      return { kind: "tool", seq, entry };
    case "thinking":
      return { kind: "thinking-entry", seq, entry };
    default:
      return null;
  }
}

/** channel 条目时间戳归一（T3.1 起单源 @helix/protocol projection
 *  entrySortKey：message/tool = number ts；thinking/compaction = ISO createdAt）。 */
const entryTimelineKey = entrySortKey;

/**
 * 实例通道历史分组（v0.2 instances[].channels；F-14⑤ 完整保留不截断）→
 * 单一时间线条目：三组各按到达序，合并后按时间戳稳定排序（同刻保组内序）。
 */
function groupedChannelItems(dto: AgentInstanceDto, next: () => number): ChannelItem[] {
  const ch = dto.channels;
  const merged: EntryDto[] = ch
    ? [...(ch.messages ?? []), ...(ch.tools ?? []), ...(ch.thinking ?? [])].sort(
        (a, b) => entryTimelineKey(a) - entryTimelineKey(b),
      )
    : [];
  const items: ChannelItem[] = [];
  for (const e of merged) {
    const item = entryToChannelItem(e, next());
    if (item) items.push(item);
  }
  return items;
}

/** 快照 → channel 重建（spawned/模型解析行 + 实例历史归流 + closure 尾卡；AD-10 历史保留）。
 *  实例历史源优先级：v0.2 dto.channels（完整分组）> snap.entries 归组（旧快照兼容）。 */
function channelsFromSnapshot(
  dtos: AgentInstanceDto[],
  entriesByInstance: Map<string, EntryDto[]>,
  sessionModel: string,
): Record<string, ChannelItem[]> {
  const channels: Record<string, ChannelItem[]> = {};
  let seq = 1;
  for (const dto of dtos) {
    if (dto.kind !== "subagent") continue;
    const items: ChannelItem[] = [
      lcItem("spawned")(seq++),
      lcItem("modelResolved", {
        model: dto.model ?? sessionModel,
        slot: dto.model !== undefined ? "declared" : "inherited",
      })(seq++),
    ];
    if (dto.channels !== undefined) {
      // v0.2 完整分组（F-14⑤：不随主时间轴尾窗截断）
      items.push(...groupedChannelItems(dto, () => seq++));
    } else {
      for (const e of entriesByInstance.get(dto.instanceId) ?? []) {
        const item = entryToChannelItem(e, seq++);
        if (item) items.push(item);
      }
    }
    if (dto.closure) items.push({ kind: "closure", seq: seq++, closure: dto.closure });
    channels[dto.instanceId] = items;
  }
  return channels;
}

/**
 * 主实例 id 习得（T10c kind 判别）：快照 instances kind=main 条目是唯一
 * 事实源（daemon 恒列主实例，新形态 agent-<唯一串> / legacy 会话 "main"
 * 自闭合）；无 instances/无 main 条目 = 保持现值（初始 legacy 字面，
 * 判别退化读侧推断——旧快照兼容）。
 */
function mainInstanceIdOf(dtos: readonly AgentInstanceDto[], fallback: string): string {
  return dtos.find((d) => d.kind === "main")?.instanceId ?? fallback;
}

/** steer 队列坞重建：快照 pendingSteer（additive 权威）优先；缺省回退
 *  entries 抽取的 queued 条目（旧 daemon wire 无 pendingSteer 字段 / 旧数据）。 */
function steerQueueFromSnapshot(
  snap: { pendingSteer?: PendingSteerDto[] },
  queuedEntries: readonly MessageEntryDto[],
): SteerQueueDockItem[] {
  if (snap.pendingSteer !== undefined) {
    return snap.pendingSteer.map((item) => ({
      id: item.entryId,
      text: item.text,
      confirmed: true,
      ts: 0, // pendingSteer 无时间戳（FIFO 数组序即权威序）
      ...(item.source !== undefined ? { source: item.source } : {}),
    }));
  }
  return queuedEntries.map((e) => ({
    id: e.id,
    text: e.content,
    confirmed: true,
    ts: e.ts,
    ...(e.source !== undefined ? { source: e.source } : {}),
  }));
}

export function applySnapshotEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "session.snapshot": {
      const snap = event.payload.snapshot;
      const dtos = snap.instances ?? [];
      const mainId = mainInstanceIdOf(dtos, s.mainInstanceId);
      // F1.6 分流（快照面，kind 判别）：main 条目（isMainChannel：主实例 id
      // 或 legacy 缺省/"main"）进主消息流；SubAgent 条目归实例 channel
      // （重建用）；compaction 归 main 流（M2 语义）
      // CL-3（契约 §3.2 Q-3a）：定向 steer 干预条目（user+steerState 且
      // 非 main）双投影——进主流（daemon isMainAxisEntry 同规，恢复
      // 重放保留）同时保留归组（dto.channels 缺省时的 channel 重建 fallback 面）
      const mainEntries: EntryDto[] = [];
      const entriesByInstance = new Map<string, EntryDto[]>();
      // drain 落盘语义：queued steer 不上时间轴——从主流抽取归队列坞重建
      //（旧版本落盘的 queued entry 同规抽取；定向 steer 恒 drained 不误伤）
      const queuedSteerEntries: MessageEntryDto[] = [];
      for (const e of snap.entries) {
        const main = isMainChannel(e.instanceId, mainId);
        if (main && e.kind === "message" && e.steerState === "queued") {
          queuedSteerEntries.push(e);
          continue;
        }
        const directedSteer =
          !main &&
          e.kind === "message" &&
          e.role === "user" &&
          e.steerState !== undefined;
        if (main || e.kind === "compaction" || directedSteer) {
          mainEntries.push(e);
          if (!directedSteer) continue;
        }
        // 归组：SubAgent 条目 / 定向干预条目（instanceId 必有——非 main 判别
        // 已排除缺省与 legacy 字面；防御 else-if）
        if (e.instanceId !== undefined) {
          const list = entriesByInstance.get(e.instanceId) ?? [];
          list.push(e);
          entriesByInstance.set(e.instanceId, list);
        }
      }
      const rebuilt = channelsFromSnapshot(dtos, entriesByInstance, snap.model);
      // 重连合入：已有事件流构建的 channel 保留（含 stalled 等仅存于事件流的行）；
      // 重启恢复（空状态起）= 全量重建；快照未列实例的 channel 丢弃（卡片已不存）
      const merged: Record<string, ChannelItem[]> = {};
      for (const dto of dtos) {
        if (dto.kind !== "subagent") continue;
        merged[dto.instanceId] = s.instanceChannels[dto.instanceId] ?? rebuilt[dto.instanceId] ?? [];
      }
      let nextSeq = s.nextChannelSeq;
      for (const items of Object.values(merged)) {
        for (const i of items) nextSeq = Math.max(nextSeq, i.seq + 1);
      }
      // AD-1 尾窗分页游标：tailStartCursor 携带且有交 → hasMore；缺省/null =
      // 已含全部历史（v0/v0.1 旧快照兼容同判）
      const startCursor = snap.tailStartCursor ?? null;
      // thinking 批③（契约 ③，additive）：快照 thinking 读面 → 切片初始化
      //（F1.5 快照侧：切换/重连/重启后 UI 与引擎一致）。协议 SessionSnapshotDto
      // 已登记 thinking 可选字段 + SnapshotMapper 已映射（修复批 F-8）；本消费按
      // additive 可选位防御读取，缺省保留现值（旧快照/未映射兼容）
      const snapThinking = (snap as { thinking?: ThinkingSlice }).thinking;
      return {
        ...s,
        entries: mainEntries, // 整体替换：重连恢复全量来自 daemon（无本地补齐）；F1.6 分流见上
        // steer 队列坞重建（drain 落盘语义）：快照 pendingSteer 为权威（additive——
        // 新 daemon 携带）；缺省回退 entries 抽取的 queued 条目（旧 daemon/旧数据兼容）
        steerQueue: steerQueueFromSnapshot(snap, queuedSteerEntries),
        model: snap.model,
        // P1 T4 快照 mode 收权：建会话定格值回带（草稿转正/切换/重连共用）；
        // 缺省 = default 兜底（旧 daemon 兼容）——此后无写路径（只读锁定）
        mode: snap.mode ?? DEFAULT_MODE_ID,
        agentState: snap.agentState,
        sessionId: snap.sessionId,
        mainInstanceId: mainId, // T10c：主实例 id 习得（kind=main 条目；快照权威）
        streaming: null, // 快照为落盘终态；进行中的流随重连作废
        thinkingStreams: {}, // 同上：thinking 流式中间态不落盘，重建后由后续 delta 重新累积
        lastStreamKind: null, // 同上：流式通道信号随槽位重建重置
        channelStreams: {}, // 同上：channel 流式消息为不落盘中间态
        instances: snap.instances ? instancesFromSnapshot(dtos) : [], // additive：实例清单重建卡片（无字段旧剧本兼容 → 空）
        instanceChannels: merged,
        nextChannelSeq: nextSeq,
        usage: usageFromSnapshot(snap.usage, snap.instances, mainId, snap.entries), // additive：账目重建（权威）
        // additive：thinking 切片重建（权威）；缺省保留现值（含草稿暂存——
        // 建会话快照未携带时暂存值不丢，provider 补发 thinking.set 后广播收权）
        thinking: snapThinking !== undefined
          ? { override: snapThinking.override, effective: snapThinking.effective }
          : s.thinking,
        // additive：主会话工作台账恢复种子（main-session plan 批）——携带时
        // 整体替换（null = 无台账如实落）；缺省保留现值（旧 daemon 兼容，
        // 与 thinking 切片同判）
        plan: snap.plan !== undefined ? snap.plan : s.plan,
        ledger: snap.plan !== undefined ? (snap.ledger ?? null) : s.ledger,
        spawnToast: null, // 快照为新会话视图；旧 toast 不跨会话残留
        killToast: null,
        restoreToast: s.toastPending ? { kind: s.toastPending, count: snap.entries.length } : s.restoreToast,
        toastPending: null,
        view: "ready", // P-1s 两阶段：快照到达即 success（输入恢复判据）
        // total = 分页胶囊分母（totalEntries）；paged = 曾有更早历史可载
        history: {
          hasMore: startCursor !== null,
          nextCursor: startCursor,
          loading: false,
          total: snap.totalEntries ?? null,
          paged: startCursor !== null,
        },
      };
    }
    default:
      return s;
  }
}

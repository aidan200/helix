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
import type { SessionPlanChangedPayload, TaskBatchLedgerDto, WorkItemDto } from "@helix/protocol";
import type { SessionStateView, InstanceSnapshotEntry } from "../../../application/ports/inbound/SessionPort";
import type { SessionMetaView } from "../../../application/ports/inbound/SessionDirectoryPort";
import type { SessionUsageSummary, UsageSummary } from "../../../domain/session/SessionSnapshot";
import type { WorkItemData } from "../../../application/ports/outbound/WorkLedgerPort";
import { isMainAxisEntry, sessionEntryDto, toolCallEntryDto, WIRE_LEGACY_MAIN_ID } from "./EntryDtoMapper";
// 投影收敛：entry 排序基元 + spawn 锚权威计算单源 @helix/protocol
// projection（原 EntryDtoMapper.entrySortKey / SpawnAnchor.ts 两纯函数迁出）
import { computeAnchorEntryId, entrySortKey, TAIL_WINDOW_SIZE } from "@helix/protocol";

// ── 尾窗/分页参数（G-1 钦死：契约 B §4；daemon 侧可注入） ───────────
// W3 #2.36：TAIL_WINDOW_SIZE 单源在 @helix/protocol/projection——此处 re-export
// 兼容既有 import 面（WsServerAdapter）；不再本地定义镜像。
export { TAIL_WINDOW_SIZE };
/** loadHistory 分页大小缺省（G-1）。 */
export const HISTORY_PAGE_DEFAULT = 50;
/** loadHistory 分页大小上限（防滥用）。 */
export const HISTORY_PAGE_MAX = 200;

/**
 * 快照序列化字节预算缺省（快照体量批，重连循环第二轮修复）：主轴尾窗 +
 * 全部实例通道合计的近似序列化上限。事故链（2026-09-20 实测）：17be1a88
 * （3754 entries + 40 实例 + 4972 tool_calls 结果共 8.5MB）单帧 15.51MB；
 * welcome attach 快照 + replay subscribe ack 快照 = 每连接 31MB，慢客户端
 * 排水不及 → 背压 close(4000) → 800ms 退避 + 主线程阻塞 ≈ 2.0s 周期自持
 * 循环。2MB 取值依据：① 双发（welcome+replay）+ 小回执合计 ≈ 4.5MB，对
 * 8MB 背压限留 44% 余量；② webview 主线程 JSON.parse 2MB ≈ 15-30ms
 * （15.5MB ≈ 150-300ms+ 阻塞）；③ 正常会话（G-1 尾窗 30 + 每通道 ≤50 条）
 * 天然在预算内零截断。
 */
export const SNAPSHOT_BUDGET_BYTES = 2 * 1024 * 1024;
/** 单通道条数尾窗缺省（快照体量批）：字节预算内的深历史通道条数上限。 */
export const CHANNEL_TAIL_SIZE = 50;
/**
 * 快照内每通道预览条数（channels 惰性化批）：快照只携带预览（抽屉摘要
 * 可见），完整通道历史经 session.instanceChannels 按需分页拉取。
 * 取值 2：末条状态 + 倒数第二条上下文（摘要足够）；SubAgent 重度会话
 * 实测 channels 占单帧 81%（52 实例 × 50 条/通道）——预览化后单帧回到
 * 主轴体量（<100KB 量级）。CHANNEL_TAIL_SIZE 退役快照职责，仅作历史
 * 参考值保留（按需拉取页宽走 HISTORY_PAGE_DEFAULT 同口径）。
 */
export const SNAPSHOT_CHANNEL_PREVIEW = 2;

/** 快照组装的尾窗参数（组合根/测试注入面）。 */
export interface SnapshotTailOptions {
  /** 主时间轴尾窗大小（缺省 TAIL_WINDOW_SIZE）。 */
  readonly tailSize?: number;
  /** 快照字节预算（主轴 + 通道合计；缺省 SNAPSHOT_BUDGET_BYTES）。 */
  readonly budgetBytes?: number;
  /** 单通道条数尾窗（缺省 SNAPSHOT_CHANNEL_PREVIEW——快照只带预览条数，
   *  完整通道历史经 session.instanceChannels 按需分页；CHANNEL_TAIL_SIZE 已
   *  退役快照职责，见上方常量注）。 */
  readonly channelTail?: number;
}

/** loadHistory 分页结果（契约 B §1.3；游标非法抛 Error 由调用方转 invalid_cursor）。 */
export interface HistoryPage {
  readonly entries: EntryDto[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

// ── 主会话工作台账投影（main-session plan 批；快照与广播同源单点）────

/**
 * 台账行 → wire DTO（WorkItemDto；字段同形直映射——status 为 task 域状态机
 * 原值，展示映射归前端）。
 */
function workItemDtoOf(item: WorkItemData): WorkItemDto {
  return { seq: item.seq, content: item.content, status: item.status, note: item.note };
}

/**
 * ledger 计数摘要服务端组装（前端零拼装，AD-4② 同规）：total/done/inProgress
 * 从 plan 行算得——与 task 域 TaskQueryService.batchDtoOf 同口径。
 */
function ledgerDtoOf(rows: readonly WorkItemData[]): TaskBatchLedgerDto {
  return {
    total: rows.length,
    done: rows.filter((item) => item.status === "done").length,
    inProgress: rows.filter((item) => item.status === "in_progress").length,
  };
}

/**
 * session.plan.changed 载荷组装（发布点 = 装配层包装；快照 plan/ledger 同源）：
 * 无台账（零行）→ plan/ledger 双 null（null 语义与 task 批次行同构）。
 * instanceId（实例台账抽屉批，可选）携带时 = SubAgent 实例台账——
 * 信封 sessionId 仍 = 归属会话（订阅路由），payload.instanceId = 台账
 * 归属实例；缺省 = 主会话台账（instanceId 维度 = sessionId）。
 */
export function sessionPlanPayloadOf(
  sessionId: string,
  rows: readonly WorkItemData[],
  instanceId?: string,
): SessionPlanChangedPayload {
  const has = rows.length > 0;
  return {
    sessionId,
    ...(instanceId !== undefined ? { instanceId } : {}),
    plan: has ? rows.map(workItemDtoOf) : null,
    ledger: has ? ledgerDtoOf(rows) : null,
  };
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
 * 主时间轴（主实例条目）只下发尾窗 tail（AD-1 尾窗口径，G-1=30）；
 * per-instance channel 分组按实例分组保留**最新 channelTail 条**（快照
 * 体量批：主轴 + 通道合计受 SNAPSHOT_BUDGET_BYTES 字节预算约束，被截通道
 * 携带 truncated: true——F-14⑤「完整保留不截断」经背压断连循环事故降级为
 * 「有界保最新 + 截断标记」）；totalEntries/tailStartCursor 分页指示。
 */
export function toSnapshotDto(
  view: SessionStateView,
  model: string,
  agentState: AgentStateDto,
  opts: SnapshotTailOptions = {},
): SessionSnapshotDto {
  const snapshot = view.session;
  const merged = assembleMerged(view);
  // 主时间轴 = 主实例条目 + 定向 steer 干预条目（契约 v0.3 §3.2）；尾窗只作用于主轴（AD-1）
  const mainAxis = merged.filter(isMainAxisEntry);
  const tailSize = opts.tailSize ?? TAIL_WINDOW_SIZE;
  const budgetBytes = opts.budgetBytes ?? SNAPSHOT_BUDGET_BYTES;
  const channelTail = opts.channelTail ?? SNAPSHOT_CHANNEL_PREVIEW;
  const countTail = mainAxis.length > tailSize ? mainAxis.slice(mainAxis.length - tailSize) : mainAxis;
  const { entries: tail, usedBytes } = byteTailNewest(countTail, Math.floor(budgetBytes / 2));
  // 帧级计账（快照体量批）：entries 与 tail 同源双写（v0.2 兼容别名——wire
  // 上同数组序列化两次），主轴占用按双份计；通道预算 = 余量。
  const agentDtos = dtoInstances(view, merged, {
    channelTail,
    channelBudgetBytes: Math.max(0, budgetBytes - usedBytes * 2),
  });
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
    ...(agentDtos !== undefined ? { instances: agentDtos } : {}),
    ...(view.usage !== undefined ? { usage: usageDto(view.usage) } : {}),
    // 未消费 steer 队列（additive）：队列坞重建数据源——drain 落盘语义下
    // queued 项不在 entries 里；空队列不携带键
    ...(snapshot.pendingSteer.length > 0
      ? {
          pendingSteer: snapshot.pendingSteer.map((item) => ({
            entryId: item.entryId,
            text: item.text,
            ...(item.source !== undefined ? { source: item.source } : {}),
          })),
        }
      : {}),
    // 未收口提权申请（permission_request 批，additive）：视图携带才下发——
    // 重连/切换会话后 ask 卡片原位复活（倒计时按 expiresAt 剩余量续走）
    ...(view.pendingAsk !== undefined ? { pendingAsk: view.pendingAsk } : {}),
    // 主会话工作台账（main-session plan 批，additive）：携带才下发——plan
    // 全行 + ledger 计数摘要（服务端组装）；空台账 = 双 null；缺省 = 未携带
    //（旧装配/未接 plan 读面兼容，读侧保持现值）
    ...(view.plan !== undefined
      ? (() => {
          const p = sessionPlanPayloadOf(view.session.sessionId, view.plan);
          return { plan: p.plan, ledger: p.ledger };
        })()
      : {}),
  };
}

/**
 * loadHistory 分页切取（契约 B §1.3，AD-1 向上回溯）：主时间轴在
 * beforeEntryId 之前的更早历史，升序至多 limit 条；hasMore/nextCursor 指示
 * 续拉。游标不在主轴内（SubAgent 条目/不存在）→ 抛错（调用方转
 * session.invalid_cursor）。快照体量批：页内条目同受 SNAPSHOT_BUDGET_BYTES
 * 字节预算（保最新——大结果工具页不再整帧下发，hasMore/nextCursor 随字节
 * 窗收敛，前端「加载更早」续拉语义不变）。
 */
export function historyPage(
  view: SessionStateView,
  beforeEntryId: string,
  limit: number = HISTORY_PAGE_DEFAULT,
): HistoryPage {
  const snapshot = view.session;
  const merged = assembleMerged(view);
  const mainAxis = merged.filter(isMainAxisEntry);
  const cursorIndex = mainAxis.findIndex((entry) => entry.id === beforeEntryId);
  if (cursorIndex < 0) {
    throw new Error(`游标 ${beforeEntryId} 不在会话 ${snapshot.sessionId} 主时间轴内`);
  }
  const earlier = mainAxis.slice(0, cursorIndex); // 严格早于游标（升序）
  // 钳制前守卫（code-review L）：非有限值（NaN/Infinity）会滑出 Math 链
  //（Math.max/min 遇 NaN 恒 NaN，slice(NaN) 视同 0 → 整段返回未截断）。
  // 入口已校验正整数（handlers/session.ts），此处纯防御兑底：回落缺省页宽。
  const size = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), HISTORY_PAGE_MAX)
    : HISTORY_PAGE_DEFAULT;
  const countPage = earlier.length > size ? earlier.slice(earlier.length - size) : earlier;
  const { entries: page } = byteTailNewest(countPage, SNAPSHOT_BUDGET_BYTES);
  const hasMore = earlier.length > page.length;
  return {
    entries: page,
    hasMore,
    nextCursor: hasMore ? (page[0]?.id ?? null) : null,
  };
}

/**
 * merged 组装（toSnapshotDto/historyPage 两投影面共有）：entries
 * （message/thinking/compaction 混排联合）+ toolCalls 合并、升序稳定排序
 *（时间并列保持组内原序）；mainId = 快照 mainInstanceId 缺省 legacy "main"
 *（T10a wire 边界归属判别基准）。主轴过滤（isMainAxisEntry）由调用面
 * 一行接续——toSnapshotDto 尚需 merged 全量（instanceChannels/computeAnchor）。
 */
function assembleMerged(view: SessionStateView): EntryDto[] {
  const snapshot = view.session;
  const mainId = snapshot.mainInstanceId ?? WIRE_LEGACY_MAIN_ID;
  const queuedSteer = new Set(snapshot.pendingSteer.map((item) => item.entryId));
  return [
    ...snapshot.entries.flatMap((entry) => sessionEntryDto(entry, queuedSteer, mainId)),
    ...view.toolCalls.map((record) => toolCallEntryDto(record, mainId)),
  ].sort((a, b) => entrySortKey(a) - entrySortKey(b));
}

// ── 快照体量批：字节预算辅助（重连循环第二轮修复） ──────────────

/** 条目近似序列化字节（UTF-8 字节口径——wire 实际传输单位；中文内容
 *  字节数 ≈ 码元数 2-3 倍，按码元计数会低估预算致超限）。 */
function entryCostBytes(entry: EntryDto): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
  } catch {
    return 4096; // 异常值兑底：不可序列化条目按 4KB 计（不阻断组装）
  }
}

/**
 * 单条条目硬顶（F2 #20）：字节预算原先是软顶——「单条超预算保底 1 条」让一个
 * 巨型工具结果（result 无截断）整条进帧，2MB 预算被单条击穿，重连循环事故面
 * 复现。超顶条目按「最长字符串字段截断 + 省略标记」压进上限内（结构保留，
 * 条目仍在，内容有损——快照面本就是有界预览）。
 */
const MAX_SINGLE_ENTRY_BYTES = 256 * 1024;
const ENTRY_TRUNCATE_MARKER = "…（快照体量超预算：本条内容已截断，完整内容见会话详情/工具结果）";

/** 把超顶条目压进 maxBytes：逐轮砍最长顶层字符串字段（最多 4 轮）。 */
function capEntryBytes(entry: EntryDto, maxBytes: number): { entry: EntryDto; bytes: number; shrunk: boolean } {
  let bytes = entryCostBytes(entry);
  if (bytes <= maxBytes) return { entry, bytes, shrunk: false };
  const clone = { ...(entry as unknown as Record<string, unknown>) };
  let shrunk = false;
  for (let round = 0; round < 4 && bytes > maxBytes; round++) {
    let key: string | undefined;
    let len = -1;
    for (const [k, v] of Object.entries(clone)) {
      if (typeof v === "string" && v.length > len) {
        key = k;
        len = v.length;
      }
    }
    if (key === undefined) break; // 无可砍字符串字段（结构体条目）：放弃压缩，交由尾窗整条取舍
    const overflow = bytes - maxBytes;
    const chars = [...(clone[key] as string)];
    // 每个码元至少 1 字节，砍 overflow 个码元至少回收 overflow 字节（含标记开销需多留）
    const keep = Math.max(32, chars.length - Math.ceil(overflow * 1.2));
    clone[key] = `${chars.slice(0, keep).join("")}${ENTRY_TRUNCATE_MARKER}`;
    bytes = entryCostBytes(clone as unknown as EntryDto);
    shrunk = true;
  }
  return { entry: clone as unknown as EntryDto, bytes, shrunk };
}

/**
 * 字节尾窗（保最新；单条超预算先压进单条硬顶——快照非空进度保证，F2 #20）。
 * 返回实际保留段、累计字节（供通道预算分摊）与是否发生过单条压缩。
 */
function byteTailNewest(
  entries: readonly EntryDto[],
  budgetBytes: number,
  maxEntryBytes: number = Math.min(MAX_SINGLE_ENTRY_BYTES, Math.max(4 * 1024, budgetBytes)),
): { entries: EntryDto[]; usedBytes: number; shrunk: boolean } {
  let used = 0;
  const kept: EntryDto[] = [];
  let shrunk = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const capped = capEntryBytes(entries[i]!, maxEntryBytes);
    if (kept.length > 0 && used + capped.bytes > budgetBytes) break;
    kept.push(capped.entry);
    used += capped.bytes;
    shrunk = shrunk || capped.shrunk;
  }
  kept.reverse();
  return { entries: kept, usedBytes: used, shrunk };
}

/** 实例通道预算分摊参数（dtoInstances 消费）。 */
interface ChannelBudgetOpts {
  readonly channelTail: number;
  readonly channelBudgetBytes: number;
}

/**
 * instances[].channels 有界组装（快照体量批）：非 main 实例公平分摊通道
 * 预算（份额 = 总预算/实例数），仓内工具结果优先（tools → messages →
 * thinking 定序消耗份额）；每通道先条数尾窗后字节尾窗（均保最新）；任一
 * 通道被裁（条数或字节）→ channels.truncated = true（additive 标记，缺省
 * = 未截断全量——小会话零截断零携带）。主实例不分组（主轴 entries 即其历史）。
 */
function dtoInstances(
  view: SessionStateView,
  merged: readonly EntryDto[],
  opts: ChannelBudgetOpts,
): AgentInstanceDto[] | undefined {
  if (view.instances === undefined) return undefined;
  const nonMain = view.instances.filter((instance) => instance.kind !== "main");
  const share = nonMain.length > 0 ? Math.max(4096, Math.floor(opts.channelBudgetBytes / nonMain.length)) : 0;
  return view.instances.map((instance) => {
    if (instance.kind === "main") {
      return instanceDto(instance, undefined, computeAnchorEntryId(merged, instance));
    }
    const full = instanceChannels(merged, instance);
    let remaining = share;
    let truncated = false;
    const channels: InstanceChannelHistory = {};
    // 通道消耗序：tools → messages → thinking（工具结果体量与抽屉价值双高优先）
    for (const key of ["tools", "messages", "thinking"] as const) {
      const list = full?.[key];
      if (list === undefined || list.length === 0) continue;
      const countTail = list.length > opts.channelTail ? list.slice(list.length - opts.channelTail) : [...list];
      if (countTail.length < list.length) truncated = true;
      if (remaining <= 0) {
        truncated = true;
        channels[key] = [];
        continue;
      }
      const bounded = byteTailNewest(countTail, remaining);
      if (bounded.entries.length < countTail.length || bounded.shrunk) truncated = true;
      remaining -= bounded.usedBytes;
      channels[key] = bounded.entries;
    }
    const hasAny = Object.keys(channels).length > 0;
    return instanceDto(
      instance,
      hasAny ? (truncated ? { ...channels, truncated: true } : channels) : channels,
      computeAnchorEntryId(merged, instance),
    );
  });
}

/**
 * 实例通道历史分组（AD-3：SubAgent Entry 按实例归组——thinking/messages/
 * tools 三槽，契约 §6.2 InstanceChannelHistory）。主实例不分组（主时间轴
 * entries 全量即主实例历史；尾窗只作用于主时间轴）。
 * 快照体量批注：本函数产出全量分组，预算裁剪在 dtoInstances（保最新）。
 */
function instanceChannels(entries: readonly EntryDto[], instance: InstanceSnapshotEntry): InstanceChannelHistory | undefined {
  if (instance.kind === "main") return undefined; // 主实例不分组（kind 判别，T10a）
  let channels: InstanceChannelHistory | undefined;
  for (const entry of entries) {
    if (entry.instanceId !== instance.instanceId) continue; // 主实例条目 wire 边界省略（undefined）天然跳过
    channels ??= {};
    // push 累积（单通道 O(n)——原 [...展开重建] 形态是 O(n²)，纯卫生改写）
    if (entry.kind === "message") (channels.messages ??= []).push(entry);
    else if (entry.kind === "thinking") (channels.thinking ??= []).push(entry);
    else if (entry.kind === "tool-call") (channels.tools ??= []).push(entry);
    // compaction：会话级里程碑（仅主实例产生），不进实例通道
    // error（code-review M 钉样，全抑制口径）：SubAgent error 条目实时帧
    // error.entry 按 SubAgent 抑制（EnvelopeMapper：shell 主聊天流无 instanceId
    // 分流，不抑制会错位弹主流）、快照主轴经 isMainAxisEntry 排除、本通道
    // 三槽词表亦不收——SubAgent 引擎错误的终态可见面 = 实例卡 closure failed
    // 状态。缺口记录：若未来要通道内错误红条，需协议 InstanceChannelHistory
    // 加 errors 槽 + 抽屉渲染面（跨包改动，产品决策点）。
  }
  return channels;
}

/**
 * 实例通道历史按需分页（channels 惰性化批）：打平单时间轴（三槽归并升序）
 * 上的游标回溯——与主轴 historyPage 同构（保最新 + hasMore/nextCursor +
 * 字节预算），返回时重新归组三槽。快照只携带 SNAPSHOT_CHANNEL_PREVIEW
 * 条预览，完整历史经本函数补拉（session.instanceChannels 命令消费）。
 * 游标不在实例时间轴内 / main 实例（主轴即其历史）→ 抛错（handler 转
 * connection.error）。
 */
export function instanceChannelsPage(
  view: SessionStateView,
  instanceId: string,
  beforeEntryId: string | undefined,
  limit: number,
): { channels: InstanceChannelHistory; hasMore: boolean; nextCursor: string | null } {
  const instance = view.instances?.find((i) => i.instanceId === instanceId);
  if (instance === undefined) {
    throw new Error(`实例 ${instanceId} 不在会话实例清单`);
  }
  if (instance.kind === "main") {
    throw new Error(`主实例 ${instanceId} 历史即主时间轴（走 session.loadHistory）`);
  }
  const merged = assembleMerged(view);
  const full = instanceChannels(merged, instance) ?? {};
  // 三槽归并打平（升序稳定——时间并列保持槽内原序，与主轴同口径）
  const timeline = [
    ...(full.messages ?? []),
    ...(full.thinking ?? []),
    ...(full.tools ?? []),
  ].sort((a, b) => entrySortKey(a) - entrySortKey(b));
  let earlier = timeline;
  if (beforeEntryId !== undefined && beforeEntryId !== "") {
    const cursorIndex = timeline.findIndex((entry) => entry.id === beforeEntryId);
    if (cursorIndex < 0) {
      throw new Error(`游标 ${beforeEntryId} 不在实例 ${instanceId} 通道时间轴内`);
    }
    earlier = timeline.slice(0, cursorIndex); // 严格早于游标（升序）
  }
  // 钳制与 historyPage 同口径（低危批：此前 limit 直进 slice 数学，NaN/0/负数
  // 未防御——NaN 使比较恒 false 整段返回、0 得空页、负数 slice 反向取尾）。
  // 入口已校验正整数（handlers/session.ts），此处纯防御兑底：回落缺省页宽。
  const size = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), HISTORY_PAGE_MAX)
    : HISTORY_PAGE_DEFAULT;
  const countPage = earlier.length > size ? earlier.slice(earlier.length - size) : [...earlier];
  const { entries: page } = byteTailNewest(countPage, SNAPSHOT_BUDGET_BYTES);
  const hasMore = earlier.length > page.length;
  const channels: InstanceChannelHistory = {};
  for (const [key, kind] of [
    ["tools", "tool-call"],
    ["messages", "message"],
    ["thinking", "thinking"],
  ] as const) {
    const items = page.filter((entry) => entry.kind === kind).sort((a, b) => entrySortKey(a) - entrySortKey(b));
    if (items.length > 0) channels[key] = items;
  }
  return { channels, hasMore, nextCursor: hasMore ? (page[0]?.id ?? null) : null };
}

/** InstanceSnapshotEntry（domain）→ AgentInstanceDto（协议；task/closure/usage 同构直映射）。
 *  channels 携带时附加（SubAgent 通道历史分组，AD-3/⑤）。
 *  （契约 v0.3 §1，AD-5）：anchor 由 computeAnchorEntryId 权威计算后传入——
 *   undefined = 主实例不携带；null = 流首锚（有效值）。 */
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
    // 实例台账种子（SubAgent 抽屉 plan 面）：domain 全行 → 协议 plan/ledger
    // 双携带（ledger 服务端组装，前端零拼装——与 sessionPlanPayloadOf 同源
    // 同形；组装面保证有行才携带，零行 = 缺省不携带）
    ...(entry.plan !== undefined
      ? { plan: entry.plan.map(workItemDtoOf), ledger: ledgerDtoOf(entry.plan) }
      : {}),
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
  return {
    total: usageTotal(summary.total),
    compaction: usageTotal(summary.compaction),
    // 水位直通（TR-59 观察面；undefined/空对象 → 缺席，shell 回落兑底）
    ...(summary.ctx !== undefined && Object.keys(summary.ctx).length > 0 ? { ctx: { ...summary.ctx } } : {}),
    // per-turn 账目直通（轮末 token 用量显示面；空/缺席不下发——additive）
    ...(summary.byTurn !== undefined && Object.keys(summary.byTurn).length > 0
      ? { byTurn: { ...summary.byTurn } }
      : {}),
  };
}

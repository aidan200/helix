/**
 * StewardDialogMemory —— 管家工作记忆（A1 工作记忆批 → B6 消息落盘批）。
 *
 * 替代 StewardService 裸内存数组：完整记录（thinking/工具/对话全形态）
 * 落盘经 StewardDialogStorePort（steward_memory.db 行式 steward_messages 表
 * ——一条记录一行），daemon 重启后对话恢复。
 *
 * B6 弃用面（A1 旧形态，问题较大故换轨）：runtime_config 整包 KV——每次
 * append 全窗 JSON 重写（写放大 + 与 helix.db 引擎库共 WriteQueue）、不可
 * 查询（事故排查取证盲区）、单 JSON 损坏整窗报废。新形态：append 单行写、
 * 裁剪 deleteHead、压缩/迁移 replaceAll。旧 KV 数据一次性迁移（migrateStewardDialogKv，幂等墓碑）。
 *
 * 记录形态 = 协议 StewardHistoryRecord（回放链路同源 DTO——UI 显示的 =
 * LLM 记得的 = 落盘的）；不存：feed 事件流（订阅态）、通知卡（无操作面）。
 *
 * 三闸清理（策略层全保留）：
 * ① 预算闸——append 时 token 估算（chars/2 保守）超预算丢最老记录，且
 *    配对感知（A1-hotfix）：裁剪不切 toolCall/toolResult 配对——窗口头孤儿
 *    toolResult 连带丢弃（生产实证：孤儿直达 provider = 400
 *    "tool_call_id is not found"）；
 * ② TTL 闸——ensureLoaded 时 lastActiveAt 距今超 TTL（72h）整库清空；
 * ③ 新对话闸——clear()（steward.history {clear:true} 三处同步清之一）。
 *
 * store 缺席 = 纯内存模式（开库失败降级——对话照常，重启即失，观测面
 * 可用性优先）。纯函数（estimateTokens/trimToBudget/dropHeadOrphanToolResults/
 * isExpired/parseStewardDialogKv）导出供单测直测。
 */
import type { StewardHistoryRecord } from "@helix/protocol";
import type {
  StewardDialogStorePort,
  StewardDialogStoreSnapshot,
} from "../ports/outbound/StewardDialogStorePort";

/** A1 旧 KV 键（迁移墓碑面；新代码不再读写——保留供迁移与旧代码共存期识别）。 */
export const STEWARD_DIALOG_KEY = "steward_dialog";

/** token 预算窗口起点（任务书：建议起点 16k token，实测后调）。 */
export const STEWARD_DIALOG_BUDGET_TOKENS = 16384;

/** TTL（72h 无活动 → 整库清空）。 */
export const STEWARD_DIALOG_TTL_MS = 72 * 60 * 60 * 1000;

/** KV 序列化形态（A1 旧形态——迁移读面）。 */
interface StewardDialogKv {
  readonly records: readonly StewardHistoryRecord[];
  readonly lastActiveAt: number;
}

/** 单条记录 token 估算（chars/2 保守近似——中文 ~1.5-2 char/token、英文
 *  ~4 char/token 的折中下界；宁可早裁不可爆上下文）。 */
export function estimateTokens(record: StewardHistoryRecord): number {
  let chars = 0;
  if (record.kind === "user") chars = record.text.length;
  else if (record.kind === "toolResult") chars = record.text.length + record.name.length;
  else {
    chars = (record.text ?? "").length + (record.thinking?.text.length ?? 0) + (record.thinking?.signature?.length ?? 0);
    if (record.toolCall !== undefined) {
      chars += record.toolCall.name.length + JSON.stringify(record.toolCall.args).length;
    }
  }
  // 形状开销（kind/role/id 等结构位）——粗常量
  return Math.ceil(chars / 2) + 8;
}

/** 预算裁剪（老记录先弃；保序）。至少保留最新一条（单条超预算也保留——
 *  记录本身不可截断，宁可窗口缩到一条；A1-hotfix 例外：幸存孤儿 toolResult
 *  允许清空——空窗口优于毒孤儿）。配对感知（A1-hotfix）：切片后从窗口头
 *  继续丢弃孤儿 toolResult——孤儿直达 LLM 请求 = provider 400
 *  "tool_call_id is not found"。 */
export function trimToBudget(
  records: readonly StewardHistoryRecord[],
  budgetTokens: number,
): StewardHistoryRecord[] {
  const costs = records.map(estimateTokens);
  const total = costs.reduce((a, b) => a + b, 0);
  let window: StewardHistoryRecord[];
  if (total <= budgetTokens) {
    window = [...records];
  } else {
    let dropUntil = 0;
    let acc = total;
    while (dropUntil < records.length - 1 && acc > budgetTokens) {
      acc -= costs[dropUntil]!;
      dropUntil += 1;
    }
    window = records.slice(dropUntil);
  }
  return dropHeadOrphanToolResults(window);
}

/** 窗口头孤儿 toolResult 丢弃（A1-hotfix 纯函数，导出供单测）：孤儿 =
 *  toolCallId 在窗内无 assistant toolCall 配对（toolCall 恒先于 toolResult，
 *  配对头被切 → 孤儿只在头部连续出现；未触预算的脏窗头部孤儿同样清——
 *  append 路径自愈）。允许清空（空窗口优于毒孤儿）。 */
export function dropHeadOrphanToolResults(
  records: readonly StewardHistoryRecord[],
): StewardHistoryRecord[] {
  if (records.length === 0) return [];
  const callIds = new Set<string>();
  for (const r of records) {
    if (r.kind === "assistant" && r.toolCall !== undefined) callIds.add(r.toolCall.id);
  }
  let head = 0;
  while (head < records.length) {
    const r = records[head]!;
    if (r.kind !== "toolResult" || callIds.has(r.toolCallId)) break;
    head += 1;
  }
  return head === 0 ? [...records] : records.slice(head);
}

/** TTL 判定（72h 无活动 = 过期）。 */
export function isExpired(lastActiveAt: number, now: number, ttlMs: number): boolean {
  return now - lastActiveAt > ttlMs;
}

/** 压缩保尾窗（helix-loop L1 件一纯函数）：尾部 keepRecentCount 条 + 头部
 *  孤儿 toolResult 连带丢弃（配对 call 已被压掉——A1-hotfix 同族：空窗优于
 *  毒孤儿，孤儿直达 LLM 请求 = provider 400）。 */
export function keepTailPairAware(
  records: readonly StewardHistoryRecord[],
  keepRecentCount: number,
): StewardHistoryRecord[] {
  return dropHeadOrphanToolResults(records.slice(Math.max(0, records.length - keepRecentCount)));
}

/** A1 KV 原值 → 域值（迁移读面；形状防御：非法 JSON/字段缺失 → undefined
 *  = 不可用）。 */
export function parseStewardDialogKv(raw: string | undefined): StewardDialogKv | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as { records?: unknown; lastActiveAt?: unknown };
    if (!Array.isArray(parsed.records)) return undefined;
    if (typeof parsed.lastActiveAt !== "number" || !Number.isFinite(parsed.lastActiveAt)) return undefined;
    const records: StewardHistoryRecord[] = [];
    for (const r of parsed.records) {
      if (typeof r !== "object" || r === null || typeof (r as { kind?: unknown }).kind !== "string") continue;
      records.push(r as StewardHistoryRecord);
    }
    return { records, lastActiveAt: parsed.lastActiveAt };
  } catch {
    return undefined;
  }
}

export interface StewardDialogMemoryOptions {
  /** token 预算（缺省 16384——实测后调）。 */
  readonly budgetTokens?: number;
  /** TTL ms（缺省 72h）。 */
  readonly ttlMs?: number;
  /** 时钟注入（测试面；缺省 Date.now）。 */
  readonly now?: () => number;
}

export class StewardDialogMemory {
  private readonly store: StewardDialogStorePort | undefined;
  private readonly budgetTokens: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private records: StewardHistoryRecord[] = [];
  private loaded = false;

  constructor(store?: StewardDialogStorePort, options: StewardDialogMemoryOptions = {}) {
    this.store = store;
    this.budgetTokens = options.budgetTokens ?? STEWARD_DIALOG_BUDGET_TOKENS;
    this.ttlMs = options.ttlMs ?? STEWARD_DIALOG_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 懒加载（首次 ask / history 读面触发）：TTL 过期 → 整库清空；store
   *  缺席 = 纯内存模式空窗起步（不抛——观测面可用性优先）。 */
  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.store === undefined) return;
    const snap: StewardDialogStoreSnapshot = this.store.loadRecent();
    if (snap.records.length === 0 && snap.lastActiveAt === 0) return;
    if (isExpired(snap.lastActiveAt, this.now(), this.ttlMs)) {
      // TTL 闸：72h 无活动整库清空（同步清——better-sqlite3 无异步面）
      this.store.clear();
      return;
    }
    this.records = [...snap.records];
  }

  /** 现值（ensureLoaded 后镜像；未加载时先加载）。 */
  snapshot(): readonly StewardHistoryRecord[] {
    this.ensureLoaded();
    return [...this.records];
  }

  /** 追加一条（预算闸：写入时裁剪老记录先弃——镜像裁剪量同步 deleteHead，
   *  落盘单行追加；活跃时间随写更新）。 */
  async append(record: StewardHistoryRecord): Promise<void> {
    this.ensureLoaded();
    const next = trimToBudget([...this.records, record], this.budgetTokens);
    const dropped = this.records.length + 1 - next.length;
    this.records = next;
    if (this.store === undefined) return;
    if (dropped > 0) this.store.deleteHead(dropped);
    this.store.append(record, this.now());
  }

  /** 新对话闸：整库清空（回执面由 service 收口）。 */
  async clear(): Promise<void> {
    this.loaded = true;
    this.records = [];
    this.store?.clear();
  }

  /** 压缩替换（helix-loop L1 件一）：[summary, ...尾部 keepRecentCount 条原文]
   *  整窗替换（TR-47：压的是历史不是工作集——尾部滚动窗保留；头部孤儿
   *  toolResult 连带清理）。与引擎侧压缩窗口替换同步（engine_compaction_completed 回调
   *  驱动——落盘与 LLM 窗口同源不变量）；低频全量写（单事务）。 */
  async compact(summary: StewardHistoryRecord, keepRecentCount: number): Promise<void> {
    this.ensureLoaded();
    this.records = [summary, ...keepTailPairAware(this.records, keepRecentCount)];
    this.store?.replaceAll(this.records, this.now());
  }
}

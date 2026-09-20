/**
 * StewardDialogMemory —— 管家工作记忆 KV（A1 工作记忆批）。
 *
 * 替代 StewardService 裸内存数组：完整记录（thinking/工具/对话全形态）
 * 持久化经 RuntimeConfigPort KV（runtime_config 表，WriteQueue 单写通道
 * AG-06——KvConfigStore 同仓先例，不自造表），daemon 重启后对话恢复。
 *
 * KV 规格（任务书硬约束）：
 * - key = "steward_dialog"；值 = JSON { records, lastActiveAt }；
 * - 记录形态 = 协议 StewardHistoryRecord（回放链路同源 DTO——UI 显示的 =
 *   LLM 记得的）；
 * - 不存：feed 事件流（订阅态）、pending 确认卡（过期即失效不跨重启）。
 *
 * 三闸清理：
 * ① 预算闸——append 时 token 估算（chars/2 保守）超预算丢最老记录，且
 *    配对感知（A1-hotfix）：裁剪不切 toolCall/toolResult 配对——窗口头孤儿
 *    toolResult 连带丢弃（生产实证：孤儿直达 provider = 400
 *    "tool_call_id is not found"）；
 * ② TTL 闸——ensureLoaded 时 lastActiveAt 距今超 TTL（72h）整 key 清空；
 * ③ 新对话闸——clear()（steward.history {clear:true} 三处同步清之一）。
 *
 * 纯函数（estimateTokens/trimToBudget/dropHeadOrphanToolResults/isExpired）
 * 导出供单测直测。
 */
import type { StewardHistoryRecord } from "@helix/protocol";
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";

/** 工作记忆 KV 键（daemon 级单键——管家唯一全局会话）。 */
export const STEWARD_DIALOG_KEY = "steward_dialog";

/** token 预算窗口起点（任务书：建议起点 16k token，实测后调）。 */
export const STEWARD_DIALOG_BUDGET_TOKENS = 16384;

/** TTL（72h 无活动 → 整 key 清空）。 */
export const STEWARD_DIALOG_TTL_MS = 72 * 60 * 60 * 1000;

/** KV 序列化形态。 */
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
 *  配对头被切 → 孤儿只在头部连续出现；未触预算的脏 KV 头部孤儿同样清——
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

/** KV 原值 → 域值（形状防御：非法 JSON/字段缺失 → undefined = 不可用）。 */
function parseDialog(raw: string | undefined): StewardDialogKv | undefined {
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
  private readonly kv: RuntimeConfigPort;
  private readonly budgetTokens: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private records: StewardHistoryRecord[] = [];
  private loaded = false;

  constructor(kv: RuntimeConfigPort, options: StewardDialogMemoryOptions = {}) {
    this.kv = kv;
    this.budgetTokens = options.budgetTokens ?? STEWARD_DIALOG_BUDGET_TOKENS;
    this.ttlMs = options.ttlMs ?? STEWARD_DIALOG_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 懒加载（首次 ask / history 读面触发）：TTL 过期 → 整 key 清空；
   *  KV 不可用（db 关闭/形状不符）→ 空窗口起步（不抛——观测面可用性优先）。 */
  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const parsed = parseDialog(this.kv.get(STEWARD_DIALOG_KEY));
    if (parsed === undefined) return;
    if (isExpired(parsed.lastActiveAt, this.now(), this.ttlMs)) {
      // TTL 闸：72h 无活动整 key 清空（异步落盘不阻塞恢复路径）
      void this.kv.set(STEWARD_DIALOG_KEY, this.serialize([], this.now())).catch(() => {});
      return;
    }
    this.records = [...parsed.records];
  }

  /** 现值（ensureLoaded 后镜像；未加载时先加载）。 */
  snapshot(): readonly StewardHistoryRecord[] {
    this.ensureLoaded();
    return [...this.records];
  }

  /** 追加一条（预算闸：写入时裁剪老记录先弃；lastActiveAt 随写更新）。 */
  async append(record: StewardHistoryRecord): Promise<void> {
    this.ensureLoaded();
    this.records = trimToBudget([...this.records, record], this.budgetTokens);
    await this.kv.set(STEWARD_DIALOG_KEY, this.serialize(this.records, this.now()));
  }

  /** 新对话闸：整 key 清空（回执面由 service 收口）。 */
  async clear(): Promise<void> {
    this.loaded = true;
    this.records = [];
    await this.kv.set(STEWARD_DIALOG_KEY, this.serialize([], this.now()));
  }

  private serialize(records: readonly StewardHistoryRecord[], lastActiveAt: number): string {
    return JSON.stringify({ records, lastActiveAt });
  }
}

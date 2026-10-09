/**
 * StewardActivityStorePort —— 管家活动账落盘写面（M3-d1 感知兑现批）。
 *
 * 存储形态裁决（AG-06 / TR-20 单写面纪律）：活动账落 steward_memory.db
 * （管家域库第三连接，与长期记忆 entries/vec_items、短期对话 steward_messages
 * 同库不同表——管家域数据单库聚合先例，B6 批同构）；helix.db 写 SQL 仍只在
 * WriteQueue.ts（本批零改动）。driven 实现体 SqliteActivityLedgerStore（arch
 * -guard 白名单登记成员）；缺席/构造失败 = 纯内存降级（记录不丢、回看降级）。
 */
import type { StewardActivityEntryView } from "@helix/protocol";

export interface StewardActivityWindowQuery {
  /** 窗口下界（epoch ms，含）。 */
  readonly sinceMs: number;
  /** 窗口上界（epoch ms，不含；缺省 = 无上界）。 */
  readonly untilMs?: number;
  /** 条数上限（at 降序取最近）。 */
  readonly limit: number;
}

export interface StewardActivityStorePort {
  /** 追加一条（行式落盘；调用方保证条目形状合法）。 */
  append(entry: StewardActivityEntryView): void;
  /** 时间窗查询（at 降序——最新在前；有界库上再加 limit）。 */
  listWindow(query: StewardActivityWindowQuery): StewardActivityEntryView[];
  /** 清空全部条目（幂等）。 */
  clear(): void;
}

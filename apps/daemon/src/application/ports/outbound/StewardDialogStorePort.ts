import type { StewardHistoryRecord } from "@helix/protocol";

/**
 * 管家短期记忆（对话记录）落盘出站口（B6 消息落盘批）。
 *
 * 替代 A1 的 runtime_config 整包 KV（helix.db 单键 JSON 全量重写——写放大、
 * 与引擎库共 WriteQueue、不可查询）。行式消息存储：一条记录一行，追加单行
 * 写；裁剪/压缩/清空为显式操作。
 *
 * 语义约束（实现体必须遵守）：
 * - append 幂等序：先 deleteHead 再 append 由调用方编排，本口各操作原子
 *   （better-sqlite3 同步事务）；
 * - loadRecent 返回当前窗口全量（预算闸保证上界；实现体可带防御 LIMIT），
 *   形状防御：损坏行（非法 JSON/缺 kind）跳过不抛——可用性优先；
 * - clear 清记录与活跃时间（新对话从零点起算）。
 */
export interface StewardDialogStoreSnapshot {
  /** 当前窗口记录（旧→新保序）。 */
  readonly records: readonly StewardHistoryRecord[];
  /** 最近活跃时间（ms epoch；空库 = 0）。 */
  readonly lastActiveAt: number;
}

export interface StewardDialogStorePort {
  /** 追加一条记录（at = 记录时间，同时刷新活跃时间）。 */
  append(record: StewardHistoryRecord, at: number): void;
  /** 删最老 count 行（预算裁剪/孤儿丢弃的落盘面——镜像已裁，行同步删）。 */
  deleteHead(count: number): void;
  /** 整窗替换（压缩/迁移路径——低频全量写，单事务）。 */
  replaceAll(records: readonly StewardHistoryRecord[], at: number): void;
  /** 读当前窗口快照（旧→新）。 */
  loadRecent(): StewardDialogStoreSnapshot;
  /** 清空全部记录与活跃时间（TTL 过期/新对话闸）。 */
  clear(): void;
}

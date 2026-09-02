/**
 * work_item（实例 plan，AD-6①）读写出口端口（outbound，O-1 表分域）：
 * 本端口不出现任何 job/stage/batch 方法（TaskStorePort 侧）。
 *
 * 双面装配（O-1 决策消解）：
 * - 写面（insertItems/replaceItems/updateItem）子进程本地栈装配（T1.4 plan
 *   工具直连，自设 WAL + busy_timeout 的直连连接，KgDatabase 先例）；
 *   main-session plan 批起父进程主会话 executor 同持写面（LazyWorkLedger
 *   直连，同库 WAL 跨进程安全——E-7 双形态）；
 * - 父进程组合根（T1.3 buildTaskStack）另持读/清理面——getItems 只读 +
 *   deleteByInstanceIds（F3.6 清孤儿台账，父进程 work_item 例外写点，
 *   直接执行不经 WriteQueue；O-4 白名单「父两写点」之二，T2.1 登记）。
 */

import type { WorkItemStatus } from "../../../domain/task/types";

/** work_item 行数据形状（读面）。 */
export interface WorkItemData {
  readonly instanceId: string;
  readonly seq: number;
  /** plan 项内容（人类可读，AD-6③）。 */
  readonly content: string;
  readonly status: WorkItemStatus;
  /** 关键事实 + 产物指针（文件/节点 id/卡点）；null = 未记。 */
  readonly note: string | null;
  readonly updatedAt: string;
}

/** insertItems 输入行（新 plan 项：状态机入口恒 pending、note 空）。 */
export interface WorkItemInput {
  readonly seq: number;
  readonly content: string;
}

export interface WorkLedgerPort {
  /** 批量插入实例 plan（plan_create；整批原子：零部分落库）。 */
  insertItems(instanceId: string, items: readonly WorkItemInput[]): Promise<void>;
  /**
   * 原子重建实例 plan（main-session plan 批：台账全部 resolved 后
   * plan_create 重开 seq 1..n）：同事务清旧行 + 插新行（零残留零部分落库）。
   */
  replaceItems(instanceId: string, items: readonly WorkItemInput[]): Promise<void>;
  /**
   * 单项状态迁移/记 note（plan_update；note undefined = 不动既有值，
   * 显式 null = 清空）。
   */
  updateItem(
    instanceId: string,
    seq: number,
    status: WorkItemStatus,
    note?: string | null,
  ): Promise<void>;
  /** 实例 plan 读（seq 升序；派发方判进度 AD-6③，WAL 读不阻塞子写）。 */
  getItems(instanceId: string): readonly WorkItemData[];
  /** 按 instance id 集清 work_item（F3.6 清孤儿台账；空集 no-op）。 */
  deleteByInstanceIds(instanceIds: readonly string[]): Promise<void>;
}

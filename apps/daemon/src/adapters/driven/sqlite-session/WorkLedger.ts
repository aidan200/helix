import type { Database, Statement } from "bun:sqlite";
import type { WorkItemStatus } from "../../../domain/task/types";
import {
  openTaskLedgerDatabase,
  prepareWorkLedgerStatements,
  type WorkLedgerStatements,
  type WriteQueue,
} from "./WriteQueue";
import { rowsToWorkItems, workItemInputsToRows } from "./rows/TaskRowMapper";
import type { WorkItemRow } from "./rows/TaskRows";
import type {
  WorkItemData,
  WorkItemInput,
  WorkLedgerPort,
} from "../../../application/ports/outbound/WorkLedgerPort";

/**
 * WorkLedger —— work_item（实例 plan）读写面（WorkLedgerPort 实现，O-1 表分域：
 * 本类无任何 job/stage/batch 方法）。
 *
 * 双面装配（O-1 决策消解）：
 * - 子进程写面（T1.4 plan 工具本地栈）：`new WorkLedger(openTaskLedgerDatabase(
 *   dbPath))`——直连连接自设 WAL + busy_timeout（连接工厂在 WriteQueue.ts，
 *   KgDatabase 先例；子连接不能依赖父进程设置）；
 * - 父进程面（T1.3 buildTaskStack）：`parentWorkLedger(writeQueue)` 装配
 *   只读 getItems + F3.6 清理 deleteByInstanceIds（父进程唯一 work_item
 *   例外写点，直接执行不经队列——O-4 白名单「父两写点」之二，T2.1 登记）。
 *
 * 写 SQL 语句经 prepareWorkLedgerStatements（AG-06：helix.db 写语句宿主在
 * WriteQueue.ts，本文件零写 SQL）；SELECT 读语句可在此 prepare。
 */
export class WorkLedger implements WorkLedgerPort {
  private readonly stmts: WorkLedgerStatements;
  private readonly selectItems: Statement;

  constructor(private readonly db: Database) {
    this.stmts = prepareWorkLedgerStatements(db);
    this.selectItems = db.prepare(
      "SELECT instance_id, seq, content, status, note, updated_at " +
        "FROM work_item WHERE instance_id = ? ORDER BY seq",
    );
  }

  async insertItems(instanceId: string, items: readonly WorkItemInput[]): Promise<void> {
    if (items.length === 0) return;
    const rows = workItemInputsToRows(instanceId, items, new Date().toISOString());
    // 整批原子（plan_create：零部分落库——半份 plan 无消费意义）
    this.db.transaction(() => {
      for (const row of rows) {
        this.stmts.insertWorkItem.run(
          row.instance_id,
          row.seq,
          row.content,
          row.status,
          row.note,
          row.updated_at,
        );
      }
    })();
  }

  async updateItem(
    instanceId: string,
    seq: number,
    status: WorkItemStatus,
    note?: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (note === undefined) {
      this.stmts.updateWorkItemStatus.run(status, now, instanceId, seq);
    } else {
      this.stmts.updateWorkItemWithNote.run(status, note, now, instanceId, seq);
    }
  }

  getItems(instanceId: string): readonly WorkItemData[] {
    return rowsToWorkItems(this.selectItems.all(instanceId) as WorkItemRow[]);
  }

  /** 关闭底层直连连接（重复关闭由 LazyWorkLedger 置空守护；父进程面共用 WriteQueue 连接不调本方法）。 */
  close(): void {
    this.db.close();
  }

  async deleteByInstanceIds(instanceIds: readonly string[]): Promise<void> {
    if (instanceIds.length === 0) return; // 空集 no-op（不构造非法 IN ()）
    this.db.transaction(() => {
      for (const instanceId of instanceIds) {
        this.stmts.deleteWorkItemsByInstance.run(instanceId);
      }
    })();
  }
}

/**
 * 父进程装配面（T1.3 buildTaskStack）：只读 getItems + F3.6 清理
 * deleteByInstanceIds——写面（insertItems/updateItem）仅子进程组合根装配
 * （T1.4 ChildMain）；本类型让「父进程不持 plan 写面」机械可查。
 */
export type WorkLedgerParentFace = Pick<WorkLedgerPort, "getItems" | "deleteByInstanceIds">;

/** 父进程面工厂：共用 WriteQueue 连接（读不阻塞；delete = 唯一例外写点）。 */
export function parentWorkLedger(writeQueue: WriteQueue): WorkLedgerParentFace {
  return new WorkLedger(writeQueue.database);
}

// ── 子进程惰性直连面（T1.4 ChildMain 装配） ────────────────────

/**
 * LazyWorkLedger —— 子进程本地栈惰性直连面：首次读写才
 * openTaskLedgerDatabase（自设 WAL + busy_timeout，连接工厂在 WriteQueue.ts）。
 *
 * 惰性动机（TR-TEST-4）：plan 三工具随 SubAgentProfile 全量声明，无 plan
 * 调用的子进程若构造期即开库会触碰真实 ~/.helix——惰性 = 零 plan 调用零
 * 文件触碰，既有测试形态不变。dbPath 缺席（父进程未注入 HELIX_DB_PATH）
 * → 首次调用抛「未装配」（注册常驻、依赖缺席报错，browser 先例）。
 * close 幂等（未开过 = no-op）。
 */
export class LazyWorkLedger {
  private inner: WorkLedger | null = null;

  constructor(private readonly dbPath: string | undefined) {}

  private face(): WorkLedger {
    if (this.dbPath === undefined) {
      throw new Error(
        "work_item 台账库路径未注入（HELIX_DB_PATH 缺席——父进程未透传）→ plan 工具不可用",
      );
    }
    return (this.inner ??= new WorkLedger(openTaskLedgerDatabase(this.dbPath)));
  }

  insertItems(instanceId: string, items: readonly WorkItemInput[]): Promise<void> {
    return this.face().insertItems(instanceId, items);
  }

  updateItem(
    instanceId: string,
    seq: number,
    status: WorkItemStatus,
    note?: string | null,
  ): Promise<void> {
    return this.face().updateItem(instanceId, seq, status, note);
  }

  getItems(instanceId: string): readonly WorkItemData[] {
    return this.face().getItems(instanceId);
  }

  /** 关闭已开的直连连接（未开过 = no-op；幂等）。 */
  close(): void {
    this.inner?.close();
    this.inner = null;
  }
}

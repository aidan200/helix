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
 * 双面装配（O-1 决策消解；main-session plan 批扩双宿主）：
 * - 子进程写面（T1.4 plan 工具本地栈）：`new WorkLedger(openTaskLedgerDatabase(
 *   dbPath))`——直连连接自设 WAL + busy_timeout（连接工厂在 WriteQueue.ts，
 *   KgDatabase 先例；子连接不能依赖父进程设置）；
 * - 父进程主会话写面（main-session plan 批）：LazyWorkLedger 直连同一
 *   helix.db（同库 WAL + busy_timeout 跨进程安全——E-7 双形态）；
 * - 父进程任务栈面（T1.3 buildTaskStack）：`parentWorkLedger(writeQueue)`
 *   装配只读 getItems + F3.6 清理 deleteByInstanceIds（父进程 work_item
 *   例外写点，直接执行不经队列——O-4 白名单「父两写点」之二，T2.1 登记）。
 *   主会话台账行清理随 WriteQueue deleteSession 写链（同批扩展）。
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

  /**
   * 原子重建（main-session plan 批）：同事务清旧行 + 插新行——调用方
   * （WorkLedgerService.createPlan）已判全 resolved；本面只保原子性
   * （清+插同事务，零残留零部分落库）。
   */
  async replaceItems(instanceId: string, items: readonly WorkItemInput[]): Promise<void> {
    if (items.length === 0) return;
    const rows = workItemInputsToRows(instanceId, items, new Date().toISOString());
    this.db.transaction(() => {
      this.stmts.deleteWorkItemsByInstance.run(instanceId);
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
    expectedStatus?: WorkItemStatus,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (expectedStatus !== undefined) {
      // TOCTOU 收口（code-review M16）：读-判-写非原子时父子进程并发可绕过
      // 状态机守卫——前态谓词并入 UPDATE（原子），并发变更即 changes=0 抛错。
      const result =
        note === undefined
          ? this.stmts.updateWorkItemStatusGuarded.run(status, now, instanceId, seq, expectedStatus)
          : this.stmts.updateWorkItemWithNoteGuarded.run(status, note, now, instanceId, seq, expectedStatus);
      if (result.changes !== 1) {
        throw new Error(
          `工作项 #${seq} 状态已并发变更（期望前态 ${expectedStatus}，未命中）——刷新台账（plan_read）后重试`,
        );
      }
      return;
    }
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
 * 父进程任务栈装配面（T1.3 buildTaskStack）：只读 getItems + F3.6 清理
 * deleteByInstanceIds——写面（insertItems/replaceItems/updateItem）归
 * 子进程本地栈与父进程主会话 plan 栈（LazyWorkLedger 直连，两栈独立）；
 * 本类型让任务栈读/清理面机械可查。
 */
export type WorkLedgerParentFace = Pick<WorkLedgerPort, "getItems" | "deleteByInstanceIds">;

/** 父进程面工厂：共用 WriteQueue 连接（读不阻塞；delete = 唯一例外写点）。 */
export function parentWorkLedger(writeQueue: WriteQueue): WorkLedgerParentFace {
  return new WorkLedger(writeQueue.database);
}

// ── 子进程惰性直连面（T1.4 ChildMain 装配） ────────────────────

/**
 * LazyWorkLedger —— 惰性直连面（子进程本地栈 T1.4 ChildMain 装配 + 父进程
 * 主会话 plan 栈 main-session plan 批装配）：首次读写才
 * openTaskLedgerDatabase（自设 WAL + busy_timeout，连接工厂在 WriteQueue.ts）。
 *
 * 惰性动机（TR-TEST-4）：plan 三工具随 profile 全量声明，无 plan 调用的
 * 进程若构造期即开库会触碰真实 ~/.helix——惰性 = 零 plan 调用零文件
 * 触碰，既有测试形态不变（主会话栈同动机：未用 plan 的会话零额外连接）。
 * dbPath 缺席 → 首次调用抛「未装配」（注册常驻、依赖缺席报错，browser
 * 先例）。close 幂等（未开过 = no-op）。
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

  replaceItems(instanceId: string, items: readonly WorkItemInput[]): Promise<void> {
    return this.face().replaceItems(instanceId, items);
  }

  updateItem(
    instanceId: string,
    seq: number,
    status: WorkItemStatus,
    note?: string | null,
    expectedStatus?: WorkItemStatus,
  ): Promise<void> {
    return this.face().updateItem(instanceId, seq, status, note, expectedStatus);
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

import type { WorkItemData, WorkLedgerPort } from "../../ports/outbound/WorkLedgerPort";
import type { WorkItemStatus } from "../../../domain/task/types";

/**
 * WorkLedgerService —— work_item（实例 plan，AD-6①）应用服务：plan 工具族
 * 支撑（写面）+ 派发方读口（读面）+ closure 全 resolve 机械判定（AD-6⑤）。
 *
 * 双面装配（O-1 表分域的装配镜像，main-session plan 批双形态）：
 * - 子进程写面：ChildMain 以 { reader, writer } 双面构造（writer = 同一
 *   LazyWorkLedger）——plan 三工具直连；
 * - 父进程主会话写面：buildSessionStack 主会话 executor 同持双面
 *   （instanceId 维度 = sessionId；观察面即问责面，chat 域无收口概念）；
 * - 读面（getPlan/isFullyResolved）父进程/派发方共用同一读口（AD-6③：
 *   chat MainAgent 与编排器不各自扒表）。
 *
 * 校验语义（brief 决策消解）：
 * - plan_create：一次全量建（seq 1..n，恒 pending）；台账为空或全部
 *   resolved（done 或 abandoned 带 note）→ 允许重建（清旧行原子重开，
 *   main-session plan 批）；存在未决项 → 拒绝（半份/双份 plan 无消费
 *   意义，未决台账不可静默覆盖）；
 * - plan_update：状态机 pending→in_progress→done/abandoned（终态无出边，
 *   §3.2）；abandoned 必须 note 非空（trim 后 >0——「带理由」机械判据）；
 * - isFullyResolved：resolved ⟺ 全部项 status=done 或（abandoned 且 note
 *   非空）；空台账 = true（轻量实例无台账约束，AD-6⑥ 强制程度按 brief）。
 *   判定独立于写面守卫（脏数据照判不通过——机械判据不信任写路径）。
 */

/** work_item 合法迁移集（§3.2）：pending→in_progress；in_progress→done/abandoned；终态无出边。 */
const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  pending: ["in_progress"],
  in_progress: ["done", "abandoned"],
  done: [],
  abandoned: [],
};

/** closure 全 resolve 判定结果（AD-6⑤；消费方 = 父进程 closure 收口链 T2.2）。 */
export interface PlanResolution {
  readonly resolved: boolean;
  /** 未决项（seq + 当前 status；abandoned 无 note 的脏行也算未决）。 */
  readonly unresolved: ReadonlyArray<{ seq: number; status: WorkItemStatus }>;
}

export interface WorkLedgerServiceDeps {
  /** 读面（父/子进程均装配）。 */
  readonly reader: Pick<WorkLedgerPort, "getItems">;
  /** 写面（子进程本地栈 + 父进程主会话 plan 工具栈装配，main-session plan 批双形态）。 */
  readonly writer?: Pick<WorkLedgerPort, "insertItems" | "replaceItems" | "updateItem">;
}

export class WorkLedgerService {
  constructor(private readonly deps: WorkLedgerServiceDeps) {}

  // ── 写面（子进程 plan 工具支撑；instanceId 由装配面注入，不进工具参数） ──

  /**
   * 建实例 plan（plan_create）：seq 1..n、恒 pending、note 空。
   *
   * 重建语义（main-session plan 批）：台账为空或全部 resolved（done 或
   * abandoned 带 note）→ 允许重建——清旧行原子重开 seq 1..n（子进程
   * single-shot 到不了该分支，子进程语义零变化）；存在未决项
   * （pending/in_progress/abandoned 空 note 脏行）→ 仍拒绝（推进中台账
   * 不可静默覆盖）。原子性：清 + 插同事务（replaceItems 面）。
   */
  async createPlan(
    instanceId: string,
    items: readonly string[],
  ): Promise<{ created: number; rebuilt: boolean }> {
    const writer = this.requireWriter();
    if (items.length === 0) {
      throw new Error("工作台账条目不能为空（plan_create 需一次给出全部计划条目）");
    }
    for (let i = 0; i < items.length; i++) {
      if (typeof items[i] !== "string" || items[i]!.trim() === "") {
        throw new Error(`第 ${i + 1} 条台账内容为空（每条须为一项非空工作描述）`);
      }
    }
    const existing = this.deps.reader.getItems(instanceId);
    if (existing.length > 0) {
      const resolved = existing.every(
        (item) =>
          item.status === "done" || (item.status === "abandoned" && (item.note ?? "").trim() !== ""),
      );
      if (!resolved) {
        throw new Error(
          `实例 ${instanceId} 已有工作台账且未全部办结（plan_create 不覆盖未决台账）` +
            `——推进用 plan_update、查看用 plan_read；全部办结后可重建`,
        );
      }
      await writer.replaceItems(
        instanceId,
        items.map((content, i) => ({ seq: i + 1, content })),
      );
      return { created: items.length, rebuilt: true };
    }
    await writer.insertItems(
      instanceId,
      items.map((content, i) => ({ seq: i + 1, content })),
    );
    return { created: items.length, rebuilt: false };
  }

  /**
   * 台账项状态迁移 + 记 note（plan_update）。note undefined = 不动既有值。
   * abandoned 必须 note 非空（trim 后 >0）。
   */
  async updateItem(
    instanceId: string,
    seq: number,
    status: WorkItemStatus,
    note?: string,
  ): Promise<void> {
    const writer = this.requireWriter();
    const current = this.itemOf(instanceId, seq);
    if (status === "abandoned" && (note === undefined || note.trim() === "")) {
      throw new Error(`#${seq} abandoned 必须携带非空 note（放弃理由/替代方案）`);
    }
    if (!WORK_ITEM_TRANSITIONS[current.status].includes(status)) {
      const legal = WORK_ITEM_TRANSITIONS[current.status].join("/") || "无（终态）";
      throw new Error(`非法工作项状态迁移：${current.status}→${status}（合法目标：${legal}）`);
    }
    await writer.updateItem(instanceId, seq, status, note);
  }

  /**
   * closure done 收口前机械兑底（task-8659b320 三连败修复）：把全部
   * in_progress 项置 done（带机械 note 可追溯）——实例忘 plan_update 标记
   * 收口项时父进程判据②（TR-31）会 failBatch → 重试耗尽全损，实质工作
   * （检查/报告/findings）却已完成。closure 解析成功且 status=done 时
   * （实例已自证完成）只兑「忘标记」的 in_progress；pending（声明未开工）
   * 不兑——真漏做照旧未决，防漏做判据保留。幂等（无 in_progress → 0）。
   */
  async forceResolveInProgress(instanceId: string, note: string): Promise<{ resolved: number }> {
    this.requireWriter();
    const ongoing = this.deps.reader.getItems(instanceId).filter((item) => item.status === "in_progress");
    for (const item of ongoing) {
      await this.updateItem(instanceId, item.seq, "done", note);
    }
    return { resolved: ongoing.length };
  }

  // ── 读面（父进程/派发方共用同一读口，AD-6③） ──

  /** 实例 plan 全行（seq 升序）。 */
  getPlan(instanceId: string): readonly WorkItemData[] {
    return this.deps.reader.getItems(instanceId);
  }

  /**
   * closure 全 resolve 机械判定（AD-6⑤）：resolved ⟺ 全部项 done 或
   * abandoned 带 note；空台账 = true。判定不信任写路径（脏行照判不通过）。
   */
  isFullyResolved(instanceId: string): PlanResolution {
    const unresolved = this.deps.reader
      .getItems(instanceId)
      .filter(
        (item) =>
          !(item.status === "done" || (item.status === "abandoned" && (item.note ?? "").trim() !== "")),
      )
      .map((item) => ({ seq: item.seq, status: item.status }));
    return { resolved: unresolved.length === 0, unresolved };
  }

  // ── 内部 ─────────────────────────────────────────────────

  private requireWriter(): Pick<WorkLedgerPort, "insertItems" | "replaceItems" | "updateItem"> {
    if (this.deps.writer === undefined) {
      throw new Error("工作台账写面未装配（本服务以只读面构造——写操作仅子进程本地栈/主会话 plan 栈可用）");
    }
    return this.deps.writer;
  }

  private itemOf(instanceId: string, seq: number): WorkItemData {
    const hit = this.deps.reader.getItems(instanceId).find((item) => item.seq === seq);
    if (hit === undefined) {
      const existing = this.deps.reader.getItems(instanceId);
      const range =
        existing.length > 0 ? `现有 #1~#${existing[existing.length - 1]!.seq}` : "台账为空（先 plan_create）";
      throw new Error(`序号 #${seq} 不在工作台账（${range}——先 plan_read 核对）`);
    }
    return hit;
  }
}

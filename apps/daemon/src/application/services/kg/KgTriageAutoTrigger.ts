/**
 * KgTriageAutoTrigger —— kg-triage **静默点自动触发**（B 方案：水位 + 静默门 + 冷却）。
 *
 * 为什么存在：候选台账入口是即时纪律（改后落账/收口 findings），出口是人审
 * 裁决——产出速率超过裁决速率即积压（2026-10 实测 3 天 47 条）。原设计红线
 * 「不做全自动无人值守触发」只留面板提示（E-230 triageHint）+ 一键发起，提示
 * 不会自己按；用户裁决（2026-10-12）改为**静默点自动触发**：水位到了且项目
 * 静默时 daemon 自动发起 kg-triage，人只抽查裁决报告（E-229 auto: 溯源）。
 *
 * 并发安全三层（用户担忧「触发时其他 chat 在干活」的分层答案）：
 * - 物理层：全部 kg 写过唯一写入口 + SQLite 事务（零撕裂）；
 * - 条目层：decideCandidate 终态守卫（KG_E_STATE）——双裁决后到者被拒；
 *   触发期新进料本轮快照看不见，留 pending 下轮收（最坏晚一轮）；
 * - 内容层：落地前新鲜度核对（SKILL.md read-compare-apply 硬约束）——
 *   目标节点被并发改写即 deferred 升级，不基于旧文覆盖。
 * 本服务的**静默门**是第四层降险（非安全前提）：非终态任务/活跃写租约
 * 存在即推迟到静默再评估——但即使漏判，上面三层兜底。
 *
 * 触发通道两条：写入口候选变化通知（防抖合流）+ 周期 sweep（无事件时兜底
 * ——48h 年龄水位的必达通道）。评估流：水位 → 静默门 → 冷却 → create
 * （KgTriageService.create 准入三态复用——index_absent/nothing_pending/
 * task_running 机械复核不在此重复）。
 *
 * 水位只计 **pending**（不含 deferred）：deferred 是升级人审项，把它们计入
 * 会让同一批硬骨头空转重复裁决（defer_age 递增不消化）；升级项靠 defer
 * 软上限警告浮出人工。冷却窗同理兜住「刚裁完又触发」。
 */

import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { TaskStorePort } from "../../ports/outbound/TaskStorePort";
import type { JobData } from "../../ports/outbound/TaskStorePort";
import { normalizeScopePath, type LeaseScope, type OccupancyLeaseData } from "../../../domain/agent/OccupancyLease";
import type { WorkspaceStack } from "../workspace/WorkspaceService";
import type { KgTriageService } from "./KgTriageService";
import { projectNameOf } from "./job-activity";

/** 水位 A：pending 条数 ≥ 20（E-229 单批阈值同源——到单批直派规模即触发）。 */
export const KG_TRIAGE_AUTO_WATERMARK_COUNT = 20;
/** 水位 B：最老 pending 年龄 ≥ 48h（小股慢积压的兜底通道）。 */
export const KG_TRIAGE_AUTO_WATERMARK_AGE_MS = 48 * 60 * 60 * 1000;
/** 冷却窗：该项目任一 kg-triage job（含终态）创建后 6h 内不自动再发。 */
export const KG_TRIAGE_AUTO_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** 周期 sweep 间隔（30min——年龄水位无事件必达；写通道已覆盖即时性）。 */
export const KG_TRIAGE_AUTO_SWEEP_MS = 30 * 60 * 1000;
/** 写通知防抖窗（突发 N 个候选 op 合并一次评估）。 */
export const KG_TRIAGE_AUTO_DEBOUNCE_MS = 1000;

export interface KgTriageAutoTriggerDeps {
  /** triage 发起面（kgTriageResolver 同源；workspace 未绑定 → undefined 零动作）。 */
  readonly triage: () => KgTriageService | undefined;
  /** workspace 现值栈（projectService/graph 读面；未绑定 → 零动作）。 */
  readonly stack: () => WorkspaceStack | null;
  /** 任务三表读面（静默门 + 冷却判定）。 */
  readonly listJobs: () => readonly JobData[];
  /** 写占用租约读面（静默门：active 租约 = 有人正在写）。 */
  readonly leases: () => readonly OccupancyLeaseData[];
  readonly logger?: { info(msg: string): void; warn(msg: string): void };
  /** 测试注水时钟（缺省 Date.now）。 */
  readonly now?: () => number;
  /** 测试注水防抖窗（缺省 DEBOUNCE 常量）。 */
  readonly debounceMs?: number;
}

/** 项目内归属判定（双向前缀：project 根覆盖 / paths 指向项目内任一处）。 */
function leaseTouchesProject(scope: LeaseScope, projectRoot: string): boolean {
  const root = normalizeScopePath(projectRoot);
  if (scope.kind === "project") {
    const own = normalizeScopePath(scope.projectRoot);
    return root === own || root.startsWith(`${own}/`) || own.startsWith(`${root}/`);
  }
  return scope.patterns.some((p) => {
    const np = normalizeScopePath(p);
    return np === root || np.startsWith(`${root}/`) || root.startsWith(`${np}/`);
  });
}

export class KgTriageAutoTrigger {
  private readonly deps: KgTriageAutoTriggerDeps;
  private readonly queued = new Set<string>();
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: KgTriageAutoTriggerDeps) {
    this.deps = deps;
  }

  /** 写入口候选变化通知（KgWriteService autoTriage 钩子；防抖合流）。 */
  notifyCandidateChange(projectRoot: string): void {
    this.queued.add(projectRoot);
    if (this.drainTimer !== undefined) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      const roots = [...this.queued];
      this.queued.clear();
      for (const root of roots) this.evaluate(root);
    }, this.deps.debounceMs ?? KG_TRIAGE_AUTO_DEBOUNCE_MS);
    this.drainTimer.unref?.();
  }

  /** 周期兜底 sweep（全项目评估）。 */
  sweep(): void {
    const stack = this.deps.stack();
    if (stack === null) return;
    for (const row of stack.projectService.listProjects()) this.evaluate(row.path);
  }

  /** 启动周期 sweep（daemon 生命周期；unref 不阻塞进程退出）。返回 stop。 */
  start(): () => void {
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        this.deps.logger?.warn(`kg-triage 自动触发 sweep 异常（忽略续跑）：${String(error)}`);
      }
    }, KG_TRIAGE_AUTO_SWEEP_MS);
    this.sweepTimer.unref?.();
    return () => {
      if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
      if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    };
  }

  /** 单项目评估：水位 → 静默门 → 冷却 → 发起（任何一环不满足即推迟——
   *  无状态：下一次通知/sweep 重评。发起失败仅 WARN 不重试风暴）。 */
  evaluate(projectRoot: string): void {
    const triage = this.deps.triage();
    const stack = this.deps.stack();
    if (triage === undefined || stack === null) return;
    // absent 绝不读候选（读 port 连接即建库——先过 hasIndex 短路）。
    if (!stack.projectService.hasIndex(projectRoot)) return;

    const now = this.deps.now?.() ?? Date.now();
    const pending = stack.graph.listCandidates(projectRoot, { status: "pending" });
    if (!this.watermarkReached(pending, now)) return;

    const projectName = projectNameOf(projectRoot);
    // 静默门：pending/running 任务 = 有人在干活（paused 是显式挂起不算）。
    const busy = this.deps.listJobs().some(
      (j) => (j.status === "pending" || j.status === "running") && j.projects.includes(projectName),
    );
    if (busy) return;
    // 静默门：active 写租约 = 有会话正在写。
    const writing = this.deps.leases().some((l) => l.status === "active" && leaseTouchesProject(l.scope, projectRoot));
    if (writing) return;

    // 冷却：任一 kg-triage job（含终态）创建后窗口内不自动再发。
    const cooling = this.deps.listJobs().some(
      (j) =>
        j.type === "kg-triage" &&
        j.projects.includes(projectName) &&
        now - Date.parse(j.createdAt) < KG_TRIAGE_AUTO_COOLDOWN_MS,
    );
    if (cooling) return;

    void triage
      .create(projectRoot, { createdBy: "auto" })
      .then((result) => {
        if (result.ok) this.deps.logger?.info(`kg-triage 自动触发（水位命中）：${projectName} → ${result.value.jobId}`);
        else this.deps.logger?.info(`kg-triage 自动触发被准入拒绝（${result.error.code}）：${projectName}`);
      })
      .catch((error: unknown) => {
        this.deps.logger?.warn(`kg-triage 自动触发失败（忽略续跑）：${projectName}：${String(error)}`);
      });
  }

  /** 水位：pending ≥ 20 或最老 pending ≥ 48h（只计 pending——deferred 是升级人审项）。 */
  private watermarkReached(pending: readonly { createdAt: string }[], now: number): boolean {
    if (pending.length >= KG_TRIAGE_AUTO_WATERMARK_COUNT) return true;
    for (const row of pending) {
      const at = Date.parse(row.createdAt);
      if (Number.isFinite(at) && now - at >= KG_TRIAGE_AUTO_WATERMARK_AGE_MS) return true;
    }
    return false;
  }
}

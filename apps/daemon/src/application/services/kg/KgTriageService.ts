/**
 * KgTriageService —— kg-triage 待办面即时裁决任务 kg.triage.create 发起面
 *（设计 docs/temp/kg-auto-adjudication-design.md §5 P1；三层漏斗 L1 层）。
 *
 * 对标 KgReviewService 同构路径（准入机械复核 → createTask 同一 API，
 * createdBy="page"），但**只有发起面**——裁决执行归任务系统（kg-triage
 * skill SOP 驱动编排），本服务不含裁决逻辑。
 *
 * 准入三态（与 kg-review 从简准入的差异 = 待办面非空门槛，注释即裁决）：
 * - index_absent：无索引 → 拒绝（裁决对象依赖代码索引做证据验证）；
 * - nothing_pending：待办面五计数（candidates pending+deferred + dead_anchor
 *   残量 + 无锚节点（orphan_node/unanchored_node）+ draft ready/stale）总和
 *   = 0 → 拒绝（空待办跑任务是白转；L0 机械重定位已消化 rename 类孤儿锚，
 *   残量归本任务；P3 扩 ③④ 路：无锚节点挂锚判断 + 草稿内容裁决）；
 * - task_running：仅禁并发（非终态 kg-triage job 存在；终态后可再发）。
 *
 * 产出纪律（任务侧硬约束，写进 skill SOP）：applied 裁决直接落地 confirmed
 * （change_log taskId + auto: 前缀构成事后审计面）；命中升级判据的条目走
 * deferred + 报告升级清单——人只兜底例外。
 */

import type { TaskEnginePort } from "../../ports/inbound/TaskEnginePort";
import type { TaskStorePort } from "../../ports/outbound/TaskStorePort";
import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { KgProjectService } from "./KgProjectService";
import type { KgVerifyService } from "./KgVerifyService";
import { createTaskWithSlot, hasActiveJob, narrowCreateErrorCode, projectNameOf } from "./job-activity";

/** 准入复核结论（create 前置；reason = 契约词表三态）。 */
export type TriageEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: "index_absent" | "nothing_pending" | "task_running" };

/** kg.triage.create 结果。 */
export interface KgTriageCreateView {
  readonly jobId: string;
}

/** 结构化错误（契约词表；与 KgReviewError 同构但码域不同）。 */
export type KgTriageErrorCode = "kg.triage.not_eligible" | "task.validation_failed" | "task.type_unknown" | "task.internal" | "KG_E_PARAM";

const KG_TRIAGE_ERROR_CODES: readonly KgTriageErrorCode[] = [
  "kg.triage.not_eligible",
  "task.validation_failed",
  "task.type_unknown",
  "task.internal",
  "KG_E_PARAM",
];

export interface KgTriageError {
  readonly code: KgTriageErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type KgTriageResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: KgTriageError };

/** task_running 拒绝文案（准入与互斥槽两处共用，M7④ 收口同构）。 */
const TASK_RUNNING_MESSAGE =
  "task_running：该项目已有进行中的待办面裁决任务（kg-triage）；可在「任务」页观察进度，任务终态后可再次发起（仅禁并发）";

export interface KgTriageServiceDeps {
  readonly project: KgProjectService;
  /** 任务引擎（与 kg.bootstrap/kg.review.create 同源 createTask）。 */
  readonly taskEngine: TaskEnginePort;
  /** 任务三表读面（并发禁入判定：非终态 kg-triage job 查询）。 */
  readonly store: TaskStorePort;
  /** .kg 读 port（candidates 计数——待办面四路之一）。 */
  readonly graph: KnowledgeGraphPort;
  /** 验证期检查（findOrphans dead_anchor 残量与无锚节点计数——待办面四路之二三；findDrafts ready/stale——四路之四）。 */
  readonly verify: KgVerifyService;
}

export class KgTriageService {
  constructor(private readonly deps: KgTriageServiceDeps) {}

  /**
   * 待办面五计数（发起准入与 UI 按钮可用性同源；P3 扩 ③④ 路）：
   * 候选 pending+deferred + dead_anchor 残量 + 无锚节点（orphan_node/
   * unanchored_node）+ draft ready/stale + **带声明的 anchor-debt**。
   * 无声明 anchor-debt 不重复计数——过宽限即在无锚节点计数内，宽限内是
   * 刚落账的正常等待（设计 §三决策 4）；带声明类 ②③ 按声明豁免永不浮现，
   * 且声明已存在即无宽限问题（不是刚落账待作者补），漏计会 nothing_pending
   * 拒发——修复于 2026-09-29（与 classifyDrafts 豁免修复同源：裁决输入面
   * 漏项=结构性排空）。
   */
  pendingCount(projectRoot: string): number {
    const candidates = this.deps.graph.countCandidatesByStatus(projectRoot);
    const orphans = this.deps.verify.findOrphans(projectRoot);
    const unanchored = orphans.filter((o) => o.kind === "orphan_node" || o.kind === "unanchored_node").length;
    const deadAnchors = orphans.filter((o) => o.kind === "dead_anchor").length;
    const drafts = this.deps.verify.findDrafts(projectRoot).filter(
      (d) => d.kind === "ready" || d.kind === "stale" || (d.kind === "anchor-debt" && d.declared),
    ).length;
    return candidates.pending + candidates.deferred + unanchored + deadAnchors + drafts;
  }

  /** 准入机械复核（后端不信赖前端）：索引存在 + 待办面非空 + 仅禁并发。 */
  eligibility(projectRoot: string): TriageEligibility {
    if (!this.deps.project.hasIndex(projectRoot)) return { eligible: false, reason: "index_absent" };
    if (this.pendingCount(projectRoot) === 0) return { eligible: false, reason: "nothing_pending" };
    if (hasActiveJob(this.deps.store.listJobs(), "kg-triage", projectNameOf(projectRoot))) return { eligible: false, reason: "task_running" };
    return { eligible: true };
  }

  async create(project: string, opts?: { readonly createdBy?: "page" | "auto" }): Promise<KgTriageResult<KgTriageCreateView>> {
    const resolved = this.deps.project.resolve(project);
    if (resolved === undefined) {
      return {
        ok: false,
        error: { code: "KG_E_PARAM", message: `project 无法解析（不在 workspace 项目列表内）：${project}`, path: "payload.project" },
      };
    }
    const projectRoot = resolved;
    const eligibility = this.eligibility(projectRoot);
    if (!eligibility.eligible) {
      return {
        ok: false,
        error: {
          code: "kg.triage.not_eligible",
          message:
            eligibility.reason === "task_running"
              ? TASK_RUNNING_MESSAGE
              : eligibility.reason === "nothing_pending"
                ? "nothing_pending：待办面为空（候选 pending+deferred、孤儿锚残量、无锚节点与草稿待裁决五计数 = 0）——无事可裁决，不发起空任务"
                : "index_absent：项目尚未构建索引——裁决证据验证依赖代码索引，先完成一次机械构建",
        },
      };
    }
    const projectName = projectNameOf(projectRoot);
    // 槽+调用+错误归一走共享骨架（M7④）；stages 策略 fixed 由 manifest 生成两行
    //（待办面聚合与分派决策 / 条目裁决与落库）
    const created = await createTaskWithSlot({
      taskType: "kg-triage",
      projectName,
      slotBusyError: () => ({ code: "kg.triage.not_eligible", message: TASK_RUNNING_MESSAGE }),
      createTask: () =>
        this.deps.taskEngine.createTask({ type: "kg-triage", projects: [projectName], params: { projectRoot }, createdBy: opts?.createdBy ?? "page" }),
    });
    if (!created.ok)
      return {
        ok: false,
        error: { code: narrowCreateErrorCode(created.error.code, KG_TRIAGE_ERROR_CODES, "task.internal"), message: created.error.message },
      };
    return { ok: true, value: { jobId: created.jobId } };
  }
}

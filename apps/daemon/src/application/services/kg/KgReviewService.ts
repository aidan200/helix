/**
 * KgReviewService —— W2-F 轨二语义体检任务 kg.review.create 发起面
 *（设计 kg-driven-dev-loop-design D5 轨二 + R21/R23；契约 PROTOCOL.md §23）。
 *
 * 对标 KgBootstrapService.create 的同构路径（准入机械复核 → createTask 同一
 * API，createdBy="page"），但**只有发起面**——体检执行归任务系统（kg-review
 * skill SOP 驱动编排），本服务不含评审逻辑。
 *
 * 准入语义与 bootstrap 一次性不同（注释即裁决）：体检面向存量图谱，知识层
 * 非空恰是评审对象——**允许反复发起**（终态后可再发），准入从简 = 索引存在
 * 即可（building 中索引已存在也放行：sync 只动符号层，评审读知识层零冲突）。
 * 未建索引 → kg.review.not_eligible（message 带原因 index_absent）。P0① 同
 * 口径并发禁入：该项目存在非终态 kg-review job → 拒绝（task_running，仅禁
 * 并发不绑一次性）。
 *
 * 产出纪律（任务侧硬约束，写进 skill SOP）：评审只提 candidates 台账人审，
 * 唯一例外 = scene 缺失节点可 updateNode 直补（R23 元数据补全不是内容推翻）。
 */

import type { TaskEnginePort } from "../../ports/inbound/TaskEnginePort";
import type { TaskStorePort } from "../../ports/outbound/TaskStorePort";
import type { KgProjectService } from "./KgProjectService";
import { claimCreateSlot, hasActiveJob, projectNameOf, releaseCreateSlot } from "./job-activity";

/** 准入复核结论（create 前置；reason = 契约词表 index_absent / task_running
 *（P0① 并发禁入；终态后放行，保留反复发起语义））。 */
export type ReviewEligibility = { readonly eligible: true } | { readonly eligible: false; readonly reason: "index_absent" | "task_running" };

/** kg.review.create 结果。 */
export interface KgReviewCreateView {
  readonly jobId: string;
}

/** 结构化错误（契约词表；与 KgBootstrapError 同构但码域不同）。 */
export type KgReviewErrorCode = "kg.review.not_eligible" | "task.validation_failed" | "task.type_unknown" | "task.internal" | "KG_E_PARAM";

export interface KgReviewError {
  readonly code: KgReviewErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type KgReviewResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: KgReviewError };

export interface KgReviewServiceDeps {
  readonly project: KgProjectService;
  /** 任务引擎（与 kg.bootstrap.create / chat task_create 同源 createTask）。 */
  readonly taskEngine: TaskEnginePort;
  /** 任务三表读面（P0① 并发禁入判定：非终态 kg-review job 查询）。 */
  readonly store: TaskStorePort;
}

export class KgReviewService {
  constructor(private readonly deps: KgReviewServiceDeps) {}

  /** 准入机械复核（后端不信赖前端）：索引存在即可——允许反复发起（与 bootstrap
   *  一次性语义不同：体检面向存量图谱，知识层非空不拒绝）；P0① 仅禁并发：
   *  非终态 kg-review job 存在 → task_running 拒绝（终态后可再发）。 */
  eligibility(projectRoot: string): ReviewEligibility {
    if (!this.deps.project.hasIndex(projectRoot)) return { eligible: false, reason: "index_absent" };
    if (hasActiveJob(this.deps.store.listJobs(), "kg-review", projectNameOf(projectRoot))) return { eligible: false, reason: "task_running" };
    return { eligible: true };
  }

  async create(project: string): Promise<KgReviewResult<KgReviewCreateView>> {
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
          code: "kg.review.not_eligible",
          message:
            eligibility.reason === "task_running"
              ? "task_running：该项目已有进行中的语义体检任务（kg-review）；可在「任务」页观察进度，任务终态后可再次发起（仅禁并发）"
              : "index_absent：项目尚未构建索引（先完成一次机械构建，B1 冷启动链）——体检面向存量图谱，无索引无评审对象",
        },
      };
    }
    const projectName = projectNameOf(projectRoot);
    if (!claimCreateSlot("kg-review", projectName)) {
      return {
        ok: false,
        error: { code: "kg.review.not_eligible", message: "task_running：该项目已有进行中的语义体检任务（kg-review）；可在「任务」页观察进度，任务终态后可再次发起（仅禁并发）" },
      };
    }
    try {
      try {
        // createTask 同一 API（type/params/projects/createdBy 与 kg.bootstrap.create 同源）；
        // stages 策略 fixed 由 manifest 生成三行（L0 结构面预检 / L1 规则册逐节点评审 / L2 实体册逐节点评审）
        const { jobId } = await this.deps.taskEngine.createTask({
          type: "kg-review",
          projects: [projectName],
          params: { projectRoot },
          createdBy: "page",
        });
        return { ok: true, value: { jobId } };
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        const message = err instanceof Error ? err.message : String(err);
        if (code === "task.validation_failed" || code === "task.type_unknown") {
          return { ok: false, error: { code, message } };
        }
        return { ok: false, error: { code: typeof code === "string" && code !== "" ? (code as KgReviewErrorCode) : "task.internal", message } };
      }
    } finally {
      releaseCreateSlot("kg-review", projectName);
    }
  }
}

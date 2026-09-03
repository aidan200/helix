/**
 * CodeReviewService —— code-review 任务 page 入口发起面（code-review v1.5
 * 体检区双入口之代码评审；KgReviewService 同构窄服务，command 层零编排）。
 *
 * 与 KgReviewService 的语义差：**无准入门槛**——评审对象是代码不是图谱，
 * 不要求 .helix-kg 索引存在（无 index_absent 分支）；可反复发起（终态后可
 * 再发）。P0① 同口径并发禁入：该项目存在非终态 code-review job → 拒绝
 * （task_running，仅禁并发不绑一次性）。
 *
 * 产出纪律（任务侧硬约束，写进 code-review skill SOP）：发现只进任务报告
 * 与 closure（kind="issue"），不进 candidates 台账；可泛化为规则的少量
 * 发现才以 sediment 申报。
 */

import type { TaskEnginePort } from "../../ports/inbound/TaskEnginePort";
import type { TaskStorePort } from "../../ports/outbound/TaskStorePort";
import type { KgProjectService } from "./KgProjectService";
import { hasActiveJob, projectNameOf } from "./job-activity";

/** code.review.create 结果。 */
export interface CodeReviewCreateView {
  readonly jobId: string;
}

/** 结构化错误（与 KgReviewError 同构但无 not_eligible——无准入门槛）。 */
export type CodeReviewErrorCode = "task.validation_failed" | "task.type_unknown" | "task.task_running" | "KG_E_PARAM";

export interface CodeReviewError {
  readonly code: CodeReviewErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type CodeReviewResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CodeReviewError };

export interface CodeReviewServiceDeps {
  readonly project: KgProjectService;
  /** 任务引擎（与 kg.review.create / chat task_create 同源 createTask）。 */
  readonly taskEngine: TaskEnginePort;
  /** 任务三表读面（并发禁入判定：非终态 code-review job 查询）。 */
  readonly store: TaskStorePort;
}

export class CodeReviewService {
  constructor(private readonly deps: CodeReviewServiceDeps) {}

  async create(project: string): Promise<CodeReviewResult<CodeReviewCreateView>> {
    const projectRoot = this.deps.project.resolve(project);
    if (projectRoot === undefined) {
      return {
        ok: false,
        error: { code: "KG_E_PARAM", message: `project 无法解析（不在 workspace 项目列表内）：${project}`, path: "payload.project" },
      };
    }
    const projectName = projectNameOf(projectRoot);
    if (hasActiveJob(this.deps.store.listJobs(), "code-review", projectName)) {
      return {
        ok: false,
        error: {
          code: "task.task_running",
          message: "task_running：该项目已有进行中的代码评审任务（code-review）；可在「任务」页观察进度，任务终态后可再次发起（仅禁并发）",
        },
      };
    }
    try {
      // createTask 同一 API（type/params/projects/createdBy 与 kg.review.create 同源）；
      // stages 策略 fixed 由 manifest 生成三行（盘点分批 / 分批评审 / 汇总报告）
      const { jobId } = await this.deps.taskEngine.createTask({
        type: "code-review",
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
      return { ok: false, error: { code: "task.validation_failed", message } };
    }
  }
}

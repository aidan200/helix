import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type {
  TaskDetailDto,
  TaskQueryService,
  TaskSummaryDto,
} from "../../../../application/services/task/TaskQueryService";
import type { ClosureRecordData } from "../../../../application/ports/outbound/SessionRepositoryPort";
import { taskSessionIdOf } from "../../../../application/services/task/TaskOrchestratorService";
import { TaskError } from "../../../../application/services/task/TaskError";
import { JOB_STATUSES, type JobStatus } from "../../../../domain/task/types";

/**
 * task_report 工具（D3——chat 回流通用报告查询面，填 G2）：MainAgent 只读
 * 多 op 单工具（kg/codegraph 同风格），让 chat 主会话经对话感知**所有任务
 * 类型**（kg-bootstrap/kg-review/code-review/未来类型——不绑单一类型）的
 * 任务结果与报告。
 *
 * - op=list：最近任务清单（jobId/type/title/status/updatedAt/hasReport），
 *   type/status 过滤（status 透传查询服务，type 薄壳按 DTO 过滤），limit
 *   缺省 20——agent 的发现面；
 * - op=get { jobId }：stage artifacts（含 D2 body——detail.stages 单点组装
 *   透传）+ 批次 closure 摘要行（agentId/result/summary/reportPath，会话 id
 *   = task:<jobId> 经 taskSessionIdOf 推导）+ findings 按 kind 计数 + 报告
 *   路径清单（汇总 summary.md 固定落点 + 各批次 reportPath 去重）。
 *
 * 薄壳零领域逻辑（TR-32）：读面全部现成——TaskQueryService（list/detail 投影）
 * + closure_records 读面（SessionRepositoryPort.queryClosureRecords 注入为
 * 函数面）+ 报告目录约定（reportDirFor 注入，<home>/reports/<sessionId> 与
 * ClosureRecorder 兜底同源同式）。只读零写（TR-20 不涉写面）。
 *
 * token 经济纪律：报告全文**不进**工具回执——回路径，MainAgent 用既有 read
 * 工具按需读全文（「summary 足够决策要不要深入」的 closure 哲学同构）。
 *
 * 错误面：jobId 缺失/非法/不存在 → task.not_found 同构（TaskError code 透传，
 * executor 转结构化 error——code 留在消息里零吞改，TaskCreateTool 同款）。
 *
 * 生效集：仅 MainAgent（CoreToolExecutor options.taskReport 注入 +
 * MainSessionProfile 声明）；SubAgent 子进程（ChildMain 本地栈）与编排主
 * agent 均不注入——批次/编排面无「查询其他任务报告」职责。
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const taskReportParameters = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["list", "get"],
      description: "list=最近任务清单（发现面）/ get=指定任务结果与报告路径（jobId 必填）",
    },
    jobId: { type: "string", description: "get 必填：任务 jobId（list 回执的 jobId 字段）" },
    type: { type: "string", description: "list 可选：按任务类型过滤（如 kg-bootstrap / kg-review / code-review）" },
    status: {
      type: "string",
      enum: [...JOB_STATUSES],
      description: "list 可选：按任务状态过滤",
    },
    limit: { type: "number", description: `list 可选：条数上限（缺省 ${DEFAULT_LIST_LIMIT}，最大 ${MAX_LIST_LIMIT}）` },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

export interface TaskReportToolDeps {
  /** 任务读面（TR-32 查询投影归属；listTasks/getTaskDetail 现成面，薄壳不拼文案）。 */
  readonly query: Pick<TaskQueryService, "listTasks" | "getTaskDetail">;
  /** closure_records 读面（SessionRepositoryPort.queryClosureRecords 注入为函数面）。 */
  readonly closureRecords: (sessionId: string) => readonly ClosureRecordData[];
  /** 报告目录约定（<home>/reports/<sessionId>，ClosureRecorder 兜底同源同式）。 */
  readonly reportDirFor: (sessionId: string) => string;
}

/** task_report 工具：注册名 "task_report"。 */
export function createTaskReportTool(
  deps: TaskReportToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "task_report",
    label: "task_report",
    description:
      "查询任务结果与报告（只读；全任务类型通用：kg-bootstrap/kg-review/code-review 等）。" +
      "op=list 最近任务清单（jobId/类型/标题/状态/有无报告，可按 type/status 过滤）；" +
      "op=get 指定任务的阶段产物（含发现清单 body）、批次收口摘要、findings 统计与报告路径清单。" +
      "纪律：报告全文不进回执——回执只给摘要与路径，需要全文时用 read 工具按路径按需读。",
    parameters: taskReportParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const args = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      const op = typeof args["op"] === "string" ? args["op"] : "";
      if (op === "list") return text(JSON.stringify(listTasks(deps, args)));
      if (op === "get") return text(JSON.stringify(getTaskReport(deps, args)));
      throw new Error('缺少必填参数 op（"list" 最近任务清单 / "get" 指定任务结果与报告路径）');
    },
  };
}

// ── op=list ──────────────────────────────────────────────────

function listTasks(deps: TaskReportToolDeps, args: Record<string, unknown>): {
  ok: true;
  count: number;
  tasks: { jobId: string; type: string; title: string; status: JobStatus; updatedAt: string; hasReport: boolean }[];
} {
  const status = shapeStatus(args["status"]);
  const type = typeof args["type"] === "string" ? args["type"].trim() : undefined;
  const limit = shapeLimit(args["limit"]);
  const tasks = deps.query
    .listTasks(status !== undefined ? { status } : {})
    .filter((t) => type === undefined || type === "" || t.type === type)
    .slice(0, limit)
    .map((t) => ({
      jobId: t.jobId,
      type: t.type,
      title: t.title,
      status: t.status,
      updatedAt: t.updatedAt,
      hasReport: hasReportOf(deps, t.jobId),
    }));
  return { ok: true, count: tasks.length, tasks };
}

/** 有无报告双源：批次 closure reportPath 存在，或汇总 summary.md 固定落点已落盘。 */
function hasReportOf(deps: TaskReportToolDeps, jobId: string): boolean {
  const sessionId = taskSessionIdOf(jobId);
  if (deps.closureRecords(sessionId).some((r) => r.reportPath !== null)) return true;
  return existsSync(summaryPathOf(deps, sessionId));
}

// ── op=get ───────────────────────────────────────────────────

function getTaskReport(deps: TaskReportToolDeps, args: Record<string, unknown>): {
  ok: true;
  job: { jobId: string; type: string; title: string; status: JobStatus; updatedAt: string };
  stages: TaskDetailDto["stages"];
  closures: { agentId: string; result: ClosureRecordData["result"]; summary: string; reportPath: string | null }[];
  findings: { total: number; byKind: Record<string, number> };
  reports: { summaryPath: string; summaryExists: boolean; batchReports: string[] };
} {
  const jobId = typeof args["jobId"] === "string" ? args["jobId"].trim() : "";
  if (jobId === "") {
    throw new Error("task.not_found：缺少必填参数 jobId（先用 op=list 发现任务，再按 jobId 查询）");
  }
  const detail = detailOrThrow(deps, jobId);
  const sessionId = taskSessionIdOf(jobId);
  const records = deps.closureRecords(sessionId);
  const summaryPath = summaryPathOf(deps, sessionId);
  return {
    ok: true,
    job: {
      jobId: detail.jobId,
      type: detail.type,
      title: detail.title,
      status: detail.status,
      updatedAt: detail.updatedAt,
    },
    // stage artifacts 含 D2 body（detail.stages 单点组装透传，薄壳不重组）
    stages: detail.stages,
    closures: records.map((r) => ({ agentId: r.agentId, result: r.result, summary: r.summary, reportPath: r.reportPath })),
    findings: findingsStatsOf(records),
    reports: {
      summaryPath,
      summaryExists: existsSync(summaryPath),
      batchReports: [...new Set(records.map((r) => r.reportPath).filter((p): p is string => p !== null))],
    },
  };
}

/** 详情读面 + 错误透传：TaskError 转携带 code 的 throw（executor 取 message 转结构化 error——零吞改）。 */
function detailOrThrow(deps: TaskReportToolDeps, jobId: string): TaskDetailDto {
  try {
    return deps.query.getTaskDetail(jobId);
  } catch (error) {
    if (error instanceof TaskError) {
      throw new Error(`${error.code}：${error.message}`);
    }
    throw error;
  }
}

/** findings 按 kind 计数（closure findings 全文不回执，只回统计——token 经济）。 */
function findingsStatsOf(records: readonly ClosureRecordData[]): { total: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const record of records) {
    for (const finding of record.findings ?? []) {
      const kind =
        typeof finding === "object" && finding !== null && typeof (finding as { kind?: unknown }).kind === "string"
          ? ((finding as { kind: string }).kind || "unknown")
          : "unknown";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      total += 1;
    }
  }
  return { total, byKind };
}

// ── 参数整形 ─────────────────────────────────────────────────

function shapeStatus(value: unknown): JobStatus | undefined {
  if (value === undefined) return undefined;
  const status = typeof value === "string" ? value.trim() : "";
  if ((JOB_STATUSES as readonly string[]).includes(status)) return status as JobStatus;
  throw new Error(`status 须为 ${JOB_STATUSES.join("/")} 之一（收到：${JSON.stringify(value)}）`);
}

function shapeLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`limit 须为正整数（缺省 ${DEFAULT_LIST_LIMIT}，最大 ${MAX_LIST_LIMIT}）`);
  }
  return Math.min(value, MAX_LIST_LIMIT);
}

function summaryPathOf(deps: TaskReportToolDeps, sessionId: string): string {
  return path.join(deps.reportDirFor(sessionId), "summary.md");
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}

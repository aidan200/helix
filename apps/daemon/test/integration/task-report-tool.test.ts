import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createTaskReportTool,
  type TaskReportToolDeps,
} from "../../src/adapters/driven/tools/task-report/TaskReportTool";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SubAgentKgWriterProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import { SubAgentCodeReviewerProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";
import { OrchestratorProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import type {
  TaskDetailDto,
  TaskSummaryDto,
} from "../../src/application/services/task/TaskQueryService";
import type { ClosureRecordData } from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { JobStatus } from "../../src/domain/task/types";
import { TaskError } from "../../src/application/services/task/TaskError";
import { taskReportStub } from "../helpers/taskReportStub";

/**
 * I 层：task_report 工具（D3——chat 回流通用报告查询面；多 op 单工具，
 * kg/codegraph 同风格）。全任务类型通用（kg-bootstrap/kg-review/code-review/
 * 未来类型），只读零写。
 *
 * 覆盖：
 * ① list：摘要形状（jobId/type/title/status/updatedAt/hasReport）+ type/status
 *    过滤 + limit 缺省 20/显式上限 + hasReport 双源（closure reportPath 或
 *    summary.md 落点存在）；
 * ② get：全字段组装——job 基本信息 + stage artifacts（含 body）+ 批次 closure
 *    摘要行（agentId/result/summary/reportPath）+ findings 按 kind 计数 +
 *    报告路径清单（summary.md 固定落点 + 各批次 reportPath 去重）；
 * ③ 错误面：jobId 缺失/非法/不存在 → task.not_found 同构（executor 转换后
 *    content 仍含 code）；op/status/limit 整形错误；
 * ④ 注册面：task_report ∈ MainSessionProfile.tools，∉ SubAgent/kg-writer/
 *    code-reviewer/Orchestrator 生效集；未注入 taskReport → resolve 不到；
 * ⑤ 工具描述纪律：报告全文不进回执——回路径，MainAgent 用 read 按需读。
 */

// ── fakes ────────────────────────────────────────────────────

function summaryDto(overrides: Partial<TaskSummaryDto> & { jobId: string }): TaskSummaryDto {
  return {
    type: "kg-bootstrap",
    title: `任务 ${overrides.jobId}`,
    status: "done",
    projects: [],
    createdBy: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    progress: null,
    error: null,
    ...overrides,
  };
}

/** 记录型 listTasks + 表驱动 getTaskDetail fake。 */
function fakeQuery(input: {
  tasks?: readonly TaskSummaryDto[];
  details?: Record<string, TaskDetailDto>;
}): TaskReportToolDeps["query"] & { readonly listCalls: { status?: JobStatus }[] } {
  const listCalls: { status?: JobStatus }[] = [];
  return {
    listCalls,
    listTasks(filter) {
      listCalls.push({ ...(filter.status !== undefined ? { status: filter.status } : {}) });
      return input.tasks ?? [];
    },
    getTaskDetail(jobId) {
      const hit = input.details?.[jobId];
      if (hit === undefined) throw new TaskError("task.not_found", `任务 ${jobId} 不存在`);
      return hit;
    },
  };
}

function detailOf(jobId: string, overrides: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return {
    ...summaryDto({ jobId }),
    stages: [],
    batches: [],
    params: {},
    ...overrides,
  };
}

function closureRow(overrides: Partial<ClosureRecordData> & { agentId: string }): ClosureRecordData {
  return {
    result: "done",
    status: "done",
    summary: `批次 ${overrides.agentId} 收口`,
    reportPath: null,
    findings: null,
    taskId: null,
    createdAt: "2026-01-01T02:00:00.000Z",
    ...overrides,
  };
}

function makeTool(
  query: TaskReportToolDeps["query"],
  options: { closures?: Record<string, readonly ClosureRecordData[]>; reportDir?: string } = {},
): AgentHarnessTool<ExecutionToolContext, any, any> {
  return createTaskReportTool({
    query,
    closureRecords: (sessionId) => options.closures?.[sessionId] ?? [],
    reportDirFor: (sessionId) => path.join(options.reportDir ?? tmpdir(), "reports", sessionId),
  });
}

type RunResult = { ok: true; text: string } | { ok: false; error: string };

async function run(
  tool: AgentHarnessTool<ExecutionToolContext, any, any>,
  args: unknown,
): Promise<RunResult> {
  const env = new NodeExecutionEnv({ cwd: tmpdir() });
  try {
    const result = await tool.execute("tc-task-report", args as never, undefined, undefined, { env });
    return {
      ok: true,
      text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n"),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── ① list：摘要形状 + 过滤 + limit ─────────────────────────

describe("① list：最近任务清单（摘要形状 + type/status 过滤 + limit）", () => {
  test("无过滤 → 全量摘要行（jobId/type/title/status/updatedAt/hasReport）", async () => {
    const query = fakeQuery({
      tasks: [
        summaryDto({ jobId: "job-1", type: "kg-bootstrap", title: "建图谱（demo）", status: "done" }),
        summaryDto({ jobId: "job-2", type: "code-review", title: "评审（app）", status: "running" }),
      ],
    });
    const tool = makeTool(query, {
      // job-1 的批次报告存在（closure reportPath）→ hasReport=true；job-2 无 → false
      closures: { "task:job-1": [closureRow({ agentId: "agent-1", reportPath: "/reports/task:job-1/agent-1.md" })] },
    });
    const r = await run(tool, { op: "list" });
    if (!r.ok) throw new Error(`task_report list 失败：${r.error}`);
    expect(JSON.parse(r.text)).toEqual({
      ok: true,
      count: 2,
      tasks: [
        { jobId: "job-1", type: "kg-bootstrap", title: "建图谱（demo）", status: "done", updatedAt: "2026-01-01T01:00:00.000Z", hasReport: true },
        { jobId: "job-2", type: "code-review", title: "评审（app）", status: "running", updatedAt: "2026-01-01T01:00:00.000Z", hasReport: false },
      ],
    });
  });

  test("hasReport 第二源：summary.md 固定落点存在即 true（零 closure 行也算）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-task-report-list-"));
    try {
      const summaryDir = path.join(dir, "reports", "task:job-s");
      mkdirSync(summaryDir, { recursive: true });
      writeFileSync(path.join(summaryDir, "summary.md"), "# 汇总");
      const query = fakeQuery({ tasks: [summaryDto({ jobId: "job-s" })] });
      const tool = makeTool(query, { reportDir: dir });
      const r = await run(tool, { op: "list" });
      if (!r.ok) throw new Error(`task_report list 失败：${r.error}`);
      const receipt = JSON.parse(r.text) as { tasks: { jobId: string; type: string; title: string; status: string; updatedAt: string; hasReport: boolean }[] };
      expect(receipt.tasks).toEqual([
        { jobId: "job-s", type: "kg-bootstrap", title: "任务 job-s", status: "done", updatedAt: "2026-01-01T01:00:00.000Z", hasReport: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("type 过滤（薄壳按 DTO.type 过滤）；status 过滤透传查询服务", async () => {
    const query = fakeQuery({
      tasks: [
        summaryDto({ jobId: "job-1", type: "kg-bootstrap" }),
        summaryDto({ jobId: "job-2", type: "code-review" }),
        summaryDto({ jobId: "job-3", type: "kg-review" }),
      ],
    });
    const tool = makeTool(query);
    const r = await run(tool, { op: "list", type: "code-review" });
    if (!r.ok) throw new Error(`task_report list 失败：${r.error}`);
    const receipt = JSON.parse(r.text) as { tasks: { jobId: string }[] };
    expect(receipt.tasks.map((t) => t.jobId)).toEqual(["job-2"]);

    const r2 = await run(tool, { op: "list", status: "done" });
    if (!r2.ok) throw new Error(`task_report list 失败：${r2.error}`);
    expect(query.listCalls.at(-1)).toEqual({ status: "done" });
  });

  test("limit：缺省 20（25 条截 20）；显式 limit=5 → 5 条", async () => {
    const tasks = Array.from({ length: 25 }, (_, i) => summaryDto({ jobId: `job-${i + 1}` }));
    const tool = makeTool(fakeQuery({ tasks }));
    const r = await run(tool, { op: "list" });
    if (!r.ok) throw new Error(`task_report list 失败：${r.error}`);
    const receipt = JSON.parse(r.text) as { count: number; tasks: unknown[] };
    expect(receipt.tasks).toHaveLength(20);
    expect(receipt.count).toBe(20);

    const r2 = await run(tool, { op: "list", limit: 5 });
    if (!r2.ok) throw new Error(`task_report list 失败：${r2.error}`);
    expect((JSON.parse(r2.text) as { tasks: unknown[] }).tasks).toHaveLength(5);
  });

  test("status 非法值 / limit 非正整数 → 整形错误（不触查询面）", async () => {
    const query = fakeQuery({});
    const tool = makeTool(query);
    expect((await run(tool, { op: "list", status: "archived" })).ok).toBe(false);
    expect((await run(tool, { op: "list", limit: 0 })).ok).toBe(false);
    expect((await run(tool, { op: "list", limit: 2.5 })).ok).toBe(false);
    expect(query.listCalls).toHaveLength(0);
  });
});

// ── ② get：全字段组装 ───────────────────────────────────────

describe("② get { jobId }：artifacts（含 body）+ closure 摘要行 + findings 计数 + 报告路径清单", () => {
  test("全字段：job/stages(body 透传)/closures/findings.byKind/reports(summary.md 落点 + 批次路径去重)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-task-report-get-"));
    try {
      const summaryDir = path.join(dir, "reports", "task:job-g");
      mkdirSync(summaryDir, { recursive: true });
      writeFileSync(path.join(summaryDir, "summary.md"), "# 汇总报告");
      const detail = detailOf("job-g", {
        type: "code-review",
        title: "代码评审（app）",
        status: "done",
        stages: [
          { seq: 1, name: "评审", status: "done", artifact: { summary: "评审完成", body: "发现 3 处问题" } },
          { seq: 2, name: "汇总", status: "done", artifact: { summary: "汇总完成" } },
          { seq: 3, name: "收口", status: "pending", artifact: null },
        ],
      });
      const closures: ClosureRecordData[] = [
        closureRow({
          agentId: "agent-1",
          reportPath: path.join(summaryDir, "agent-1.md"),
          findings: [{ kind: "issue" }, { kind: "issue" }, { kind: "sediment" }],
        }),
        closureRow({ agentId: "agent-2", reportPath: path.join(summaryDir, "agent-2.md"), findings: [{ kind: "issue" }] }),
        closureRow({ agentId: "agent-3", reportPath: null, findings: null }),
      ];
      const tool = makeTool(fakeQuery({ details: { "job-g": detail } }), {
        closures: { "task:job-g": closures },
        reportDir: dir,
      });
      const r = await run(tool, { op: "get", jobId: "job-g" });
      if (!r.ok) throw new Error(`task_report get 失败：${r.error}`);
      expect(JSON.parse(r.text)).toEqual({
        ok: true,
        job: { jobId: "job-g", type: "code-review", title: "代码评审（app）", status: "done", updatedAt: "2026-01-01T01:00:00.000Z" },
        stages: [
          { seq: 1, name: "评审", status: "done", artifact: { summary: "评审完成", body: "发现 3 处问题" } },
          { seq: 2, name: "汇总", status: "done", artifact: { summary: "汇总完成" } },
          { seq: 3, name: "收口", status: "pending", artifact: null },
        ],
        closures: [
          { agentId: "agent-1", result: "done", summary: "批次 agent-1 收口", reportPath: path.join(summaryDir, "agent-1.md") },
          { agentId: "agent-2", result: "done", summary: "批次 agent-2 收口", reportPath: path.join(summaryDir, "agent-2.md") },
          { agentId: "agent-3", result: "done", summary: "批次 agent-3 收口", reportPath: null },
        ],
        findings: { total: 4, byKind: { issue: 3, sediment: 1 } },
        reports: {
          summaryPath: path.join(summaryDir, "summary.md"),
          summaryExists: true,
          batchReports: [path.join(summaryDir, "agent-1.md"), path.join(summaryDir, "agent-2.md")],
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("无 closure 行 + summary.md 未落盘 → closures=[]、findings 零计数、summaryExists=false", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-task-report-empty-"));
    try {
      const tool = makeTool(fakeQuery({ details: { "job-e": detailOf("job-e", { status: "running" }) } }), {
        reportDir: dir,
      });
      const r = await run(tool, { op: "get", jobId: "job-e" });
      if (!r.ok) throw new Error(`task_report get 失败：${r.error}`);
      const receipt = JSON.parse(r.text) as {
        closures: unknown[];
        findings: { total: number; byKind: Record<string, number> };
        reports: { summaryPath: string; summaryExists: boolean; batchReports: string[] };
      };
      expect(receipt.closures).toEqual([]);
      expect(receipt.findings).toEqual({ total: 0, byKind: {} });
      expect(receipt.reports.summaryPath).toBe(path.join(dir, "reports", "task:job-e", "summary.md"));
      expect(receipt.reports.summaryExists).toBe(false);
      expect(receipt.reports.batchReports).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── ③ 错误面：task.not_found 同构 ───────────────────────────

describe("③ 错误面（jobId 缺失/不存在 → task.not_found；op 非法）", () => {
  test("get 缺 jobId / 空白 jobId → error 含 task.not_found", async () => {
    const tool = makeTool(fakeQuery({}));
    for (const args of [{ op: "get" }, { op: "get", jobId: "  " }]) {
      const r = await run(tool, args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("task.not_found");
    }
  });

  test("jobId 不存在 → error 含 task.not_found 与引擎原文（薄壳零吞改）", async () => {
    const tool = makeTool(fakeQuery({}));
    const r = await run(tool, { op: "get", jobId: "ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("task.not_found");
      expect(r.error).toContain("ghost");
    }
  });

  test("executor 执行链：error 结果 content 含 task.not_found（转换后仍不丢）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-task-report-exec-"));
    try {
      const executor = new CoreToolExecutor({
        cwd: dir,
        taskReport: { ...taskReportStub(), query: fakeQuery({}) },
      });
      const result = await executor.execute({
        toolCallId: "tc-err",
        toolName: "task_report",
        args: { op: "get", jobId: "ghost" },
        signal: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("task.not_found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("op 缺失/非法 → 整形错误", async () => {
    const tool = makeTool(fakeQuery({}));
    expect((await run(tool, {})).ok).toBe(false);
    expect((await run(tool, { op: "delete" })).ok).toBe(false);
  });
});

// ── ④ 注册面：仅 MainAgent 生效集 ───────────────────────────

describe("④ 注册面：task_report 只进 MainAgent（D3 chat 查询面）", () => {
  test("配给面：∈ MainSessionProfile.tools；∉ SubAgent/kg-writer/code-reviewer/Orchestrator", () => {
    expect(MainSessionProfile.tools).toContain("task_report");
    expect(SubAgentProfile.tools).not.toContain("task_report");
    expect(SubAgentKgWriterProfile.tools).not.toContain("task_report");
    expect(SubAgentCodeReviewerProfile.tools).not.toContain("task_report");
    expect(OrchestratorProfile.tools).not.toContain("task_report");
  });

  test("MainAgent 形态（注入 taskReport）：resolve 得到 task_report", () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir(), taskReport: taskReportStub() });
    const resolved = executor.resolveTools(["task_report"]);
    expect(resolved.map((t) => t.name)).toEqual(["task_report"]);
  });

  test("SubAgent 形态（无 taskReport deps）→ resolve 不到 task_report", () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir() });
    expect(() => executor.resolveTools(["task_report"])).toThrow(/不在注册表/);
  });
});

// ── ⑤ 工具描述纪律：全文不进回执 ────────────────────────────

describe("⑤ 工具描述纪律（报告全文不进回执——回路径，read 按需读）", () => {
  test("description 声明路径回执 + read 按需读全文纪律", () => {
    const tool = makeTool(fakeQuery({}));
    expect(tool.description).toContain("路径");
    expect(tool.description).toContain("read");
  });
});

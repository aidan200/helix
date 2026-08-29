import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createTaskCreateTool,
  type TaskCreateToolDeps,
} from "../../src/adapters/driven/tools/task-create/TaskCreateTool";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { TaskError } from "../../src/application/services/task/TaskError";
import type { CreateTaskInput, TaskEnginePort } from "../../src/application/ports/inbound/TaskEnginePort";
import { kgToolsStub } from "../helpers/kgToolsStub";
import { withTaskEnv } from "../helpers/task-fixtures";

/**
 * I 层：task_create 工具（T2.4，CL-1/F1.3，AD-7 chat 第二创建入口）——
 * 薄壳透明性 + 生效集隔离 + 双入口同源（testing/test-design CL-1-T4 映射）。
 *
 * 覆盖：
 * ① 参数整形与透传：createTask 收到 createdBy="chat"，type/projects/params/
 *    confirmedStages 原样（fake 引擎记录断言）；projects 缺省 = []；
 * ② 人类可读回执：{ ok, jobId, title, stageNames }（供 MainAgent 向用户交代）；
 * ③ 错误透传零吞改：task.type_unknown / task.validation_failed 全量透传
 *    （executor 转 error 结果后 content 仍含 code）；
 * ④ 生效集隔离（装配断言）：task_create 只进 MainAgent 生效集——SubAgent
 *    形态（ChildMain 同款，无 taskCreate deps）resolve 不到；
 * ⑤ 双入口同源：同一 createTask fake 驱动两入口（工具=chat / 直调=page）
 *    → 调用载荷仅 createdBy 不同；
 * ⑥ 真栈端到端（验收）：真 TaskEngineService+TaskQueryService → job 行
 *    created_by="chat" + 回执与库一致。
 */

// ── fakes（结构化注入面同形——与真服务可互换） ──────────────

/** 记录型 fake 引擎（透传/同源断言的载荷事实源）。 */
class RecordingTaskEngine implements Pick<TaskEnginePort, "createTask"> {
  readonly calls: CreateTaskInput[] = [];
  constructor(private readonly behavior: (input: CreateTaskInput) => Promise<{ jobId: string }>) {}
  async createTask(input: CreateTaskInput): Promise<{ jobId: string }> {
    this.calls.push(input);
    return this.behavior(input);
  }
}

/** 回执读面 fake：jobId → title/stageNames 投影（未登记 jobId → 兑底投影，不炸回执组装）。 */
function fakeQuery(details: Record<string, { title: string; stageNames: readonly string[] }>): TaskCreateToolDeps["query"] {
  return {
    getTaskDetail(jobId: string) {
      const hit = details[jobId] ?? { title: `任务 ${jobId}`, stageNames: ["阶段一"] };
      return { title: hit.title, stages: hit.stageNames.map((name, i) => ({ seq: i + 1, name })) };
    },
  };
}

function makeTool(
  engine: Pick<TaskEnginePort, "createTask">,
  query?: TaskCreateToolDeps["query"],
): AgentHarnessTool<ExecutionToolContext, any, any> {
  return createTaskCreateTool({ engine, query: query ?? fakeQuery({}) });
}

type RunResult = { ok: true; text: string } | { ok: false; error: string };

async function run(
  tool: AgentHarnessTool<ExecutionToolContext, any, any>,
  args: unknown,
): Promise<RunResult> {
  const env = new NodeExecutionEnv({ cwd: tmpdir() });
  try {
    const result = await tool.execute("tc-task-create", args as never, undefined, undefined, { env });
    return {
      ok: true,
      text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n"),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const KG_BOOTSTRAP_ARGS = {
  type: "kg-bootstrap",
  projects: ["demo"],
  params: { projectRoot: "/tmp/demo", scope: "core" },
} as const;

// ── ① 参数整形与透传 ────────────────────────────────────────

describe("① 参数整形与透传（CL-1-T4 工具面）", () => {
  test("工具调用 → createTask 收到 createdBy=chat，type/projects/params/confirmedStages 原样", async () => {
    const engine = new RecordingTaskEngine(async () => ({ jobId: "job-1" }));
    const tool = makeTool(engine);
    const r = await run(tool, { ...KG_BOOTSTRAP_ARGS, confirmedStages: ["L0 核心层", "L1 领域层"] });
    expect(r.ok).toBe(true);
    expect(engine.calls).toEqual([
      {
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo", scope: "core" },
        confirmedStages: ["L0 核心层", "L1 领域层"],
        createdBy: "chat",
      },
    ]);
  });

  test("projects 缺省 = []；confirmedStages 缺省不携带", async () => {
    const engine = new RecordingTaskEngine(async () => ({ jobId: "job-2" }));
    const tool = makeTool(engine);
    const r = await run(tool, { type: "zero-project-scan", params: {} });
    expect(r.ok).toBe(true);
    expect(engine.calls[0]).toEqual({ type: "zero-project-scan", projects: [], params: {}, createdBy: "chat" });
    expect("confirmedStages" in engine.calls[0]!).toBe(false);
  });

  test("缺 type / 缺 params / params 非对象 → 工具面整形错误（不触引擎）", async () => {
    const engine = new RecordingTaskEngine(async () => ({ jobId: "never" }));
    const tool = makeTool(engine);
    expect((await run(tool, { params: {} })).ok).toBe(false);
    expect((await run(tool, { type: "kg-bootstrap" })).ok).toBe(false);
    expect((await run(tool, { type: "kg-bootstrap", params: "not-an-object" })).ok).toBe(false);
    expect(engine.calls).toHaveLength(0);
  });
});

// ── ② 人类可读回执 ──────────────────────────────────────────

describe("② 人类可读回执（{ ok, jobId, title, stageNames }）", () => {
  test("合法 kg-bootstrap 参数 → JSON 回执含 jobId/title/stageNames=[L0,L1,L2]", async () => {
    const engine = new RecordingTaskEngine(async () => ({ jobId: "job-fx" }));
    const tool = makeTool(engine, fakeQuery({ "job-fx": { title: "为项目批量创建知识图谱内容（demo）", stageNames: ["L0 核心层", "L1 领域层", "L2 实体层"] } }));
    const r = await run(tool, KG_BOOTSTRAP_ARGS);
    if (!r.ok) throw new Error(`task_create 失败：${r.error}`);
    expect(JSON.parse(r.text)).toEqual({
      ok: true,
      jobId: "job-fx",
      title: "为项目批量创建知识图谱内容（demo）",
      stageNames: ["L0 核心层", "L1 领域层", "L2 实体层"],
    });
  });
});

// ── ③ 错误透传零吞改 ────────────────────────────────────────

describe("③ 错误透传（引擎 code 全量透传，薄壳零吞改）", () => {
  test("type 无 skill → error 含 task.type_unknown 且引擎原文保留", async () => {
    const engine = new RecordingTaskEngine(async () => {
      throw new TaskError("task.type_unknown", `任务类型 "no-such-type" 无对应任务 skill（任务类型注册表未收录）`);
    });
    const tool = makeTool(engine);
    const r = await run(tool, { type: "no-such-type", params: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("task.type_unknown");
      expect(r.error).toContain("no-such-type");
      expect(r.error).toContain("无对应任务 skill");
    }
  });

  test("params 违例 → error 含 task.validation_failed", async () => {
    const engine = new RecordingTaskEngine(async () => {
      throw new TaskError("task.validation_failed", "params 校验失败：缺少必填字段 projectRoot");
    });
    const tool = makeTool(engine);
    const r = await run(tool, { type: "kg-bootstrap", projects: ["demo"], params: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("task.validation_failed");
      expect(r.error).toContain("projectRoot");
    }
  });

  test("executor 执行链：error 结果 content 含 code（executor 转换后仍不丢）", async () => {
    const engine = new RecordingTaskEngine(async () => {
      throw new TaskError("task.type_unknown", `任务类型 "ghost" 无对应任务 skill（任务类型注册表未收录）`);
    });
    const dir = mkdtempSync(path.join(tmpdir(), "helix-task-create-exec-"));
    try {
      const executor = new CoreToolExecutor({ cwd: dir, taskCreate: { engine, query: fakeQuery({}) } });
      const result = await executor.execute({
        toolCallId: "tc-err",
        toolName: "task_create",
        args: { type: "ghost", params: {} },
        signal: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("task.type_unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── ④ 生效集隔离（装配断言） ────────────────────────────────

describe("④ 生效集：task_create 只进 MainAgent（AD-2 创建按宿主）", () => {
  test("配给面：task_create ∈ MainSessionProfile.tools 且 ∉ SubAgentProfile.tools", () => {
    expect(MainSessionProfile.tools).toContain("task_create");
    expect(SubAgentProfile.tools).not.toContain("task_create");
  });

  test("MainAgent 形态（注入 taskCreate）：全 profile 名集一次装配成功且含 task_create", () => {
    const orchestration = {
      spawn: (task: string) => ({ status: "rejected", error: `测试桩不 spawn：${task}` }) as const,
      send: () => ({ delivered: false, detail: "测试桩不投递" }),
      status: () => [],
      kill: () => ({ killed: false, error: "测试桩不 kill" }),
      inspect: () => null,
    };
    const executor = new CoreToolExecutor({
      cwd: tmpdir(),
      orchestration,
      browser: undefined,
      kg: kgToolsStub(tmpdir()),
      taskCreate: {
        engine: new RecordingTaskEngine(async () => ({ jobId: "job-asm" })),
        query: fakeQuery({}),
      },
    });
    // main 全集（减动态族 browser——条件注册面，与本任务无关）
    const names = MainSessionProfile.tools.filter((t) => t !== "browser");
    const resolved = executor.resolveTools(names);
    expect(resolved.map((t) => t.name)).toEqual([...names]);
    expect(resolved.some((t) => t.name === "task_create")).toBe(true);
  });

  test("SubAgent 形态（ChildMain 同款：无 taskCreate deps）→ resolve 不到 task_create", () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir() });
    expect(() => executor.resolveTools(["task_create"])).toThrow(/不在注册表/);
    // SubAgent 声明名集本身不含 task_create（profile 零声明——批次 SubAgent 不能建任务）
    expect(SubAgentProfile.tools.includes("task_create")).toBe(false);
  });

  test("工具描述声明「与用户确认干什么之后再调用」；无 confirm/dryRun 参数（AD-7 机械判据）", () => {
    const tool = makeTool(new RecordingTaskEngine(async () => ({ jobId: "x" })));
    expect(tool.description).toContain("确认");
    // 机械判据：参数面无 confirm/dryRun 参数名（调用即创建，无二次确认；
    // confirmedStages 是阶段确认名单——引擎 API 契约字段，非确认开关）
    const schema = JSON.parse(JSON.stringify(tool.parameters)) as { properties: Record<string, unknown> };
    const keys = Object.keys(schema.properties);
    expect(keys).toEqual(["type", "projects", "params", "confirmedStages"]);
    expect(keys.includes("confirm")).toBe(false);
    expect(keys.includes("dryRun")).toBe(false);
  });
});

// ── ⑤ 双入口同源 ───────────────────────────────────────────

describe("⑤ 双入口同源（CL-1-T4：同一 createTask fake 驱动两入口）", () => {
  test("chat 工具入口与 page 直调入口 → 调用载荷仅 createdBy 不同", async () => {
    const engine = new RecordingTaskEngine(
      async (input: CreateTaskInput): Promise<{ jobId: string }> => ({ jobId: `job-${engine.calls.length}` }),
    );
    const tool = makeTool(engine, fakeQuery({}));
    // chat 入口：经工具（createdBy 由薄壳定死 "chat"）
    const chat = await run(tool, KG_BOOTSTRAP_ARGS);
    expect(chat.ok).toBe(true);
    // page 入口：/project handler 同款直调形态（同一 createTask API，AD-7 双宿主）
    await engine.createTask({ ...KG_BOOTSTRAP_ARGS, createdBy: "page" });
    expect(engine.calls).toHaveLength(2);
    const [chatCall, pageCall] = engine.calls;
    expect(chatCall!.createdBy).toBe("chat");
    expect(pageCall!.createdBy).toBe("page");
    // 载荷同构：仅 createdBy 不同
    const { createdBy: _c, ...chatPayload } = chatCall!;
    const { createdBy: _p, ...pagePayload } = pageCall!;
    expect(chatPayload).toEqual(pagePayload);
  });
});

// ── ⑥ 真栈端到端（验收：job 行 created_by="chat"） ──────────

describe("⑥ 真栈端到端（真 TaskEngineService + TaskQueryService @ tmp SQLite）", () => {
  test("经 task_create 建 kg-bootstrap → job 行 createdBy=chat + 回执 title/stageNames 与库一致", async () => {
    await withTaskEnv(async (env) => {
      const tool = createTaskCreateTool({ engine: env.engine, query: env.query });
      const r = await run(tool, KG_BOOTSTRAP_ARGS);
      if (!r.ok) throw new Error(`task_create 失败：${r.error}`);
      const receipt = JSON.parse(r.text) as { ok: boolean; jobId: string; title: string; stageNames: string[] };
      expect(receipt.ok).toBe(true);
      const job = env.store.getJob(receipt.jobId);
      expect(job).toMatchObject({ type: "kg-bootstrap", status: "pending", createdBy: "chat", projects: ["demo"] });
      expect(env.store.getStages(receipt.jobId).map((s) => s.name)).toEqual(receipt.stageNames);
      expect(receipt.stageNames).toEqual(["L0 核心层", "L1 领域层", "L2 实体层"]);
      expect(receipt.title).toContain("为项目批量创建知识图谱内容");
      expect(receipt.title).toContain("demo");
      // §5.2 编排启动同路径
      expect(env.starter.starts).toContain(receipt.jobId);
    });
  });
});

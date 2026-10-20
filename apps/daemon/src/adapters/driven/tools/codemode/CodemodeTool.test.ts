import { describe, expect, test } from "bun:test";
import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
  AgentToolResult,
  Context,
  ExecutionToolContext,
} from "../vendor/pi-harness";
import { BACKGROUND_CONTEXT } from "../vendor/pi-harness";
import {
  CODEMODE_TOOL_NAME,
  createCodemodeTool,
  resolveCodemodeWorkerUrl,
} from "./CodemodeTool";

/**
 * CodemodeTool 单元/集成测试（pi-codemode 接入批）——**真沙箱往返**
 * （每次 execute 新 worker + 新 QuickJS VM，非 mock）：
 * - 嵌套调用走六参直执（共享 context + 沙箱中止信号透传 chord）；
 * - structuredContent 优先于文本拼接（S2 地基的消费面）；
 * - 排除集（审批/编排面不进脚本）；
 * - 失败路径（工具 throw → 脚本 Error；脚本错误 → isError + 脚本失败文案）。
 */

function invocation(id: string): AgentHarnessToolInvocation {
  return {
    invocationId: id,
    operationId: id,
    turnId: id,
    getMemo: () => Promise.resolve(undefined),
    setMemo: () => Promise.resolve(),
  };
}

/** 直呼六参 execute 的测试驱动（跳过 AgentRuntime 装配）。 */
async function runCodemode(
  tool: AgentHarnessTool<ExecutionToolContext>,
  code: string,
): Promise<AgentToolResult<unknown>> {
  return tool.execute(
    "test-call",
    { code },
    () => {},
    {} as ExecutionToolContext,
    invocation("test-call"),
    BACKGROUND_CONTEXT,
  );
}

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}

const echoTool: AgentHarnessTool<ExecutionToolContext> = {
  name: "echo",
  label: "echo",
  description: "回声工具",
  parameters: { type: "object", properties: { v: { type: "string" } } } as never,
  async execute(_id, params) {
    return textResult(`echo:${(params as { v: string }).v}`);
  },
};

const structTool: AgentHarnessTool<ExecutionToolContext> = {
  name: "struct",
  label: "struct",
  description: "结构化输出工具",
  parameters: { type: "object", properties: {} } as never,
  outputSchema: { type: "object" } as never,
  async execute() {
    return {
      content: [{ type: "text" as const, text: "文本形态" }],
      details: undefined,
      structuredContent: { rows: [1, 2, 3] } as never,
    };
  },
};

const failingTool: AgentHarnessTool<ExecutionToolContext> = {
  name: "failing",
  label: "failing",
  description: "总是失败",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    throw new Error("boom");
  },
};

function parallelTool(state: { active: number; max: number }): AgentHarnessTool<ExecutionToolContext> {
  return {
    name: "par",
    label: "par",
    description: "并行探针",
    parameters: { type: "object", properties: {} } as never,
    async execute() {
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      state.active -= 1;
      return textResult("ok");
    },
  };
}

const permissionRequestStub: AgentHarnessTool<ExecutionToolContext> = {
  name: "permission_request",
  label: "permission_request",
  description: "提权申请（排除面）",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return textResult("SHOULD-NOT-BE-CALLABLE");
  },
};

const taskCreateStub: AgentHarnessTool<ExecutionToolContext> = {
  name: "task_create",
  label: "task_create",
  description: "任务创建（排除面：对话即确认的重型副作用）",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return textResult("SHOULD-NOT-BE-CALLABLE");
  },
};

const coordClaimStub: AgentHarnessTool<ExecutionToolContext> = {
  name: "coord_claim",
  label: "coord_claim",
  description: "占用声明（排除面：决策工具）",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return textResult("SHOULD-NOT-BE-CALLABLE");
  },
};

const coordQueryStub: AgentHarnessTool<ExecutionToolContext> = {
  name: "coord_query",
  label: "coord_query",
  description: "占用查询（只读——保留可编排）",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return textResult("queried");
  },
};

const agentSpawnStub: AgentHarnessTool<ExecutionToolContext> = {
  name: "agent_spawn",
  label: "agent_spawn",
  description: "编排（排除面）",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return textResult("SHOULD-NOT-BE-CALLABLE");
  },
};

describe("resolveCodemodeWorkerUrl", () => {
  test("源码形态 → 缺省 worker（包自带文件在磁盘上；未注入 = undefined）", () => {
    expect(resolveCodemodeWorkerUrl(undefined)).toBeUndefined();
  });
  test("编译形态 → --define 注入的嵌入 entrypoint 相对串透传", () => {
    expect(resolveCodemodeWorkerUrl("./apps/daemon/src/codemode-worker.ts")).toBe(
      "./apps/daemon/src/codemode-worker.ts",
    );
  });
});

describe("CodemodeTool（真沙箱往返）", () => {
  test("嵌套调用返回值：文本工具 → 脚本拿到拼接文本，return 直达 content", async () => {
    const tool = createCodemodeTool({ getTools: () => [echoTool] });
    const result = await runCodemode(tool, `return await tools.echo({ v: "hi" });`);
    expect(result.isError).toBe(false);
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts).toContain("echo:hi");
    const calls = (result.details as { calls: { name: string; status: string; durationMs: number }[] }).calls;
    expect(calls).toEqual([{ name: "echo", status: "ok", durationMs: expect.any(Number) }]);
  });

  test("structuredContent 优先：声明 outputSchema 的工具 → 脚本拿到对象", async () => {
    const tool = createCodemodeTool({ getTools: () => [structTool] });
    const result = await runCodemode(tool, `return await tools.struct();`);
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts).toContain(JSON.stringify({ rows: [1, 2, 3] }, null, 2));
  });

  test("并行扇出：Promise.all 三路并发（嵌套中间结果不进上下文）", async () => {
    const state = { active: 0, max: 0 };
    const tool = createCodemodeTool({ getTools: () => [parallelTool(state)] });
    const result = await runCodemode(
      tool,
      `const rs = await Promise.all([tools.par(), tools.par(), tools.par()]); return rs.join(",");`,
    );
    expect(state.max).toBe(3);
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts).toContain("ok,ok,ok");
  });

  test("排除集：permission_request / agent_spawn / codemode 不进沙箱面", async () => {
    const tool = createCodemodeTool({
      getTools: () => [echoTool, permissionRequestStub, agentSpawnStub],
    });
    const result = await runCodemode(tool, `return ALL_TOOLS.map(t => t.name).join(",");`);
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts[0]).toBe("echo");
  });

  test("排除集补入：task_create / coord_claim 不进沙箱面；coord_query 只读仍可编排（低危批）", async () => {
    const tool = createCodemodeTool({
      getTools: () => [echoTool, taskCreateStub, coordClaimStub, coordQueryStub],
    });
    const result = await runCodemode(tool, `return ALL_TOOLS.map(t => t.name).sort().join(",");`);
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts[0]).toBe("coord_query,echo");
    // 被排除工具在脚本内不可见（tools.task_create 不存在 → TypeError 捕获面）
    const probe = await runCodemode(
      tool,
      `try { await tools.task_create({}); return "callable"; } catch (e) { return "blocked"; }`,
    );
    const probeTexts = (probe.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(probeTexts.join("")).toContain("blocked");
  });

  test("工具失败 → 脚本内 rejected promise（catch 得到 Error）", async () => {
    const tool = createCodemodeTool({ getTools: () => [failingTool, echoTool] });
    const result = await runCodemode(
      tool,
      `try { await tools.failing(); return "not-reached"; } catch (e) { return "caught:" + e.message; }`,
    );
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts).toContain("caught:boom");
    const calls = (result.details as { calls: { name: string; status: string }[] }).calls;
    expect(calls.find((c) => c.name === "failing")?.status).toBe("error");
  });

  test("脚本自身错误 → isError + 脚本失败文案（stack 随行）", async () => {
    const tool = createCodemodeTool({ getTools: () => [echoTool] });
    const result = await runCodemode(tool, `throw new Error("script-boom");`);
    expect(result.isError).toBe(true);
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts.some((t) => t?.includes("脚本失败") === true)).toBe(true);
    expect(texts.some((t) => t?.includes("script-boom") === true)).toBe(true);
  });

  test("text()/console.log 输出条目按序回填 content", async () => {
    const tool = createCodemodeTool({ getTools: () => [echoTool] });
    const result = await runCodemode(
      tool,
      `text("first"); console.log("second"); return "third";`,
    );
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts).toEqual(["first", "second", "third"]);
  });

  test("超时 → sandbox 终止 worker，isError 且非挂死", async () => {
    const tool = createCodemodeTool({ getTools: () => [echoTool], timeoutMs: 150 });
    const result = await runCodemode(tool, `while (true) {}`);
    expect(result.isError).toBe(true);
    const texts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts.some((t) => t?.includes("脚本失败") === true)).toBe(true);
  });

  test("工具名 = CODEMODE_TOOL_NAME（排除集自引用一致）", () => {
    const tool = createCodemodeTool({ getTools: () => [] });
    expect(tool.name).toBe(CODEMODE_TOOL_NAME);
    expect(CODEMODE_TOOL_NAME).toBe("codemode");
  });
});

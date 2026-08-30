import { describe, expect, test } from "bun:test";
import type {
  CodegraphEnginePort,
  CodegraphQueryRequest,
} from "../../src/application/ports/outbound/CodegraphEnginePort";
import { createCodegraphTool } from "../../src/adapters/driven/tools/codegraph/CodegraphTool";

/**
 * W1-B（R5/R6）codegraph 只读 agent 工具单测——薄壳语义：
 *
 * - 六 op（status/search/node/callers/callees/impact，**无 explore**），
 *   未知 op / 缺参数 → 结构化报错（非空结果）；
 * - projectPath 解析：工作区一级子目录名 → join(workspaceRoot, name)；
 *   绝对路径 → 原样；相对路径含分隔符/.. → 拒绝（防逃逸工作区）；
 * - 索引缺失短路（同 KgProjectService absent 先例）：.codegraph 不在 →
 *   返回「请先构建索引」提示，**绝不触引擎**（读面零建索引）；
 * - op → CodegraphQueryRequest 映射（引擎调用记录断言）。
 */

/** 记录型引擎 stub（只实现 runQuery 读面）。 */
function stubEngine(result = "{\"ok\":true}") {
  const calls: { readonly projectRoot: string; readonly request: CodegraphQueryRequest }[] = [];
  const engine: Pick<CodegraphEnginePort, "runQuery"> = {
    runQuery: async (projectRoot, request) => {
      calls.push({ projectRoot, request });
      return result;
    },
  };
  return { engine, calls };
}

const WS = "/ws";

function makeTool(opts: { indexExists?: (root: string) => boolean; result?: string } = {}) {
  const { engine, calls } = stubEngine(opts.result);
  const tool = createCodegraphTool({
    engine,
    workspaceRoot: WS,
    indexExists: opts.indexExists ?? (() => true), // 缺省视为索引已建（免触盘）
  });
  return { tool, calls };
}

async function run(tool: ReturnType<typeof createCodegraphTool>, params: Record<string, unknown>): Promise<string> {
  const r = await tool.execute("call-1", params as never, undefined, undefined, undefined as never);
  return r.content.map((b) => (b as { type: string; text?: string }).text ?? "").join("\n");
}

describe("codegraph 工具：op 与参数校验（R6 六 op 面）", () => {
  test("注册名 codegraph；description 引导 impact 查影响面 / search/node 探索结构", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("codegraph");
    expect(tool.description).toContain("impact");
    expect(tool.description).toContain("search");
  });

  test("未知 op → 报错列出六合法 op（explore 不在其列）", async () => {
    const { tool } = makeTool();
    await expect(run(tool, { op: "explore", projectPath: "p" })).rejects.toThrow(/status.*search.*node.*callers.*callees.*impact/s);
  });

  test("缺 projectPath → 报错", async () => {
    const { tool } = makeTool();
    await expect(run(tool, { op: "status" })).rejects.toThrow(/projectPath/);
  });

  test("search 缺 pattern → 报错；callers/callees/impact 缺 symbol → 报错；node 缺 symbol+file → 报错", async () => {
    const { tool } = makeTool();
    await expect(run(tool, { op: "search", projectPath: "p" })).rejects.toThrow(/pattern/);
    await expect(run(tool, { op: "callers", projectPath: "p" })).rejects.toThrow(/symbol/);
    await expect(run(tool, { op: "callees", projectPath: "p" })).rejects.toThrow(/symbol/);
    await expect(run(tool, { op: "impact", projectPath: "p" })).rejects.toThrow(/symbol/);
    await expect(run(tool, { op: "node", projectPath: "p" })).rejects.toThrow(/symbol|file/);
  });
});

describe("codegraph 工具：projectPath 解析", () => {
  test("一级子目录名 → join(workspaceRoot, name)", async () => {
    const { tool, calls } = makeTool();
    await run(tool, { op: "status", projectPath: "helix" });
    expect(calls[0]!.projectRoot).toBe("/ws/helix");
  });

  test("绝对路径 → 原样使用", async () => {
    const { tool, calls } = makeTool();
    await run(tool, { op: "status", projectPath: "/elsewhere/proj" });
    expect(calls[0]!.projectRoot).toBe("/elsewhere/proj");
  });

  test("相对路径含分隔符或 .. → 拒绝（防逃逸工作区一级）", async () => {
    const { tool } = makeTool();
    await expect(run(tool, { op: "status", projectPath: "a/b" })).rejects.toThrow(/projectPath/);
    await expect(run(tool, { op: "status", projectPath: "../x" })).rejects.toThrow(/projectPath/);
  });
});

describe("codegraph 工具：索引缺失短路（absent 先例——读面绝不触发建索引）", () => {
  test("indexExists=false → 返回「请先构建索引」提示，六 op 均不触引擎", async () => {
    for (const op of ["status", "search", "node", "callers", "callees", "impact"]) {
      const { tool, calls } = makeTool({ indexExists: () => false });
      const params: Record<string, unknown> = { op, projectPath: "p", pattern: "x", symbol: "y" };
      const out = await run(tool, params);
      expect(out).toContain("请先构建索引");
      expect(calls).toHaveLength(0);
    }
  });

  test("indexExists 缺省 = 实查 .codegraph 目录（不存在 → 短路提示）", async () => {
    const { engine, calls } = stubEngine();
    const tool = createCodegraphTool({ engine, workspaceRoot: "/nonexistent-ws-root-42" });
    const out = await run(tool, { op: "status", projectPath: "proj" });
    expect(out).toContain("请先构建索引");
    expect(calls).toHaveLength(0);
  });
});

describe("codegraph 工具：op → 查询请求映射", () => {
  test("status → { op: status }；返回引擎输出", async () => {
    const { tool, calls } = makeTool({ result: "{\"initialized\":true}" });
    const out = await run(tool, { op: "status", projectPath: "p" });
    expect(calls[0]!.request).toEqual({ op: "status" });
    expect(out).toContain("initialized");
  });

  test("search → pattern/kind/limit 透传", async () => {
    const { tool, calls } = makeTool();
    await run(tool, { op: "search", projectPath: "p", pattern: "Foo", kind: "class", limit: 5 });
    expect(calls[0]!.request).toEqual({ op: "search", pattern: "Foo", kind: "class", limit: 5 });
  });

  test("node → symbol 模式 / file 模式（offset/limit/symbolsOnly 透传）", async () => {
    const { tool, calls } = makeTool();
    await run(tool, { op: "node", projectPath: "p", symbol: "Bar" });
    expect(calls[0]!.request).toEqual({ op: "node", symbol: "Bar" });
    await run(tool, { op: "node", projectPath: "p", file: "src/a.ts", offset: 10, limit: 50, symbolsOnly: true });
    expect(calls[1]!.request).toEqual({ op: "node", file: "src/a.ts", offset: 10, limit: 50, symbolsOnly: true });
  });

  test("callers/callees/impact → symbol + limit/depth 透传", async () => {
    const { tool, calls } = makeTool();
    await run(tool, { op: "callers", projectPath: "p", symbol: "f", limit: 30 });
    expect(calls[0]!.request).toEqual({ op: "callers", symbol: "f", limit: 30 });
    await run(tool, { op: "callees", projectPath: "p", symbol: "f" });
    expect(calls[1]!.request).toEqual({ op: "callees", symbol: "f" });
    await run(tool, { op: "impact", projectPath: "p", symbol: "f", depth: 3 });
    expect(calls[2]!.request).toEqual({ op: "impact", symbol: "f", depth: 3 });
  });

  test("缺省 indexExists 实查命中（tmp 目录造 .codegraph）→ 正常调引擎", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "codegraph-tool-"));
    try {
      mkdirSync(path.join(dir, "proj", ".codegraph"), { recursive: true });
      const { engine, calls } = stubEngine();
      const tool = createCodegraphTool({ engine, workspaceRoot: dir });
      await run(tool, { op: "status", projectPath: "proj" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.projectRoot).toBe(path.join(dir, "proj"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

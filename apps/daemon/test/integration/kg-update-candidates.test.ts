import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { createKgUpdateTool } from "../../src/adapters/driven/tools/kg-update/KgUpdateTool";

/**
 * I 层（真 SQLite tmp 库）：kg-update 工具面扩展（W1-C，R2/R23）——
 * ① scene 参数（createNode/batchCreateNodes 必带，replacement 可选）；
 * ② proposeCandidate / decideCandidate 候选 op（仅 MainAgent 可用——
 *    description 纪律；source_task_id 批次上下文机械注入沿用 AD-10）；
 * ③ decide defer 软上限警告透传到工具回执。
 */

interface Stack {
  readonly root: string;
  readonly proj: string;
  readonly database: KgDatabase;
  readonly write: KgWriteService;
  readonly query: KgQueryService;
}

const disposers: Array<() => void> = [];

afterAll(() => {
  for (const dispose of disposers) dispose();
  disposers.length = 0;
});

function freshStack(): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-cand-"));
  const proj = path.join(root, "proj");
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const query = new KgQueryService({ graph, projects: () => [proj] });
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, proj, database, write, query };
}

function makeTool(stack: Stack, taskContext?: () => { taskId: string; originBatchId: string } | undefined) {
  return createKgUpdateTool({
    query: stack.query,
    write: stack.write,
    workspaceRoot: stack.root,
    scanProjects: () => [stack.proj],
    ...(taskContext !== undefined ? { taskContext } : {}),
  });
}

async function call(tool: ReturnType<typeof makeTool>, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("call-1", params as never, undefined, undefined, undefined as never);
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function probe<T>(root: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const ITER = "iter-20260830-w1c";

describe("① scene 参数（R23 沉淀必填的工具面兑现）", () => {
  test("createNode 缺 scene → 工具层结构化报错（缺必填参数）", async () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "createNode", iterationId: ITER, kind: "rule", name: "n", digest: "d", project: "proj" }),
    ).rejects.toThrow("scene");
  });

  test("createNode 带 scene → 落库可读回；batchCreateNodes 逐项带 scene → 批量落库", async () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    const single = await call(tool, {
      op: "createNode",
      iterationId: ITER,
      kind: "rule",
      name: "单条",
      digest: "d",
      scene: "改动 X 前",
      project: "proj",
    });
    expect(single).toContain("已建节点 TR-1");
    expect(probe<{ scene: string }>(stack.proj, "SELECT scene FROM nodes WHERE id = 'TR-1'")[0]!.scene).toBe("改动 X 前");

    const batch = await call(tool, {
      op: "batchCreateNodes",
      iterationId: ITER,
      project: "proj",
      nodes: [
        { kind: "rule", name: "批一", digest: "d", scene: "场景一" },
        { kind: "entity", name: "批二", digest: "d", scene: "场景二" },
      ],
    });
    expect(batch).toContain("已批量建节点 2 个");
    const scenes = probe<{ id: string; scene: string }>(stack.proj, "SELECT id, scene FROM nodes WHERE id IN ('TR-2','E-1') ORDER BY id");
    expect(scenes).toEqual([
      { id: "E-1", scene: "场景二" },
      { id: "TR-2", scene: "场景一" },
    ]);
  });

  test("batchCreateNodes 任一项缺 scene → 工具层报错（整批不落）", async () => {
    const stack = freshStack();
    stack.database.knowledgeConnection(stack.proj); // 工具层拒绝场景库未建——先建库供 probe
    const tool = makeTool(stack);
    await expect(
      call(tool, {
        op: "batchCreateNodes",
        iterationId: ITER,
        project: "proj",
        nodes: [
          { kind: "rule", name: "有", digest: "d", scene: "s" },
          { kind: "rule", name: "无", digest: "d" },
        ],
      }),
    ).rejects.toThrow("scene");
    expect(probe(stack.proj, "SELECT id FROM nodes")).toHaveLength(0);
  });
});

describe("② 候选 op（R2：proposeCandidate / decideCandidate）", () => {
  test("proposeCandidate → CAND-1 pending；批次上下文 source_task_id 机械注入；decideCandidate applied 全字段", async () => {
    const stack = freshStack();
    const tool = makeTool(stack, () => ({ taskId: "job-9", originBatchId: "batch-9" }));
    const proposed = await call(tool, {
      op: "proposeCandidate",
      iterationId: ITER,
      candidateKind: "sediment",
      title: "闭环发现的沉淀",
      body: "建议内容",
    });
    expect(proposed).toContain("CAND-1");
    const row = probe<{ status: string; source_task_id: string | null; source_iteration_id: string | null }>(
      stack.proj,
      "SELECT status, source_task_id, source_iteration_id FROM candidates WHERE id = 'CAND-1'",
    )[0]!;
    expect(row).toEqual({ status: "pending", source_task_id: "job-9", source_iteration_id: ITER });

    const decided = await call(tool, {
      op: "decideCandidate",
      iterationId: ITER,
      candidateId: "CAND-1",
      decision: "applied",
      reason: "人审采纳",
      formalId: "TR-1",
      appliedNodeId: "TR-1",
    });
    expect(decided).toContain("applied");
    expect(probe(stack.proj, "SELECT status, formal_id, applied_node_id FROM candidates WHERE id = 'CAND-1'")[0]).toEqual({
      status: "applied",
      formal_id: "TR-1",
      applied_node_id: "TR-1",
    });
    // 审计：两行 change_log
    expect(
      probe<{ op: string }>(stack.proj, "SELECT op FROM change_log ORDER BY seq").map((r) => r.op),
    ).toEqual(["proposeCandidate", "decideCandidate"]);
  });

  test("非任务上下文 proposeCandidate：source_task_id NULL（零注入语义保持）；decision 非法 → 报错", async () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    await call(tool, { op: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "t" });
    expect(probe(stack.proj, "SELECT source_task_id FROM candidates WHERE id = 'CAND-1'")[0]).toEqual({
      source_task_id: null,
    });
    await expect(
      call(tool, { op: "decideCandidate", iterationId: ITER, candidateId: "CAND-1", decision: "maybe" }),
    ).rejects.toThrow("decision");
  });

  test("工具 description 不写「仅 MainAgent 可用」（W-R6：收权后注册面管控，描述不做角色枚举）", () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    expect(tool.description).toContain("proposeCandidate");
    expect(tool.description).toContain("decideCandidate");
    // findings 通道纪律面保留（SubAgent 闭环发现经 findings 落候选）
    expect(tool.description).toContain("findings");
    expect(tool.description).not.toContain("仅 MainAgent 可用");
  });
});

describe("③ defer 软上限警告透传（只警告不拒绝）", () => {
  test("第二次 defer → 回执含 defer_age 警告；仍落库", async () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    await call(tool, { op: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "t" });
    const first = await call(tool, { op: "decideCandidate", iterationId: ITER, candidateId: "CAND-1", decision: "deferred" });
    expect(first).not.toContain("警告");
    const second = await call(tool, { op: "decideCandidate", iterationId: ITER, candidateId: "CAND-1", decision: "deferred" });
    expect(second).toContain("警告");
    expect(second).toContain("defer_age");
    expect(probe(stack.proj, "SELECT status, defer_age FROM candidates WHERE id = 'CAND-1'")[0]).toEqual({
      status: "deferred",
      defer_age: 2,
    });
  });
});

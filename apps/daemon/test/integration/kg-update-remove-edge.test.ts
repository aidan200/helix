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
import type { KnowledgeWriteOp } from "../../src/domain/kg/types";

/**
 * I 层（真 SQLite tmp 库）：kg-update 工具面 removeEdge op——
 * 悬挂边/误连边清理通道（补边工程实证的缺口：端点 superseded 后边无删法，
 * 只能留档；TR-68→E-116 悬挂边是首个动机案例）。
 *
 * 覆盖：
 * ① removeEdge 全链：建边 → 删边 → edges 零行 + change_log 记 removeEdge 行
 *    （node_id=src）+ getNode 关系区回空；
 * ② 校验拒绝：srcId/dstId/verb 缺 / verb 越界 KG_E_VERB / 边不存在
 *    KG_E_ID（verb 记错零行命中）/ 端点不存在 / 跨项目两端；
 * ③ 非幂等对照：删除后重删 → KG_E_ID（与 addEdge OR IGNORE 幂等刻意
 *    不对称——零行删除说明调用方图模型有误，报错暴露而非静默成功）；
 * ④ 悬挂边场景（核心动机）：dst 已 superseded 的边仍可删——删除不筛
 *    端点 status（悬挂边清理的动机即在 superseded 端点）；
 * ⑤ 工具词表同步（op enum 含 removeEdge + description 提及）。
 */

interface Stack {
  readonly root: string;
  readonly projA: string;
  readonly projB: string;
  readonly database: KgDatabase;
  readonly write: KgWriteService;
  readonly query: KgQueryService;
  readonly graph: SqliteKnowledgeGraph;
}

const stacks: Stack[] = [];

afterAll(() => {
  for (const s of stacks) {
    s.database.closeAll();
    rmSync(s.root, { recursive: true, force: true });
  }
  stacks.length = 0;
});

function freshStack(): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-remove-edge-"));
  const projA = path.join(root, "projA");
  const projB = path.join(root, "projB");
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const query = new KgQueryService({ graph, projects: () => [projA, projB] });
  const stack: Stack = { root, projA, projB, database, write, query, graph };
  stacks.push(stack);
  return stack;
}

function makeTool(stack: Stack) {
  return createKgUpdateTool({
    query: stack.query,
    write: stack.write,
    workspaceRoot: stack.root,
    scanProjects: () => [stack.projA, stack.projB],
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

const ITER = "iter-20260910-remove-edge";

/** 种子：指定项目建 confirmed 节点（显式保号 id——跨项目定位测试需要确定 id）。 */
function seedNode(stack: Stack, proj: string, id: string, name: string): string {
  const r = stack.write.write(proj, {
    kind: "createNode",
    iterationId: ITER,
    id,
    draft: { kind: "rule", name, digest: `${name}摘要`, scene: "本规则适用于：测试种子", status: "confirmed" },
  } as KnowledgeWriteOp);
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
  if (r.nodeId === undefined) throw new Error("ok 结果缺 nodeId（意外形态）");
  return r.nodeId;
}

describe("① removeEdge 全链（删边 + 读面回空 + 审计）", () => {
  test("建边 → removeEdge → edges 零行 + change_log 记 removeEdge(node_id=src) + getNode 关系区回空", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    stack.database.knowledgeConnection(stack.projA); // probe 前建库（幂等）
    const tool = makeTool(stack);
    await call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });

    const out = await call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });

    expect(out).toContain("TR-201");
    expect(out).toContain("governs");
    expect(out).toContain("TR-202");
    expect(probe<{ n: number }>(stack.projA, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 0 }]);
    expect(
      probe<{ op: string; node_id: string }>(stack.projA, "SELECT op, node_id FROM change_log WHERE op = 'removeEdge'"),
    ).toEqual([{ op: "removeEdge", node_id: "TR-201" }]);
    expect(stack.graph.getNode(stack.projA, "TR-201")?.edges).toEqual([]);
    expect(stack.graph.getNode(stack.projA, "TR-202")?.edges).toEqual([]);
  });
});

describe("② 校验拒绝（薄壳 + 服务层/store，零副作用）", () => {
  test("srcId / dstId / verb 缺省 → 薄壳直拒（必填）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    const tool = makeTool(stack);
    await expect(call(tool, { op: "removeEdge", iterationId: ITER, verb: "governs", dstId: "TR-202" })).rejects.toThrow("srcId");
    await expect(call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", dstId: "TR-202" })).rejects.toThrow("verb");
    await expect(call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "governs" })).rejects.toThrow("dstId");
  });

  test("verb 越界封闭词表 → 服务层 KG_E_VERB 透传", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "loves", dstId: "TR-202" }),
    ).rejects.toThrow("KG_E_VERB");
  });

  test("边不存在（verb 记错零行命中）→ KG_E_ID（严格三元组）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    stack.database.knowledgeConnection(stack.projA);
    const tool = makeTool(stack);
    await call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });

    // verb 记错：库里的边是 governs，删 references → 零行命中报错而非静默成功
    await expect(
      call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "references", dstId: "TR-202" }),
    ).rejects.toThrow("KG_E_ID");
    // 原边不受影响
    expect(probe<{ n: number }>(stack.projA, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 1 }]);
  });

  test("端点不存在 → 结构化报错（不猜目标）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-404" }),
    ).rejects.toThrow("TR-404");
  });

  test("两端不在同一项目 → 结构化报错（跨项目无边可删）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projB, "TR-202", "终点规则");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" }),
    ).rejects.toThrow("同一项目");
  });
});

describe("③ 非幂等对照（与 addEdge OR IGNORE 刻意不对称）", () => {
  test("删除成功后重删同三元组 → KG_E_ID 报错（静默成功会掩盖调用方图模型错误）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    stack.database.knowledgeConnection(stack.projA);
    const tool = makeTool(stack);
    await call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });
    await call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });

    await expect(
      call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" }),
    ).rejects.toThrow("KG_E_ID");
    // change_log 恰一条 removeEdge（重删未落第二行审计）
    expect(probe<{ n: number }>(stack.projA, "SELECT COUNT(*) AS n FROM change_log WHERE op = 'removeEdge'")).toEqual([{ n: 1 }]);
  });
});

describe("④ 悬挂边场景（核心动机：superseded 端点可删）", () => {
  test("dst 已 superseded 的边仍可删——删除不筛端点 status", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "旧承载规则");
    stack.database.knowledgeConnection(stack.projA);
    const tool = makeTool(stack);
    await call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "references", dstId: "TR-202" });
    // dst 翻 superseded（悬挂边成型：端点终态但边仍在）
    const r = stack.write.write(stack.projA, {
      kind: "supersede",
      iterationId: ITER,
      nodeId: "TR-202",
      reason: "测试：端点退役成悬挂边",
    } as KnowledgeWriteOp);
    if (!r.ok) throw new Error(`supersede 失败：${r.error.code} ${r.error.message}`);

    const out = await call(tool, { op: "removeEdge", iterationId: ITER, srcId: "TR-201", verb: "references", dstId: "TR-202" });

    expect(out).toContain("已删边");
    expect(probe<{ n: number }>(stack.projA, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 0 }]);
  });
});

describe("⑤ 工具词表与 description 同步", () => {
  test("op enum 含 removeEdge；op description 与工具 description 提及 removeEdge", () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    const params = tool.parameters as {
      properties: { op: { enum: string[]; description: string } };
    };
    expect(params.properties.op.enum).toContain("removeEdge");
    expect(params.properties.op.description).toContain("removeEdge");
    expect(tool.description).toContain("removeEdge");
  });
});

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
 * I 层（真 SQLite tmp 库）：kg-update 工具面 addEdge op——
 * store/service 写面早已就绪（KnowledgeWriteOp 枚举 + applyAddEdge），
 * 工具面缺位（图谱边零 LLM 写入通道，全库 0 边实锤）。
 *
 * 覆盖：
 * ① addEdge 全链：两节点 → addEdge → edges 落行 + change_log 记 addEdge 行
 *    + kg get（getNode 聚合）关系行带对端 name（otherName LEFT JOIN）；
 * ② 校验拒绝（薄壳 + 服务层错误码透传）：srcId/dstId/verb 缺 / verb 越界
 *    KG_E_VERB / 端点不存在 / 端点多项目命中 / 跨项目建边；
 * ③ 幂等重声明：同边二次声明 → 复合主键去重不报错；
 * ④ 工具 op 词表与 description 同步（addEdge 入列 + verb 枚举 = EDGE_VERBS）。
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-add-edge-"));
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

const ITER = "iter-20260905-edge";

/** 种子：指定项目建 confirmed 节点（显式保号 id——跨项目定位测试需要确定 id）。 */
function seedNode(stack: Stack, proj: string, id: string, name: string): string {
  const r = stack.write.write(proj, {
    kind: "createNode",
    iterationId: ITER,
    id,
    draft: { kind: "rule", name, digest: `${name}摘要`, scene: "本规则适用于：测试种子", status: "confirmed" },
  } as KnowledgeWriteOp);
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
  return r.nodeId;
}

describe("① addEdge 全链（建边 + 读面聚合）", () => {
  test("两节点 → addEdge → edges 落行 + change_log 记 addEdge + getNode 关系带对端 name", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    stack.database.knowledgeConnection(stack.projA); // probe 前建库（幂等）
    const tool = makeTool(stack);

    const out = await call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });

    expect(out).toContain("TR-201");
    expect(out).toContain("governs");
    expect(out).toContain("TR-202");
    expect(out).toContain("projA");
    // edges 落行（src+verb+dst 复合主键）
    expect(
      probe<{ src_id: string; verb: string; dst_id: string }>(
        stack.projA,
        "SELECT src_id, verb, dst_id FROM edges",
      ),
    ).toEqual([{ src_id: "TR-201", verb: "governs", dst_id: "TR-202" }]);
    // change_log 记 addEdge 行（审计链）
    expect(
      probe<{ op: string; node_id: string }>(stack.projA, "SELECT op, node_id FROM change_log WHERE op = 'addEdge'"),
    ).toEqual([{ op: "addEdge", node_id: "TR-201" }]);
    // getNode 聚合：出边/入边双向可见且带对端 name（一级跳转内语义闭环）
    const srcDetail = stack.graph.getNode(stack.projA, "TR-201");
    expect(srcDetail?.edges).toEqual([{ verb: "governs", otherId: "TR-202", otherName: "终点规则", direction: "out" }]);
    const dstDetail = stack.graph.getNode(stack.projA, "TR-202");
    expect(dstDetail?.edges).toEqual([{ verb: "governs", otherId: "TR-201", otherName: "起点规则", direction: "in" }]);
  });
});

describe("② 校验拒绝（薄壳 + 服务层，零落库）", () => {
  test("srcId / dstId / verb 缺省 → 薄壳直拒（必填）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    const tool = makeTool(stack);
    await expect(call(tool, { op: "addEdge", iterationId: ITER, verb: "governs", dstId: "TR-202" })).rejects.toThrow("srcId");
    await expect(call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", dstId: "TR-202" })).rejects.toThrow("verb");
    await expect(call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs" })).rejects.toThrow("dstId");
  });

  test("verb 越界封闭词表 → 服务层 KG_E_VERB 透传", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "loves", dstId: "TR-202" }),
    ).rejects.toThrow("KG_E_VERB");
  });

  test("端点不存在 → 结构化报错（不猜目标）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-404" }),
    ).rejects.toThrow("TR-404");
  });

  test("端点跨项目多命中 → 结构化报错（不猜跨项目）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-299", "双栖规则");
    seedNode(stack, stack.projB, "TR-299", "双栖规则");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-299" }),
    ).rejects.toThrow("多个项目命中");
  });

  test("两端不在同一项目 → 结构化报错（edges 是 per-project 库内行）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projB, "TR-202", "终点规则");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" }),
    ).rejects.toThrow("同一项目");
  });
});

describe("③ 幂等重声明（复合主键去重）", () => {
  test("同边二次声明不报错、行数不翻倍", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    seedNode(stack, stack.projA, "TR-202", "终点规则");
    stack.database.knowledgeConnection(stack.projA);
    const tool = makeTool(stack);

    await call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });
    await call(tool, { op: "addEdge", iterationId: ITER, srcId: "TR-201", verb: "governs", dstId: "TR-202" });

    expect(probe<{ n: number }>(stack.projA, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 1 }]);
  });
});

describe("④ 工具词表与 description 同步", () => {
  test("op enum 含 addEdge；verb 枚举 = EDGE_VERBS 封闭词表；description 提及 addEdge", () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    const params = tool.parameters as {
      properties: { op: { enum: string[]; description: string }; verb: { enum: string[] } };
    };
    expect(params.properties.op.enum).toContain("addEdge");
    expect(params.properties.op.description).toContain("addEdge");
    expect(params.properties.verb.enum).toEqual([
      "supersedes",
      "changed",
      "dependsOn",
      "partOf",
      "governs",
      "affects",
      "references",
    ]);
    expect(tool.description).toContain("addEdge");
  });
});

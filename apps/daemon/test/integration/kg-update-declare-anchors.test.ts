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
 * I 层（真 SQLite tmp 库）：kg-update 工具面 declareAnchors op——
 * 写面早已支持（KnowledgeWriteOp 枚举 + execCreateNode 组合锚第二笔
 * 内部在用），工具面缺位（存量节点补锚无通道：TR-40 类「人审重写时
 * 可一并补锚声明」落地受阻实锤）。
 *
 * 覆盖：
 * ① declareAnchors 全链：无锚节点 → declareAnchors([symbol/path 锚]) →
 *    anchor_decl 落行 + change_log 记 declareAnchors 行；
 * ② 校验拒绝（薄壳 + 服务层错误码透传）：anchors 缺 / 空数组 /
 *    scopeKind 越界 / nodeId 不存在；
 * ③ 幂等重声明：同锚二次声明 → 复合主键去重不报错（anchor_decl 幂等）；
 * ④ 工具 op 词表与 description 同步（declareAnchors 入列）。
 */

interface Stack {
  readonly root: string;
  readonly proj: string;
  readonly database: KgDatabase;
  readonly write: KgWriteService;
  readonly query: KgQueryService;
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-decl-anchors-"));
  const proj = path.join(root, "proj");
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const query = new KgQueryService({ graph, projects: () => [proj] });
  const stack: Stack = { root, proj, database, write, query };
  stacks.push(stack);
  return stack;
}

function makeTool(stack: Stack) {
  return createKgUpdateTool({
    query: stack.query,
    write: stack.write,
    workspaceRoot: stack.root,
    scanProjects: () => [stack.proj],
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

const ITER = "iter-20260902-decl";

/** 种子：无锚 confirmed 节点（存量补锚的标准场景——TR-40 类节点形态）。 */
function seedAnchorlessNode(stack: Stack): string {
  const r = stack.write.write(stack.proj, {
    kind: "createNode",
    iterationId: ITER,
    id: "TR-101",
    draft: {
      kind: "rule",
      name: "存量无锚规则",
      digest: "既有摘要（锚声明缺失）",
      scene: "本规则适用于：测试种子",
      status: "confirmed",
    },
  } as KnowledgeWriteOp);
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
  return r.nodeId;
}

describe("① declareAnchors 全链（存量节点补锚）", () => {
  test("无锚节点 → declareAnchors([symbol, path]) → anchor_decl 落行 + change_log 记 declareAnchors 行", async () => {
    const stack = freshStack();
    seedAnchorlessNode(stack);
    stack.database.knowledgeConnection(stack.proj); // probe 前建库（幂等）
    const tool = makeTool(stack);

    const out = await call(tool, {
      op: "declareAnchors",
      iterationId: ITER,
      nodeId: "TR-101",
      anchors: [
        { scopeKind: "symbol", pattern: "src/foo.ts#bar" },
        { scopeKind: "path", pattern: "src/foo.ts" },
      ],
    });

    expect(out).toContain("TR-101");
    expect(out).toContain("2");
    // anchor_decl 落行（scope_kind + pattern 逐行）
    expect(
      probe<{ scope_kind: string; pattern: string }>(
        stack.proj,
        "SELECT scope_kind, pattern FROM anchor_decl WHERE node_id = 'TR-101' ORDER BY scope_kind",
      ),
    ).toEqual([
      { scope_kind: "path", pattern: "src/foo.ts" },
      { scope_kind: "symbol", pattern: "src/foo.ts#bar" },
    ]);
    // change_log 记 declareAnchors 行
    expect(
      probe<{ op: string; node_id: string }>(stack.proj, "SELECT op, node_id FROM change_log WHERE op = 'declareAnchors'"),
    ).toEqual([{ op: "declareAnchors", node_id: "TR-101" }]);
  });
});

describe("② 校验拒绝（薄壳 + 服务层，零落库）", () => {
  test("anchors 缺省 / 空数组 → 结构化报错（必填非空）", async () => {
    const stack = freshStack();
    seedAnchorlessNode(stack);
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "declareAnchors", iterationId: ITER, nodeId: "TR-101" }),
    ).rejects.toThrow("anchors");
    await expect(
      call(tool, { op: "declareAnchors", iterationId: ITER, nodeId: "TR-101", anchors: [] }),
    ).rejects.toThrow("anchors");
  });

  test("scopeKind 越界 → 薄壳直拒", async () => {
    const stack = freshStack();
    seedAnchorlessNode(stack);
    const tool = makeTool(stack);
    await expect(
      call(tool, {
        op: "declareAnchors",
        iterationId: ITER,
        nodeId: "TR-101",
        anchors: [{ scopeKind: "file", pattern: "src/foo.ts" }],
      }),
    ).rejects.toThrow("global / path / symbol");
  });

  test("nodeId 不存在 → 结构化报错（不猜目标）", async () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    await expect(
      call(tool, {
        op: "declareAnchors",
        iterationId: ITER,
        nodeId: "TR-404",
        anchors: [{ scopeKind: "path", pattern: "src/foo.ts" }],
      }),
    ).rejects.toThrow("TR-404");
  });
});

describe("③ 幂等重声明（复合主键去重）", () => {
  test("同锚二次声明不报错、行数不翻倍", async () => {
    const stack = freshStack();
    seedAnchorlessNode(stack);
    stack.database.knowledgeConnection(stack.proj);
    const tool = makeTool(stack);
    const anchors = [{ scopeKind: "path", pattern: "src/foo.ts" }];

    await call(tool, { op: "declareAnchors", iterationId: ITER, nodeId: "TR-101", anchors });
    await call(tool, { op: "declareAnchors", iterationId: ITER, nodeId: "TR-101", anchors });

    expect(
      probe<{ n: number }>(stack.proj, "SELECT COUNT(*) AS n FROM anchor_decl WHERE node_id = 'TR-101'"),
    ).toEqual([{ n: 1 }]);
  });
});

describe("④ 工具词表与 description 同步", () => {
  test("op enum 含 declareAnchors；description 提及 declareAnchors", () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    const params = tool.parameters as { properties: { op: { enum: string[]; description: string } } };
    expect(params.properties.op.enum).toContain("declareAnchors");
    expect(params.properties.op.description).toContain("declareAnchors");
    expect(tool.description).toContain("declareAnchors");
  });
});

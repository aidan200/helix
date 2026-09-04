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
 * I 层（真 SQLite tmp 库）：kg-update prune op——腐烂物化锚（orphan=1
 * tombstone，CL-2.A7 失效通道的保留行）物理清理通道。
 * ① nodeId 定向 prune：只清该节点的 orphan 行，健康锚（orphan=0）不动，
 *    change_log 按节点落审计行；
 * ② 全项目 prune（不携带 nodeId）：清目标项目全部 orphan 行；
 * ③ 目标节点不存在 → KG_E_ID；零 orphan 行 → 幂等 ok（prunedCount=0）。
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-prune-"));
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

const ITER = "iter-20260903-prune";

/** 测试布景：建两节点 + 直接 SQL 插入物化锚行（孤儿/健康各若干——布景不走被测写面）。 */
function seedAnchors(stack: Stack): void {
  stack.write.write(stack.proj, {
    kind: "createNode",
    iterationId: ITER,
    draft: { kind: "rule", name: "甲", digest: "d", scene: "场景" },
  });
  stack.write.write(stack.proj, {
    kind: "createNode",
    iterationId: ITER,
    draft: { kind: "rule", name: "乙", digest: "d", scene: "场景" },
  });
  const db = stack.database.knowledgeConnection(stack.proj);
  const insert = db.prepare(
    "INSERT INTO materialized_anchors (node_id, anchor_kind, anchor_path, anchor_symbol, orphan) VALUES (?, ?, ?, ?, ?)",
  );
  // TR-1：两行 orphan tombstone + 一行健康锚
  insert.run("TR-1", "path", "src/dead-a.ts", "", 1);
  insert.run("TR-1", "path", "src/dead-b.ts", "", 1);
  insert.run("TR-1", "path", "src/alive.ts", "", 0);
  // TR-2：一行 orphan tombstone + 一行健康锚
  insert.run("TR-2", "path", "src/dead-c.ts", "", 1);
  insert.run("TR-2", "path", "src/alive2.ts", "", 0);
}

describe("① nodeId 定向 prune", () => {
  test("只清目标节点 orphan 行，健康锚与其他节点 tombstone 不动；change_log 落审计行", async () => {
    const stack = freshStack();
    seedAnchors(stack);
    const tool = makeTool(stack);

    const out = await call(tool, { op: "prune", iterationId: ITER, nodeId: "TR-1" });
    expect(out).toContain("2");

    const remaining = probe<{ node_id: string; orphan: number }>(
      stack.proj,
      "SELECT node_id, orphan FROM materialized_anchors ORDER BY node_id, orphan",
    );
    expect(remaining).toEqual([
      { node_id: "TR-1", orphan: 0 },
      { node_id: "TR-2", orphan: 0 },
      { node_id: "TR-2", orphan: 1 },
    ]);
    const log = probe<{ op: string; node_id: string }>(
      stack.proj,
      "SELECT op, node_id FROM change_log WHERE op = 'prune'",
    );
    expect(log).toEqual([{ op: "prune", node_id: "TR-1" }]);
  });

  test("目标节点不存在 → KG_E_ID 结构化报错", async () => {
    const stack = freshStack();
    seedAnchors(stack);
    const tool = makeTool(stack);
    await expect(call(tool, { op: "prune", iterationId: ITER, nodeId: "TR-99" })).rejects.toThrow("TR-99");
    // 零副作用
    expect(
      probe<{ n: number }>(stack.proj, "SELECT COUNT(*) AS n FROM materialized_anchors WHERE orphan = 1")[0]!.n,
    ).toBe(3);
  });
});

describe("② 全项目 prune（不携带 nodeId）", () => {
  test("清目标项目全部 orphan 行，健康锚不动；每受影响节点落一行 change_log", async () => {
    const stack = freshStack();
    seedAnchors(stack);
    const tool = makeTool(stack);

    const out = await call(tool, { op: "prune", iterationId: ITER, project: "proj" });
    expect(out).toContain("3");

    expect(
      probe<{ n: number }>(stack.proj, "SELECT COUNT(*) AS n FROM materialized_anchors WHERE orphan = 1")[0]!.n,
    ).toBe(0);
    expect(
      probe<{ n: number }>(stack.proj, "SELECT COUNT(*) AS n FROM materialized_anchors WHERE orphan = 0")[0]!.n,
    ).toBe(2);
    const log = probe<{ node_id: string }>(
      stack.proj,
      "SELECT node_id FROM change_log WHERE op = 'prune' ORDER BY node_id",
    );
    expect(log).toEqual([{ node_id: "TR-1" }, { node_id: "TR-2" }]);
  });
});

describe("③ 幂等（零 orphan 行）", () => {
  test("无 tombstone 时 prune → ok 且 prunedCount=0，不落 change_log", async () => {
    const stack = freshStack();
    seedAnchors(stack);
    const tool = makeTool(stack);
    await call(tool, { op: "prune", iterationId: ITER, project: "proj" }); // 先清一轮
    const out = await call(tool, { op: "prune", iterationId: ITER, project: "proj" });
    expect(out).toContain("0");
    expect(
      probe<{ n: number }>(stack.proj, "SELECT COUNT(*) AS n FROM change_log WHERE op = 'prune'")[0]!.n,
    ).toBe(2); // 仅第一轮两行
  });
});

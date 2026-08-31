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
 * I 层（真 SQLite tmp 库）：kg-update 工具面 updateNode op（D8 遗留①——
 * 服务层写面早有：KgWriteService op 枚举 + ws kg.node.update /project 页
 * 在用，agent 工具面缺位，kg-review SKILL「scene 缺失 → updateNode 直补」
 * 一调即报未知 op）。
 *
 * 覆盖：
 * ① scene 补全全链：老节点（scene=''、confirmed）→ updateNode({scene}) →
 *    nodes.scene 更新 + status 保持 confirmed + change_log 记 updateNode 行
 *    （元数据补全不是内容推翻，R23）；
 * ② 校验拒绝（服务层错误码透传）：patch 空 / scene 空白 / patch 未知字段 /
 *    nodeId 不存在；
 * ③ 工具 op 词表与 description 同步（updateNode 入列 + 「仅限 scene 等元数据
 *    补全；内容改动走候选人审」纪律句）。
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-updnode-"));
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

const ITER = "iter-20260905-d8a";
const SCENE = "本规则适用于：改动 kg 写通道前";

/**
 * 存量老节点种子：显式保号通道（迁移豁免 scene 必填）落 scene='' 的
 * confirmed 节点——kg-review 体检对象的标准形态。
 */
function seedScenelessConfirmedNode(stack: Stack): string {
  const r = stack.write.write(stack.proj, {
    kind: "createNode",
    iterationId: ITER,
    id: "TR-101",
    draft: { kind: "rule", name: "存量无场景规则", digest: "既有摘要（scene 未回填）", status: "confirmed" },
  } as KnowledgeWriteOp);
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
  return r.nodeId;
}

describe("① updateNode 补 scene 全链（R23 元数据补全，不是内容推翻）", () => {
  test("老节点（scene=''、confirmed）→ updateNode({scene}) → scene 更新 + status 保持 confirmed + change_log 记 updateNode 行", async () => {
    const stack = freshStack();
    const nodeId = seedScenelessConfirmedNode(stack);
    expect(nodeId).toBe("TR-101");
    stack.database.knowledgeConnection(stack.proj); // probe 前建库（种子已建，幂等）

    const tool = makeTool(stack);
    const out = await call(tool, { op: "updateNode", iterationId: ITER, nodeId: "TR-101", patch: { scene: SCENE } });

    expect(out).toContain("TR-101");
    // 落库终态：scene 补全、status 保持 confirmed（元数据补全不动状态机）
    expect(probe<{ scene: string; status: string }>(stack.proj, "SELECT scene, status FROM nodes WHERE id = 'TR-101'")).toEqual([
      { scene: SCENE, status: "confirmed" },
    ]);
    // change_log 记 updateNode 行（op + 节点归属）
    expect(probe<{ op: string; node_id: string }>(stack.proj, "SELECT op, node_id FROM change_log WHERE op = 'updateNode'")).toEqual([
      { op: "updateNode", node_id: "TR-101" },
    ]);
  });
});

describe("② 校验拒绝（服务层错误码透传，零落库）", () => {
  test("patch 空 → KG_E_SCHEMA（patch 至少含一个可更新字段）", async () => {
    const stack = freshStack();
    seedScenelessConfirmedNode(stack);
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "updateNode", iterationId: ITER, nodeId: "TR-101", patch: {} }),
    ).rejects.toThrow("KG_E_SCHEMA");
    await expect(
      call(tool, { op: "updateNode", iterationId: ITER, nodeId: "TR-101", patch: {} }),
    ).rejects.toThrow("patch");
  });

  test("patch.scene 空白串 → KG_E_SCHEMA（scene 非空字符串）", async () => {
    const stack = freshStack();
    seedScenelessConfirmedNode(stack);
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "updateNode", iterationId: ITER, nodeId: "TR-101", patch: { scene: "   " } }),
    ).rejects.toThrow("KG_E_SCHEMA");
    // 零落库：scene 保持 ''
    expect(probe<{ scene: string }>(stack.proj, "SELECT scene FROM nodes WHERE id = 'TR-101'")).toEqual([{ scene: "" }]);
  });

  test("patch 未知字段 → KG_E_SCHEMA（不支持字段拒绝）", async () => {
    const stack = freshStack();
    seedScenelessConfirmedNode(stack);
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "updateNode", iterationId: ITER, nodeId: "TR-101", patch: { kind: "entity" } as never }),
    ).rejects.toThrow("KG_E_SCHEMA");
  });

  test("nodeId 不存在 → 结构化报错（不猜目标）", async () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "updateNode", iterationId: ITER, nodeId: "TR-404", patch: { scene: SCENE } }),
    ).rejects.toThrow("TR-404");
  });
});

describe("③ 工具词表与 description 同步（D8 遗留①）", () => {
  test("op enum 含 updateNode；description 含 op 清单与「仅限 scene 等元数据补全」纪律句", () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    const params = tool.parameters as { properties: { op: { enum: string[]; description: string } } };
    expect(params.properties.op.enum).toContain("updateNode");
    expect(params.properties.op.description).toContain("updateNode");
    expect(tool.description).toContain("updateNode");
    // 纪律句（对齐 kg-review SKILL 产出纪律：内容改动走候选人审）
    expect(tool.description).toContain("仅限 scene 等元数据补全");
    expect(tool.description).toContain("内容改动走候选人审");
  });
});

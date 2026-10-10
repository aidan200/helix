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
import { createKgTool } from "../../src/adapters/driven/tools/kg/KgTool";
import type { KnowledgeWriteOp } from "../../src/domain/kg/types";
import { BACKGROUND_CONTEXT } from "../../src/adapters/driven/tools/vendor/pi-harness";

/**
 * I 层（真 SQLite tmp 库）：kg-update 定位类 op 的多项目撞号 project 消歧。
 *
 * 背景（CAND-710）：kg 节点 id 是 per-DB 独立发号（TR-n/E-n），多项目
 * workspace 下跨项目撞号是常态而非意外。locateUnique 的「不猜」语义
 * （多命中即拒）本身正确，但此前没有任何消歧通道——报错文案让「人工
 * 确认目标项目」却无参数可承载确认，定位类 op（addEdge/removeEdge/
 * supersede/updateNode/declareAnchors/定向 prune）在撞号场景结构性不可用。
 *
 * 修复语义：project 参数（既有参数位，此前仅 createNode 消费）成为定位
 * 类 op 的显式消歧通道——
 * - 不传 project：行为与历史逐字节一致（多命中仍报错，不猜）；
 * - 传 project：locate 命中按该项目过滤后唯一性校验（过滤后零命中
 *   = 该节点不在指定项目，结构化报错；project 名不在 workspace 报错）。
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-disambig-"));
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
  const result = await tool.execute("call-1", params as never, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
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

const ITER = "iter-20261010-disambig";

/** 种子：指定项目建 confirmed 节点（显式保号 id——撞号测试需要确定 id）。 */
function seedNode(stack: Stack, proj: string, id: string, name: string, kind: "rule" | "entity" = "rule"): string {
  const r = stack.write.write(proj, {
    kind: "createNode",
    iterationId: ITER,
    id,
    draft: { kind, name, digest: `${name}摘要`, scene: "本规则适用于：测试种子", status: "confirmed" },
  } as KnowledgeWriteOp);
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
  if (r.nodeId === undefined) throw new Error("ok 结果缺 nodeId（意外形态）");
  return r.nodeId;
}

/** 双栖种子：同一 id 在两项目各建一节点（撞号现场；kind 随 id 前缀）。 */
function seedDualHit(stack: Stack, id: string, nameA: string, nameB: string): void {
  const kind = id.startsWith("E-") ? "entity" as const : "rule" as const;
  seedNode(stack, stack.projA, id, nameA, kind);
  seedNode(stack, stack.projB, id, nameB, kind);
}

describe("① addEdge 撞号消歧", () => {
  test("双栖端点 + project 消歧 → 边落指定项目库", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    stack.database.knowledgeConnection(stack.projA);
    stack.database.knowledgeConnection(stack.projB);
    const tool = makeTool(stack);

    const out = await call(tool, {
      op: "addEdge",
      iterationId: ITER,
      srcId: "TR-299",
      verb: "governs",
      dstId: "TR-201",
      project: "projA",
    });

    expect(out).toContain("TR-299");
    expect(out).toContain("projA");
    // 边落 projA 库；projB 库零行（消歧写对库，不误写他库）
    expect(probe<{ n: number }>(stack.projA, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 1 }]);
    expect(probe<{ n: number }>(stack.projB, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 0 }]);
  });

  test("双栖端点消歧到对方项目 → 过滤后零命中报错（含命中项目清单）", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    seedNode(stack, stack.projA, "TR-201", "起点规则");
    const tool = makeTool(stack);
    // TR-201 只在 projA——把 src 消歧到 projB 后 dst 过滤零命中
    await expect(
      call(tool, {
        op: "addEdge",
        iterationId: ITER,
        srcId: "TR-299",
        verb: "governs",
        dstId: "TR-201",
        project: "projB",
      }),
    ).rejects.toThrow("projB 不存在");
  });

  test("project 名不在 workspace → 报错（消歧意图不静默忽略）", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    const tool = makeTool(stack);
    await expect(
      call(tool, {
        op: "addEdge",
        iterationId: ITER,
        srcId: "TR-299",
        verb: "governs",
        dstId: "TR-299",
        project: "no-such-proj",
      }),
    ).rejects.toThrow("不在 workspace");
  });
});

describe("② removeEdge 撞号消歧", () => {
  test("双栖端点 + project 消歧 → 删指定项目库的边", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    seedDualHit(stack, "TR-201", "起点A", "起点B");
    // 两库各预置一条同形边（绕过工具面直接种子——被测对象是 removeEdge 消歧）
    for (const proj of [stack.projA, stack.projB]) {
      const r = stack.write.write(proj, {
        kind: "addEdge",
        iterationId: ITER,
        srcId: "TR-299",
        verb: "governs",
        dstId: "TR-201",
      } as KnowledgeWriteOp);
      if (!r.ok) throw new Error(`种子边写失败：${r.error.message}`);
    }
    stack.database.knowledgeConnection(stack.projA);
    stack.database.knowledgeConnection(stack.projB);
    const tool = makeTool(stack);

    await call(tool, {
      op: "removeEdge",
      iterationId: ITER,
      srcId: "TR-299",
      verb: "governs",
      dstId: "TR-201",
      project: "projB",
    });

    // projB 的边删了，projA 的边保留（消歧删对库）
    expect(probe<{ n: number }>(stack.projA, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 1 }]);
    expect(probe<{ n: number }>(stack.projB, "SELECT COUNT(*) AS n FROM edges")).toEqual([{ n: 0 }]);
  });
});

describe("③ supersede 撞号消歧", () => {
  test("双栖节点 + project 消歧 → 仅目标项目翻转 status", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    stack.database.knowledgeConnection(stack.projA);
    stack.database.knowledgeConnection(stack.projB);
    const tool = makeTool(stack);

    await call(tool, {
      op: "supersede",
      iterationId: ITER,
      nodeId: "TR-299",
      reason: "撞号消歧测试：只翻 projA",
      project: "projA",
    });

    const status = (proj: string) =>
      probe<{ status: string }>(proj, "SELECT status FROM nodes WHERE id = 'TR-299'");
    expect(status(stack.projA)).toEqual([{ status: "superseded" }]);
    expect(status(stack.projB)).toEqual([{ status: "confirmed" }]);
  });
});

describe("④ updateNode 撞号消歧", () => {
  test("双栖节点 + project 消歧 → 仅目标项目落 patch", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    stack.database.knowledgeConnection(stack.projA);
    stack.database.knowledgeConnection(stack.projB);
    const tool = makeTool(stack);

    await call(tool, {
      op: "updateNode",
      iterationId: ITER,
      nodeId: "TR-299",
      patch: { digest: "仅 projA 的新摘要" },
      project: "projA",
    });

    const digests = (proj: string) =>
      probe<{ digest: string }>(proj, "SELECT digest FROM nodes WHERE id = 'TR-299'");
    expect(digests(stack.projA)).toEqual([{ digest: "仅 projA 的新摘要" }]);
    expect(digests(stack.projB)).toEqual([{ digest: "双栖规则B摘要" }]);
  });
});

describe("⑤ declareAnchors 撞号消歧", () => {
  test("双栖节点 + project 消歧 → 锚落指定项目库", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    stack.database.knowledgeConnection(stack.projA);
    stack.database.knowledgeConnection(stack.projB);
    const tool = makeTool(stack);

    await call(tool, {
      op: "declareAnchors",
      iterationId: ITER,
      nodeId: "TR-299",
      anchors: [{ scopeKind: "path", pattern: "src/**" }],
      project: "projA",
    });

    const anchors = (proj: string) =>
      probe<{ n: number }>(proj, "SELECT COUNT(*) AS n FROM anchor_decl WHERE node_id = 'TR-299'");
    expect(anchors(stack.projA)).toEqual([{ n: 1 }]);
    expect(anchors(stack.projB)).toEqual([{ n: 0 }]);
  });
});

describe("⑥ 不传 project 的行为保持（不猜语义不变）", () => {
  test("多命中零消歧参数 → 仍报错，且文案指明 project 消歧通道（死胡同提示变活路）", async () => {
    const stack = freshStack();
    seedDualHit(stack, "TR-299", "双栖规则A", "双栖规则B");
    const tool = makeTool(stack);
    await expect(
      call(tool, { op: "supersede", iterationId: ITER, nodeId: "TR-299", reason: "不消歧应报错" }),
    ).rejects.toThrow("project");
  });

  test("project 参数描述不再限定 createNode（定位类 op 消歧语义入 schema）", () => {
    const stack = freshStack();
    const tool = makeTool(stack);
    const params = tool.parameters as { properties: { project: { description: string } } };
    expect(params.properties.project.description).toContain("消歧");
  });
});

describe("⑦ kg 只读 get 撞号消歧（读面静默首命中 → 显式消歧）", () => {
  async function kgCall(stack: Stack, params: Record<string, unknown>): Promise<string> {
    const tool = createKgTool({ query: stack.query });
    const result = await tool.execute("kg-call-1", params as never, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
    return result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  test("双栖 id + get 无 project → 报错列命中项目（不再静默取首命中）", async () => {
    const stack = freshStack();
    seedDualHit(stack, "E-15", "移动域边界A", "移动域边界B");
    await expect(kgCall(stack, { op: "get", nodeId: "E-15" })).rejects.toThrow("多个项目命中");
  });

  test("双栖 id + get project=projA → 返回指定项目节点全量", async () => {
    const stack = freshStack();
    seedDualHit(stack, "E-15", "移动域边界A", "移动域边界B");
    const out = await kgCall(stack, { op: "get", nodeId: "E-15", project: "projA" });
    expect(out).toContain("移动域边界A");
    expect(out).toContain("projA");
  });

  test("单栖 id + get 无 project → 照旧成功（单命中零影响）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-888", "独居规则");
    const out = await kgCall(stack, { op: "get", nodeId: "TR-888" });
    expect(out).toContain("独居规则");
  });

  test("get project 过滤后零命中 → 报错含实际命中项目清单", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-888", "独居规则");
    await expect(kgCall(stack, { op: "get", nodeId: "TR-888", project: "projB" })).rejects.toThrow("projB 不存在");
  });

  test("get project 名未命中任何项目 → 报错含实际命中项目清单（消歧意图不静默忽略）", async () => {
    const stack = freshStack();
    seedNode(stack, stack.projA, "TR-888", "独居规则");
    await expect(kgCall(stack, { op: "get", nodeId: "TR-888", project: "no-such" })).rejects.toThrow("no-such 不存在");
  });
});

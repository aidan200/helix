import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { createKgUpdateTool } from "../../src/adapters/driven/tools/kg-update/KgUpdateTool";
import { createKgTaskContextResolver } from "../../src/adapters/driven/subagent/child/ChildMain";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { EDGE_VERBS, type KnowledgeWriteOp } from "../../src/domain/kg/types";
import { counterClock } from "../helpers/task-fixtures";

/**
 * I 层（真 SQLite @ tmp）：kg-update 任务归属元数据机械注入（T4.2，AD-10
 * 唯一衔接面的接线层兑现——AF-T4.1.4/T4.1.5/T4.1.6 三条首跑裂口）。
 *
 * 覆盖：
 * - 三路径机械落章：单条 createNode / batchCreateNodes / supersede（含
 *   replacement）在任务上下文下不带 taskId/originBatchId 也 100% 落章
 *   （change_log.task_id + nodes.origin_batch_id）——不再依赖 LLM 透传；
 * - LLM 显式传参优先于注入默认值（透传降级为可选覆盖）；
 * - 非任务上下文零行为变化（task_id NULL、replacement 无 confirmed 默认）；
 * - replacement 批次上下文默认 status=confirmed（bootstrap 无 draft 裂口）；
 * - 子进程接线层解析器（HELIX_DB_PATH + instanceId 同面惰性解析
 *   batch.instance_id → jobId/batchId；dbPath 缺席/无批次行 → 不注入）。
 */

interface KgStack {
  readonly root: string;
  readonly proj: string;
  readonly database: KgDatabase;
  readonly write: KgWriteService;
  readonly query: KgQueryService;
}

const disposers: Array<() => void> = [];

function freshKgStack(): KgStack {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-inject-"));
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

afterAll(() => {
  for (const dispose of disposers) dispose();
});

// ── 原始库探针（直查 SQL——落章权威证据面） ─────────────────

function changeLogRows(root: string): Record<string, unknown>[] {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return db.prepare("SELECT iteration_id, op, node_id, task_id FROM change_log ORDER BY rowid").all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function nodeRow(root: string, id: string): Record<string, unknown> | null {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return db
      .prepare("SELECT id, origin_batch_id, status FROM nodes WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
  } finally {
    db.close();
  }
}

function makeTool(stack: KgStack, taskContext?: () => { taskId: string; originBatchId: string } | undefined) {
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

const CTX = { taskId: "task-job-1", originBatchId: "batch-1" };
const ITER = "iter-20260829-ys7q";

describe("批次上下文机械注入：组合 declareAnchors op 同盖（A4 丢章复现）", () => {
  // 复现实证缺陷：bootstrap 首跑 declareAnchors change_log 行 task_id 全 NULL。
  // 根因 = KgUpdateTool.execCreateNode 内组合第二笔 declareAnchors op 未经
  // createOp 注入面（仅主 op 走注入）——本断言在修复前失败（declareAnchors 行 NULL）。
  test("createNode + anchors：createNode 与 declareAnchors 两行 change_log 均落 task_id", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack, () => CTX);
    const text = await call(tool, {
      op: "createNode",
      iterationId: ITER,
      kind: "rule",
      name: "锚规则",
      digest: "摘要",
      scene: "测试场景",
      project: "proj",
      anchors: [{ scopeKind: "global" }, { scopeKind: "path", pattern: "src/**" }],
    });
    expect(text).toContain("锚声明 2 条");
    const rows = changeLogRows(stack.proj);
    expect(rows.map((r) => r["op"])).toEqual(["createNode", "declareAnchors"]);
    expect(rows.every((r) => r["task_id"] === CTX.taskId)).toBe(true);
  });

  test("非任务上下文 createNode + anchors：两行 change_log 均 NULL（零注入语义保持）", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack); // 无注入面
    await call(tool, {
      op: "createNode",
      iterationId: ITER,
      kind: "rule",
      name: "锚规则",
      digest: "摘要",
      scene: "测试场景",
      project: "proj",
      anchors: [{ scopeKind: "global" }],
    });
    const rows = changeLogRows(stack.proj);
    expect(rows.map((r) => r["op"])).toEqual(["createNode", "declareAnchors"]);
    expect(rows.every((r) => r["task_id"] === null)).toBe(true);
  });
});

describe("写入口 6 种 op kind 透传 taskId（逐 op 断言，store 面机械保证）", () => {
  // 工具面只暴露 createNode/supersede/batchCreateNodes（+组合 declareAnchors）；
  // updateNode/addEdge 无工具路径——store 面逐 op 断言保证任何写路径（含未来
  // 新增工具/页面修正面）携带 taskId 即落章。
  test("createNode/updateNode/supersede/declareAnchors/addEdge/batchCreateNodes 携带 taskId → change_log 全行落章", () => {
    const stack = freshKgStack();
    const w = (op: KnowledgeWriteOp): string => {
      const r = stack.write.write(stack.proj, op);
      if (!r.ok) throw new Error(`写失败：${r.error.code} ${r.error.message}`);
      return r.nodeId;
    };
    const taskId = "task-six-ops";
    const a = w({ kind: "createNode", iterationId: ITER, taskId, originBatchId: "b1", draft: { kind: "rule", name: "规则A", digest: "d", scene: "测试场景" } });
    const b = w({ kind: "batchCreateNodes", iterationId: ITER, taskId, originBatchId: "b1", nodes: [{ draft: { kind: "entity", name: "实体B", digest: "d", scene: "测试场景" } }] });
    w({ kind: "updateNode", iterationId: ITER, taskId, nodeId: a, patch: { digest: "d2" } });
    const replacement = w({ kind: "supersede", iterationId: ITER, taskId, nodeId: a, reason: "修正", replacementNodeDraft: { kind: "rule", name: "规则C", digest: "d" } });
    w({ kind: "declareAnchors", iterationId: ITER, taskId, nodeId: b, anchors: [{ scopeKind: "global", pattern: "" }] });
    w({ kind: "addEdge", iterationId: ITER, taskId, srcId: b, dstId: replacement, verb: EDGE_VERBS[2] });
    const rows = changeLogRows(stack.proj);
    // createNode(1) + batchCreateNodes(1) + updateNode(1) + supersede(2：翻态+replacement) + declareAnchors(1) + addEdge(1)
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r["task_id"] === taskId)).toBe(true);
  });
});

describe("iterationId 解析去 v1 化（P0 ④：.helix/iterations 回落移除；无法解析落空不报错）", () => {
  /** 在 workspace 根造 v1 迭代状态目录（.helix/iterations/iter-*）——修复后不再被读取。 */
  function seedWorkspaceIterations(root: string, ids: readonly string[]): void {
    for (const id of ids) {
      mkdirSync(path.join(root, ".helix", "iterations", id), { recursive: true });
      writeFileSync(path.join(root, ".helix", "iterations", id, "phase-state.yaml"), "{}");
    }
  }

  test("v1 目录在场也不再读取：缺省 + 库无锚 → 写成功且 iteration_id 落 NULL（写面不被溯源章卡死）", async () => {
    const stack = freshKgStack();
    seedWorkspaceIterations(stack.root, ["iter-20260825-11fo", "iter-20260829-ys7q"]);
    const tool = makeTool(stack, () => CTX);
    const text = await call(tool, { op: "createNode", kind: "rule", name: "无参规则", digest: "摘要", scene: "测试场景", project: "proj" });
    expect(text).toContain("已建节点");
    const rows = changeLogRows(stack.proj);
    expect(rows).toHaveLength(1);
    // v1 冻结值（iter-20260829-ys7q）不得再被盖章；task 章照常机械注入
    expect(rows[0]).toMatchObject({ iteration_id: null, task_id: CTX.taskId });
  });

  test("缺省 iterationId → 回落目标库最近迭代锚（库内 change_log 末行，滞后兑底）", async () => {
    const stack = freshKgStack();
    const seed = await stack.write.write(stack.proj, {
      kind: "createNode",
      iterationId: "iter-seed-anchor",
      draft: { kind: "rule", name: "种子", digest: "d", scene: "测试场景" },
    });
    if (!seed.ok) throw new Error("种子建点失败");
    const tool = makeTool(stack, () => CTX);
    await call(tool, { op: "createNode", kind: "rule", name: "锚回落", digest: "摘要", scene: "测试场景", project: "proj" });
    const rows = changeLogRows(stack.proj);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ iteration_id: "iter-seed-anchor" });
  });

  test("库锚取末行字面值：末行 NULL → 后续缺省写不回填旧锚（v1 冻结值不得再自我延续）", async () => {
    const stack = freshKgStack();
    const seed = stack.write.write(stack.proj, {
      kind: "createNode",
      iterationId: "iter-seed-anchor",
      draft: { kind: "rule", name: "种子", digest: "d", scene: "测试场景" },
    });
    if (!seed.ok) throw new Error("种子建点失败");
    const nullRow = stack.write.write(stack.proj, {
      kind: "createNode",
      iterationId: null,
      draft: { kind: "rule", name: "无锚行", digest: "d", scene: "测试场景" },
    });
    if (!nullRow.ok) throw new Error("无锚建点失败");
    const tool = makeTool(stack, () => CTX);
    await call(tool, { op: "createNode", kind: "rule", name: "后续", digest: "摘要", scene: "测试场景", project: "proj" });
    const rows = changeLogRows(stack.proj);
    // 末行（无锚）之后不再回填 iter-seed-anchor——末行 NULL = 当前无迭代归属，
    // 老库 v1 冻结值不会经库锚回落自我延续
    expect(rows[2]).toMatchObject({ iteration_id: null });
  });

  test("显式 iterationId 覆盖机械解析（覆盖语义保持）", async () => {
    const stack = freshKgStack();
    seedWorkspaceIterations(stack.root, ["iter-20260829-ys7q"]);
    const tool = makeTool(stack, () => CTX);
    await call(tool, { op: "createNode", iterationId: "iter-explicit", kind: "rule", name: "显式", digest: "摘要", scene: "测试场景", project: "proj" });
    expect(changeLogRows(stack.proj)[0]).toMatchObject({ iteration_id: "iter-explicit" });
  });

  test("双锚缺失（无 v1 目录 + 库空）且未显式传参 → 不再报错：写成功且 iteration_id NULL", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack); // 非任务上下文：task_id 亦 NULL（零注入语义）
    const text = await call(tool, { op: "createNode", kind: "rule", name: "无锚", digest: "摘要", scene: "测试场景", project: "proj" });
    expect(text).toContain("已建节点");
    expect(changeLogRows(stack.proj)[0]).toMatchObject({ iteration_id: null, task_id: null });
  });
});

describe("批次上下文机械注入：三路径落章（不再依赖 LLM 透传）", () => {
  test("单条 createNode：不带 taskId/originBatchId → change_log.task_id + nodes.origin_batch_id 落章", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack, () => CTX);
    const text = await call(tool, { op: "createNode", iterationId: ITER, kind: "rule", name: "规则甲", digest: "摘要甲", scene: "测试场景", project: "proj" });
    const nodeId = /已建节点 (\S+?)（/.exec(text)?.[1]!;
    expect(changeLogRows(stack.proj).map((r) => r["task_id"])).toEqual([CTX.taskId]);
    expect(nodeRow(stack.proj, nodeId)).toMatchObject({ origin_batch_id: CTX.originBatchId });
  });

  test("batchCreateNodes：op 级不带元数据 → 逐节点 change_log.task_id + origin_batch_id 同源落章", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack, () => CTX);
    const text = await call(tool, {
      op: "batchCreateNodes",
      iterationId: ITER,
      project: "proj",
      nodes: [
        { kind: "rule", name: "规则一", digest: "摘要一", scene: "测试场景" },
        { kind: "entity", name: "实体一", digest: "摘要二", scene: "测试场景" },
      ],
    });
    const lastId = /末节点 (\S+?)）/.exec(text)?.[1]!;
    const rows = changeLogRows(stack.proj);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["task_id"] === CTX.taskId)).toBe(true);
    expect(nodeRow(stack.proj, lastId)).toMatchObject({ origin_batch_id: CTX.originBatchId });
  });

  test("supersede + replacement：supersede/replacement 两 change_log 行落 task_id；replacement 落 origin_batch_id 且默认 confirmed", async () => {
    const stack = freshKgStack();
    // 种子旧节点（confirmed）
    const seed = await stack.write.write(stack.proj, {
      kind: "createNode",
      iterationId: ITER,
      draft: { kind: "entity", name: "旧实体", digest: "旧摘要", scene: "测试场景", status: "confirmed" },
    });
    if (!seed.ok) throw new Error("种子建点失败");
    const tool = makeTool(stack, () => CTX);
    const text = await call(tool, {
      op: "supersede",
      iterationId: ITER,
      nodeId: seed.nodeId,
      reason: "批次内自我修正",
      replacement: { kind: "entity", name: "新实体", digest: "新摘要" },
    });
    const replacementId = /新节点 (\S+?)（/.exec(text)?.[1]!;
    const rows = changeLogRows(stack.proj);
    // 种子行（无上下文）+ supersede 行 + replacement createNode 行
    expect(rows.map((r) => r["op"])).toEqual(["createNode", "supersede", "createNode"]);
    expect(rows[1]).toMatchObject({ task_id: CTX.taskId });
    expect(rows[2]).toMatchObject({ task_id: CTX.taskId });
    expect(nodeRow(stack.proj, replacementId)).toMatchObject({
      origin_batch_id: CTX.originBatchId,
      status: "confirmed", // 批次上下文 replacement 默认 confirmed（bootstrap 无 draft）
    });
  });
});

describe("LLM 显式传参优先于注入默认值", () => {
  test("createNode 显式 taskId/originBatchId 覆盖上下文默认值", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack, () => CTX);
    const text = await call(tool, {
      op: "createNode",
      iterationId: ITER,
      kind: "rule",
      name: "规则乙",
      digest: "摘要乙",
      scene: "测试场景",
      project: "proj",
      taskId: "task-explicit",
      originBatchId: "batch-explicit",
    });
    const nodeId = /已建节点 (\S+?)（/.exec(text)?.[1]!;
    expect(changeLogRows(stack.proj)[0]).toMatchObject({ task_id: "task-explicit" });
    expect(nodeRow(stack.proj, nodeId)).toMatchObject({ origin_batch_id: "batch-explicit" });
  });
});

describe("非任务上下文零行为变化", () => {
  test("无 taskContext：task_id NULL + origin_batch_id NULL（与现状逐字节一致）", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack); // 无注入面
    const text = await call(tool, { op: "createNode", iterationId: ITER, kind: "rule", name: "规则丙", digest: "摘要丙", scene: "测试场景", project: "proj" });
    const nodeId = /已建节点 (\S+?)（/.exec(text)?.[1]!;
    expect(changeLogRows(stack.proj)[0]).toMatchObject({ task_id: null });
    expect(nodeRow(stack.proj, nodeId)).toMatchObject({ origin_batch_id: null });
  });

  test("无 taskContext 的 replacement：status 语义不变（缺省 draft）", async () => {
    const stack = freshKgStack();
    const seed = await stack.write.write(stack.proj, {
      kind: "createNode",
      iterationId: ITER,
      draft: { kind: "entity", name: "旧实体", digest: "旧摘要", scene: "测试场景", status: "confirmed" },
    });
    if (!seed.ok) throw new Error("种子建点失败");
    const tool = makeTool(stack);
    const text = await call(tool, {
      op: "supersede",
      iterationId: ITER,
      nodeId: seed.nodeId,
      reason: "现场修正",
      replacement: { kind: "entity", name: "新实体", digest: "新摘要" },
    });
    const replacementId = /新节点 (\S+?)（/.exec(text)?.[1]!;
    expect(nodeRow(stack.proj, replacementId)).toMatchObject({ status: "draft", origin_batch_id: null });
  });
});

describe("子进程接线层解析器（HELIX_DB_PATH + instanceId 同面惰性解析）", () => {
  async function withLedgerDb(fn: (dbPath: string, store: TaskStore) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-ctx-resolver-"));
    const dbPath = path.join(dir, "helix.db");
    const queue = new WriteQueue(dbPath);
    try {
      await fn(dbPath, new TaskStore(queue));
    } finally {
      await queue.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("batch.instance_id 命中 → 解析出 jobId/batchId", async () => {
    await withLedgerDb(async (dbPath, store) => {
      const now = counterClock().now();
      await store.insertJob({
        id: "task-j1", type: "kg-bootstrap", params: {}, projects: ["demo"], status: "running",
        createdBy: "page", createdAt: now, updatedAt: now, error: null,
      });
      await store.insertStage({ jobId: "task-j1", seq: 1, name: "L0", status: "running", artifact: null, updatedAt: now });
      await store.insertBatch({
        id: "batch-b1", jobId: "task-j1", stageSeq: 1, scope: "s", status: "running",
        retryCount: 0, retryNote: null, instanceId: "inst-x", createdAt: now, updatedAt: now,
      });
      const resolver = createKgTaskContextResolver(dbPath, "inst-x");
      try {
        expect(resolver?.()).toEqual({ taskId: "task-j1", originBatchId: "batch-b1" });
      } finally {
        resolver?.close?.();
      }
    });
  });

  test("instance_id 无批次行（chat 子进程等非任务上下文）→ undefined（不注入）", async () => {
    await withLedgerDb(async (dbPath) => {
      const resolver = createKgTaskContextResolver(dbPath, "inst-unknown");
      try {
        expect(resolver?.()).toBeUndefined();
      } finally {
        resolver?.close?.();
      }
    });
  });

  test("dbPath 缺席（HELIX_DB_PATH 未注入）→ 无解析器（零注入零触盘）", () => {
    expect(createKgTaskContextResolver(undefined, "inst-x")).toBeUndefined();
  });
});

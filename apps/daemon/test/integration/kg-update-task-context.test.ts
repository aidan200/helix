import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    return db.prepare("SELECT op, node_id, task_id FROM change_log ORDER BY rowid").all() as Record<string, unknown>[];
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

describe("批次上下文机械注入：三路径落章（不再依赖 LLM 透传）", () => {
  test("单条 createNode：不带 taskId/originBatchId → change_log.task_id + nodes.origin_batch_id 落章", async () => {
    const stack = freshKgStack();
    const tool = makeTool(stack, () => CTX);
    const text = await call(tool, { op: "createNode", iterationId: ITER, kind: "rule", name: "规则甲", digest: "摘要甲", project: "proj" });
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
        { kind: "rule", name: "规则一", digest: "摘要一" },
        { kind: "entity", name: "实体一", digest: "摘要二" },
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
      draft: { kind: "entity", name: "旧实体", digest: "旧摘要", status: "confirmed" },
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
    const text = await call(tool, { op: "createNode", iterationId: ITER, kind: "rule", name: "规则丙", digest: "摘要丙", project: "proj" });
    const nodeId = /已建节点 (\S+?)（/.exec(text)?.[1]!;
    expect(changeLogRows(stack.proj)[0]).toMatchObject({ task_id: null });
    expect(nodeRow(stack.proj, nodeId)).toMatchObject({ origin_batch_id: null });
  });

  test("无 taskContext 的 replacement：status 语义不变（缺省 draft）", async () => {
    const stack = freshKgStack();
    const seed = await stack.write.write(stack.proj, {
      kind: "createNode",
      iterationId: ITER,
      draft: { kind: "entity", name: "旧实体", digest: "旧摘要", status: "confirmed" },
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
        id: "batch-b1", jobId: "task-j1", stageSeq: 1, seq: 1, scope: "s", status: "running",
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

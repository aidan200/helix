import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { supersedeTransition } from "../../src/domain/kg/supersede";

/**
 * I 层（+U 半）：supersede 状态机（CL-3.A4 前半；AD-14/AD-16）——
 * 翻 status 不换号、change_log 链完整（迭代 id + supersede_of）、id 永不回收。
 */

interface Stack {
  readonly root: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly service: KgWriteService;
}

const disposers: Array<() => void> = [];

function freshStack(): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-supersede-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const service = new KgWriteService({ store });
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database, store, graph, service };
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

describe("domain/kg/supersede 状态机（U 半，纯函数）", () => {
  test("draft/confirmed → superseded 合法；superseded 终态不可再翻", () => {
    expect(supersedeTransition("draft")).toEqual({ ok: true, next: "superseded" });
    expect(supersedeTransition("confirmed")).toEqual({ ok: true, next: "superseded" });
    expect(supersedeTransition("superseded")).toEqual({ ok: false, current: "superseded" });
  });
});

describe("supersede 落库（I 半：翻 status 不换号 + change_log 链）", () => {
  test("① supersede 后旧 id status=superseded、id 不变；change_log 含迭代 id 与链；replacement 另发新号", () => {
    const s = freshStack();
    const created = s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "旧规", digest: "旧规摘要" },
    });
    expect(created).toEqual({ ok: true, nodeId: "TR-1" });

    const superseded = s.service.write(s.root, {
      kind: "supersede",
      iterationId: "iter-9",
      nodeId: "TR-1",
      reason: "已被新架构取代",
      replacementNodeDraft: { kind: "rule", name: "新规", digest: "新规摘要" },
    });
    expect(superseded).toEqual({ ok: true, nodeId: "TR-2" }); // replacement 自动发新号

    // 旧节点：status 翻转、id 不变、日志两行（create + supersede，含迭代 id 与链）
    const old = s.graph.getNode(s.root, "TR-1");
    expect(old).not.toBeNull();
    expect(old?.node.id).toBe("TR-1"); // 不换号
    expect(old?.node.status).toBe("superseded");
    expect(old?.changeLog.map((entry) => entry.op)).toEqual(["createNode", "supersede"]);
    expect(old?.changeLog[1]).toMatchObject({
      iterationId: "iter-9",
      supersedeOf: "TR-1", // supersede_of=自身历史链
      reason: "已被新架构取代",
    });

    // replacement 节点：新号、默认 draft、create 行挂链（supersede_of=TR-1）
    const replacement = s.graph.getNode(s.root, "TR-2");
    expect(replacement?.node.status).toBe("draft");
    expect(replacement?.changeLog[0]).toMatchObject({ op: "createNode", supersedeOf: "TR-1" });

    // 双向链：旧/新节点 supersede 链均覆盖两节点（旧→新方向可查）
    expect(old?.supersedeChain.map((link) => link.nodeId)).toEqual(["TR-1", "TR-2"]);
    expect(replacement?.supersedeChain.map((link) => link.nodeId)).toEqual(["TR-1", "TR-2"]);
  });

  test("② supersede 无 replacement：只翻状态，不发新号", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "entity", name: "E1", digest: "d" },
    });
    const result = s.service.write(s.root, {
      kind: "supersede",
      iterationId: "iter-2",
      nodeId: "E-1",
      reason: "实体已删除",
    });
    expect(result).toEqual({ ok: true, nodeId: "E-1" });
    expect(s.graph.getNode(s.root, "E-1")?.node.status).toBe("superseded");
    // 后续自动发号仍从 2 起（seq 只增不减，id 永不回收）
    const next = s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-3",
      draft: { kind: "entity", name: "E2", digest: "d" },
    });
    expect(next).toEqual({ ok: true, nodeId: "E-2" });
  });

  test("③ supersede 不存在的节点 → KG_E_ID；已 superseded 再翻 → KG_E_STATE；reason 缺失 → KG_E_SCHEMA", () => {
    const s = freshStack();
    const missing = s.service.write(s.root, {
      kind: "supersede",
      iterationId: "iter-1",
      nodeId: "TR-404",
      reason: "r",
    });
    expect(missing).toEqual({
      ok: false,
      error: { code: "KG_E_ID", message: expect.any(String), path: "op.nodeId" },
    });

    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "n", digest: "d" },
    });
    s.service.write(s.root, { kind: "supersede", iterationId: "iter-2", nodeId: "TR-1", reason: "r" });
    const again = s.service.write(s.root, {
      kind: "supersede",
      iterationId: "iter-3",
      nodeId: "TR-1",
      reason: "r2",
    });
    expect(again).toEqual({
      ok: false,
      error: { code: "KG_E_STATE", message: expect.any(String), path: "op.nodeId" },
    });

    const noReason = s.service.write(s.root, {
      kind: "supersede",
      iterationId: "iter-4",
      nodeId: "TR-1",
      reason: "",
    } as unknown as Parameters<typeof s.service.write>[1]);
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.path).toBe("op.reason");
  });

  test("④ 三级链：A←B←C（两次 supersede+replacement），中点 getNode 链完整", () => {
    const s = freshStack();
    s.service.write(s.root, {
      kind: "createNode",
      iterationId: "iter-1",
      draft: { kind: "rule", name: "A", digest: "dA" },
    });
    s.service.write(s.root, {
      kind: "supersede",
      iterationId: "iter-2",
      nodeId: "TR-1",
      reason: "r1",
      replacementNodeDraft: { kind: "rule", name: "B", digest: "dB" },
    });
    s.service.write(s.root, {
      kind: "supersede",
      iterationId: "iter-3",
      nodeId: "TR-2",
      reason: "r2",
      replacementNodeDraft: { kind: "rule", name: "C", digest: "dC" },
    });
    const mid = s.graph.getNode(s.root, "TR-2");
    expect(mid?.supersedeChain.map((link) => link.nodeId)).toEqual(["TR-1", "TR-2", "TR-3"]);
    expect(mid?.supersedeChain.map((link) => link.status)).toEqual(["superseded", "superseded", "draft"]);
  });
});

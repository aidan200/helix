/**
 * node_vectors 存储面（批1 WP-B）I 层真 SQLite 测试。
 *
 * 断言面：
 * 1. 建表：新库 KG_SCHEMA_SQL 直建含 node_vectors（列形态严格按 §4.1：
 *    node_id PK / content_hash / model / dim / embedded_at / embedding BLOB）；
 * 2. 老库升级幂等：无 node_vectors 的旧库重开经 ensureSchemaEvolved 补表
 *    （自动升级）；二次重开零改写（幂等）；
 * 3. 读写面：upsert 覆盖写（同 node_id 单行）/ meta 读（blob 不出读面）/
 *    delete / count；listEmbedTargets 只含活跃节点（superseded 排除）并挂
 *    现有向量 meta；
 * 4. purgeAll 随库生命周期联动：node_vectors 计入 KG_TABLES 全清面；
 * 5. 写入口挂钩真链路：KgWriteService（唯一写入口）createNode/batchCreateNodes/
 *    updateNode/supersede 成功后向量行联动（KgVectorService fire-and-forget，
 *    drain 落定）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KG_TABLES } from "../../src/adapters/driven/sqlite-kg/schema";
import { nodeVectorContentHash } from "../../src/adapters/driven/sqlite-kg/node-vector-codec";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgVectorService } from "../../src/application/services/kg/KgVectorService";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { NodeVectorRow } from "../../src/application/ports/outbound/NodeVectorStorePort";
import type { NodeDraft } from "../../src/domain/kg/types";

const disposers: Array<() => void> = [];

function freshProject(): { root: string; database: KgDatabase } {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-vectors-"));
  const database = new KgDatabase();
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database };
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

function fakeEmbedding(): EmbeddingPort & { calls: number } {
  const port = { calls: 0 } as EmbeddingPort & { calls: number };
  port.embed = async (texts: readonly string[]): Promise<EmbeddingResult> => {
    port.calls += texts.length;
    return { vectors: texts.map((t) => Float32Array.from([t.length % 7, 0.5, 0.25])), dim: 3 };
  };
  port.endpointLabel = () => "fake";
  return port;
}

const DRAFT: NodeDraft = {
  kind: "entity",
  name: "写点白名单",
  digest: "写 SQL 收口 SqliteKnowledgeStore",
  scene: "改存储写面前",
  body: "AG-06：全部写语句收口于 SqliteKnowledgeStore / KgDatabase。",
};

describe("node_vectors 建表与老库升级（§4.1）", () => {
  test("① 新库直建含 node_vectors（列形态严格）", () => {
    const { root, database } = freshProject();
    database.knowledgeConnection(root);
    const probe = new Database(kgDbPath(root));
    try {
      const cols = probe.prepare("PRAGMA table_info(node_vectors)").all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      expect(cols.map((c) => c.name)).toEqual([
        "node_id",
        "content_hash",
        "model",
        "dim",
        "embedded_at",
        "embedding",
      ]);
      expect(cols.find((c) => c.name === "node_id")!.pk).toBe(1);
      expect(cols.find((c) => c.name === "embedding")!.type.toUpperCase()).toBe("BLOB");
      expect(cols.find((c) => c.name === "dim")!.type.toUpperCase()).toBe("INTEGER");
    } finally {
      probe.close();
    }
    expect(KG_TABLES).toContain("node_vectors"); // purge 全清面覆盖（随库生命周期联动）
  });

  test("② 老库升级幂等：无 node_vectors 的旧库重开自动补表；二次重开零改写", () => {
    const { root, database } = freshProject();
    database.knowledgeConnection(root);
    database.closeAll();
    // 模拟旧库：删表（老库形态 = 无 node_vectors）
    const raw = new Database(kgDbPath(root));
    raw.exec("DROP TABLE node_vectors");
    raw.close();
    // 重开 = 老库自动升级（KG_SCHEMA_SQL additive + ensureSchemaEvolved 补表）
    const upgraded = new KgDatabase();
    upgraded.knowledgeConnection(root);
    const probe = new Database(kgDbPath(root));
    const tables1 = (
      probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_vectors'").all() as unknown[]
    ).length;
    probe.close();
    expect(tables1).toBe(1);
    // 幂等：二次重开零改写（不炸不重建——先写一行，重开后行还在）
    const store = new SqliteKnowledgeStore({ database: upgraded });
    const row: NodeVectorRow = {
      nodeId: "E-1",
      contentHash: "h",
      model: "bge-m3",
      dim: 3,
      embeddedAt: 1,
      embedding: Float32Array.from([1, 2, 3]),
    };
    store.upsertNodeVector(root, row);
    upgraded.closeAll();
    const again = new KgDatabase();
    again.knowledgeConnection(root);
    const store2 = new SqliteKnowledgeStore({ database: again });
    expect(store2.getNodeVectorMeta(root, "E-1")?.contentHash).toBe("h");
    again.closeAll();
  });
});

describe("node_vectors 读写面（SqliteKnowledgeStore 单点）", () => {
  test("③ upsert 覆盖写单行 / meta 读不出 blob / delete / count；listEmbedTargets 只含活跃节点", () => {
    const { root, database } = freshProject();
    const store = new SqliteKnowledgeStore({ database });
    const write = new KgWriteService({ store });
    expect(write.write(root, { kind: "createNode", iterationId: null, id: "E-1", draft: DRAFT }).ok).toBe(true);
    expect(write.write(root, { kind: "createNode", iterationId: null, id: "E-2", draft: { ...DRAFT, name: "二号" } }).ok).toBe(true);
    // 覆盖写单行
    store.upsertNodeVector(root, { nodeId: "E-1", contentHash: "h1", model: "m1", dim: 3, embeddedAt: 1, embedding: Float32Array.from([1, 2, 3]) });
    store.upsertNodeVector(root, { nodeId: "E-1", contentHash: "h2", model: "m2", dim: 3, embeddedAt: 2, embedding: Float32Array.from([4, 5, 6]) });
    expect(store.countNodeVectors(root)).toBe(1);
    const meta = store.getNodeVectorMeta(root, "E-1")!;
    expect(meta.contentHash).toBe("h2");
    expect(meta.model).toBe("m2");
    expect(meta.embeddedAt).toBe(2);
    expect("embedding" in meta).toBe(false); // blob 不出 meta 读面
    // listEmbedTargets：两活跃节点 + E-1 挂向量 meta
    const targets = store.listEmbedTargets(root);
    expect(targets.map((t) => t.nodeId).sort()).toEqual(["E-1", "E-2"]);
    expect(targets.find((t) => t.nodeId === "E-1")!.vector?.contentHash).toBe("h2");
    expect(targets.find((t) => t.nodeId === "E-2")!.vector).toBeNull();
    expect(store.getNodeEmbedTarget(root, "E-1")!.body).toContain("AG-06");
    // delete
    store.deleteNodeVector(root, "E-1");
    expect(store.getNodeVectorMeta(root, "E-1")).toBeNull();
    expect(store.countNodeVectors(root)).toBe(0);
  });

  test("④ purgeAll 全清面含 node_vectors（随库生命周期联动）", () => {
    const { root, database } = freshProject();
    const store = new SqliteKnowledgeStore({ database });
    store.upsertNodeVector(root, { nodeId: "E-1", contentHash: "h", model: "m", dim: 3, embeddedAt: 1, embedding: Float32Array.from([1, 2, 3]) });
    expect(store.countNodeVectors(root)).toBe(1);
    store.purgeAll(root);
    expect(store.countNodeVectors(root)).toBe(0);
  });
});

describe("写入口挂钩真链路（KgWriteService → KgVectorService）", () => {
  test("⑤ createNode/batchCreateNodes/updateNode 落库 → 向量行联动；supersede → 删向量", async () => {
    const { root, database } = freshProject();
    const store = new SqliteKnowledgeStore({ database });
    const embedding = fakeEmbedding();
    const vectors = new KgVectorService({
      store,
      embedding,
      resolveEndpoint: () => ({ baseUrl: "http://x/v1", model: "bge-m3" }),
      contentHash: nodeVectorContentHash,
      clock: () => 1000,
    });
    const write = new KgWriteService({ store, vectorSync: vectors });
    // createNode
    expect(write.write(root, { kind: "createNode", iterationId: null, id: "E-1", draft: DRAFT }).ok).toBe(true);
    await vectors.drain();
    expect(store.getNodeVectorMeta(root, "E-1")?.model).toBe("bge-m3");
    // batchCreateNodes（自动发号——nodeIds 回执全集逐个嵌入）
    expect(
      write.write(root, {
        kind: "batchCreateNodes",
        iterationId: null,
        nodes: [
          { draft: { ...DRAFT, name: "批量甲" } },
          { draft: { ...DRAFT, name: "批量乙" } },
        ],
      }).ok,
    ).toBe(true);
    await vectors.drain();
    expect(store.countNodeVectors(root)).toBe(3);
    // updateNode 改 body → hash 变重嵌（content_hash 换新可见）
    const hashBefore = store.getNodeVectorMeta(root, "E-1")!.contentHash;
    expect(
      write.write(root, { kind: "updateNode", iterationId: null, nodeId: "E-1", patch: { body: "正文改写", reason: "改" } }).ok,
    ).toBe(true);
    await vectors.drain();
    expect(store.getNodeVectorMeta(root, "E-1")!.contentHash).not.toBe(hashBefore);
    // supersede（带 replacement）：被推翻删向量 + replacement 嵌入
    const before = store.countNodeVectors(root);
    const outcome = write.write(root, {
      kind: "supersede",
      iterationId: null,
      nodeId: "E-1",
      reason: "推翻",
      replacementNodeDraft: { ...DRAFT, name: "推翻产物" },
    });
    expect(outcome.ok).toBe(true);
    await vectors.drain();
    expect(store.getNodeVectorMeta(root, "E-1")).toBeNull(); // 被推翻节点向量删除
    expect(store.countNodeVectors(root)).toBe(before); // 一删一增
    expect(embedding.calls).toBeGreaterThan(0);
  });
});

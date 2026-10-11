/**
 * kg 向量基建（批1 WP-B）单测——KgVectorService（fake store / fake
 * EmbeddingPort，零网络零 sqlite）+ 向量化纯函数。
 *
 * 断言面（brief 测试要求逐条）：
 * 1. 向量化文本与 content_hash（§4.2 公式）：doc = name\nscene\ndigest\n
 *    body.slice(0,1500)；hash = sha256(doc)；blob float32 往返；
 * 2. 增量重嵌判据：无向量 → 嵌入落行；hash 未变 ∧ model 未变 → 跳过零调用；
 *    hash 变 → 重嵌；model 换版 → 重嵌（dim/model 行上记录）；
 * 3. 写入口挂钩（KgWriteService 单点消费面）：createNode / batchCreateNodes /
 *    updateNode 成功后异步嵌入 upsert（fire-and-forget，drain 后可见）；
 *    supersede → 被推翻节点向量删除 + replacement 新节点正常嵌入；
 * 4. 可选件纪律：默认端点缺失（resolveEndpoint null）→ 降级 warn 零写入零抛错；
 *    嵌入调用失败 → warn 留档不阻塞写；
 * 5. syncAll（回填/缺失向量修复共用）：跳过未变节点；dryRun 零落库；逐条失败
 *    warn 留档不影响其余节点。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type {
  NodeEmbedTarget,
  NodeVectorMeta,
  NodeVectorRow,
  NodeVectorStorePort,
} from "../../src/application/ports/outbound/NodeVectorStorePort";
import { buildNodeVectorDoc, NODE_VECTOR_BODY_LIMIT } from "../../src/domain/kg/node-vector";
import {
  nodeVectorContentHash,
  float32ToBlob,
  blobToFloat32,
} from "../../src/adapters/driven/sqlite-kg/node-vector-codec";
import { KgVectorService } from "../../src/application/services/kg/KgVectorService";
import type { KnowledgeWriteOp, NodeDraft, WriteResult } from "../../src/domain/kg/types";

// ── fakes ─────────────────────────────────────────────────────────

/** 内存 fake 向量库（nodes 表极简投影：活跃/推翻两态）。 */
function fakeVectorStore() {
  const vectors = new Map<string, NodeVectorRow>();
  const nodes = new Map<string, { name: string; scene: string; digest: string; body: string; superseded: boolean }>();
  const store: NodeVectorStorePort & { vectors: Map<string, NodeVectorRow>; nodes: typeof nodes } = {
    vectors,
    nodes,
    upsertNodeVector(_projectRoot: string, row: NodeVectorRow) {
      vectors.set(row.nodeId, row);
    },
    deleteNodeVector(_projectRoot: string, nodeId: string) {
      vectors.delete(nodeId);
    },
    getNodeVectorMeta(_projectRoot: string, nodeId: string): NodeVectorMeta | null {
      const row = vectors.get(nodeId);
      return row === undefined
        ? null
        : { nodeId: row.nodeId, contentHash: row.contentHash, model: row.model, dim: row.dim, embeddedAt: row.embeddedAt };
    },
    getNodeEmbedTarget(_projectRoot: string, nodeId: string): NodeEmbedTarget | null {
      const node = nodes.get(nodeId);
      if (node === undefined || node.superseded) return null;
      return { nodeId, ...node, vector: store.getNodeVectorMeta(_projectRoot, nodeId) };
    },
    listEmbedTargets(_projectRoot: string): readonly NodeEmbedTarget[] {
      return [...nodes.entries()]
        .filter(([, n]) => !n.superseded)
        .map(([nodeId, n]) => ({ nodeId, ...n, vector: store.getNodeVectorMeta(_projectRoot, nodeId) }));
    },
    countNodeVectors() {
      return vectors.size;
    },
  };
  return store;
}

/** fake 嵌入端口（计数 + 可注入失败；向量 = 文本 hash 前缀衍生，可区分）。 */
function fakeEmbedding(opts: { fail?: (text: string) => boolean } = {}) {
  const calls: string[][] = [];
  const port: EmbeddingPort & { calls: string[][] } = {
    calls,
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      const failed = texts.find((t) => opts.fail?.(t) === true);
      if (failed !== undefined) throw new Error(`嵌入端点 503（${failed.slice(0, 8)}）`);
      calls.push([...texts]);
      return {
        vectors: texts.map((t) => Float32Array.from([t.length % 7, 0.5, 0.25])),
        dim: 3,
      };
    },
  };
  return port;
}

function serviceOf(
  store: ReturnType<typeof fakeVectorStore>,
  embedding: ReturnType<typeof fakeEmbedding>,
  endpoint: { model: string } | null = { model: "bge-m3" },
): KgVectorService & { warns: string[] } {
  const warns: string[] = [];
  const svc = new KgVectorService({
    store,
    embedding,
    resolveEndpoint: () => (endpoint === null ? null : { baseUrl: "http://x/v1", model: endpoint.model }),
    contentHash: nodeVectorContentHash,
    logger: { warn: (m) => warns.push(m) },
    clock: () => 1000,
  });
  return Object.assign(svc, { warns });
}

const SRC = {
  name: "写点白名单",
  digest: "写 SQL 收口 SqliteKnowledgeStore",
  scene: "改存储写面前",
  body: "AG-06：全部写语句收口于 SqliteKnowledgeStore / KgDatabase。",
};
const DRAFT: NodeDraft = { kind: "rule", ...SRC };

function okResult(nodeId: string, extra: Record<string, unknown> = {}): Extract<WriteResult, { ok: true }> {
  return { ok: true, nodeId, ...extra };
}

// ── 1. 向量化纯函数（§4.2 公式）────────────────────────────────

describe("向量化文本与 content_hash（§4.2 公式）", () => {
  test("doc = name\\nscene\\ndigest\\nbody.slice(0,1500)；hash = sha256(doc)", () => {
    const doc = buildNodeVectorDoc({ name: "N", scene: "S", digest: "D", body: "B" });
    expect(doc).toBe("N\nS\nD\nB");
    expect(nodeVectorContentHash(doc)).toBe(createHash("sha256").update(doc, "utf8").digest("hex"));
  });

  test("body 截断防长文稀释（>1500 只取前 1500 码元）", () => {
    const body = "x".repeat(NODE_VECTOR_BODY_LIMIT + 100);
    const doc = buildNodeVectorDoc({ name: "N", scene: "S", digest: "D", body });
    expect(doc.endsWith("x".repeat(NODE_VECTOR_BODY_LIMIT))).toBe(true);
    expect(doc.length).toBe("N\nS\nD\n".length + NODE_VECTOR_BODY_LIMIT);
  });

  test("float32 blob 往返（BLOB float32[dim] 序列化）", () => {
    const v = Float32Array.from([0.25, -1.5, 3.75]);
    const blob = float32ToBlob(v);
    expect(blob.byteLength).toBe(12);
    expect([...blobToFloat32(blob)]).toEqual([0.25, -1.5, 3.75]);
  });
});

// ── 2/4/5. 增量重嵌判据 + 降级 + syncAll ───────────────────────

describe("KgVectorService：增量重嵌 / 降级 / 修复路径", () => {
  test("① 无向量 → 嵌入落行（content_hash/model/dim/embeddedAt 记录）", async () => {
    const store = fakeVectorStore();
    store.nodes.set("E-1", { ...SRC, superseded: false });
    const embedding = fakeEmbedding();
    const svc = serviceOf(store, embedding);
    expect(await svc.embedNode("proj", "E-1")).toBe("embedded");
    expect(embedding.calls).toHaveLength(1);
    const row = store.vectors.get("E-1")!;
    expect(row.model).toBe("bge-m3");
    expect(row.dim).toBe(3);
    expect(row.embeddedAt).toBe(1000);
    expect(row.contentHash).toBe(nodeVectorContentHash(buildNodeVectorDoc(SRC)));
  });

  test("② hash 未变 ∧ model 未变 → 跳过零嵌入调用", async () => {
    const store = fakeVectorStore();
    store.nodes.set("E-1", { ...SRC, superseded: false });
    const embedding = fakeEmbedding();
    const svc = serviceOf(store, embedding);
    await svc.embedNode("proj", "E-1");
    expect(await svc.embedNode("proj", "E-1")).toBe("skipped");
    expect(embedding.calls).toHaveLength(1);
  });

  test("③ hash 变（updateNode 改字段）→ 重嵌；model 换版 → 重嵌", async () => {
    const store = fakeVectorStore();
    store.nodes.set("E-1", { ...SRC, superseded: false });
    const embedding = fakeEmbedding();
    const svc = serviceOf(store, embedding);
    await svc.embedNode("proj", "E-1");
    // hash 变
    store.nodes.set("E-1", { ...SRC, body: "正文改写", superseded: false });
    expect(await svc.embedNode("proj", "E-1")).toBe("embedded");
    expect(embedding.calls).toHaveLength(2);
    // model 换版（hash 未变也重嵌——换版重嵌判据）
    store.nodes.set("E-1", { ...SRC, body: "正文改写", superseded: false });
    const svc2 = serviceOf(store, embedding, { model: "bge-m3-v2" });
    expect(await svc2.embedNode("proj", "E-1")).toBe("embedded");
    expect(store.vectors.get("E-1")!.model).toBe("bge-m3-v2");
  });

  test("④ 默认端点缺失 → 降级 warn 零写入零抛错（可选件纪律）", async () => {
    const store = fakeVectorStore();
    store.nodes.set("E-1", { ...SRC, superseded: false });
    const embedding = fakeEmbedding();
    const svc = serviceOf(store, embedding, null);
    expect(await svc.embedNode("proj", "E-1")).toBe("degraded");
    expect(embedding.calls).toHaveLength(0);
    expect(store.vectors.size).toBe(0);
    expect(svc.warns).toHaveLength(1);
  });

  test("⑤ 嵌入调用失败 → warn 留档不抛错（写入可靠性优先）", async () => {
    const store = fakeVectorStore();
    store.nodes.set("E-1", { ...SRC, superseded: false });
    const svc = serviceOf(store, fakeEmbedding({ fail: () => true }));
    expect(await svc.embedNode("proj", "E-1")).toBe("failed");
    expect(store.vectors.size).toBe(0);
    expect(svc.warns).toHaveLength(1);
  });

  test("⑥ syncAll：跳过未变节点；缺失/变更补嵌；dryRun 零落库；逐条失败 warn 留档不影响其余", async () => {
    const store = fakeVectorStore();
    store.nodes.set("E-1", { ...SRC, superseded: false });
    store.nodes.set("E-2", { ...SRC, name: "另一节点", superseded: false });
    store.nodes.set("E-3", { ...SRC, name: "第三节点", body: "失败品", superseded: false });
    store.nodes.set("E-old", { ...SRC, name: "被推翻", superseded: true }); // 非活跃不嵌
    const embedding = fakeEmbedding({ fail: (t) => t.includes("失败品") });
    const svc = serviceOf(store, embedding);
    const first = await svc.syncAll("proj");
    expect(first.embedded).toBe(2);
    expect(first.failed).toBe(1);
    expect(first.warnings).toHaveLength(1);
    expect(store.vectors.has("E-1")).toBe(true);
    expect(store.vectors.has("E-old")).toBe(false);
    // 幂等重跑：hash 未变跳过（零调用）
    const second = await svc.syncAll("proj");
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(2);
    // dryRun：判定照跑零落库（E-3 仍失败依旧零写入——失败品恒失败）
    const dry = await svc.syncAll("proj", { dryRun: true });
    expect(dry.embedded).toBe(0);
    expect(dry.failed).toBe(1);
    expect(store.vectors.has("E-3")).toBe(false);
  });
});

// ── 3. 写入口挂钩（KgWriteService 单点消费面）──────────────────

describe("KgVectorService.onWriteSuccess：写入口异步嵌入挂钩", () => {
  test("① createNode 成功 → fire-and-forget 嵌入 upsert（drain 后落行）", async () => {
    const store = fakeVectorStore();
    const svc = serviceOf(store, fakeEmbedding());
    const op = { kind: "createNode", iterationId: null, draft: DRAFT } as KnowledgeWriteOp;
    store.nodes.set("E-9", { ...SRC, superseded: false });
    svc.onWriteSuccess("proj", op, okResult("E-9"));
    expect(store.vectors.size).toBe(0); // 异步：尚未落
    await svc.drain();
    expect(store.vectors.has("E-9")).toBe(true);
  });

  test("② batchCreateNodes 成功 → nodeIds 逐个嵌入；updateNode 成功 → 重嵌", async () => {
    const store = fakeVectorStore();
    const embedding = fakeEmbedding();
    const svc = serviceOf(store, embedding);
    store.nodes.set("E-1", { ...SRC, superseded: false });
    store.nodes.set("E-2", { ...SRC, name: "二号", superseded: false });
    const batch: KnowledgeWriteOp = { kind: "batchCreateNodes", iterationId: null, nodes: [] };
    svc.onWriteSuccess("proj", batch, okResult("E-2", { nodeIds: ["E-1", "E-2"] }));
    await svc.drain();
    expect([...store.vectors.keys()].sort()).toEqual(["E-1", "E-2"]);
    // updateNode：hash 未变跳过（判据在 embedNode 单点）
    const update: KnowledgeWriteOp = { kind: "updateNode", iterationId: null, nodeId: "E-1", patch: { name: "N", reason: "r" } };
    svc.onWriteSuccess("proj", update, okResult("E-1"));
    await svc.drain();
    expect(embedding.calls).toHaveLength(2); // 批量 2 次单条调用（fire-and-forget 逐条），update 跳过
  });

  test("③ supersede → 被推翻节点向量删除 + replacement 新节点正常嵌入", async () => {
    const store = fakeVectorStore();
    store.nodes.set("E-1", { ...SRC, superseded: false });
    const svc = serviceOf(store, fakeEmbedding());
    await svc.embedNode("proj", "E-1");
    expect(store.vectors.has("E-1")).toBe(true);
    // 推翻落库后：E-1 superseded、replacement E-2 新号
    store.nodes.set("E-1", { ...SRC, superseded: true });
    store.nodes.set("E-2", { ...SRC, name: "推翻产物", superseded: false });
    const op: KnowledgeWriteOp = {
      kind: "supersede",
      iterationId: null,
      nodeId: "E-1",
      reason: "推翻",
      replacementNodeDraft: DRAFT,
    };
    svc.onWriteSuccess("proj", op, okResult("E-2"));
    await svc.drain();
    expect(store.vectors.has("E-1")).toBe(false); // 被推翻节点向量删除（防相似度噪声源）
    expect(store.vectors.has("E-2")).toBe(true); // replacement 走 createNode 路径嵌入
  });

  test("④ 非节点写 op（addEdge/proposeCandidate）零动作", async () => {
    const store = fakeVectorStore();
    const embedding = fakeEmbedding();
    const svc = serviceOf(store, embedding);
    svc.onWriteSuccess("proj", { kind: "addEdge", iterationId: null, srcId: "E-1", verb: "references", dstId: "E-2" }, okResult("E-1"));
    await svc.drain();
    expect(embedding.calls).toHaveLength(0);
    expect(store.vectors.size).toBe(0);
  });
});

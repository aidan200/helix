/**
 * 存量知识节点向量回填脚本（批1 WP-B）单测——真 store（tmp 库）+ fake
 * EmbeddingPort。
 *
 * 断言面（brief 测试要求）：
 * 1. 回填全量：活跃节点 → 嵌入 → 落表；非活跃（superseded）不嵌；
 * 2. 幂等重跑：hash 判据跳过未变节点——二次运行零嵌入调用零改写；
 *    节点变更后增量补嵌；
 * 3. 端点缺失（resolveDefault null）→ 整批放弃零写入（可选件纪律）；
 * 4. dry-run 判定照跑零落库；
 * 5. 逐条失败 warn 留档不影响其余节点（失败条目可下次重跑修复）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgVectorService } from "../../src/application/services/kg/KgVectorService";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { NodeDraft } from "../../src/domain/kg/types";
import { nodeVectorContentHash } from "../../src/adapters/driven/sqlite-kg/node-vector-codec";
import { runKgVectorBackfill } from "../../scripts/backfill-kg-vectors";

const disposers: Array<() => void> = [];

function freshProject(): { root: string; database: KgDatabase; store: SqliteKnowledgeStore } {
  const root = mkdtempSync(path.join(tmpdir(), "helix-kg-backfill-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database, store };
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

function fakeEmbedding(opts: { failBody?: string } = {}): EmbeddingPort & { calls: string[] } {
  const calls: string[] = [];
  const port = { calls } as EmbeddingPort & { calls: string[] };
  port.embed = async (texts: readonly string[]): Promise<EmbeddingResult> => {
    for (const t of texts) {
      if (opts.failBody !== undefined && t.includes(opts.failBody)) {
        throw new Error("嵌入端点 503");
      }
      calls.push(t);
    }
    return { vectors: texts.map((t) => Float32Array.from([t.length % 7, 0.5, 0.25])), dim: 3 };
  };
  port.endpointLabel = () => "fake";
  return port;
}

function draft(name: string, body = "正文"): NodeDraft {
  return { kind: "entity", name, digest: `${name} 摘要`, scene: `${name} 场景`, body };
}

function serviceOf(store: SqliteKnowledgeStore, embedding: EmbeddingPort, endpoint: { model: string } | null = { model: "bge-m3" }): KgVectorService {
  return new KgVectorService({
    store,
    embedding,
    resolveEndpoint: () => (endpoint === null ? null : { baseUrl: "http://x/v1", model: endpoint.model }),
    contentHash: nodeVectorContentHash,
    clock: () => 1000,
  });
}

describe("backfill-kg-vectors：存量回填（幂等）", () => {
  test("① 全量回填 + 幂等重跑零改写 + 变更增量补嵌", async () => {
    const { root, store } = freshProject();
    const write = new KgWriteService({ store });
    write.write(root, { kind: "createNode", iterationId: null, id: "E-1", draft: draft("甲") });
    write.write(root, { kind: "createNode", iterationId: null, id: "E-2", draft: draft("乙") });
    write.write(root, { kind: "createNode", iterationId: null, id: "E-3", draft: draft("丙") });
    // E-3 推翻（非活跃不回填）
    write.write(root, { kind: "supersede", iterationId: null, nodeId: "E-3", reason: "推翻" });
    const embedding = fakeEmbedding();
    const service = serviceOf(store, embedding);
    const first = await runKgVectorBackfill({ service, projectRoots: [root] });
    expect(first.status).toBe("done");
    expect(first.embedded).toBe(2);
    expect(first.failed).toBe(0);
    expect(store.countNodeVectors(root)).toBe(2);
    expect(store.getNodeVectorMeta(root, "E-3")).toBeNull(); // superseded 不嵌
    // 幂等重跑：hash 判据跳过未变节点——零嵌入调用
    const second = await runKgVectorBackfill({ service, projectRoots: [root] });
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(2);
    expect(embedding.calls).toHaveLength(2);
    // 变更后增量补嵌（只嵌变化节点）
    write.write(root, { kind: "updateNode", iterationId: null, nodeId: "E-1", patch: { body: "正文改写", reason: "改" } });
    const third = await runKgVectorBackfill({ service, projectRoots: [root] });
    expect(third.embedded).toBe(1);
    expect(third.skipped).toBe(1);
    expect(embedding.calls).toHaveLength(3);
  });

  test("② 端点缺失 → 整批放弃零写入（可选件纪律，aborted 带原因）", async () => {
    const { root, store } = freshProject();
    const write = new KgWriteService({ store });
    write.write(root, { kind: "createNode", iterationId: null, id: "E-1", draft: draft("甲") });
    const embedding = fakeEmbedding();
    const service = serviceOf(store, embedding, null);
    const report = await runKgVectorBackfill({ service, projectRoots: [root] });
    expect(report.status).toBe("aborted");
    expect(report.reason).toContain("默认");
    expect(store.countNodeVectors(root)).toBe(0);
    expect(embedding.calls).toHaveLength(0);
  });

  test("③ dry-run 判定照跑零落库；逐条失败 warn 留档不影响其余", async () => {
    const { root, store } = freshProject();
    const write = new KgWriteService({ store });
    write.write(root, { kind: "createNode", iterationId: null, id: "E-1", draft: draft("甲", "失败品正文") });
    write.write(root, { kind: "createNode", iterationId: null, id: "E-2", draft: draft("乙") });
    const embedding = fakeEmbedding({ failBody: "失败品正文" });
    const service = serviceOf(store, embedding);
    const dry = await runKgVectorBackfill({ service, projectRoots: [root], options: { dryRun: true } });
    expect(dry.embedded).toBe(1); // 乙 可嵌（预估）
    expect(dry.failed).toBe(1); // 甲 失败（warn 留档）
    expect(dry.warnings).toHaveLength(1);
    expect(dry.warnings[0]).toContain("E-1");
    expect(store.countNodeVectors(root)).toBe(0); // dry-run 零落库
    // 真跑：甲 仍失败逐条 warn，乙 落表
    const real = await runKgVectorBackfill({ service, projectRoots: [root] });
    expect(real.embedded).toBe(1);
    expect(real.failed).toBe(1);
    expect(real.warnings).toHaveLength(1);
    expect(store.countNodeVectors(root)).toBe(1);
  });
});

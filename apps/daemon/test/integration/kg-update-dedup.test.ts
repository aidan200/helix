/**
 * kg-update 写入口语义查重闸（批2 WP-C §5.1）I 层真 SQLite 测试。
 *
 * 覆盖：
 * ① 三档触发：相似度 < warnThreshold 静默 / ≥ warnThreshold 软警告 +
 *    similarTo 连线 / ≥ dupThreshold 再加疑似重复候选（自动 proposeCandidate）；
 * ② 软闸不阻塞：端点缺失 / 嵌入失败 → 降级 warn，落库照常（可选件纪律）；
 * ③ similarTo 幂等建边（复合主键去重）+ removeEdge 可删 + 词表外动词仍
 *    KG_E_VERB（D3 扩词表后语义不变）；
 * ④ 自动候选 body 非空合规（TR-33）+ 双方 digest 对照 + TR-56 三要素
 *    （事实描述/决策的点/决策后的效果）+ TR-147 姿势（reason/evidence 内嵌 body）；
 * ⑤ batchCreateNodes 逐条查重但警告合并回工具结果（同批互似对只报一次——
 *    不逐条刷屏）；updateNode 不触发查重。
 *
 * 向量 fake：doc 文本标记驱动（MARK-BASE=[1,0,0] / MARK-WARN=cos 0.87 /
 * MARK-DUP=cos 0.95 / MARK-LOW=cos 0.5——与 BASE 的夹角可精确断言）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { nodeVectorContentHash } from "../../src/adapters/driven/sqlite-kg/node-vector-codec";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { KgVectorService } from "../../src/application/services/kg/KgVectorService";
import { KgDedupService } from "../../src/application/services/kg/KgDedupService";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { NodeVectorRow } from "../../src/application/ports/outbound/NodeVectorStorePort";
import type { KnowledgeWriteOp, WriteResult } from "../../src/domain/kg/types";
import { createKgUpdateTool } from "../../src/adapters/driven/tools/kg-update/KgUpdateTool";
import { BACKGROUND_CONTEXT } from "../../src/adapters/driven/tools/vendor/pi-harness";

// ── 向量 fake（标记驱动——四个标记子空间正交化，与 MARK-BASE 的夹角可
//    精确断言而互不相扰：WARN/DUP/LOW 两两 < 0.8 防同批交叉误报）────────

const V_BASE = Float32Array.from([1, 0, 0, 0]);

function vectorFor(doc: string): Float32Array {
  if (doc.includes("MARK-BASE")) return Float32Array.from(V_BASE);
  if (doc.includes("MARK-WARN")) return Float32Array.from([0.87, Math.sqrt(1 - 0.87 ** 2), 0, 0]);
  if (doc.includes("MARK-DUP")) {
    const third = Math.sqrt(1 - 0.95 ** 2 - 0.19 ** 2);
    return Float32Array.from([0.95, -0.19, third, 0]);
  }
  if (doc.includes("MARK-LOW")) {
    return Float32Array.from([0.5, -0.3, 0, Math.sqrt(1 - 0.5 ** 2 - 0.3 ** 2)]);
  }
  // 无标记：伪随机单位向量（文本哈希驱动——不同节点互不相似）
  let h = 0;
  for (let i = 0; i < doc.length; i += 1) h = (h * 31 + doc.charCodeAt(i)) >>> 0;
  const angle = ((h % 3600) / 3600) * Math.PI * 2;
  return Float32Array.from([0, 0, Math.cos(angle), Math.sin(angle)]);
}

function fakeEmbedding(opts: { fail?: boolean } = {}): EmbeddingPort {
  return {
    endpointLabel: () => "fake",
    embed: async (texts: readonly string[]): Promise<EmbeddingResult> => {
      if (opts.fail === true) throw new Error("嵌入端点炸了");
      return { vectors: texts.map(vectorFor), dim: 4 };
    },
  };
}

// ── 栈（kg-update-add-edge.test.ts 同构 rig）───────────────────

interface Stack {
  readonly root: string;
  readonly proj: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly write: KgWriteService;
  readonly query: KgQueryService;
  readonly vectorService: KgVectorService;
  readonly dedup: KgDedupService;
  readonly tool: ReturnType<typeof createKgUpdateTool>;
}

const stacks: Stack[] = [];

afterAll(() => {
  for (const s of stacks) {
    s.database.closeAll();
    rmSync(s.root, { recursive: true, force: true });
  }
  stacks.length = 0;
});

function freshStack(opts: { endpointMissing?: boolean; embedFail?: boolean } = {}): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-dedup-"));
  const proj = path.join(root, "proj");
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const query = new KgQueryService({ graph, projects: () => [proj] });
  const vectorService = new KgVectorService({
    store,
    embedding: fakeEmbedding({ ...(opts.embedFail === true ? { fail: true } : {}) }),
    resolveEndpoint: () => (opts.endpointMissing === true ? null : { baseUrl: "http://fake", model: "fake-embed" }),
    contentHash: nodeVectorContentHash,
  });
  // 写入口带向量联动（批1 同构——种子写入同样增量重嵌）
  const write = new KgWriteService({ store, vectorSync: vectorService });
  const dedup = new KgDedupService({
    vectors: vectorService,
    store,
    write,
    thresholds: () => ({ warn: 0.8, dup: 0.92 }),
  });
  const tool = createKgUpdateTool({
    query,
    write,
    workspaceRoot: root,
    scanProjects: () => [proj],
    dedup,
  });
  const stack: Stack = { root, proj, database, store, write, query, vectorService, dedup, tool };
  stacks.push(stack);
  return stack;
}

async function call(stack: Stack, params: Record<string, unknown>): Promise<string> {
  const result = await stack.tool.execute("call-1", params as never, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
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

/** 种子：write 面直建 confirmed 基准节点（body 携向量标记）。 */
function seedNode(stack: Stack, id: string, name: string, marker: string): void {
  const r = stack.write.write(stack.proj, {
    kind: "createNode",
    iterationId: "iter-dedup",
    id,
    draft: { kind: "rule", name, digest: `${name}的摘要`, scene: "本规则适用于：查重测试种子", body: `种子正文 ${marker}`, status: "confirmed" },
  } as KnowledgeWriteOp);
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
}

/** 等 fire-and-forget 向量联动落定（批1 onWriteSuccess 嵌入）。 */
async function drain(stack: Stack): Promise<void> {
  await stack.vectorService.drain();
}

// ── ① 三档触发 ────────────────────────────────────────────────

describe("① 查重三档（<0.80 静默 / 0.80-0.92 警告+连线 / ≥0.92 再加候选）", () => {
  test("低相似（cos 0.5）：工具结果零警告、零 similarTo 边、零候选", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-301", "基准规则", "MARK-BASE");
    await drain(stack);

    const out = await call(stack, {
      op: "createNode",
      kind: "rule",
      name: "低相似新节点",
      digest: "低相似摘要",
      scene: "本规则适用于：查重测试",
      body: "正文 MARK-LOW",
    });

    expect(out).toContain("已建节点");
    expect(out).not.toContain("⚠");
    stack.database.knowledgeConnection(stack.proj);
    expect(probe(stack.proj, "SELECT * FROM edges WHERE verb = 'similarTo'")).toHaveLength(0);
    expect(probe(stack.proj, "SELECT * FROM candidates")).toHaveLength(0);
  });

  test("警告档（cos 0.87）：软警告文本 + 自动 similarTo 连线（幂等复合主键），不落候选", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-302", "基准规则", "MARK-BASE");
    await drain(stack);

    const out = await call(stack, {
      op: "createNode",
      kind: "rule",
      name: "近似新节点",
      digest: "近似摘要",
      scene: "本规则适用于：查重测试",
      body: "正文 MARK-WARN",
    });

    // 软警告文本（§5.1 文案）：⚠ + 对端 id/name + 相似度 + 改道指引
    expect(out).toContain("⚠ 已存在相似节点 TR-302");
    expect(out).toContain("《基准规则》");
    expect(out).toContain("相似度 0.87");
    expect(out).toContain("updateNode");
    // similarTo 连线：新节点 → 既有节点
    const created = /已建节点 (TR-\d+)/.exec(out)?.[1];
    expect(created).toBeDefined();
    stack.database.knowledgeConnection(stack.proj);
    const edges = probe<{ src_id: string; verb: string; dst_id: string }>(
      stack.proj,
      "SELECT * FROM edges WHERE verb = 'similarTo'",
    );
    expect(edges).toEqual([{ src_id: created!, verb: "similarTo", dst_id: "TR-302" }]);
    // 警告档不落候选
    expect(probe(stack.proj, "SELECT * FROM candidates")).toHaveLength(0);
  });

  test("重复档（cos 0.95）：以上 + 自动疑似重复候选（body 合规含双方 digest 对照）", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-303", "基准规则", "MARK-BASE");
    await drain(stack);

    const out = await call(stack, {
      op: "createNode",
      kind: "rule",
      name: "重复新节点",
      digest: "重复新节点摘要",
      scene: "本规则适用于：查重测试",
      body: "正文 MARK-DUP",
    });

    const created = /已建节点 (TR-\d+)/.exec(out)?.[1];
    expect(created).toBeDefined();
    expect(out).toContain("⚠ 已存在相似节点 TR-303");
    expect(out).toContain("相似度 0.95");
    // similarTo 连线照建
    stack.database.knowledgeConnection(stack.proj);
    expect(
      probe(stack.proj, "SELECT * FROM edges WHERE verb = 'similarTo' AND src_id = ? AND dst_id = 'TR-303'", created!),
    ).toHaveLength(1);
    // 自动候选：一行，title 疑似重复 + 相似度；body 非空（TR-33）+ 双方 digest
    // 对照（TR-56 三要素：事实描述/决策的点/决策后的效果——TR-147 姿势内嵌 body）
    const cands = probe<{ id: string; title: string; body: string; target_node: string | null; status: string }>(
      stack.proj,
      "SELECT * FROM candidates",
    );
    expect(cands).toHaveLength(1);
    const cand = cands[0]!;
    expect(cand.status).toBe("pending");
    expect(cand.title).toContain("疑似重复");
    expect(cand.title).toContain("0.95");
    expect(cand.body.trim().length).toBeGreaterThan(0);
    expect(cand.body).toContain("重复新节点摘要"); // 新节点 digest
    expect(cand.body).toContain("基准规则的摘要"); // 既有节点 digest
    expect(cand.body).toContain("事实描述");
    expect(cand.body).toContain("决策的点");
    expect(cand.body).toContain("决策后的效果");
    expect(cand.target_node).toBe(created!); // 标的 = 疑似冗余的新节点（合并方向）
  });
});

// ── ② 软闸不阻塞（可选件纪律——降级 warn 不挡写）────────────────

describe("② 软闸不阻塞：查重失败/端点缺失降级 warn，落库照常", () => {
  test("端点缺失：建点成功 + 降级 warn 文案 + 零边零候选", async () => {
    const stack = freshStack({ endpointMissing: true });
    seedNode(stack, "TR-304", "基准规则", "MARK-BASE");
    await drain(stack);

    const out = await call(stack, {
      op: "createNode",
      kind: "rule",
      name: "端点缺失新节点",
      digest: "摘要",
      scene: "本规则适用于：查重测试",
      body: "正文 MARK-DUP",
    });

    expect(out).toContain("已建节点"); // 落库照常
    expect(out).toContain("查重"); // 降级交代（warn）
    expect(out).not.toContain("⚠ 已存在相似节点"); // 未查成，不虚报
    stack.database.knowledgeConnection(stack.proj);
    expect(probe(stack.proj, "SELECT * FROM nodes WHERE name = '端点缺失新节点'")).toHaveLength(1);
    expect(probe(stack.proj, "SELECT * FROM edges")).toHaveLength(0);
    expect(probe(stack.proj, "SELECT * FROM candidates")).toHaveLength(0);
  });

  test("嵌入失败：建点成功 + 降级 warn 文案（绝不抛错挡写）", async () => {
    const stack = freshStack({ embedFail: true });
    const out = await call(stack, {
      op: "createNode",
      kind: "rule",
      name: "嵌入失败新节点",
      digest: "摘要",
      scene: "本规则适用于：查重测试",
      body: "正文 MARK-DUP",
    });
    expect(out).toContain("已建节点");
    expect(out).toContain("查重");
    stack.database.knowledgeConnection(stack.proj);
    expect(probe(stack.proj, "SELECT * FROM nodes WHERE name = '嵌入失败新节点'")).toHaveLength(1);
    expect(probe(stack.proj, "SELECT * FROM edges")).toHaveLength(0);
  });
});

// ── ③ similarTo 边动词扩员（D3）────────────────────────────────

describe("③ similarTo 词表扩员：addEdge/removeEdge 同径 + 词表外仍 KG_E_VERB", () => {
  test("similarTo 手工建边幂等（复合主键去重）+ removeEdge 严格三元组可删 + 越界动词拒绝", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-305", "节点甲", "MARK-BASE");
    seedNode(stack, "TR-306", "节点乙", "MARK-LOW");
    await drain(stack);

    // 手工建边（LLM 可手工建/删——D3 词表扩员）：二次声明幂等
    for (let i = 0; i < 2; i += 1) {
      const out = await call(stack, { op: "addEdge", srcId: "TR-305", verb: "similarTo", dstId: "TR-306" });
      expect(out).toContain("已建边");
    }
    stack.database.knowledgeConnection(stack.proj);
    expect(
      probe(stack.proj, "SELECT * FROM edges WHERE verb = 'similarTo' AND src_id = 'TR-305' AND dst_id = 'TR-306'"),
    ).toHaveLength(1);

    // 词表外动词仍 KG_E_VERB（KG_E_VERB 语义不变）
    let verbError = "";
    try {
      await call(stack, { op: "addEdge", srcId: "TR-305", verb: "similarity", dstId: "TR-306" });
    } catch (err) {
      verbError = (err as Error).message;
    }
    expect(verbError).toContain("KG_E_VERB");

    // removeEdge 同径可删（严格三元组）
    const out = await call(stack, { op: "removeEdge", srcId: "TR-305", verb: "similarTo", dstId: "TR-306" });
    expect(out).toContain("已删边");
    expect(probe(stack.proj, "SELECT * FROM edges WHERE verb = 'similarTo'")).toHaveLength(0);
  });

  test("查重闸自动边幂等：同对相似节点重复落点不重复建边（复合主键去重）", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-307", "基准规则", "MARK-BASE");
    await drain(stack);
    // 同名同内容再建一点（模拟重复建点）——两新节点各自与基准连线，各 1 行
    for (const name of ["近似甲", "近似乙"]) {
      await call(stack, {
        op: "createNode",
        kind: "rule",
        name,
        digest: `${name}摘要`,
        scene: "本规则适用于：查重测试",
        body: "正文 MARK-WARN",
      });
    }
    stack.database.knowledgeConnection(stack.proj);
    const edges = probe<{ src_id: string }>(
      stack.proj,
      "SELECT * FROM edges WHERE verb = 'similarTo' AND dst_id = 'TR-307'",
    );
    expect(edges).toHaveLength(2); // 两新节点各一线（不同复合主键）
  });
});

// ── ⑤ 批量合并 + updateNode 不触发 ─────────────────────────────

describe("⑤ batchCreateNodes 警告合并 / updateNode 不触发", () => {
  test("批量建点逐条查重：警告合并回一个工具结果（每对恰一行 ⚠）+ 边/候选各自落账", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-308", "基准规则", "MARK-BASE");
    await drain(stack);

    const out = await call(stack, {
      op: "batchCreateNodes",
      nodes: [
        { kind: "rule", name: "批量近似", digest: "批量近似摘要", scene: "本规则适用于：查重测试", body: "正文 MARK-WARN" },
        { kind: "rule", name: "批量重复", digest: "批量重复摘要", scene: "本规则适用于：查重测试", body: "正文 MARK-DUP" },
        { kind: "rule", name: "批量无关", digest: "批量无关摘要", scene: "本规则适用于：查重测试", body: "正文 MARK-LOW" },
      ],
    });

    expect(out).toContain("已批量建节点 3 个");
    // 合并回工具结果：两对命中各恰一行 ⚠（警告档 + 重复档），不逐条刷屏
    const warnLines = out.split("\n").filter((l) => l.startsWith("⚠"));
    expect(warnLines).toHaveLength(2);
    expect(warnLines.join("\n")).toContain("0.87");
    expect(warnLines.join("\n")).toContain("0.95");
    stack.database.knowledgeConnection(stack.proj);
    expect(probe(stack.proj, "SELECT * FROM edges WHERE verb = 'similarTo'")).toHaveLength(2);
    expect(probe(stack.proj, "SELECT * FROM candidates")).toHaveLength(1);
  });

  test("同批互似对只报一次（对去重——批量刷屏防护）", async () => {
    const stack = freshStack();
    const out = await call(stack, {
      op: "batchCreateNodes",
      nodes: [
        { kind: "rule", name: "互似甲", digest: "甲摘要", scene: "本规则适用于：查重测试", body: "正文 MARK-WARN" },
        { kind: "rule", name: "互似乙", digest: "乙摘要", scene: "本规则适用于：查重测试", body: "正文 MARK-WARN" },
      ],
    });
    const warnLines = out.split("\n").filter((l) => l.startsWith("⚠"));
    expect(warnLines).toHaveLength(1); // 甲↔乙一对恰一行（cos=1 → 重复档）
    stack.database.knowledgeConnection(stack.proj);
    expect(probe(stack.proj, "SELECT * FROM edges WHERE verb = 'similarTo'")).toHaveLength(1);
    expect(probe(stack.proj, "SELECT * FROM candidates")).toHaveLength(1);
  });

  test("updateNode 不触发查重（改既有节点不该被拦）", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-309", "基准规则", "MARK-BASE");
    seedNode(stack, "TR-310", "被改节点", "MARK-LOW");
    await drain(stack);

    const out = await call(stack, {
      op: "updateNode",
      nodeId: "TR-310",
      patch: { body: "改成高度相似正文 MARK-DUP" },
    });
    expect(out).toContain("已更新节点");
    expect(out).not.toContain("⚠");
    stack.database.knowledgeConnection(stack.proj);
    expect(probe(stack.proj, "SELECT * FROM edges WHERE verb = 'similarTo'")).toHaveLength(0);
    expect(probe(stack.proj, "SELECT * FROM candidates")).toHaveLength(0);
  });
});

// ── 向量邻居读面（NodeVectorStorePort 批2 开面）────────────────

describe("NodeVectorStorePort.listActiveNodeVectors（查重邻居读面）", () => {
  test("活跃节点全量 + superseded 不入面 + 携 name/digest + blob 反序列化", async () => {
    const stack = freshStack();
    seedNode(stack, "TR-311", "活跃甲", "MARK-BASE");
    seedNode(stack, "TR-312", "将亡乙", "MARK-LOW");
    await drain(stack);
    const sr = stack.write.write(stack.proj, {
      kind: "supersede",
      iterationId: "iter-dedup",
      nodeId: "TR-312",
      reason: "测试翻态",
    } as KnowledgeWriteOp);
    if (!sr.ok) throw new Error("supersede 失败");

    const neighbors = stack.store.listActiveNodeVectors(stack.proj);
    expect(neighbors.map((n) => n.nodeId)).toEqual(["TR-311"]);
    expect(neighbors[0]!.name).toBe("活跃甲");
    expect(neighbors[0]!.digest).toBe("活跃甲的摘要");
    expect(neighbors[0]!.embedding.length).toBe(4);
    expect([...neighbors[0]!.embedding].map((v) => Math.round(v * 100) / 100)).toEqual([1, 0, 0, 0]);
  });
});

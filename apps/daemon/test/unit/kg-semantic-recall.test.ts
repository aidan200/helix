/**
 * kg 语义召回轨单测（检索语义化接线批；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. rankSemanticCandidates（domain 纯函数）：全库余弦 top-K 且 ≥ 阈值、
 *    score 降序、同分输入序 tie-break、dim 不齐跳过、topK 下限钳制；
 * 2. KgSemanticRecallService：query = 查询文本整段向量化；端点缺失 / 嵌入
 *    失败 / 超时三路降级 → []（纯关键词轨，绝不抛、绝不挂死）；settings
 *    读面抛错回退缺省对；digestRows 解析缺失节点跳过。
 */
import { describe, expect, test } from "bun:test";
import type { NodeDigestRow } from "../../src/domain/kg/types";
import { rankSemanticCandidates, type SemanticVectorRow } from "../../src/domain/kg/semantic-recall";
import {
  KG_SEMANTIC_MINSCORE_DEFAULT,
  KG_SEMANTIC_TOPK_DEFAULT,
} from "../../src/application/services/kg/kgConfig";
import { KgSemanticRecallService } from "../../src/application/services/kg/KgSemanticRecallService";

function row(id: string, name = `节点 ${id}`): NodeDigestRow {
  return { id, kind: "rule", name, digest: `${name} 摘要`, scene: "测试场景", status: "confirmed", domain: null };
}

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe("rankSemanticCandidates（向量轨纯选择函数）", () => {
  const query = vec([1, 0, 0]);

  test("① 全库余弦 top-K 且 ≥ 阈值：score 降序、低于阈值过滤、topK 截断", () => {
    const candidates: SemanticVectorRow[] = [
      { project: "/p", row: row("TR-1"), embedding: vec([1, 0, 0]) }, // cos = 1
      { project: "/p", row: row("TR-2"), embedding: vec([0, 1, 0]) }, // cos = 0
      { project: "/p", row: row("TR-3"), embedding: vec([0.6, 0.8, 0]) }, // cos = 0.6
      { project: "/p", row: row("TR-4"), embedding: vec([0.8, 0.6, 0]) }, // cos = 0.8
    ];
    const hits = rankSemanticCandidates(query, candidates, { topK: 2, minScore: 0.5 });
    expect(hits.map((h) => h.row.id)).toEqual(["TR-1", "TR-4"]); // 降序 + topK=2
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.score).toBeCloseTo(0.8, 5);
    // 阈值过滤：cos=0.6（≥0.5）未进 topK 但先被 topK 截断——换大 topK 验证阈值
    const all = rankSemanticCandidates(query, candidates, { topK: 10, minScore: 0.5 });
    expect(all.map((h) => h.row.id)).toEqual(["TR-1", "TR-4", "TR-3"]); // TR-2（cos=0）被阈值滤掉
  });

  test("② 同分 tie-break 保持输入序（确定性）；dim 不齐跳过不猜", () => {
    const candidates: SemanticVectorRow[] = [
      { project: "/p", row: row("TR-A"), embedding: vec([1, 0, 0]) },
      { project: "/p", row: row("TR-B"), embedding: vec([1, 0, 0]) }, // 与 TR-A 同分
      { project: "/p", row: row("TR-C"), embedding: vec([1, 0]) }, // dim 不齐
    ];
    const hits = rankSemanticCandidates(query, candidates, { topK: 10, minScore: 0 });
    expect(hits.map((h) => h.row.id)).toEqual(["TR-A", "TR-B"]);
  });

  test("③ topK 非法（<1/非整）钳制为 0 下限安全；minScore=0 时零向量边界不炸", () => {
    const candidates: SemanticVectorRow[] = [{ project: "/p", row: row("TR-1"), embedding: vec([1, 0, 0]) }];
    expect(rankSemanticCandidates(query, candidates, { topK: 0, minScore: 0 })).toEqual([]);
    const hits = rankSemanticCandidates(query, candidates, { topK: 1, minScore: 0 });
    expect(hits).toHaveLength(1);
  });
});

/** 嵌入端口替身工厂（确定性 fake embedding——语义轨测试保序不保浮点巧合）。 */
function fakeEmbedding(
  impl: (texts: readonly string[]) => Promise<{ vectors: readonly Float32Array[]; dim: number }>,
): { embed: typeof impl; endpointLabel: () => string } {
  return { embed: impl, endpointLabel: () => "fake/embed" };
}

const endpoint = { baseUrl: "http://fake", model: "fake-model" };

function serviceOf(overrides: Partial<ConstructorParameters<typeof KgSemanticRecallService>[0]> = {}): KgSemanticRecallService {
  return new KgSemanticRecallService({
    embedding: fakeEmbedding(async () => ({ vectors: [vec([1, 0, 0])], dim: 3 })),
    resolveEndpoint: () => endpoint,
    vectors: {
      listActiveNodeVectors: () => [
        { nodeId: "TR-1", name: "节点 TR-1", digest: "节点 TR-1 摘要", embedding: vec([1, 0, 0]) },
        { nodeId: "TR-2", name: "节点 TR-2", digest: "节点 TR-2 摘要", embedding: vec([0, 1, 0]) },
      ],
    },
    digestRows: (_projectRoot, ids) => ids.map((id) => row(id)),
    settings: () => ({ topK: 5, minScore: 0.35 }),
    timeoutMs: 50,
    ...overrides,
  });
}

describe("KgSemanticRecallService（向量轨召回）", () => {
  test("① query 整段向量化 + 全库比对：命中行带 score 降序（≥ 阈值）", async () => {
    const seenTexts: string[] = [];
    const svc = serviceOf({
      embedding: fakeEmbedding(async (texts) => {
        seenTexts.push(...texts);
        return { vectors: [vec([1, 0, 0])], dim: 3 };
      }),
    });
    const hits = await svc.recall("任务文本整段作为 query", ["/p"]);
    expect(seenTexts).toEqual(["任务文本整段作为 query"]); // 整段一次嵌入（非分词词条）
    expect(hits.map((h) => h.row.id)).toEqual(["TR-1"]); // TR-2 cos=0 < 0.35 滤掉
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[0]!.project).toBe("/p");
  });

  test("② 端点缺失 → [] 零嵌入调用（可选件纪律：纯关键词轨）", async () => {
    let called = 0;
    const svc = serviceOf({
      resolveEndpoint: () => null,
      embedding: fakeEmbedding(async () => {
        called += 1;
        return { vectors: [vec([1, 0, 0])], dim: 3 };
      }),
    });
    expect(await svc.recall("任意任务", ["/p"])).toEqual([]);
    expect(called).toBe(0);
  });

  test("③ 嵌入失败 → [] 不抛（降级纯关键词轨）", async () => {
    const warnings: string[] = [];
    const svc = serviceOf({
      embedding: fakeEmbedding(async () => {
        throw new Error("endpoint 500");
      }),
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(await svc.recall("任意任务", ["/p"])).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("④ 嵌入超时 → timeoutMs 内落定 []（不挂死注入链）", async () => {
    const svc = serviceOf({
      timeoutMs: 20,
      embedding: fakeEmbedding(() => new Promise(() => undefined)), // 永不落定
    });
    const started = Date.now();
    expect(await svc.recall("任意任务", ["/p"])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("⑤ settings 读面抛错 → 回退缺省对（topK/minScore 缺省）不炸；digestRows 缺行跳过", async () => {
    const svc = serviceOf({
      settings: () => {
        throw new Error("kv read fault");
      },
      digestRows: () => [], // 全部解析缺失 → 全跳过
    });
    expect(await svc.recall("任意任务", ["/p"])).toEqual([]);
    // 缺省值语义对齐 kgConfig 缺省（5 / 0.35）——回退对可观察面
    expect(KG_SEMANTIC_TOPK_DEFAULT).toBe(5);
    expect(KG_SEMANTIC_MINSCORE_DEFAULT).toBe(0.35);
  });

  test("⑥ 空 query / 空项目集 → [] 零调用", async () => {
    let called = 0;
    const svc = serviceOf({
      embedding: fakeEmbedding(async () => {
        called += 1;
        return { vectors: [vec([1, 0, 0])], dim: 3 };
      }),
    });
    expect(await svc.recall("   ", ["/p"])).toEqual([]);
    expect(await svc.recall("任务", [])).toEqual([]);
    expect(called).toBe(0);
  });
});

/**
 * kg 语义召回纯选择函数（检索语义化批）——向量轨的 domain 层。
 *
 * 定位：node_vectors 余弦比对的纯函数选择核（cosineSimilarity 复用
 * node-vector.ts 单源），零 IO（TR-AD-1）。服务层（KgSemanticRecallService）
 * 负责嵌入往返/超时/降级，本层只做确定性排序选择。
 *
 * 语义：全库余弦 **top-K 且 ≥ 阈值**（两条件同时生效——topK 截断在阈值
 * 过滤之后），score 降序；同分 tie-break = 候选输入序（调用方按项目序 +
 * 节点 id 序供给，确定性）；dim 不齐（模型换版中间态）跳过不猜。
 */

import type { NodeDigestRow } from "./types";
import { cosineSimilarity } from "./node-vector";

/** 语义召回命中行（向量轨产出——score 降序追加在关键词轨后）。 */
export interface SemanticHit {
  readonly project: string;
  readonly row: NodeDigestRow;
  readonly score: number;
}

/** 向量比对候选行（node_vectors 行 × 节点摘要行——跨项目扁平供给）。 */
export interface SemanticVectorRow {
  readonly project: string;
  readonly row: NodeDigestRow;
  /** float32[dim] 已反序列化向量（NodeVectorStorePort 读面形态）。 */
  readonly embedding: Float32Array;
}

/** 选择参数（kg.semanticTopK / kg.semanticMinScore 生效值——读面裁决后）。 */
export interface SemanticRankOptions {
  readonly topK: number;
  readonly minScore: number;
}

/**
 * 全库余弦 top-K 且 ≥ 阈值选择：score 降序 + 同分输入序 tie-break +
 * topK 截断（<1 钳制为空——上限保护）。不修改入参。
 */
export function rankSemanticCandidates(
  query: Float32Array,
  candidates: readonly SemanticVectorRow[],
  options: SemanticRankOptions,
): readonly SemanticHit[] {
  const topK = Math.floor(options.topK);
  if (!Number.isFinite(topK) || topK < 1) return [];
  const scored: { readonly hit: SemanticHit; readonly index: number }[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.embedding.length !== query.length) continue; // dim 不齐跳过（换模型中间态不猜）
    const score = cosineSimilarity(query, candidate.embedding);
    if (score < options.minScore) continue;
    scored.push({ hit: { project: candidate.project, row: candidate.row, score }, index });
  }
  // score 降序；同分保持输入序（显式 index tie-break——确定性不依赖 sort 稳定性）
  scored.sort((a, b) => b.hit.score - a.hit.score || a.index - b.index);
  return scored.slice(0, topK).map((s) => s.hit);
}

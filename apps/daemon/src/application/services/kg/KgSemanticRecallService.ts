/**
 * KgSemanticRecallService —— kg 语义召回轨（检索语义化批）。
 *
 * 职责：任务文本/query 整段向量化（短词条 embedding 信息量低——语义检索
 * 的价值是「用词不一致也能命中」）→ 全库余弦 top-K 且 ≥ 阈值
 * （rankSemanticCandidates 纯函数单源）→ 命中行（score 降序）。
 *
 * 可选件纪律（E-306 消费契约）：嵌入一律经 EmbeddingPort + resolveEndpoint
 * （resolveDefault 窄投影）；**端点缺失 / 嵌入失败 / 超时 → 一律回落纯
 * 关键词轨**（recall 返回 []，绝不抛、绝不挂死注入链——降级是可用性保护）。
 * 查询向量往返设超时上限（KG_SEMANTIC_QUERY_TIMEOUT_MS 缺省 800ms——
 * 用户裁决：延迟预算放开但不挂死；超时降级不重试）。
 */
import type { EmbeddingEndpointConfig, EmbeddingPort } from "../../ports/outbound/EmbeddingPort";
import type { NodeVectorStorePort } from "../../ports/outbound/NodeVectorStorePort";
import type { NodeDigestRow } from "../../../domain/kg/types";
import {
  rankSemanticCandidates,
  type SemanticHit,
  type SemanticVectorRow,
} from "../../../domain/kg/semantic-recall";
import {
  KG_SEMANTIC_MINSCORE_DEFAULT,
  KG_SEMANTIC_TOPK_DEFAULT,
  type KgSemanticRecallSettings,
} from "./kgConfig";

export type { SemanticHit };

/** 查询向量往返超时上限（超时 → 降级纯关键词轨，不挂死注入链）。 */
export const KG_SEMANTIC_QUERY_TIMEOUT_MS = 800;

export interface KgSemanticRecallDeps {
  readonly embedding: EmbeddingPort;
  /** 默认端点解析（resolveDefault 单点窄投影——null = 向量面不可用）。 */
  readonly resolveEndpoint: () => EmbeddingEndpointConfig | null;
  /** 活跃节点向量读面（E-307 listActiveNodeVectors——本服务只读不动基建）。 */
  readonly vectors: Pick<NodeVectorStorePort, "listActiveNodeVectors">;
  /** 向量行 → 节点摘要行解析（KnowledgeGraphPort.getDigestRows 窄投影；缺失行跳过）。 */
  readonly digestRows: (projectRoot: string, ids: readonly string[]) => readonly NodeDigestRow[];
  /** 语义召回对生效值（kgConfig 读面裁决单点；运行期即热）。 */
  readonly settings: () => KgSemanticRecallSettings;
  /** 查询向量往返超时（缺省 KG_SEMANTIC_QUERY_TIMEOUT_MS；测试可缩）。 */
  readonly timeoutMs?: number;
  readonly logger?: { warn(message: string): void };
}

export class KgSemanticRecallService {
  private readonly deps: KgSemanticRecallDeps;

  constructor(deps: KgSemanticRecallDeps) {
    this.deps = deps;
  }

  /**
   * 语义召回（向量轨命中行，score 降序）：任何失败路径 → []（降级纯
   * 关键词轨——调用方零感知差异）。projects 顺序 = 项目序（同分 tie-break）。
   */
  async recall(queryText: string, projects: readonly string[]): Promise<readonly SemanticHit[]> {
    if (queryText.trim() === "" || projects.length === 0) return [];
    if (this.deps.resolveEndpoint() === null) return []; // 端点缺失 → 向量面不可用（可选件纪律）
    let settings: KgSemanticRecallSettings;
    try {
      settings = this.deps.settings();
    } catch (err) {
      this.warn(`kg 语义召回降级：阈值读取失败（${(err as Error).message}）——回退缺省对 ${KG_SEMANTIC_TOPK_DEFAULT}/${KG_SEMANTIC_MINSCORE_DEFAULT}`);
      settings = { topK: KG_SEMANTIC_TOPK_DEFAULT, minScore: KG_SEMANTIC_MINSCORE_DEFAULT };
    }
    const query = await this.embedQuery(queryText);
    if (query === null) return []; // 嵌入失败/超时（已 warn）
    const candidates: SemanticVectorRow[] = [];
    for (const project of projects) {
      try {
        const neighbors = this.deps.vectors.listActiveNodeVectors(project);
        if (neighbors.length === 0) continue;
        const rows = new Map(
          this.deps.digestRows(project, neighbors.map((n) => n.nodeId)).map((r) => [r.id, r]),
        );
        for (const neighbor of neighbors) {
          const row = rows.get(neighbor.nodeId);
          if (row === undefined) continue; // 摘要行缺失（竞态删除）——跳过不猜
          candidates.push({ project, row, embedding: neighbor.embedding });
        }
      } catch (err) {
        this.warn(`kg 语义召回降级（${project}）：向量读面失败（${(err as Error).message}）——该项目跳过`);
      }
    }
    return rankSemanticCandidates(query, candidates, settings);
  }

  // ── 内部 ──────────────────────────────────────────────────

  /** 查询文本整段嵌入（超时/失败 → null——降级信号，已 warn）。 */
  private async embedQuery(text: string): Promise<Float32Array | null> {
    const timeoutMs = this.deps.timeoutMs ?? KG_SEMANTIC_QUERY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const result = await Promise.race([this.embed(text), timeout]);
      if (result === null) this.warn(`kg 语义召回降级：查询嵌入超时（>${timeoutMs}ms）——回落纯关键词轨`);
      return result;
    } catch (err) {
      this.warn(`kg 语义召回降级：查询嵌入失败（${(err as Error).message}）——回落纯关键词轨`);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 单条嵌入（EmbeddingPort 契约：响应缺向量视为失败）。 */
  private async embed(text: string): Promise<Float32Array> {
    const { vectors } = await this.deps.embedding.embed([text]);
    const vector = vectors[0];
    if (vector === undefined) throw new Error("嵌入响应缺向量");
    return vector;
  }

  private warn(message: string): void {
    this.deps.logger?.warn(message);
  }
}

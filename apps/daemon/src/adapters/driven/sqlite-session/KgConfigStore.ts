import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { KgConfigPatch, KgConfigPort } from "../../../application/ports/outbound/KgConfigPort";
import {
  KG_SEMANTIC_MINSCORE_KEY,
  KG_SEMANTIC_TOPK_KEY,
  KG_SIMILARITY_DUP_KEY,
  KG_SIMILARITY_WARN_KEY,
  resolveKgSemanticRecallSettings,
  resolveKgSimilarityThresholds,
  type KgConfigEffective,
} from "../../../application/services/kg/kgConfig";

/**
 * KgConfigStore —— 知识库配置域的读写实现（批2 WP-C「知识库」配置组；
 * SummaryConfigStore 同构：RuntimeConfig KV 直读写，键位/解析单源
 * ../.. /kg/kgConfig.ts——本存储只做写入路由，值语义在读面兜底）。写面经
 * RuntimeConfigPort → WriteQueue 单写通道（AG-06）。
 *
 * 生效语义：运行期即热——查重闸触发前实时读（KgDedupService.thresholds），
 * 设置保存后下一次建点查重即按新阈值执行，无需重启。写面照存原值（不做
 * 前置值校验——非法/颠倒由读面裁决回退，回执回生效值所见即所得）。
 */
export class KgConfigStore implements KgConfigPort {
  private readonly runtimeConfig: RuntimeConfigPort;

  constructor(runtimeConfig: RuntimeConfigPort) {
    this.runtimeConfig = runtimeConfig;
  }

  /** 当前配置（生效值读面——非法/颠倒已由读面裁决回退；两对同框）。 */
  current(): KgConfigEffective {
    const similarity = resolveKgSimilarityThresholds(this.runtimeConfig);
    const semantic = resolveKgSemanticRecallSettings(this.runtimeConfig);
    return {
      warn: similarity.warn,
      dup: similarity.dup,
      semanticTopK: semantic.topK,
      semanticMinScore: semantic.minScore,
    };
  }

  /** 部分更新写入（携带项写入，未携带项保留现值；落盘完成即返回 + 回读新生效值）。 */
  async set(patch: KgConfigPatch): Promise<KgConfigEffective> {
    if (patch.similarityWarn !== undefined) {
      await this.runtimeConfig.set(KG_SIMILARITY_WARN_KEY, String(patch.similarityWarn));
    }
    if (patch.similarityDup !== undefined) {
      await this.runtimeConfig.set(KG_SIMILARITY_DUP_KEY, String(patch.similarityDup));
    }
    if (patch.semanticTopK !== undefined) {
      await this.runtimeConfig.set(KG_SEMANTIC_TOPK_KEY, String(patch.semanticTopK));
    }
    if (patch.semanticMinScore !== undefined) {
      await this.runtimeConfig.set(KG_SEMANTIC_MINSCORE_KEY, String(patch.semanticMinScore));
    }
    return this.current();
  }
}

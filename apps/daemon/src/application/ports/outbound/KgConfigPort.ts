/**
 * 知识库配置出站端口（outbound，批2 WP-C「知识库」配置组）。
 *
 * 职责：kg.* 知识库配置域（查重阈值 kg.similarityWarn / kg.similarityDup
 * 两键；后续 kg 新增可配置项归宿同域）的读写面。实现体 =
 * driven/sqlite-session/KgConfigStore（RuntimeConfigPort KV——memory.* /
 * summary.* 域同构形态：键位与值语义单源在
 * application/services/kg/kgConfig.ts）。写面经 WriteQueue 单写通道（AG-06）。
 *
 * 生效语义：运行期即热——查重闸每次触发前实时读；写面不做前置值校验
 *（memoryConfig「读面兜底」哲学），协议 handler 只做类型闸（invalid_payload），
 * 回执恒回**生效值**（读面裁决后——所见即所得，颠倒/非法已回退可见）。
 */
import type { KgConfigPatch, KgSimilarityThresholds } from "../../services/kg/kgConfig";

export type { KgConfigPatch, KgSimilarityThresholds };

export interface KgConfigPort {
  /** 当前配置（生效值读面——resolveKgSimilarityThresholds 单源）。 */
  current(): KgSimilarityThresholds;
  /** 部分更新写入（单写通道，落盘完成即返回；回读新生效值）。 */
  set(patch: KgConfigPatch): Promise<KgSimilarityThresholds>;
}

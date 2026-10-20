/**
 * 知识库配置出站端口（outbound，批2 WP-C「知识库」配置组）。
 *
 * 职责：kg.* 知识库配置域（查重阈值 kg.similarityWarn / kg.similarityDup +
 * 语义召回 kg.semanticTopK / kg.semanticMinScore 四键；后续 kg 新增可配置
 * 项归宿同域）的读写面。实现体 =
 * driven/sqlite-session/KgConfigStore（RuntimeConfigPort KV——memory.* /
 * summary.* 域同构形态：键位与值语义单源在
 * application/services/kg/kgConfig.ts）。写面经 WriteQueue 单写通道（AG-06）。
 *
 * 生效语义：运行期即热——查重闸每次触发前实时读；写面不做前置值校验
 *（memoryConfig「读面兜底」哲学），协议 handler 只做类型闸（invalid_payload），
 * 回执恒回**生效值**（读面裁决后——所见即所得，颠倒/非法已回退可见）。
 */
/**
 * 配置值类型定义在端口本身（评审 low #45：端口作为边界不得反向 import
 * 服务实现模块取类型——依赖方向 = services/kg/kgConfig 反向消费本文件，
 * kgConfig 只做 re-export 保既有 import 面）。
 */

/** 查重阈值生效对（读面解析产物——查重闸与 config.get/set_kg 回执同形取数）。 */
export interface KgSimilarityThresholds {
  /** 软警告 + similarTo 连线触发线。 */
  readonly warn: number;
  /** 疑似重复候选触发线。 */
  readonly dup: number;
}

/** 配置写面部分更新（config.set_kg 载荷同形；携带项写入未携带项保留）。 */
export interface KgConfigPatch {
  readonly similarityWarn?: number;
  readonly similarityDup?: number;
  readonly semanticTopK?: number;
  readonly semanticMinScore?: number;
}

/** 知识库配置组生效值（查重阈值对 + 语义召回对——config.get/set_kg 回执同形；
 *  结构上是 KgSimilarityThresholds 超集，既有阈值消费点结构性兼容）。 */
export interface KgConfigEffective extends KgSimilarityThresholds {
  readonly semanticTopK: number;
  readonly semanticMinScore: number;
}

export interface KgConfigPort {
  /** 当前配置（生效值读面——resolveKg* 读面裁决单点；两对同框回显）。 */
  current(): KgConfigEffective;
  /** 部分更新写入（单写通道，落盘完成即返回；回读新生效值）。 */
  set(patch: KgConfigPatch): Promise<KgConfigEffective>;
}

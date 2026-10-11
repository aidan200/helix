/**
 * kg 节点向量存储出站端口（outbound，批1 WP-B）。
 *
 * 职责：node_vectors 表（.helix-kg/kg.db 内）的读写面——节点向量是**可再生
 * 缓存**（文本唯一 source of truth，hash/model 判据增量重嵌），按节点单行
 * upsert。真实实现在 adapters/driven/sqlite-kg/SqliteKnowledgeStore
 * （AG-06 写白名单零新增——node_vectors 写语句收口同一文件）；测试注入
 * 内存 fake。
 *
 * 纪律：embedding BLOB 不出 meta 读面（读面只回判据字段）；全量余弦场景
 * 的向量读面后续（批2 查重闸）再开——本端口刻意最小。
 */

/** 向量行判据字段（blob 不出此读面）。 */
export interface NodeVectorMeta {
  readonly nodeId: string;
  /** sha256(doc)——增量重嵌判据。 */
  readonly contentHash: string;
  /** 嵌入模型标识（换版重嵌判据）。 */
  readonly model: string;
  /** 向量维度（E-224 dim 锁表思想：换维度 = 全量重嵌）。 */
  readonly dim: number;
  /** 最近嵌入时间（epoch ms）。 */
  readonly embeddedAt: number;
}

/** 向量行全量（含 blob——仅 upsert 入参形态）。 */
export interface NodeVectorRow extends NodeVectorMeta {
  /** float32[dim] 序列化向量。 */
  readonly embedding: Float32Array;
}

/**
 * 查重邻居行（批2 WP-C 查重闸比对面）：活跃节点向量 + 警告/候选数据源
 * （name = 软警告文案，digest = 疑似重复候选双方对照）——blob 只出此读面
 *（meta 读面仍不携 blob；全量余弦场景在此开面，端口演进按批2 兑现）。 */
export interface NodeVectorNeighbor {
  readonly nodeId: string;
  readonly name: string;
  readonly digest: string;
  /** float32[dim] 反序列化向量（BLOB 读面出此形）。 */
  readonly embedding: Float32Array;
}

/** 嵌入目标（活跃节点文本投影 + 现有向量 meta——回填/修复路径取数面）。 */
export interface NodeEmbedTarget {
  readonly nodeId: string;
  readonly name: string;
  readonly scene: string;
  readonly digest: string;
  readonly body: string;
  /** 现有向量判据（null = 缺失向量——修复路径标的）。 */
  readonly vector: NodeVectorMeta | null;
}

export interface NodeVectorStorePort {
  /** upsert（同 node_id 单行覆盖写）。 */
  upsertNodeVector(projectRoot: string, row: NodeVectorRow): void;
  /** 删向量（supersede 消费面：被推翻节点不参与后续相似度比对）。 */
  deleteNodeVector(projectRoot: string, nodeId: string): void;
  /** 向量判据读面（缺失 = null）。 */
  getNodeVectorMeta(projectRoot: string, nodeId: string): NodeVectorMeta | null;
  /** 嵌入目标单点读（节点不存在/非活跃 = null）。 */
  getNodeEmbedTarget(projectRoot: string, nodeId: string): NodeEmbedTarget | null;
  /** 活跃节点全集（status ≠ superseded——superseded 留史不参与相似度）。 */
  listEmbedTargets(projectRoot: string): readonly NodeEmbedTarget[];
  /** 查重邻居面（批2 WP-C）：活跃节点（status ≠ superseded）的向量全量
   *  读面（含 name/digest——软警告与疑似重复候选对照数据源；仅已嵌入
   *  节点在面，缺失向量不参与比对（回填修复后自然入面））。 */
  listActiveNodeVectors(projectRoot: string): readonly NodeVectorNeighbor[];
  /** 向量行计数（回填报告/测试判据）。 */
  countNodeVectors(projectRoot: string): number;
}

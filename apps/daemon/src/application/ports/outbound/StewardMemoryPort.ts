/**
 * 管家长期记忆存储出站端口（outbound，管家记忆 B1 批）。
 *
 * 职责：记忆条目（文本 + 元数据 + 向量）的持久化与语义检索。实现体 =
 * driven steward-memory/SqliteVecMemoryStore（better-sqlite3 + sqlite-vec
 * 扩展，独立文件 `<home>/steward_memory.db`——与 helix.db（bun:sqlite +
 * WriteQueue，AG-06 单写面）物理隔离：vec0 只能活在 better-sqlite3
 * 连接里，两种引擎同文件必打架；且本库仅管家记忆域单写者，无跨面并发）。
 *
 * 形态纪律（B1 裁决）：
 * - 文本条目是唯一 source of truth，向量是可再生缓存——维度切换（换
 *   embedding 模型）只清向量面重建，条目零损失；
 * - 接口全部同步（better-sqlite3 同步 API——无 WriteQueue 异步写面诉求，
 *   服务层自行编排 embed（异步）→ append（同步）次序）。
 */

/** 记忆条目（存储面全字段）。 */
export interface StewardMemoryEntry {
  readonly id: number;
  /** 条目类别（B1 封闭两值：fact = 事实沉淀 / preference = 用户偏好）。 */
  readonly kind: "fact" | "preference";
  /** 记忆文本（自然语言一句——写入闸纪律：只沉淀认知增量）。 */
  readonly text: string;
  /** 来源标注（如 "steward-turn"——溯源展示用）。 */
  readonly source: string;
  /** 创建时间（epoch ms）。 */
  readonly createdAt: number;
}

/** 召回命中（条目 + 相似度分数——cosine distance 转 similarity，越大越像）。 */
export interface StewardMemoryHit extends StewardMemoryEntry {
  readonly score: number;
}

/** 待写入条目（向量由服务层 embed 后随条目一并交付）。 */
export interface StewardMemoryAppendItem {
  readonly kind: "fact" | "preference";
  readonly text: string;
  readonly source: string;
  readonly createdAt: number;
  readonly vector: Float32Array;
}

export interface StewardMemoryPort {
  /** 追加条目（条目 + 向量同事务写入）。 */
  append(items: readonly StewardMemoryAppendItem[]): void;
  /** 语义检索：cosine topK（score 降序；空库/维度未初始化 → 空数组）。 */
  search(query: Float32Array, topK: number): readonly StewardMemoryHit[];
  /** 全量条目（创建时间升序——配置面只读列表数据源）。 */
  list(): readonly StewardMemoryEntry[];
  /** 按 id 删除（条目 + 向量同事务；id 不存在 → false）。 */
  forget(id: number): boolean;
  /** 条目编辑重写（text + 向量单事务；id 不存在 → false）。 */
  updateEntry(id: number, text: string, vector: Float32Array): boolean;
  /** 条目总数。 */
  count(): number;
  /** 当前向量维度（meta 表；向量面未初始化 → null）。 */
  storedDim(): number | null;
  /**
   * 维度切换重建：清空向量面并按新维度重建 vec0 虚拟表（entries 保留）。
   * 调用方（服务层）随后重嵌入全部条目并经 putVector 回填。
   */
  resetVectors(newDim: number): void;
  /** 为既有条目回填向量（resetVectors 后的重建写面）。 */
  putVector(id: number, vector: Float32Array): void;
  /** 关库（进程收尾）。 */
  close(): void;
}

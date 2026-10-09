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

/** 业务领域维度（domain 维度批；与协议面 StewardMemoryDomain 同形）：
 *  habit = 关于用户怎么干活（换个团队也成立）/ general = 环境与通用工作方式
 *  事实（跟项目无关）/ project = 绑定具体项目才有意义（换个项目不成立）。
 *  kind × domain 正交：preference/fact 都可能落任意域；progress 固定
 *  domain=project（无项目会话回落 general）。一致性约束（写入单点
 *  resolveMemoryWriteAttrs 强制）：domain="project" ↔ projectScope=具体
 *  项目名（必绑定）；domain="habit"|"general" ↔ projectScope="global"。 */
export type MemoryDomain = "habit" | "general" | "project";

/** 记忆条目（存储面全字段）。 */
export interface StewardMemoryEntry {
  readonly id: number;
  /** 条目类别（B1 封闭两值 + progress 扩展：fact = 事实沉淀 /
   *  preference = 用户偏好 / progress = 会话进展状态——轮末联合摘要器
   *  生产的阶段性状态句，同 session 覆盖更新不堆叠，半衰语义同轨参与）。 */
  readonly kind: "fact" | "preference" | "progress";
  /** 记忆文本（自然语言一句——写入闸纪律：只沉淀认知增量）。 */
  readonly text: string;
  /** 来源标注（如 "steward-turn"——溯源展示用）。 */
  readonly source: string;
  /** 创建时间（epoch ms）。 */
  readonly createdAt: number;
  /** 最后更新时间（epoch ms；B5 覆盖更新时刷新——append 时 = createdAt）。 */
  readonly updatedAt: number;
  /** 最近一次被召回时刻（epoch ms；遗忘机制批——0 = 从未被想起；新条目
   *  = createdAt，强度锄点取 max(lastRecalledAt, updatedAt)）。 */
  readonly lastRecalledAt: number;
  /** 累计被召回次数（每次注入 system prompt 记一次——复习强化）。 */
  readonly recallCount: number;
  /** 淡忘时刻（epoch ms；0 = active；非 0 = 退出召回池，观察窗后物理删除）。 */
  readonly fadedAt: number;
  /** 已置顶（永不淡忘永不 GC，强度恒满；用户 explicit 保护位）。 */
  readonly pinned: boolean;
  /** 关联会话 id（progress 批——kind=progress 专属锚：同 session 覆盖更新
   *  的精确匹配键 + 召回行文的 read_session 跳转凭据；其他 kind 不携带）。 */
  readonly sessionId?: string;
  /** 项目作用域（项目隔离批："global" = 跨项目可见 / 项目目录名 = 仅该项目
   *  + global 消费面可召回。存储投影恒携带（真库列 NOT NULL DEFAULT
   *  'global'）；可选形态 = additive 兼容旧 fake/断言）。 */
  readonly projectScope?: string;
  /** 业务领域维度（domain 维度批；存储投影恒携带——真库列 NOT NULL，存量行
   *  迁移缺省：progress→project、其余→habit；可选形态 = additive 兼容旧
   *  fake/断言）。 */
  readonly domain?: MemoryDomain;
}

/** 召回命中（条目 + 相似度分数——cosine distance 转 similarity，越大越像）。 */
export interface StewardMemoryHit extends StewardMemoryEntry {
  readonly score: number;
}

/** 待写入条目（向量由服务层 embed 后随条目一并交付）。 */
export interface StewardMemoryAppendItem {
  readonly kind: "fact" | "preference" | "progress";
  readonly text: string;
  readonly source: string;
  readonly createdAt: number;
  readonly vector: Float32Array;
  /** 关联会话 id（kind=progress 专属；其他 kind 不携带）。 */
  readonly sessionId?: string;
  /** 项目作用域（写入时落：缺省 "global"；赋值规则单点
   *  StewardMemoryService.resolveMemoryWriteAttrs——含 domain 一致性约束）。 */
  readonly projectScope?: string;
  /** 业务领域维度（写入时落；缺省 "habit"（与存量迁移打标同口径）；真实
   *  写入面由 resolveMemoryWriteAttrs 单点解析后必携）。 */
  readonly domain?: MemoryDomain;
}

export interface StewardMemoryPort {
  /** 追加条目（条目 + 向量同事务写入）。 */
  append(items: readonly StewardMemoryAppendItem[]): void;
  /** 语义检索：cosine topK（score 降序；空库/维度未初始化 → 空数组）。
   *  scopeFilter（项目隔离批，可选）：允许召回的 project_scope 集合
   *  （如 ["global"] 或 ["global", "helix"]）——rowid IN 预过滤（KNN 名额
   *  只给合格行，他项目最近邻不占位）；undefined = 不过滤（全库——兼容
   *  既有调用语义）。domainFilter（domain 维度批，可选）：允许召回的
   *  domain 集合（如 ["habit"]）——与 scopeFilter 同层同形态（rowid IN
   *  预过滤，被滤域不占 KNN 名额）；undefined = 全域。 */
  search(query: Float32Array, topK: number, scopeFilter?: readonly string[], domainFilter?: readonly MemoryDomain[]): readonly StewardMemoryHit[];
  /** 全量条目（创建时间升序——配置面只读列表数据源）。 */
  list(): readonly StewardMemoryEntry[];
  /** 按 id 删除（条目 + 向量同事务；id 不存在 → false）。 */
  forget(id: number): boolean;
  /** 条目编辑重写（text + 向量 + updatedAt 单事务；编辑即救活——faded
   *  同事务归零；id 不存在 → false）。projectScope（项目隔离批，可选）：
   *  传入 = 随写时项目重落（progress 覆盖更新语义）；缺省 = 保持原值
   *  （人工编辑/查重覆盖不改归属）。 */
  updateEntry(id: number, text: string, vector: Float32Array, updatedAt: number, projectScope?: string): boolean;
  /** 会话进展条目定位（progress 批）：session_id + kind=progress 精确
   *  匹配——命中返回条目 id（覆盖更新目标），无 → null。非 progress 条目
   *  即使携带同 session_id 也不命中（进展覆盖不误伤其他类别）。 */
  findProgressId(sessionId: string): number | null;
  /** 召回幸存者回写（lastRecalledAt=at + recallCount+1；仅注入者算复习——
   *  候选池陪跑不记）。 */
  markRecalled(ids: readonly number[], at: number): void;
  /** 置顶切换（pinned=true：置位 + 清 faded + 刷 updatedAt 浮顶；pinned=false：
   *  只清置位不动其他；id 不存在 → false）。 */
  setPinned(id: number, pinned: boolean, at: number): boolean;
  /** 淡忘恢复（faded_at 归零 + 刷 updatedAt 满血复活；active 条目幂等 no-op
   *  → false；id 不存在 → false）。 */
  restore(id: number, at: number): boolean;
  /** 批量淡忘（GC fade 段：faded_at=at；空数组 no-op）。 */
  fadeMany(ids: readonly number[], at: number): void;
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

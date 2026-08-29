/**
 * 资源启停状态出口端口（outbound）。实现体 = driven
 * sqlite-session/ResourceStateStore.ts（resource_state 全局表，写经
 * WriteQueue 单写通道 AG-06 全局链；读面共用 writeQueue.database 连接）。
 *
 * 语义边界：
 * - 配置单元 = profile kind（main-session / subagent-worker / orchestrator，
 *   T2.2 additive 扩第三值）；
 * - 资源类型 ∈ {tool, skill, model, thinking}（thinking = thinking 批扩值）；
 * - **缺省无记录 = 启用**（零配置兼容现状，存量零迁移）——本表只存用户
 *   显式选择过的差异行，全集（profile tools 声明 / 扫描技能）与「无记录
 *   视为启用」的合取语义在 ResourceService 层，store 不解释；
 * - model 槽位单行不变式：model 型行 enabled 恒 true（不承载启停语义），
 *   删除行 = 未设；setModelSlot 为原子替换（主键含 name，非原子会遗留旧行）。
 *   thinking 槽位同构（AD-6 扩维：setThinkingSlot 原子替换，单行不变式相同）。
 */
/**
 * 配置单元 = profile kind（main-session / subagent-worker / orchestrator，
 * T2.2 增第三值——编排主 agent；additive 扩值，既有两值语义零变化）。
 */
export type ProfileKind = "main-session" | "subagent-worker" | "orchestrator";

/** 资源类型（tool/skill = 启停差异行；model/thinking = 槽位单行——
 *  thinking 为 thinking 批扩值（AD-6，iter-20260823-6ps5 T1.3）：档位字符串
 *  槽位，缺省无记录 = 未配置 → 解析链后续档，全链未配置 = 默认关）。 */
export type ResourceType = "tool" | "skill" | "model" | "thinking";

/** 差异行值形状（读面）。 */
export interface ResourceStateData {
  readonly profileKind: ProfileKind;
  readonly resourceType: ResourceType;
  readonly name: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface ResourceStatePort {
  /** 单行 upsert（主键冲突即更新；tool/skill 启停差异行）。 */
  upsert(profileKind: ProfileKind, resourceType: ResourceType, name: string, enabled: boolean): Promise<void>;
  /** 单行读取（无行 → undefined）。 */
  get(profileKind: ProfileKind, resourceType: ResourceType, name: string): ResourceStateData | undefined;
  /** 按 profile kind（可再按 resource type 过滤）列差异行，落盘序。 */
  list(profileKind: ProfileKind, resourceType?: ResourceType): readonly ResourceStateData[];
  /** model 槽位写（原子替换：清空该 kind 全部 model 行后插入，enabled 恒 true）。 */
  setModelSlot(profileKind: ProfileKind, model: string): Promise<void>;
  /** model 槽位清除（删除该 kind 全部 model 行 = 未设）。 */
  clearModelSlot(profileKind: ProfileKind): Promise<void>;
  /** model 槽位读（无行 → undefined = 未设）。 */
  modelSlot(profileKind: ProfileKind): string | undefined;
  /** thinking 槽位写（原子替换同 model 槽位单行不变式：清旧行 + 新行 enabled 恒 true）。 */
  setThinkingSlot(profileKind: ProfileKind, level: string): Promise<void>;
  /** thinking 槽位清除（删除行 = 未配置）。 */
  clearThinkingSlot(profileKind: ProfileKind): Promise<void>;
  /** thinking 槽位读（无行 → undefined = 未配置 → 解析链后续档，全链未配置 = 默认关）。 */
  thinkingSlot(profileKind: ProfileKind): string | undefined;
}

import type {
  ProfileKind,
  ResourceStatePort,
  ResourceType,
} from "../ports/outbound/ResourceStatePort";
import type {
  SkillDescriptor,
  SkillSourcePort,
} from "../ports/outbound/SkillSourcePort";

/**
 * ResourceService —— profile kind 维资源启停的合取计算层（M6 T1，数据域
 * 终点：本任务只到「数据与合取计算」，state 刷新归 T2、契约归 T3）。
 *
 * 【语义核心】缺省无记录 = 启用（零配置兼容现状，存量零迁移）：
 * 生效集 = 全集（profile tools 声明 / SkillScanner 扫描产物）∩ kind 启用集
 * ——同 kind 隔离（main 禁不影响 subagent），全集侧变更（profile 发版/
 * 技能安装）自然生效，遗留差异行（名不在全集）在合取中被忽略。
 *
 * 【tools 全集注入】profiles 在 driven 层（AG-02：application 不得反向
 * import adapters）——组合根从 MainSessionProfile/SubAgentProfile.tools
 * 构建 kind→全集映射表注入本服务。
 *
 * 【toggle 未知名】显式跳过不落库（{ status: "skipped" }）：全集之外的名
 * （如 subagent 禁 agent_spawn）无生效面，落库只会制造永不生效的差异行。
 */
export class ResourceService {
  constructor(
    private readonly deps: {
      readonly store: ResourceStatePort;
      readonly skills: SkillSourcePort;
      /** kind → tools 全集（组合根从两 profile 声明面构建）。 */
      readonly toolsCatalog: Readonly<Record<ProfileKind, readonly string[]>>;
    },
  ) {}

  /** 单行启停状态（无行 = 启用）。 */
  private enabledOf(kind: ProfileKind, resourceType: ResourceType, name: string): boolean {
    return this.deps.store.get(kind, resourceType, name)?.enabled ?? true;
  }

  /**
   * 三类资源合并视图（UI/契约读面）：tools = 全集 + 启停行；skills = 扫描
   * 全集 + 启停行；model = 槽位现值（未设 → undefined）。
   */
  async list(kind: ProfileKind): Promise<{
    readonly tools: ReadonlyArray<{ name: string; enabled: boolean }>;
    readonly skills: ReadonlyArray<SkillDescriptor & { enabled: boolean }>;
    readonly model: string | undefined;
  }> {
    const tools = this.deps.toolsCatalog[kind].map((name) => ({
      name,
      enabled: this.enabledOf(kind, "tool", name),
    }));
    const scanned = await this.deps.skills.scan();
    const skills = scanned.skills.map((s) => ({ ...s, enabled: this.enabledOf(kind, "skill", s.name) }));
    return { tools, skills, model: this.deps.store.modelSlot(kind) };
  }

  /**
   * 启停写面：全集内 → 落库差异行；全集外（或 model 型——model 走
   * setModel/clearModel 槽位 API，不承载启停语义）→ 显式跳过。
   */
  async toggle(
    kind: ProfileKind,
    resourceType: ResourceType,
    name: string,
    enabled: boolean,
  ): Promise<{ status: "applied" } | { status: "skipped"; reason: string }> {
    if (resourceType === "model") {
      return { status: "skipped", reason: "model-uses-slot-api" };
    }
    const known =
      resourceType === "tool"
        ? this.deps.toolsCatalog[kind].includes(name)
        : (await this.deps.skills.scan()).skills.some((s) => s.name === name);
    if (!known) return { status: "skipped", reason: "unknown-name" };
    await this.deps.store.upsert(kind, resourceType, name, enabled);
    return { status: "applied" };
  }

  /**
   * 生效工具集（T2 消费面：resolveTools 产物同源派生的输入）——同步读
   *（store 读面同步 + write-through，await 的 toggle 落盘后必见新行）。
   */
  getEffectiveTools(kind: ProfileKind): readonly string[] {
    return this.deps.toolsCatalog[kind].filter((name) => this.enabledOf(kind, "tool", name));
  }

  /** 生效技能集（T2 消费面：提示注入三字段 + source 的完整描述符）。 */
  async getEffectiveSkills(kind: ProfileKind): Promise<readonly SkillDescriptor[]> {
    const scanned = await this.deps.skills.scan();
    return scanned.skills.filter((s) => this.enabledOf(kind, "skill", s.name));
  }

  /** model 槽位现值（未设 → undefined = 走四级/三级链后续级）。 */
  modelSlot(kind: ProfileKind): string | undefined {
    return this.deps.store.modelSlot(kind);
  }

  /** model 槽位写（store 层原子替换：清旧行 + 新行 enabled 恒 1）。 */
  async setModel(kind: ProfileKind, model: string): Promise<void> {
    await this.deps.store.setModelSlot(kind, model);
  }

  /** model 槽位清除（删除行 = 未设）。 */
  async clearModel(kind: ProfileKind): Promise<void> {
    await this.deps.store.clearModelSlot(kind);
  }
}

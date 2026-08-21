import type {
  ProfileKind,
  ResourceStatePort,
  ResourceType,
} from "../ports/outbound/ResourceStatePort";
import type {
  SkillDescriptor,
  SkillSourcePort,
} from "../ports/outbound/SkillSourcePort";
import type {
  ResourceConfigBlock,
  ResourceConfigPort,
  ResourceToggleOutcome,
} from "../ports/inbound/ResourceConfigPort";

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
 * 【builtin 防护】（T5 内置第三源）：builtin 技能不进 resource_state——
 * setEnabled 返回 { status: "skipped", reason: "builtin-immutable" }，
 * 读面恒启用（缺省无记录 = 启用语义天然覆盖）。
 *
 * M6 T3：结构满足 ResourceConfigPort（agent.config 命令族回口，AG-12
 * driving 只 import ports）；list 增透传扫描诊断（契约读面），toggle 以
 * setEnabled 别名暴露（模型槽位写面分流在 driving 层）。
 */
export class ResourceService implements ResourceConfigPort {
  constructor(
    private readonly deps: {
      readonly store: ResourceStatePort;
      readonly skills: SkillSourcePort;
      /** kind → tools 全集（组合根从两 profile 声明面构建）。 */
      readonly toolsCatalog: Readonly<Record<ProfileKind, readonly string[]>>;
      /** 工具名 → 中文一句话 snippet（组合根注入 ToolPromptSnippets 注册表；
       *  M6 T4：list 读面向契约 DTO 透传——注册表外名 = 空串）。 */
      readonly toolSnippets: Readonly<Record<string, string>>;
      /**
       * 生效集变更回调（M6 T2）：toggle applied 后同步触发（await 链）——
       * 组合根接「重算该 kind 组装快照 + 刷新活跃 runtime（main）/spawn
       * 快照缓存（subagent）」；未知名 skipped 不触发。供 T3 WS 命令复用
       * （命令只调 toggle，刷新链单点在本回调）。
       */
      readonly onApplied?: (kind: ProfileKind) => void | Promise<void>;
    },
  ) {}

  /** 单行启停状态（无行 = 启用）。 */
  private enabledOf(kind: ProfileKind, resourceType: ResourceType, name: string): boolean {
    return this.deps.store.get(kind, resourceType, name)?.enabled ?? true;
  }

  /**
   * 三类资源合并视图（UI/契约读面）：tools = 全集 + 启停行；skills = 扫描
   * 全集 + 启停行（含扫描诊断透传，坏文件上抛不炸）；model = 槽位现值
   * （未设 → undefined）。
   */
  async list(kind: ProfileKind): Promise<ResourceConfigBlock> {
    const tools = this.deps.toolsCatalog[kind].map((name) => ({
      name,
      enabled: this.enabledOf(kind, "tool", name),
      snippet: this.deps.toolSnippets[name] ?? "", // 注册表外名 = 空串（契约面钉非 undefined）
    }));
    const scanned = await this.deps.skills.scan();
    const skills = scanned.skills.map((s) => ({ ...s, enabled: this.enabledOf(kind, "skill", s.name) }));
    return { profileKind: kind, tools, skills, diagnostics: scanned.diagnostics, model: this.deps.store.modelSlot(kind) };
  }

  /**
   * 启停写面：全集内 → 落库差异行；全集外（或 model 型——model 走
   * setModel/clearModel 槽位 API，不承载启停语义）→ 显式跳过。
   * （ResourceConfigPort.setEnabled 的实现面；toggle 为同名语义保留名。）
   */
  async setEnabled(
    kind: ProfileKind,
    resourceType: ResourceType,
    name: string,
    enabled: boolean,
  ): Promise<ResourceToggleOutcome> {
    if (resourceType === "model") {
      return { status: "skipped", reason: "model-uses-slot-api" };
    }
    if (resourceType === "skill") {
      const skill = (await this.deps.skills.scan()).skills.find((s) => s.name === name);
      if (!skill) return { status: "skipped", reason: "unknown-name" };
      // T5 builtin 防护：内置技能不进 resource_state（不可禁用）——显式
      // skipped 不落禁用记录；读面恒启用（缺省无记录 = 启用天然覆盖）
      if (skill.source === "builtin") return { status: "skipped", reason: "builtin-immutable" };
    } else if (!this.deps.toolsCatalog[kind].includes(name)) {
      return { status: "skipped", reason: "unknown-name" };
    }
    await this.deps.store.upsert(kind, resourceType, name, enabled);
    await this.deps.onApplied?.(kind); // M6 T2：落库后同步刷新（读面四级链 write-through 语义）
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
  async setModelSlot(kind: ProfileKind, model: string): Promise<void> {
    await this.deps.store.setModelSlot(kind, model);
  }

  /** model 槽位清除（删除行 = 未设）。 */
  async clearModelSlot(kind: ProfileKind): Promise<void> {
    await this.deps.store.clearModelSlot(kind);
  }

  /** 同义保留名（T1 起）：ResourceConfigPort.setEnabled 的旧调用面。 */
  toggle(kind: ProfileKind, resourceType: ResourceType, name: string, enabled: boolean): Promise<ResourceToggleOutcome> {
    return this.setEnabled(kind, resourceType, name, enabled);
  }

  /** model 槽位写（T1 起保留名）：setModelSlot 同义。 */
  setModel(kind: ProfileKind, model: string): Promise<void> {
    return this.setModelSlot(kind, model);
  }

  /** model 槽位清除（T1 起保留名）：clearModelSlot 同义。 */
  clearModel(kind: ProfileKind): Promise<void> {
    return this.clearModelSlot(kind);
  }
}

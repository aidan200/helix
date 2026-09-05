import type {
  ProfileKind,
  ResourceStatePort,
  ResourceType,
} from "../ports/outbound/ResourceStatePort";
import type {
  SkillAudience,
  SkillDescriptor,
  SkillSource,
  SkillSourcePort,
} from "../ports/outbound/SkillSourcePort";
import type {
  ResourceConfigBlock,
  ResourceConfigPort,
  ResourceToggleOutcome,
} from "../ports/inbound/ResourceConfigPort";

/**
 * ResourceService —— profile kind 维资源启停的合取计算层（数据域
 * 终点：本服务只到「数据与合取计算」，刷新链经事件发布）。
 *
 * 【语义核心】（同轨批：全局显式启用制）：静态工具无差异行 = 启用
 * （声明即核心能力，零配置兼容现状）；技能与 mcp-server 无差异行 =
 * 禁用（五 kind 统一——用户自选开启，builtin 与 user 同轨；builtin 开箱
 * 即用由初始化播种差异行承担，见 seedBuiltinSkillDefaults）。生效集 =
 * 全集（profile tools 声明 / SkillScanner 扫描产物）∩ kind 启用集——
 * 同 kind 隔离（main 禁不影响 subagent），全集侧变更（profile 发版/
 * 技能安装）自然生效，遗留差异行（名不在全集）在合取中被忽略。
 * 【kind 唯一差异】写面只读性：main/sub 全型可写；
 * orchestrator/kg-writer/reviewer 仅槽位型（读面同构下发）。
 *
 * 【tools 全集注入】profiles 在 driven 层（AG-02：application 不得反向
 * import adapters）——组合根从 MainSessionProfile/SubAgentProfile.tools
 * 构建 kind→全集映射表注入本服务。
 *
 * 【toggle 未知名】显式跳过不落库（{ status: "skipped" }）：全集之外的名
 * （如 subagent 禁 agent_spawn）无生效面，落库只会制造永不生效的差异行。
 * 【task SOP 防护】：audience=task 技能写面 audience-guard 拒绝——
 * 消费通道在任务系统 kickoff，不经技能段（同轨批 builtin-immutable
 * 已撤——builtin 技能与 user 同轨显式启用）。
 *
 * 结构满足 ResourceConfigPort（agent.config 命令族回口，AG-12
 * driving 只 import ports）；list 增透传扫描诊断（契约读面），toggle 以
 * setEnabled 别名暴露（模型槽位写面分流在 driving 层）。
 */
export class ResourceService implements ResourceConfigPort {
  constructor(
    private readonly deps: {
      readonly store: ResourceStatePort;
      readonly skills: SkillSourcePort;
      /** kind → tools 全集（组合根从两 profile 声明面构建；函数形态——
       * mcp 批：动态拼接 MCP 命名空间工具名，每次调用现拍 McpRegistry 值）。 */
      readonly toolsCatalog: (kind: ProfileKind) => readonly string[];
      /**
       * kind → 生效集计算专用目录（deferred 批，可选；缺省回落
       * toolsCatalog）：MCP 懒加载拆分面——deferred server 具体工具不进
       * 初始生效集，代之 meta 工具名（`${server}__discover`）+ 已物化集
       * union。catalog 全集（页面展示 + toggle 域）仍走 toolsCatalog——
       * 两面分离保证「页面可 toggle 全部工具」与「初始集 meta-only」并存。
       */
      readonly effectiveToolsCatalog?: (kind: ProfileKind) => readonly string[];
      /**
       * kind → MCP server 运行态行（server 级配置面批，可选；组合根注入
       * 窄闭包：McpRegistry 现拍 + profile mcpServers 白名单门控）。行 =
       * 运行态透传（state/toolCount/lastError），enabled 由本服务 store 差异行
       * 合取——注入面不解释启停。缺省不注入（零 MCP daemon）→ list 块不携带
       * mcpServers、写面 unknown-mcp-server 恒 skipped。
       */
      readonly mcpServersOf?: (kind: ProfileKind) => readonly {
        readonly name: string;
        readonly state: string;
        readonly toolCount?: number;
        readonly lastError?: string;
      }[];
      /**
       * 工具名 → snippet 动态读面（server 级配置面批，可选；优先于静态
       * toolSnippets 注册表）：MCP 工具行 snippet = registry 发现的 description
       * 透传（注册表外名不再恒空串）；静态工具走注册表不变。
       */
      readonly toolSnippetOf?: (name: string) => string | undefined;
      /** 工具名 → 中文一句话 snippet（组合根注入 ToolPromptSnippets 注册表；
       * list 读面向契约 DTO 透传——注册表外名 = 空串）。 */
      readonly toolSnippets: Readonly<Record<string, string>>;
      /**
       * 生效集变更发布面（事件化，架构 §4.2.3）：toggle
       * applied 后同步发布 resources.changed（await 链——订阅侧刷新收口
       * 后 setEnabled 才返回，与旧 onApplied 回调链行为等价）；未知名
       * skipped 不发布。供 WS 命令复用（命令只调 toggle，刷新链单点在
       * 订阅侧）。发布面经组合根注入（application 不 import infrastructure）。
       */
      readonly publishResourceChanged?: (kind: ProfileKind) => void | Promise<void>;
    },
  ) {}

  /** 单行启停状态（静态工具缺省启用；技能/mcp-server 缺省禁用见各自读面）。 */
  private enabledOf(kind: ProfileKind, resourceType: ResourceType, name: string): boolean {
    return this.deps.store.get(kind, resourceType, name)?.enabled ?? true;
  }

  /**
   * 技能缺省（同轨批：全局显式启用制）：无差异行 = 禁用，不分 source、
   * 不分 kind——builtin 行为技能与 user 技能同轨（默认关、用户自开；
   * builtin-immutable 写面防护随同轨撤除）；task 类 SOP 消费通道在
   * kickoff 不经技能段（audience-guard 写面只读纵深保留）。六 kind 唯一
   * 差异 = 写面只读性（系统三 kind 恒关——写面开不了）。
   */
  private skillDefaultEnabled(_kind: ProfileKind, _s: Pick<SkillDescriptor, "source" | "audience">): boolean {
    return false;
  }

  /** 技能行启停（store 差异行优先；无行按 kind+来源缺省）。 */
  private skillEnabledOf(kind: ProfileKind, s: Pick<SkillDescriptor, "name" | "source" | "audience">): boolean {
    return this.deps.store.get(kind, "skill", s.name)?.enabled ?? this.skillDefaultEnabled(kind, s);
  }

  /**
   * mcp-server 行启停（同轨批：全局显式启用制）：无差异行 = 禁用，六 kind
   * 统一（含可写三 kind——哪个 server 进哪个 agent 由用户自开）；系统三
   * kind 写面只读恒关（读面同构展示运行态行）。
   */
  private mcpServerEnabledOf(kind: ProfileKind, name: string): boolean {
    return this.deps.store.get(kind, "mcp-server", name)?.enabled ?? false;
  }

  /**
   * 三类资源合并视图（UI/契约读面）：tools = 全集 + 启停行；skills = 扫描
   * 全集按 audience 目录二分（编排归位批：orchestrator 全量——其系统块
   * 技能区 = 任务 SOP 注册表展示；其余 kind 仅 agent 受众——任务 SOP 不
   * 进 agent 卡技能列表）+ 启停行（含扫描诊断透传，坏文件上抛不炸）；
   * model = 槽位现值（未设 → undefined）。
   */
  async list(kind: ProfileKind): Promise<ResourceConfigBlock> {
    const tools = this.deps.toolsCatalog(kind).map((name) => ({
      name,
      enabled: this.enabledOf(kind, "tool", name),
      // 动态读面优先（MCP description 透传）；静态注册表次之；注册表外名 = 空串（契约面钉非 undefined）
      snippet: this.deps.toolSnippetOf?.(name) ?? this.deps.toolSnippets[name] ?? "",
    }));
    const scanned = await this.deps.skills.scan();
    const skills = scanned.skills
      .filter((s) => kind === "orchestrator" || s.audience === "agent")
      .map((s) => ({ ...s, enabled: this.skillEnabledOf(kind, s) }));
    const mcpServers = this.deps.mcpServersOf?.(kind)?.map((row) => ({
      ...row,
      enabled: this.mcpServerEnabledOf(kind, row.name),
    }));
    return { profileKind: kind, tools, skills, ...(mcpServers !== undefined && mcpServers.length > 0 ? { mcpServers } : {}), diagnostics: scanned.diagnostics, model: this.deps.store.modelSlot(kind), thinkingLevel: this.deps.store.thinkingSlot(kind) };
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
    if (resourceType === "thinking") {
      return { status: "skipped", reason: "thinking-uses-slot-api" };
    }
    if (resourceType === "skill") {
      const skill = (await this.deps.skills.scan()).skills.find((s) => s.name === name);
      if (!skill) return { status: "skipped", reason: "unknown-name" };
      // task 类 SOP 只读防护（统一启停批）：消费通道 = 任务系统 kickoff 注入，
      // agent 面恒禁用不可开（缺省即禁）——取代旧 audience 隐藏双轨。
      // （同轨批：builtin-immutable 撤除——builtin 与 user 同轨显式启用制。）
      if (skill.audience === "task") return { status: "skipped", reason: "audience-guard" };
    } else if (resourceType === "mcp-server") {
      // server 级配置面批：全集 = mcpServersOf 现拍（注入面已做白名单门控）。
      // 全集外名（如对静态 kind 或未配置 server 写）显式跳过不落库——与
      // tool/skill 同构：无生效面的差异行只制造永不生效的脏行。
      if (!(this.deps.mcpServersOf?.(kind) ?? []).some((row) => row.name === name)) {
        return { status: "skipped", reason: "unknown-mcp-server" };
      }
    } else if (!this.deps.toolsCatalog(kind).includes(name)) {
      return { status: "skipped", reason: "unknown-name" };
    }
    await this.deps.store.upsert(kind, resourceType, name, enabled);
    await this.deps.publishResourceChanged?.(kind); // 落库后同步刷新（读面四级链 write-through 语义）
    return { status: "applied" };
  }

  /**
   * 生效工具集（消费面：resolveTools 产物同源派生的输入）——同步读
   *（store 读面同步 + write-through，await 的 toggle 落盘后必见新行）。
   */
  getEffectiveTools(kind: ProfileKind): readonly string[] {
    const catalog = this.deps.effectiveToolsCatalog?.(kind) ?? this.deps.toolsCatalog(kind);
    return catalog.filter((name) => {
      if (!this.enabledOf(kind, "tool", name)) return false;
      // server 级门控（server 级配置面批）：MCP 命名空间名（`${server}__${tool}`，
      // 含 deferred meta `${server}__discover`）按 server 前缀合取——server 关
      // ⇒ 整组出局，未来动态发现的新工具名天然被覆盖；静态工具名不含
      // 双下划线不受影响（TR-106 命名空间纪律）。
      const sep = name.indexOf("__");
      if (sep > 0 && !this.mcpServerEnabledOf(kind, name.slice(0, sep))) return false;
      return true;
    });
  }

  /** 单工具启停读面（deferred 批：MCP discover 物化前的 toggle 过滤；同 getEffectiveTools 的 enabledOf 单点）。 */
  isToolEnabled(kind: ProfileKind, name: string): boolean {
    return this.enabledOf(kind, "tool", name);
  }

  /** 生效技能集（消费面：提示注入三字段 + source 的完整描述符）。
   * 编排归位批：audience 目录二分恢复（task 类 SOP 不进任何 kind 提示词
   * 技能段——消费通道在任务系统 kickoff；写面 audience-guard 为纵深防
   * 御）；orchestrator 经 kind 缺省全禁自然为空（变相禁用单轨）。 */
  async getEffectiveSkills(kind: ProfileKind): Promise<readonly SkillDescriptor[]> {
    const scanned = await this.deps.skills.scan();
    const effectiveTools = new Set(this.getEffectiveTools(kind));
    return scanned.skills
      // audience 目录二分：任务 SOP 的消费通道是 kickoff 全文注入，不进
      // 任何 agent 提示词技能段（防混入语义由目录承载，不靠启停行）
      .filter((s) => s.audience === "agent")
      // skills+tools 成套装配（批三裁决）：声明了成套工具的技能，仅当本
      // kind 生效工具集含全部声明工具时才列出——SOP 与工具不拆开出现
      //（如 plan-workflow 只在持 plan 三工具的 kind 出现；禁用任一 plan
      // 工具 → 技能随之下线）
      .filter((s) => s.tools === undefined || s.tools.every((t) => effectiveTools.has(t)))
      .filter((s) => this.skillEnabledOf(kind, s));
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

  /** thinking 槽位现值（未配置 → undefined = 解析链后续档，全链未配置 = 默认关，AD-1/AD-6）。 */
  thinkingSlot(kind: ProfileKind): string | undefined {
    return this.deps.store.thinkingSlot(kind);
  }

  /** thinking 槽位写（store 层原子替换同 model 槽位单行不变式；不校验档位——SoT 在 pi-ai）。 */
  async setThinkingSlot(kind: ProfileKind, level: string): Promise<void> {
    await this.deps.store.setThinkingSlot(kind, level);
  }

  /** thinking 槽位清除（删除行 = 未配置）。 */
  async clearThinkingSlot(kind: ProfileKind): Promise<void> {
    await this.deps.store.clearThinkingSlot(kind);
  }

  /** 同义保留名（旧调用面）：ResourceConfigPort.setEnabled。 */
  toggle(kind: ProfileKind, resourceType: ResourceType, name: string, enabled: boolean): Promise<ResourceToggleOutcome> {
    return this.setEnabled(kind, resourceType, name, enabled);
  }

  /** model 槽位写（旧调用面保留名）：setModelSlot 同义。 */
  setModel(kind: ProfileKind, model: string): Promise<void> {
    return this.setModelSlot(kind, model);
  }

  /** model 槽位清除（旧调用面保留名）：clearModelSlot 同义。 */
  clearModel(kind: ProfileKind): Promise<void> {
    return this.clearModelSlot(kind);
  }

  /**
   * builtin 技能差异行播种（缺省启停批裁决 C）：初始化时给 agent 层 builtin
   * 技能写显式 enabled=true 差异行——运行时缺省逻辑零特判（无差异行 = 禁用
   * 不变，builtin 与 user 同轨），builtin 开箱即用 + 可关可再开。
   * 缺行才播：用户已配置（含手动关闭）不覆盖；版本升级新增 builtin 技能重启
   * 自动补播。调用面传入可写 kind（组合根 isSystemKind 反向——系统 kind 技能
   * 段 omitSkills 无消费面且写面只读，不播）。返回播种条数（幂等二跑 = 0）。
   */
  async seedBuiltinSkillDefaults(kinds: readonly ProfileKind[]): Promise<number> {
    const builtinAgentSkills = (await this.deps.skills.scan()).skills.filter(
      (s) => s.source === "builtin" && s.audience === "agent",
    );
    let seeded = 0;
    for (const kind of kinds) {
      for (const skill of builtinAgentSkills) {
        if (this.deps.store.get(kind, "skill", skill.name) !== undefined) continue;
        const outcome = await this.setEnabled(kind, "skill", skill.name, true);
        if (outcome.status === "applied") seeded += 1;
      }
    }
    return seeded;
  }
}

/**
 * audience 目录二分（编排归位批恢复）：task 类 SOP 不进任何 kind 提示词
 * 技能段与 agent 卡技能列表（消费通道 = 任务系统 kickoff；orchestrator
 * 系统块技能区 = 任务 SOP 注册表展示）。「变相禁用」由 kind 维缺省
 *（orchestrator 全禁）+ 写面只读承担——加载链同构无双轨。
 */

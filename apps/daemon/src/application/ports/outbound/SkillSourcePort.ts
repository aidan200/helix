/**
 * 技能源出口端口（outbound）。实现体 = driven
 * pi-engine/SkillScanner.ts（防腐墙内包装 pi-agent-core 的
 * loadSourcedSkills；pi 的 Skill/Diagnostic 类型不得越出防腐墙——
 * helix 域形状在本文件单点定义）。
 *
 * 三层目录（双层裁决 + 内置第三源）：user 层 = <home>/skills
 * （paths.skillsHome 单点派生）；project 层 = <工作区>/.helix/skills（启动
 * 时定格，与 toolCwd 同款工作区型语义，不做监听）；builtin 层 = daemon
 * 随仓 resources/skills（paths.builtinSkillsDir 单点派生，产品不可删改
 * ——不可禁用防护在 ResourceService 写面）。目录缺失静默跳过（首启常态）。
 *
 * audience 分类（提示词树形分层重构，批二）：builtin 层目录二分——
 * resources/skills/agent/ = agent 行为技能（面向执行 agent 的 SOP，进
 * 「可用技能」清单）；resources/skills/task/ = 任务类型 SOP（面向编排
 * agent，frontmatter 带 task 块，经 TaskSkillRegistry 注册为任务类型，
 * 全文在任务 kickoff 注入——不进任何 agent 的技能清单）。user/project
 * 层恒为 agent 类（任务类型是产品功能不是用户扩展点，F-8）。
 */

/** 技能来源层：user（~/.helix/skills）/ project（工作区 .helix/skills）/ builtin（daemon 随仓 resources/skills）。 */
export type SkillSource = "user" | "project" | "builtin";

/** 技能受众分类：agent = 执行 agent 行为技能（进技能清单）/ task = 任务类型 SOP（只进任务注册表与编排 kickoff）。 */
export type SkillAudience = "agent" | "task";

/** helix 域技能描述符（扫描产物的最小完备面：提示注入三字段 + source 标签）。 */
export interface SkillDescriptor {
  /** 技能名（SKILL.md frontmatter name，与父目录名一致的约定由 pi 校验）。 */
  readonly name: string;
  /** 单行描述（frontmatter description；缺失 = 坏文件，走诊断不产技能）。 */
  readonly description: string;
  /** SKILL.md 绝对路径（提示注入 location 字段同源）。 */
  readonly filePath: string;
  /** 来源层标签。 */
  readonly source: SkillSource;
  /** 受众分类（agent/task）——提示注入过滤与任务注册表装载的共同判据。 */
  readonly audience: SkillAudience;
}

/** 扫描诊断（坏文件上抛不炸；code 为稳定诊断码字符串）。 */
export interface SkillScanDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly source: SkillSource;
}

/** 扫描结果：技能全集 + 诊断（启用集合取在 ResourceService 层，本面不感知）。 */
export interface SkillScanResult {
  readonly skills: readonly SkillDescriptor[];
  readonly diagnostics: readonly SkillScanDiagnostic[];
}

export interface SkillSourcePort {
  /** 扫描双层目录（每次调用现扫——不缓存，与文件系统现状一致）。 */
  scan(): Promise<SkillScanResult>;
}

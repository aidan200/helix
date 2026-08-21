/**
 * 技能源出口端口（outbound，M6 T1）。实现体 = driven
 * pi-engine/SkillScanner.ts（防腐墙内包装 pi-agent-core 的
 * loadSourcedSkills；pi 的 Skill/Diagnostic 类型不得越出防腐墙——
 * helix 域形状在本文件单点定义）。
 *
 * 三层目录（M6 §三裁决双层 + T5 内置第三源）：user 层 = <home>/skills
 * （paths.skillsHome 单点派生）；project 层 = <工作区>/.helix/skills（启动
 * 时定格，与 toolCwd 同款工作区型语义，不做监听）；builtin 层 = daemon
 * 随仓 resources/skills（paths.builtinSkillsDir 单点派生，产品不可删改
 * ——不可禁用防护在 ResourceService 写面）。目录缺失静默跳过（首启常态）。
 */

/** 技能来源层：user（~/.helix/skills）/ project（工作区 .helix/skills）/ builtin（daemon 随仓 resources/skills，T5）。 */
export type SkillSource = "user" | "project" | "builtin";

/** helix 域技能描述符（扫描产物的最小完备面：T2 提示注入三字段 + source 标签）。 */
export interface SkillDescriptor {
  /** 技能名（SKILL.md frontmatter name，与父目录名一致的约定由 pi 校验）。 */
  readonly name: string;
  /** 单行描述（frontmatter description；缺失 = 坏文件，走诊断不产技能）。 */
  readonly description: string;
  /** SKILL.md 绝对路径（提示注入 location 字段同源）。 */
  readonly filePath: string;
  /** 来源层标签。 */
  readonly source: SkillSource;
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

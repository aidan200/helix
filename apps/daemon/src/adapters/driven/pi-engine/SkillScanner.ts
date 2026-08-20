import { loadSourcedSkills, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type {
  SkillDescriptor,
  SkillScanDiagnostic,
  SkillScanResult,
  SkillSource,
  SkillSourcePort,
} from "../../../application/ports/outbound/SkillSourcePort";

/**
 * SkillScanner —— 技能源端口的真实现（M6 T1，落 pi-engine 防腐墙内）。
 *
 * 包装 pi-agent-core 的 loadSourcedSkills（纯函数、目录显式传入、库层零
 * 默认目录——spike §二 事实 1）：双层输入（user = <home>/skills、
 * project = <工作区>/.helix/skills）→ source 标签逐技能/逐诊断携带；
 * 目录缺失静默跳过（loadSourcedSkills 自带：file_info not_found 不出
 * 诊断）；坏文件（缺 description 等）出 warning 诊断不炸。
 *
 * 防腐墙职责：pi 的 Skill/SkillDiagnostic 类型不得越出本文件——结构映射
 * （content 丢弃、source 标签提为 descriptor 字段）在此单点完成，上层只见
 * helix 域形状（SkillSourcePort 声明）。
 */
export interface SkillScannerOptions {
  /** user 层技能目录（paths.skillsHome() 派生值；组合根注入）。 */
  readonly userSkillsDir: string;
  /** project 层技能目录（<工作区>/.helix/skills；启动时定格——toolCwd 同款）。 */
  readonly projectSkillsDir: string;
  /** NodeExecutionEnv cwd（相对路径解析根；技能目录均为绝对路径，仅为构造必填——缺省进程工作区）。 */
  readonly cwd?: string;
}

export class SkillScanner implements SkillSourcePort {
  private readonly env: NodeExecutionEnv;
  private readonly inputs: ReadonlyArray<{ path: string; source: SkillSource }>;

  constructor(options: SkillScannerOptions) {
    this.env = new NodeExecutionEnv({ cwd: options.cwd ?? process.cwd() });
    this.inputs = [
      { path: options.userSkillsDir, source: "user" },
      { path: options.projectSkillsDir, source: "project" },
    ];
  }

  async scan(): Promise<SkillScanResult> {
    // 泛型只用 TSource（TSkill 约束须 extends pi 的 Skill 含 content——helix
    // 域形状不含正文，映射在包装数组解包后做）；pi 类型不越出本文件
    const { skills, diagnostics } = await loadSourcedSkills<SkillSource>(this.env, [
      ...this.inputs, // pi 签名要求可变数组，浅拷贝传入（内部不修改）
    ]);
    const mapped: SkillScanDiagnostic[] = diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      path: d.path,
      source: d.source,
    }));
    const descriptors: SkillDescriptor[] = skills.map(({ skill, source }) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      source,
    }));
    return { skills: descriptors, diagnostics: mapped };
  }
}

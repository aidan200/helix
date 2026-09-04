import { loadSourcedSkills, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type {
  SkillAudience,
  SkillDescriptor,
  SkillScanDiagnostic,
  SkillScanResult,
  SkillSource,
  SkillSourcePort,
} from "../../../application/ports/outbound/SkillSourcePort";

/**
 * SkillScanner —— 技能源端口的真实现（落 pi-engine 防腐墙内）。
 *
 * 包装 pi-agent-core 的 loadSourcedSkills（纯函数、目录显式传入、库层零
 * 默认目录）：四层输入（user = <home>/skills、project = <工作区>/.helix/skills、
 * builtin-agent = daemon 随仓 resources/skills/agent、
 * builtin-task = daemon 随仓 resources/skills/task——内置第三源按受众
 * 二分目录，产品不可删改）→ source/audience 标签逐技能/逐诊断携带；
 * 目录缺失静默跳过（loadSourcedSkills 自带：file_info not_found 不出
 * 诊断）；坏文件（缺 description 等）出 warning 诊断不炸。
 *
 * 防腐墙职责：pi 的 Skill/SkillDiagnostic 类型不得越出本文件——结构映射
 * （content 丢弃、source+audience 标签提为 descriptor 字段）在此单点完成，
 * 上层只见 helix 域形状（SkillSourcePort 声明）。
 */

/** 扫描输入标签：source × audience 的联合键（builtin 两子目录 source 同为 builtin、audience 不同）。 */
type ScanTag = "user" | "project" | "builtin-agent" | "builtin-task";

function splitTag(tag: ScanTag): { source: SkillSource; audience: SkillAudience } {
  switch (tag) {
    case "user":
      return { source: "user", audience: "agent" };
    case "project":
      return { source: "project", audience: "agent" };
    case "builtin-agent":
      return { source: "builtin", audience: "agent" };
    case "builtin-task":
      return { source: "builtin", audience: "task" };
  }
}
export interface SkillScannerOptions {
  /** user 层技能目录（paths.skillsHome() 派生值；组合根注入）。 */
  readonly userSkillsDir: string;
  /** project 层技能目录（<工作区>/.helix/skills；启动时定格——toolCwd 同款）。 */
  readonly projectSkillsDir: string;
  /** builtin 层技能目录（daemon 随仓 resources/skills，paths.builtinSkillsDir() 派生值；组合根注入）。 */
  readonly builtinSkillsDir: string;
  /** NodeExecutionEnv cwd（相对路径解析根；技能目录均为绝对路径，仅为构造必填——缺省进程工作区）。 */
  readonly cwd?: string;
}

export class SkillScanner implements SkillSourcePort {
  private readonly env: NodeExecutionEnv;
  private readonly inputs: ReadonlyArray<{ path: string; source: ScanTag }>;

  constructor(options: SkillScannerOptions) {
    this.env = new NodeExecutionEnv({ cwd: options.cwd ?? process.cwd() });
    this.inputs = [
      { path: options.userSkillsDir, source: "user" },
      { path: options.projectSkillsDir, source: "project" },
      // builtin 层目录二分（audience 分类即目录）：agent/ = 行为技能，task/ = 任务类型 SOP
      { path: `${options.builtinSkillsDir}/agent`, source: "builtin-agent" },
      { path: `${options.builtinSkillsDir}/task`, source: "builtin-task" },
    ];
  }

  async scan(): Promise<SkillScanResult> {
    // 泛型只用 TSource（TSkill 约束须 extends pi 的 Skill 含 content——helix
    // 域形状不含正文，映射在包装数组解包后做）；pi 类型不越出本文件
    const { skills, diagnostics } = await loadSourcedSkills<ScanTag>(this.env, [
      ...this.inputs, // pi 签名要求可变数组，浅拷贝传入（内部不修改）
    ]);
    const mapped: SkillScanDiagnostic[] = diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      path: d.path,
      source: splitTag(d.source).source,
    }));
    const descriptors: SkillDescriptor[] = await Promise.all(
      skills.map(async ({ skill, source }) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        ...splitTag(source),
        // 成套工具声明（frontmatter 可选 tools 字段；读取失败/缺字段 = undefined 不炸扫描）
        ...(await this.readCompanionTools(skill.filePath)),
      })),
    );
    return { skills: descriptors, diagnostics: mapped };
  }

  /**
   * 读 SKILL.md frontmatter 的可选 tools 字段（成套工具声明，批三）。
   * 与 TaskSkillRegistry.readFrontmatter 同哲学：坏形状静默回落 undefined，
   * 不出诊断（skills+tools 成套是增强声明，缺省 = 恒列技能）。
   */
  private async readCompanionTools(filePath: string): Promise<{ tools?: readonly string[] }> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return {};
    }
    const normalized = raw.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return {};
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) return {};
    try {
      const parsed = parseYaml(normalized.slice(4, endIndex)) as Record<string, unknown> | null;
      const tools = parsed?.["tools"];
      if (Array.isArray(tools) && tools.every((t) => typeof t === "string")) {
        return { tools: tools as readonly string[] };
      }
      return {};
    } catch {
      return {};
    }
  }
}

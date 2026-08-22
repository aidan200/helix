import type { SkillDescriptor } from "../ports/outbound/SkillSourcePort";

/**
 * SystemPromptAssembler —— 系统提示三段组装器（设计定稿 §三）。
 *
 * 三段结构：
 *   [base：profile 静态瘦身 prompt（角色+行为引导，无工具清单——消双源）]
 *   [可用工具：- name: snippet 扁平清单（ToolPromptSnippets 注册表；清单从
 *    resolveTools 产物同源派生——入参即 getEffectiveTools(kind) 生效集）]
 *   [可用技能：三句引导语（技能是什么/匹配时先 read 全文/相对路径以技能
 *    目录为基准解析）+ 每技能 name/description/location 三行 YAML 子块；
 *    内容对齐 agentskills.io 标准，格式非 XML——自写格式化，不用 pi 的
 *    formatSkillsForSystemPrompt]
 *
 * 【无条件化联动】（用户裁决）：组装器不做任何状态联动判断——read 关不删
 * 技能引导句、编排关不删委派段；错配 = 使用不当，不加代码级硬约束。
 *
 * 【落位说明】本类在 application 层：只消费 helix 域形状（SkillDescriptor）
 * 与注入的 snippet 映射（tools 目录常量经组合根传入，AG-02 依赖方向成立），
 * pi 符号不越防腐墙。
 */
export interface SystemPromptAssemblerDeps {
  /** 工具名 → 中文一句话 snippet（组合根注入 ToolPromptSnippets 注册表）。 */
  readonly toolSnippets: Readonly<Record<string, string>>;
}

/** 组装入参：base + 生效工具集 + 生效技能集（ResourceService 读面）。 */
export interface PromptAssemblyInput {
  readonly basePrompt: string;
  readonly toolNames: readonly string[];
  readonly skills: readonly SkillDescriptor[];
}

export class SystemPromptAssembler {
  constructor(private readonly deps: SystemPromptAssemblerDeps) {}

  /** 三段组装：段间空行分隔；工具/技能段为空集时整体省略（base 恒在）。 */
  assemble(input: PromptAssemblyInput): string {
    const segments: string[] = [input.basePrompt];
    const toolLines = input.toolNames.map((name) => {
      const snippet = this.deps.toolSnippets[name];
      // 注册表外防御：裸名行（不带空 snippet 冒号）——生效集来自 profile
      // 全集，正常路径不会走到
      return snippet === undefined ? `- ${name}` : `- ${name}: ${snippet}`;
    });
    if (toolLines.length > 0) segments.push(["可用工具：", ...toolLines].join("\n"));
    if (input.skills.length > 0) segments.push(this.skillSection(input.skills));
    return segments.join("\n\n");
  }

  /** 技能段：标题 + 三句引导语 + 逐技能三行 YAML 子块（name/description/location）。 */
  private skillSection(skills: readonly SkillDescriptor[]): string {
    const lines: string[] = [
      "可用技能：",
      "以下技能为特定类型的任务提供了专门的操作指引。",
      "当任务与某技能的描述匹配时，先用 read 工具读取该技能文件全文后再按其指引执行。",
      "技能文件引用相对路径时，以技能所在目录（SKILL.md 的父目录）为基准解析为绝对路径后再用于工具命令。",
    ];
    for (const skill of skills) {
      lines.push(`- name: ${skill.name}`);
      lines.push(`  description: ${foldToSingleLine(skill.description)}`);
      lines.push(`  location: ${skill.filePath}`);
    }
    return lines.join("\n");
  }
}

/** 单行折行防御：frontmatter 多行 description 压成空格分隔的单行（YAML 子块行结构不被破坏）。 */
function foldToSingleLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

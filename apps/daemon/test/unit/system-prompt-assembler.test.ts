import { describe, expect, test } from "bun:test";
import { SystemPromptAssembler } from "../../src/application/services/SystemPromptAssembler";
import { TOOL_PROMPT_SNIPPETS } from "../../src/adapters/driven/tools/ToolPromptSnippets";
import type { SkillDescriptor } from "../../src/application/ports/outbound/SkillSourcePort";

/**
 * M6 T2：SystemPromptAssembler 三段组装器（设计定稿 §三）。
 *
 * 三段 = [base：profile 静态瘦身 prompt] + [可用工具：- name: snippet 扁平清单]
 *      + [可用技能：三句引导语（技能是什么/匹配时先 read 全文/相对路径以技能
 *        目录为基准解析）+ 每技能 name/description/location 三行 YAML 子块]。
 *
 * 硬约束：
 * - 无条件化联动（用户裁决）：read 关不删技能引导句、编排关不删委派段——
 *   组装器不做任何状态联动判断；
 * - 格式非 XML（自写格式化，不用 pi 的 formatSkillsForSystemPrompt）；
 * - description 单行折行防御（frontmatter 多行 description 不破坏子块行结构）。
 */

const skill = (over: Partial<SkillDescriptor> = {}): SkillDescriptor => ({
  name: "code-review",
  description: "审查代码变更的质量与风险",
  filePath: "/home/u/.helix/skills/code-review/SKILL.md",
  source: "user",
  audience: "agent",
  ...over,
});

const assembler = new SystemPromptAssembler({ toolSnippets: TOOL_PROMPT_SNIPPETS });

describe("SystemPromptAssembler 三段组装（M6 T2）", () => {
  test("① 三段结构：base 原文 + 工具扁平清单（- name: snippet）+ 技能段（引导语 + 三行 YAML 子块）", () => {
    const out = assembler.assemble({
      basePrompt: "BASE：角色与行为引导",
      toolNames: ["bash", "grep"],
      skills: [skill()],
    });
    const segments = out.split("\n\n");
    expect(segments).toHaveLength(3);
    // 第一段 = base 原文（瘦身后只有角色+行为引导，组装器不改写）
    expect(segments[0]).toBe("BASE：角色与行为引导");
    // 第二段 = 工具段：标题 + 扁平清单（- name: snippet，snippet 来自注册表）
    expect(segments[1]).toContain("可用工具");
    expect(segments[1]).toContain(`- bash: ${TOOL_PROMPT_SNIPPETS["bash"]!}`);
    expect(segments[1]).toContain(`- grep: ${TOOL_PROMPT_SNIPPETS["grep"]!}`);
    // 第三段 = 技能段：标题 + 三句引导语（技能是什么 / 匹配先 read 全文 /
    // 相对路径以技能目录为基准解析）+ name/description/location 三行子块
    expect(segments[2]).toContain("可用技能");
    expect(segments[2]).toMatch(/技能/); // 引导语①：技能是什么
    expect(segments[2]).toMatch(/全文/); // 引导语②：匹配时先 read 全文
    expect(segments[2]).toMatch(/技能所在目录|SKILL\.md/); // 引导语③：相对路径解析规则
    expect(segments[2]).toContain("- name: code-review");
    expect(segments[2]).toContain("  description: 审查代码变更的质量与风险");
    expect(segments[2]).toContain("  location: /home/u/.helix/skills/code-review/SKILL.md");
    // 格式非 XML（自写格式化裁决）
    expect(out).not.toContain("<available_skills>");
    expect(out).not.toContain("<skill>");
  });

  test("② 多技能按入参顺序各成三行子块（T5：builtin 源技能同面进技能段）", () => {
    const out = assembler.assemble({
      basePrompt: "B",
      toolNames: ["bash"],
      skills: [
        skill(),
        skill({ name: "deploy", description: "部署向导", filePath: "/w/deploy/SKILL.md" }),
        // builtin 源技能（T5 内置第三源）：合取语义天然覆盖，组装零改动
        skill({
          name: "web-access",
          description: "联网操作指引",
          filePath: "/daemon/resources/skills/agent/web-access/SKILL.md",
          source: "builtin",
        }),
      ],
    });
    const lines = out.split("\n");
    const nameIdx = lines.findIndex((l) => l === "- name: code-review");
    expect(lines.slice(nameIdx, nameIdx + 3)).toEqual([
      "- name: code-review",
      "  description: 审查代码变更的质量与风险",
      "  location: /home/u/.helix/skills/code-review/SKILL.md",
    ]);
    expect(out).toContain("- name: deploy");
    expect(out).toContain("  location: /w/deploy/SKILL.md");
    // builtin 技能三行子块齐备（技能段含 builtin 断言）
    expect(out).toContain("- name: web-access");
    expect(out).toContain("  description: 联网操作指引");
    expect(out).toContain("  location: /daemon/resources/skills/agent/web-access/SKILL.md");
  });

  test("③ description 含换行 → 折成单行（单行防御：子块行结构不被多行 description 破坏）", () => {
    const out = assembler.assemble({
      basePrompt: "B",
      toolNames: ["bash"],
      skills: [skill({ description: "第一行\n第二行\r\n第三行" })],
    });
    const descLine = out.split("\n").find((l) => l.includes("description:"))!;
    expect(descLine).toBe("  description: 第一行 第二行 第三行");
    expect(out).not.toContain("\r");
  });

  test("④ 无启用技能 → 技能段整体省略（含标题与引导语，两段收口）", () => {
    const out = assembler.assemble({ basePrompt: "B", toolNames: ["bash"], skills: [] });
    expect(out.split("\n\n")).toHaveLength(2);
    expect(out).not.toContain("可用技能");
    expect(out).not.toMatch(/全文/);
  });

  test("⑤ 无条件化联动（用户裁决）：read 不在生效工具集时技能引导语照发（错配=使用不当，非代码级硬约束）", () => {
    const out = assembler.assemble({
      basePrompt: "B",
      toolNames: ["bash"], // read 被禁用
      skills: [skill()],
    });
    expect(out).toContain("可用技能");
    expect(out).toMatch(/read|全文/); // 引导语仍指示先读全文——不因 read 关闭而删改
  });

  test("⑥ 注册表外的工具名 → 清单行退化为裸名（- name，不带空 snippet 冒号）", () => {
    const bare = new SystemPromptAssembler({ toolSnippets: {} });
    const out = bare.assemble({ basePrompt: "B", toolNames: ["mystery-tool"], skills: [] });
    expect(out.split("\n")).toContain("- mystery-tool");
  });

  test("⑦ 双源消除正向面：组装产物含工具名与 snippet（清单只在组装产物出现）", () => {
    const toolNames = [
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "web_search",
      "web_fetch",
      "agent_spawn",
      "agent_send",
      "agent_status",
      "agent_inspect",
      "browser",
      "kg",
      "kg-update",
    ];
    const out = assembler.assemble({ basePrompt: "B", toolNames, skills: [] });
    // T1.4：注册表新增 subagent 独有 plan 三工具——本组装面（main 集）只
    // 断言集内名；两 profile 全集覆盖断言在 tool-prompt-snippets.test
    for (const name of toolNames) {
      expect(out).toContain(`- ${name}: ${TOOL_PROMPT_SNIPPETS[name]}`);
    }
  });
});

describe("SystemPromptAssembler 任务类型段（audience 分类注入，批二）", () => {
  test("④ taskTypes 传入 → 「可用任务类型」段渲染（task_create 发起面 + 不自读 SOP 指引 + 逐类型子块）", () => {
    const out = assembler.assemble({
      basePrompt: "B",
      toolNames: ["bash"],
      skills: [skill()],
      taskTypes: [
        { type: "kg-bootstrap", description: "为项目批量创建知识图谱内容" },
        { type: "code-review", description: "对项目代码做质量评审" },
      ],
    });
    expect(out).toContain("可用任务类型（无交互多 agent 任务）：");
    expect(out).toContain("用 task_create 发起");
    expect(out).toContain("你不要自己读取任务 SKILL.md 并按其指引执行");
    expect(out).toContain("- name: kg-bootstrap");
    expect(out).toContain("  description: 为项目批量创建知识图谱内容");
    expect(out).toContain("- name: code-review");
  });

  test("⑤ taskTypes 缺省/空集 → 任务类型段整体省略（与工具/技能段同款空集语义）", () => {
    expect(
      assembler.assemble({ basePrompt: "B", toolNames: ["bash"], skills: [] }),
    ).not.toContain("可用任务类型");
    expect(
      assembler.assemble({ basePrompt: "B", toolNames: ["bash"], skills: [], taskTypes: [] }),
    ).not.toContain("可用任务类型");
  });
});

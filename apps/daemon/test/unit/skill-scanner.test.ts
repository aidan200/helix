import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillScanner } from "../../src/adapters/driven/pi-engine/SkillScanner";
import { builtinSkillsDir } from "../../src/infrastructure/paths";

/**
 * M6 T1 SkillScanner（pi-engine 防腐墙内）：
 * - 包装 pi-agent-core loadSourcedSkills：双层输入（user = ~/.helix/skills、
 *   project = <工作区>/.helix/skills）→ source 标签逐技能携带；
 * - 目录缺失静默跳过（loadSourcedSkills 自带：file_info not_found 不出诊断）；
 * - 坏文件（如缺 description）→ diagnostics 上抛、零异常、不产技能；
 * - 产出 helix 域形状（SkillDescriptor：name/description/filePath/source），
 *   pi 的 Skill/Diagnostic 类型不得越出防腐墙（结构映射在此单点）。
 */

const tmpRoots: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** 造一个合法技能：<root>/<name>/SKILL.md（frontmatter name 与目录名一致）。 */
function makeSkill(root: string, name: string, frontmatter: string, body = "技能正文"): string {
  const skillDir = path.join(root, name);
  mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return file;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("SkillScanner（三层目录 → source 标签技能清单）", () => {
  test("① tmp 目录造 SKILL.md 三源扫出 + source 标签正确 + 域形状字段齐", async () => {
    const userDir = tmpDir("helix-skills-user-");
    const projectDir = tmpDir("helix-skills-project-");
    const builtinDir = tmpDir("helix-skills-builtin-");
    const userFile = makeSkill(userDir, "code-review", "name: code-review\ndescription: 审查代码变更质量");
    makeSkill(projectDir, "deploy-helper", "name: deploy-helper\ndescription: 部署流程向导");
    // builtin 层目录二分（audience 分类即目录）：agent/ = 行为技能，task/ = 任务类型 SOP
    const builtinFile = makeSkill(path.join(builtinDir, "agent"), "web-access", "name: web-access\ndescription: 联网操作指引");
    const builtinTaskFile = makeSkill(path.join(builtinDir, "task"), "kg-bootstrap", "name: kg-bootstrap\ndescription: 知识图谱批量创建");

    const scanner = new SkillScanner({ userSkillsDir: userDir, projectSkillsDir: projectDir, builtinSkillsDir: builtinDir });
    const result = await scanner.scan();

    expect(result.diagnostics).toEqual([]);
    expect(result.skills.length).toBe(4);

    const byName = new Map(result.skills.map((s) => [s.name, s]));
    const review = byName.get("code-review");
    expect(review).toBeDefined();
    expect(review!.source).toBe("user");
    expect(review!.audience).toBe("agent"); // user/project 层恒为 agent 类
    expect(review!.description).toBe("审查代码变更质量");
    expect(review!.filePath).toBe(userFile); // 绝对路径指向 SKILL.md 本体

    const deploy = byName.get("deploy-helper");
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe("project");

    // T5 内置第三源：daemon 随仓目录（产品不可删改）→ source = "builtin"；
    // audience 由子目录决定（agent/ → agent，task/ → task）
    const builtin = byName.get("web-access");
    expect(builtin).toBeDefined();
    expect(builtin!.source).toBe("builtin");
    expect(builtin!.audience).toBe("agent");
    expect(builtin!.filePath).toBe(builtinFile);
    const builtinTask = byName.get("kg-bootstrap");
    expect(builtinTask).toBeDefined();
    expect(builtinTask!.source).toBe("builtin");
    expect(builtinTask!.audience).toBe("task");
    expect(builtinTask!.filePath).toBe(builtinTaskFile);
  });

  test("② 目录缺失 → 零异常、零技能、零诊断（静默跳过，首启常态）", async () => {
    const scanner = new SkillScanner({
      userSkillsDir: path.join(tmpDir("helix-skills-none-"), "skills"), // 父在、子不存在
      projectSkillsDir: path.join(tmpDir("helix-skills-none2-"), "workspace", ".helix", "skills"), // 深层缺失
      builtinSkillsDir: path.join(tmpDir("helix-skills-none3-"), "resources", "skills"), // builtin 层同款静默
    });
    const result = await scanner.scan();
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("③ 坏文件（缺 description）→ diagnostics 上抛不炸、该技能不产出、同目录好技能不受影响", async () => {
    const userDir = tmpDir("helix-skills-bad-");
    const projectDir = tmpDir("helix-skills-bad-proj-");
    const badFile = makeSkill(userDir, "broken-skill", "name: broken-skill\ndescription:");
    makeSkill(userDir, "good-skill", "name: good-skill\ndescription: 正常技能");

    const scanner = new SkillScanner({
      userSkillsDir: userDir,
      projectSkillsDir: projectDir,
      builtinSkillsDir: path.join(tmpDir("helix-skills-bad-none-"), "skills"), // 缺失静默
    });
    const result = await scanner.scan();

    // 坏文件：invalid_metadata 诊断（source 标签随诊断上抛）
    expect(result.skills.map((s) => s.name)).toEqual(["good-skill"]);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]!.code).toBe("invalid_metadata");
    expect(result.diagnostics[0]!.path).toBe(badFile);
    expect(result.diagnostics[0]!.source).toBe("user");
    expect(typeof result.diagnostics[0]!.message).toBe("string");
  });

  test("④ 随仓内置技能（真 resources/skills）：web-access 与 kg-bootstrap 扫出 + frontmatter 合规 + 正文节齐备", async () => {
    const missing = path.join(tmpDir("helix-skills-real-none-"), "none");
    const scanner = new SkillScanner({
      userSkillsDir: missing,
      projectSkillsDir: missing,
      builtinSkillsDir: builtinSkillsDir(), // 真随仓目录（paths 单点派生）
    });
    const result = await scanner.scan();
    expect(result.diagnostics).toEqual([]); // 随仓文件必须合法（frontmatter 合规）
    // 随仓内置五技能——agent/ 层 web-access + plan-workflow（行为技能）
    // + task/ 层 kg-bootstrap/kg-review/code-review（任务类型 SOP，带 task 块）
    expect(result.skills.map((s) => s.name).sort()).toEqual(["code-review", "kg-bootstrap", "kg-review", "plan-workflow", "web-access"]);
    const skill = result.skills.find((s) => s.name === "web-access")!;
    expect(skill.source).toBe("builtin");
    expect(skill.audience).toBe("agent");
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.filePath).toBe(path.join(builtinSkillsDir(), "agent", "web-access", "SKILL.md"));
    expect(skill.tools).toBeUndefined(); // 未声明成套工具 = 恒列技能
    // plan-workflow：成套工具声明（frontmatter tools 字段，批三）
    const planWorkflow = result.skills.find((s) => s.name === "plan-workflow")!;
    expect(planWorkflow.audience).toBe("agent");
    expect(planWorkflow.tools).toEqual(["plan_create", "plan_update", "plan_read"]);
    // task/ 层三技能 audience = task（不进任何 agent 的技能清单）
    for (const name of ["kg-bootstrap", "kg-review", "code-review"]) {
      const t = result.skills.find((s) => s.name === name)!;
      expect(t.source).toBe("builtin");
      expect(t.audience).toBe("task");
    }
    // 正文七节齐备（浏览哲学/工具选择/页面就绪契约/登录判断/技术事实/程序化 vs GUI/反爬风险）
    const body = readFileSync(skill.filePath, "utf8");
    for (const section of ["浏览哲学", "工具选择", "页面就绪契约", "登录判断", "技术事实", "程序化 vs GUI", "反爬风险"]) {
      expect(body).toContain(section);
    }
  });
});

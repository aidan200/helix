import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillScanner } from "../../src/adapters/driven/pi-engine/SkillScanner";

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

describe("SkillScanner（双层目录 → source 标签技能清单）", () => {
  test("① tmp 目录造 SKILL.md 扫出技能 + source 标签正确 + 域形状字段齐", async () => {
    const userDir = tmpDir("helix-skills-user-");
    const projectDir = tmpDir("helix-skills-project-");
    const userFile = makeSkill(userDir, "code-review", "name: code-review\ndescription: 审查代码变更质量");
    makeSkill(projectDir, "deploy-helper", "name: deploy-helper\ndescription: 部署流程向导");

    const scanner = new SkillScanner({ userSkillsDir: userDir, projectSkillsDir: projectDir });
    const result = await scanner.scan();

    expect(result.diagnostics).toEqual([]);
    expect(result.skills.length).toBe(2);

    const byName = new Map(result.skills.map((s) => [s.name, s]));
    const review = byName.get("code-review");
    expect(review).toBeDefined();
    expect(review!.source).toBe("user");
    expect(review!.description).toBe("审查代码变更质量");
    expect(review!.filePath).toBe(userFile); // 绝对路径指向 SKILL.md 本体

    const deploy = byName.get("deploy-helper");
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe("project");
  });

  test("② 目录缺失 → 零异常、零技能、零诊断（静默跳过，首启常态）", async () => {
    const scanner = new SkillScanner({
      userSkillsDir: path.join(tmpDir("helix-skills-none-"), "skills"), // 父在、子不存在
      projectSkillsDir: path.join(tmpDir("helix-skills-none2-"), "workspace", ".helix", "skills"), // 深层缺失
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

    const scanner = new SkillScanner({ userSkillsDir: userDir, projectSkillsDir: projectDir });
    const result = await scanner.scan();

    // 坏文件：invalid_metadata 诊断（source 标签随诊断上抛）
    expect(result.skills.map((s) => s.name)).toEqual(["good-skill"]);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]!.code).toBe("invalid_metadata");
    expect(result.diagnostics[0]!.path).toBe(badFile);
    expect(result.diagnostics[0]!.source).toBe("user");
    expect(typeof result.diagnostics[0]!.message).toBe("string");
  });
});

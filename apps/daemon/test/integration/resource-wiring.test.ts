import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { createPaths } from "../../src/infrastructure/paths";

/**
 * M6 T1 组合根接线（resource 数据域）：
 * - daemon.resource 装配可用：tools 全集从两 profile 注入（main 8 / subagent 5）；
 * - skills 扫描挂 paths.skillsHome()（user 层）——home 内造技能即可扫出；
 * - toggle/model 槽位经真 WriteQueue 落 SQLite，daemon 重启（同 home 重建）读回。
 */

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-resource-wiring-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("组合根：ResourceService 装配 + 持久化跨重启", () => {
  test("daemon.resource 三类面可用；启停与 model 槽位落 SQLite，重启读回", async () => {
    const home = tmpHome();
    const workspace = tmpHome(); // project 层 skills 根（toolCwd 同款判定注入，测试定向 tmp）
    // user 层技能：<home>/skills/hello-skill/SKILL.md（先于 daemon 创建——启动时扫描）
    const skillDir = path.join(createPaths(home).skillsHome(), "hello-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: hello-skill\ndescription: 组合根接线验证技能\n---\n\n正文",
      "utf8",
    );

    const daemon = await createDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
    });
    try {
      // tools 全集注入：两 profile 声明面（main 8 含编排三件套；subagent 5）
      expect(daemon.resource.getEffectiveTools("main-session")).toEqual([
        "bash",
        "read",
        "write",
        "edit",
        "grep",
        "agent_spawn",
        "agent_send",
        "agent_status",
      ]);
      expect(daemon.resource.getEffectiveTools("subagent-worker")).toEqual(["bash", "read", "write", "edit", "grep"]);

      // skills：user 层扫出（source 标签 = user）
      const view = await daemon.resource.list("main-session");
      expect(view.skills).toEqual([
        {
          name: "hello-skill",
          description: "组合根接线验证技能",
          filePath: path.join(skillDir, "SKILL.md"),
          source: "user",
          enabled: true,
        },
      ]);
      expect(view.model).toBeUndefined();

      // 启停 + model 槽位经真 SQLite
      await daemon.resource.toggle("main-session", "tool", "grep", false);
      await daemon.resource.toggle("main-session", "skill", "hello-skill", false);
      await daemon.resource.setModel("subagent-worker", "anthropic/claude-haiku-4-5");
      expect(daemon.resource.getEffectiveTools("main-session").includes("grep")).toBe(false);
      expect((await daemon.resource.list("main-session")).skills[0]!.enabled).toBe(false);
      expect(daemon.resource.modelSlot("subagent-worker")).toBe("anthropic/claude-haiku-4-5");
    } finally {
      await daemon.shutdown();
    }

    // 重启（同 home 重建 daemon）：差异行 + model 槽位完整读回
    const daemon2 = await createDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
    });
    try {
      expect(daemon2.resource.getEffectiveTools("main-session").includes("grep")).toBe(false);
      expect(daemon2.resource.getEffectiveTools("subagent-worker").includes("grep")).toBe(true);
      expect((await daemon2.resource.getEffectiveSkills("main-session")).map((s) => s.name)).toEqual([]);
      expect(daemon2.resource.modelSlot("subagent-worker")).toBe("anthropic/claude-haiku-4-5");
      expect(daemon2.resource.modelSlot("main-session")).toBeUndefined();
    } finally {
      await daemon2.shutdown();
    }
  });
});

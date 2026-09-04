import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MAIN_SESSION_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SUBAGENT_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { builtinPromptsDir } from "../../src/adapters/driven/pi-engine/runtime/prompts";

/**
 * prompts-as-resources 契约（提示词树形分层重构，批一）：
 * - disciplines/ 目录下每个 md = 全局纪律——所有 profile kind 的系统提示
 *   如实注入全文（逐字包含，不经裁剪）；
 * - roles/ 目录下每个 md 非空（装载 fail-fast 的静态防线）；
 * - TS 侧零内联散文由本测试反向兜底：三 kind 提示必须含 disciplines 全文，
 *   任何「改 md 不生效 / profile 回退内联」的漂移立即红。
 */
const ALL_KIND_PROMPTS = [
  ["main-session", MAIN_SESSION_SYSTEM_PROMPT],
  ["subagent-worker", SUBAGENT_SYSTEM_PROMPT],
  ["orchestrator", ORCHESTRATOR_SYSTEM_PROMPT],
] as const;

describe("prompts-as-resources：全局纪律与角色文件", () => {
  const disciplinesDir = path.join(builtinPromptsDir(), "disciplines");
  const disciplineFiles = readdirSync(disciplinesDir).filter((f) => f.endsWith(".md"));

  test("disciplines/ 至少含知识纪律与工程纪律两件", () => {
    expect(disciplineFiles).toContain("knowledge-core.md");
    expect(disciplineFiles).toContain("engineering.md");
  });

  for (const file of disciplineFiles) {
    const body = readFileSync(path.join(disciplinesDir, file), "utf8").trim();
    for (const [kind, prompt] of ALL_KIND_PROMPTS) {
      test(`${kind} 如实注入全局纪律 disciplines/${file}（全文逐字包含）`, () => {
        expect(prompt).toContain(body);
      });
    }
  }

  test("roles/ 全部 md 非空且各 profile 引用路径存在（装载期 fail-fast 已由 import 成功证明）", () => {
    const rolesDir = path.join(builtinPromptsDir(), "roles");
    const roleFiles = readdirSync(rolesDir).filter((f) => f.endsWith(".md"));
    expect(roleFiles.length).toBeGreaterThanOrEqual(5);
    for (const file of roleFiles) {
      expect(
        readFileSync(path.join(rolesDir, file), "utf8").trim().length,
        `roles/${file} 为空`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * M6 T4 —— CL-skills E 层行为验证：智能体页 agent.config 全链（真 daemon +
 * 真 SQLite + 真 SkillScanner 双层目录；workers=1 串行，playwright.e2e.config.ts）。
 *
 * 与 F 层套件（CL-skills-agent-config.spec.ts，mock mode）互补：本 spec 走
 * 真 WS + 真落库（resource_state 表）+ 真文件系统扫描（~home/skills +
 * sandbox/.helix/skills 双层），断言页面行为与 daemon 口径一致。
 *
 * 场景（skills 单源管理批后：project 技能源已删，扫描 = user + builtin
 * 二分；user 技能显式启用制——缺省停用）：
 *   T1 list 渲染：seed 临时 home 技能（user 好 + user 坏）→ /skills 进页 →
 *      agent.config.list → 双卡渲染（工具含 snippet + 系统三块独立装配
 *      只读置灰；技能来源 chip user/builtin；invalid_metadata 诊断警示）；
 *      模型下拉 S3a 可用性口径：auth.json 预置 anthropic key（仅该组
 *      configured 可见，其余 builtin provider 整组隐藏）；
 *   T2 toggle 全链：开技能（缺省停用 → 启用）→ set_enabled applied（真落库）
 *      → changed 广播（真 EventStream）→ 页面重拉 → 态翻转；reload 后仍
 *      翻转（SQLite 持久）；
 *   T3 model 槽位：下拉选 builtin 目录内模型 → 槽位落库 → changed 重拉刷新；
 *      选回缺省 → clear；
 *   T4 skipped 回执：list 后删技能文件（磁盘漂移）→ toggle → daemon 重扫
 *      全集外 → skipped unknown-name → toast 呈现 + 态不翻转。
 *
 * 纪律：TR-TEST-4（mkdtemp 隔离 home）/ TR-TEST-5（无帧拦截全真连接）/
 * TR-TEST-6（自建 home 经 fixture 统一回收）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, expect } from "./harness/daemon-fixture";
import type { DaemonScript } from "./harness/daemon-script";
import { shotEvidence, writeEvidence } from "./harness/evidence";

/** 死代理：daemon 外网快失 → model.catalog builtin fallback（K-1 / CL-5 先例）。 */
const DEAD_PROXY = { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };
/** builtin 目录内模型（model-provider.DEFAULT_MODEL_ID 同源；hasModel 零网络）。 */
const SLOT_MODEL = "anthropic/claude-sonnet-4-5";

function seedSkill(dir: string, name: string, description?: string): void {
  mkdirSync(dir, { recursive: true });
  const front = description === undefined ? `---\nname: ${name}\n---` : `---\nname: ${name}\ndescription: ${description}\n---`;
  writeFileSync(path.join(dir, "SKILL.md"), `${front}\n\n正文`, "utf8");
}

/** 预置 home：user 层好/坏技能 + sandbox（toolCwd）project 层技能 +
 * anthropic 凭据（S3a 模型下拉可用性过滤：仅 configured 组可见）。 */
function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-agents-"));
  mkdirSync(path.join(home, "skills"), { recursive: true });
  seedSkill(path.join(home, "skills", "hello-skill"), "hello-skill", "问候技能：按名字打招呼");
  seedSkill(path.join(home, "skills", "broken-skill"), "broken-skill"); // 缺 description → invalid_metadata
  // auth.json（AD-2：pi 生态 Credential 联合；daemon --home 下凭据文件）
  writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "sk-e2e-agents-seed" } }),
    "utf8",
  );
  return home;
}

/** 空剧本（本 spec 无 LLM 交互面；daemon 命令族全走 driving 层）。 */
const SCRIPT: DaemonScript = { entries: [] };

/** 进智能体页并等首帧 list 收口（左栏五条目——可配置 2 + 系统派生 3（D5 reviewer 入列）+ 默认选中 main 后 bash 工具行在场）。 */
async function openAgents(page: import("@playwright/test").Page): Promise<void> {
  await page.locator('.rail-btn[data-page="skills"]').click();
  await expect(page.locator('[data-agents-page="/skills"]')).toBeVisible();
  await expect(page.locator("[data-agent-row]")).toHaveCount(5, { timeout: 15_000 });
  await page.locator('[data-agent-row="main-session"]').click();
  const mainCard = page.locator('[data-agent-card="main-session"]');
  await expect(mainCard.locator('[data-tool-row="bash"]')).toBeVisible({ timeout: 15_000 });
}

test.describe("M6 T4 CL-skills E 层：agent.config 真链路", () => {
  test("T1 list 渲染：双层技能目录 + 诊断 + 工具 snippet + master-detail 系统派生组（真 SkillScanner）", async ({ e2e, page }) => {
    const home = prepHome();
    await e2e.startDaemon({ script: SCRIPT, home, env: DEAD_PROXY });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await openAgents(page);

    const mainCard = page.locator('[data-agent-card="main-session"]');

    // main 23 工具 / worker 14 / 系统三块独立装配 14·14·11（工具集随 profile
    // 发版演进，计数与声明全集同步——F4 +edit-lines；kg-writer 字面量不随
    // worker 渗入、orchestrator/reviewer 无 edit-lines）；snippet 来自 daemon 注册表
    await expect(mainCard.locator("[data-tool-row]")).toHaveCount(23);
    await expect(mainCard.locator('[data-tool-row="grep"]')).toContainText("跨文件子串检索并列出匹配行"); // H11：snippet 随 rg 唯一化订正（子串语义非正则）

    // master-detail 系统派生组（真 daemon 独立装配，不从 worker 派生）：
    // orchestrator 14 全集（编排六 task_* + bash/read/grep/write/agent_spawn/plan_read/kg）
    // + kg-writer 14 字面量（含 kg-update）+ reviewer 11（write/edit/edit-lines 恒摘）
    // TR-125 显示同构终态：data-ro-tool-row/derivedFrom/sop-note 退役——统一
    // data-tool-row + 开关在场置灰（写面只读）；系统块技能 builtin 播种五 kind 全开
    await page.locator('[data-agent-row="orchestrator"]').click();
    const orchCard = page.locator('[data-agent-card="orchestrator"]');
    await expect(orchCard.locator("[data-tool-row]")).toHaveCount(14, { timeout: 10_000 });
    const orchSwitch = orchCard.locator('[data-tool-row="agent_spawn"] [data-switch="agent_spawn"]');
    await expect(orchSwitch).toBeDisabled(); // readOnly 置灰（统一开关在场）
    await expect(orchSwitch).toHaveAttribute("aria-checked", "true");
    await expect(orchCard.locator("[data-derived-note]")).toHaveCount(0);
    await page.locator('[data-agent-row="subagent-kg-writer"]').click();
    const kgwCard = page.locator('[data-agent-card="subagent-kg-writer"]');
    await expect(kgwCard.locator("[data-tool-row]")).toHaveCount(14, { timeout: 10_000 });
    await expect(kgwCard.locator('[data-tool-row="kg-update"] [data-pinned-chip]')).toHaveText("恒在");
    await expect(kgwCard.locator("[data-derived-note]")).toHaveCount(0);
    // 系统块技能 = 自身清单 + builtin 播种（plan-workflow 在场且开）
    await expect(kgwCard.locator('[data-skill-row="plan-workflow"]')).toHaveCount(1);
    await expect(kgwCard.locator('[data-skill-row="plan-workflow"] [data-switch="plan-workflow"]')).toHaveAttribute("aria-checked", "true");
    await page.locator('[data-agent-row="subagent-code-reviewer"]').click();
    const revCard = page.locator('[data-agent-card="subagent-code-reviewer"]');
    await expect(revCard.locator("[data-tool-row]")).toHaveCount(11, { timeout: 10_000 });
    await expect(revCard.locator('[data-tool-row="write"]')).toHaveCount(0);
    await expect(revCard.locator('[data-tool-row="edit"]')).toHaveCount(0);
    await expect(revCard.locator("[data-derived-note]")).toHaveCount(0);
    await page.locator('[data-agent-row="main-session"]').click();

    // 技能源单层化（单源管理批删 project 源）：user hello 在场；坏文件 →
    // invalid_metadata 诊断；user 技能显式启用制（缺省停用，见 T2）
    await expect(mainCard.locator('[data-skill-row="hello-skill"] [data-source-chip]')).toHaveText("user");
    const diag = mainCard.locator("[data-diag-row]");
    await expect(diag).toHaveCount(1);
    await expect(diag).toContainText("invalid_metadata");

    // 模型下拉：builtin 目录经死代理回落可用 + S3a 可用性口径（auth.list
    // 到达后仅 configured 组——预置 anthropic key → 只剩 anthropic 组；
    // 其余 builtin provider 整组隐藏）+ 缺省项
    const sel = page.locator("#sel-model-main-session");
    await expect(sel.locator("optgroup").first()).toBeAttached({ timeout: 15_000 });
    await expect(sel.locator("optgroup")).toHaveCount(1, { timeout: 10_000 });
    await expect(sel.locator("optgroup").first()).toHaveAttribute("label", "anthropic");
    expect(await sel.locator("option").first().textContent()).toBe("跟随全局默认");

    await shotEvidence(page, "agents-e2e-dark", "CL-skills");
    writeEvidence(
      "agents-e2e",
      "txt",
      [
        "agent-roster 批 CL-skills E 层 agent.config 真链路",
        "断言: master-detail 两组列表+只读徽标/只读详情零控件+派生说明+恒在徽标",
        "  /list 双层技能目录渲染+诊断+snippet/toggle 落库+changed 广播+reload 持久/",
        "  模型下拉 S3a 可用性过滤（仅 configured 组）/模型槽位 set+clear/skipped 磁盘漂移回执",
        "结果: PASS",
      ].join("\n"),
      "CL-skills",
    );
  });

  test("T2 toggle 全链：关技能 → applied + changed 广播重拉 → 态翻转；reload 持久（SQLite）", async ({ e2e, page }) => {
    const home = prepHome();
    const daemon = await e2e.startDaemon({ script: SCRIPT, home, env: DEAD_PROXY });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await openAgents(page);

    // 开 hello-skill（user 技能显式启用制——缺省停用）→ 真落库 + 真广播 → 页面重拉翻转
    const helloSwitch = page.locator('[data-agent-card="main-session"] [data-skill-row="hello-skill"] [data-switch="hello-skill"]');
    await expect(helloSwitch).toHaveAttribute("aria-checked", "false");
    await helloSwitch.click();
    await expect(helloSwitch).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
    await expect(helloSwitch).toBeEnabled();

    // reload（同 home 同 daemon）→ 持久态仍翻转（resource_state 表权威）
    await page.reload();
    await e2e.waitForConnected(page);
    await openAgents(page);
    await expect(page.locator('[data-agent-card="main-session"] [data-skill-row="hello-skill"] [data-switch="hello-skill"]')).toHaveAttribute(
      "aria-checked",
      "true",
      { timeout: 15_000 },
    );
    expect(daemon.home).toBe(home);
  });

  test("T3 模型槽位：选 builtin 模型 → 落库 + changed 重拉刷新；选回缺省 → clear", async ({ e2e, page }) => {
    const home = prepHome();
    await e2e.startDaemon({ script: SCRIPT, home, env: DEAD_PROXY });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await openAgents(page);

    const sel = page.locator("#sel-model-main-session");
    await expect(sel.locator("optgroup").first()).toBeAttached({ timeout: 15_000 });
    await sel.selectOption(SLOT_MODEL);
    // 真链：hasModel 目录校验 → 槽位落库 → changed → 重拉 → 下拉值刷新
    await expect(sel).toHaveValue(SLOT_MODEL, { timeout: 10_000 });

    // 选回缺省 → clear 槽位 → 下拉回空
    await sel.selectOption("");
    await expect(sel).toHaveValue("", { timeout: 10_000 });
  });

  test("T4 skipped 回执：list 后删技能文件（磁盘漂移）→ toggle → unknown-name toast + 态不翻转", async ({ e2e, page }) => {
    const home = prepHome();
    await e2e.startDaemon({ script: SCRIPT, home, env: DEAD_PROXY });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await openAgents(page);

    // 首帧已渲染 hello-skill（user 显式启用制：缺省停用）
    const helloSwitch = page.locator('[data-agent-card="main-session"] [data-skill-row="hello-skill"] [data-switch="hello-skill"]');
    await expect(helloSwitch).toHaveAttribute("aria-checked", "false");

    // 磁盘漂移：删 user 层技能文件 → toggle → daemon 重扫全集外 → skipped
    rmSync(path.join(home, "skills", "hello-skill"), { recursive: true, force: true });
    await helloSwitch.click();
    await expect(page.locator(".toast", { hasText: "未生效" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".toast", { hasText: "未生效" })).toContainText("unknown-name");
    // 态不翻转（skipped 不落库）+ 在途清
    await expect(helloSwitch).toBeEnabled();
    await expect(helloSwitch).toHaveAttribute("aria-checked", "false");
  });
});

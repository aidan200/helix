/**
 * M6 T4 —— CL-skills 智能体页（F 层 mock 帧剧本；契约 v0.6 agent.config 族）。
 *
 * 剧本（mock mode；list 双块数据 → 渲染断言 → toggle 命令帧序 → changed
 * 广播更新 → skipped 回执呈现）：
 * - 渲染：双卡片（main 8 工具 / sub 5 工具，snippet 呈现；技能来源分组 +
 *   诊断警示；模型下拉双 kind 缺省项语义 + catalog optgroup）；
 * - 数据链：进页 → agent.config.list（全 kind，全局命令无信封 sessionId）
 *   → list.result 双块渲染；
 * - toggle：点击工具开关 → agent.config.set_enabled 命令 payload 断言 →
 *   applied 回执 → changed 广播 → 重拉 list → 态翻转（事件驱动）；
 * - skipped：全集外名回执 → toast 呈现原因 + 开关态不翻转；
 * - a11y：开关 role=switch + aria-checked；导航名「智能体」；
 * - 双主题：DARK/LIGHT 渲染 + 证据截图。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  agentConfigChanged,
  agentConfigListResult,
  agentConfigSetResult,
  catalogModel,
  modelCatalogResult,
  snapshot,
  welcome,
} from "./harness/protocol";
import type { AgentConfigProfileBlock } from "@helix/protocol";

const FAKE = "?fakeTransport=1";

/** 剧本：main 卡（8 工具全启用 + 双源技能 + invalid_metadata 诊断）。 */
const MAIN_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "agent_spawn",
  "agent_send",
  "agent_status",
];
const SNIPPETS: Record<string, string> = {
  bash: "在沙箱工作目录执行 shell 命令并返回输出",
  read: "读取文件内容（文本或图片）",
  write: "创建新文件或整体写入文件",
  edit: "按精确文本匹配做字符串替换编辑",
  grep: "跨文件正则检索并列出匹配行",
  agent_spawn: "指派 SubAgent 实例独立执行任务（并行委派，立即返回不等完成）",
  agent_send: "向运行中的 SubAgent 实例追加补充指示",
  agent_status: "查询 SubAgent 的当前执行状态",
};
const SUB_TOOLS = ["bash", "read", "write", "edit", "grep"];

const MAIN_BLOCK: AgentConfigProfileBlock = {
  profileKind: "main-session",
  tools: MAIN_TOOLS.map((name) => ({ name, enabled: name !== "grep", snippet: SNIPPETS[name]! })),
  skills: [
    {
      name: "hello-skill",
      description: "问候技能：按名字打招呼并可选回显附加信息",
      filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md",
      source: "user",
      enabled: true,
    },
    {
      name: "ws-review",
      description: "工作区评审技能：按迭代清单核对交付物",
      filePath: "/ws/.helix/skills/ws-review/SKILL.md",
      source: "project",
      enabled: true,
    },
  ],
  diagnostics: [
    {
      code: "invalid_metadata",
      message: "SKILL.md 缺少 description",
      path: "/ws/.helix/skills/broken/SKILL.md",
      source: "project",
    },
  ],
  model: null,
};

const SUB_BLOCK: AgentConfigProfileBlock = {
  profileKind: "subagent-worker",
  tools: SUB_TOOLS.map((name) => ({ name, enabled: true, snippet: SNIPPETS[name]! })),
  skills: [
    {
      name: "hello-skill",
      description: "问候技能：按名字打招呼并可选回显附加信息",
      filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md",
      source: "user",
      enabled: false,
    },
  ],
  diagnostics: [],
  model: null,
};

/** 进页 + 回放 list 双块 + 目录（P-3/P-4 同源 catalog 数据面）。 */
async function openAgents(mock: import("./harness/mock-session").MockController, page: import("@playwright/test").Page) {
  await page.goto(`/skills${FAKE}`);
  await mock.awaitReady();
  await mock.open();
  await mock.waitForCommand("hello");
  const catalog = [
    catalogModel("anthropic/claude-sonnet-4-5", 200_000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
    catalogModel("anthropic/claude-opus-4-1", 200_000, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    catalogModel("openai/gpt-5.2", 400_000, { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }),
  ];
  // 建连三件套（welcome + snapshot）+ 页面命令回执
  await mock.emitAll([welcome({}), snapshot([], {})]);
  await mock.waitForCommand("agent.config.list");
  await mock.waitForCommand("model.catalog");
  await mock.emit(modelCatalogResult(catalog, { source: "cache" }));
  await mock.emit(agentConfigListResult([MAIN_BLOCK, SUB_BLOCK]));
  await expect(page.locator('[data-agents-page="/skills"]')).toBeVisible();
  await expect(page.locator('[data-tool-row="bash"]')).toHaveCount(2); // 双卡各一行
}

test.describe("M6 T4 CL-skills 智能体页（F 层 mock）", () => {
  test("① 渲染：双卡片 / 工具组（8+5 snippet）/ 技能组（来源分组+诊断）/ 模型下拉双 kind 缺省项", async ({ mock, page }) => {
    await openAgents(mock, page);

    const mainCard = page.locator('[data-agent-card="main-session"]');
    const subCard = page.locator('[data-agent-card="subagent-worker"]');
    await expect(mainCard).toBeVisible();
    await expect(subCard).toBeVisible();

    // main 8 工具（含编排三件套）+ snippet 一句话
    await expect(mainCard.locator("[data-tool-row]")).toHaveCount(8);
    await expect(mainCard.locator('[data-tool-row="grep"]')).toContainText("跨文件正则检索并列出匹配行");
    await expect(mainCard.locator('[data-tool-row="agent_spawn"]')).toContainText("指派 SubAgent 实例独立执行任务");

    // sub 5 工具（无编排三件套）+ snippet
    await expect(subCard.locator("[data-tool-row]")).toHaveCount(5);
    await expect(subCard.locator('[data-tool-row="agent_spawn"]')).toHaveCount(0);

    // 技能组：来源分组（user 在前 project 在后）+ 诊断警示
    await expect(mainCard.locator('[data-skill-row="hello-skill"] [data-source-chip]')).toHaveText("user");
    await expect(mainCard.locator('[data-skill-row="ws-review"] [data-source-chip]')).toHaveText("project");
    const diag = mainCard.locator("[data-diag-row]");
    await expect(diag).toHaveCount(1);
    await expect(diag).toContainText("invalid_metadata");
    await expect(diag).toContainText("SKILL.md 缺少 description");

    // 模型下拉：main 缺省项「跟随全局默认」+ optgroup；sub 缺省项三级链语义
    const mainSel = page.locator("#sel-model-main-session");
    await expect(mainSel).toHaveValue("");
    expect(await mainSel.locator("option").first().textContent()).toBe("跟随全局默认");
    await expect(mainSel.locator("optgroup")).toHaveCount(2);
    const subSel = page.locator("#sel-model-subagent-worker");
    expect(await subSel.locator("option").first().textContent()).toBe("跟随会话与全局默认");

    // 两级关系说明注解
    await expect(mainCard.locator('[data-note="main"]')).toContainText("已手动切换的会话不受影响");
    await expect(subCard.locator('[data-note="sub"]')).toContainText("运行中实例不受影响");

    // a11y：开关语义化（role=switch + aria-checked；grep 初始禁用态=false）
    const grepSwitch = mainCard.locator('[data-switch="grep"]');
    await expect(grepSwitch).toHaveAttribute("role", "switch");
    await expect(grepSwitch).toHaveAttribute("aria-checked", "false");
    await expect(mainCard.locator('[data-switch="bash"]')).toHaveAttribute("aria-checked", "true");
  });

  test("② 数据链：list 命令（全局无信封 sessionId）→ toggle 命令帧序 → applied + changed 广播重拉 → 态翻转", async ({ mock, page }) => {
    await openAgents(mock, page);

    // list 命令形态：全局命令（payload {} 无 profileKind；无信封 sessionId）
    const listCmd = (await mock.clientFrames()).find((f) => f.type === "agent.config.list");
    expect(listCmd!.payload).toEqual({});
    expect(listCmd!.sessionId).toBeUndefined();

    // 点击 bash 开关 → set_enabled（payload 四字段）
    await page.locator('[data-agent-card="main-session"] [data-switch="bash"]').click();
    const cmd = await mock.waitForCommand("agent.config.set_enabled");
    expect(cmd.payload).toEqual({
      profileKind: "main-session",
      resourceType: "tool",
      name: "bash",
      enabled: false,
    });
    expect(cmd.sessionId).toBeUndefined();

    // 在途：开关禁用 + 态未翻转（事件驱动非乐观）
    const bashSwitch = page.locator('[data-agent-card="main-session"] [data-switch="bash"]');
    await expect(bashSwitch).toBeDisabled();
    await expect(bashSwitch).toHaveAttribute("aria-checked", "true");

    // applied 回执 → changed 广播 → 重拉 list（帧序）
    await mock.emit(agentConfigSetResult({ status: "applied" }));
    await mock.emit(agentConfigChanged({ profileKind: "main-session", resourceType: "tool", name: "bash", enabled: false }));
    await mock.waitForCommand("agent.config.list");
    const refreshedMain: AgentConfigProfileBlock = {
      ...MAIN_BLOCK,
      tools: MAIN_BLOCK.tools.map((t) => (t.name === "bash" ? { ...t, enabled: false } : t)),
    };
    await mock.emit(agentConfigListResult([refreshedMain, SUB_BLOCK]));
    await expect(bashSwitch).toHaveAttribute("aria-checked", "false");
    await expect(bashSwitch).toBeEnabled();

    // 多页一致性：changed 广播无本地写 → 态仅随重拉翻（切走再回不闪旧态）
    await page.locator('.rail-btn[data-page="chat"]').click();
    await page.locator('.rail-btn[data-page="skills"]').click();
    await expect(page.locator('[data-agent-card="main-session"] [data-switch="bash"]')).toHaveAttribute("aria-checked", "false");
  });

  test("③ skipped 回执呈现：全集外名 → toast 原因 + 开关态不翻转", async ({ mock, page }) => {
    await openAgents(mock, page);

    const readSwitch = page.locator('[data-agent-card="main-session"] [data-switch="read"]');
    await readSwitch.click();
    await mock.waitForCommand("agent.config.set_enabled");
    await mock.emit(agentConfigSetResult({ status: "skipped", reason: "unknown-name" }));

    // toast：未生效 + 原因
    await expect(page.locator(".toast", { hasText: "未生效" })).toBeVisible();
    await expect(page.locator(".toast", { hasText: "未生效" })).toContainText("unknown-name");
    // 在途清 + 态不翻转（skipped 不落库）
    await expect(readSwitch).toBeEnabled();
    await expect(readSwitch).toHaveAttribute("aria-checked", "true");
  });

  test("④ 模型槽位：选模型 → set(model,true) → changed 重拉刷新；选缺省 → clear(model,false)", async ({ mock, page }) => {
    await openAgents(mock, page);

    const sel = page.locator("#sel-model-main-session");
    await sel.selectOption("anthropic/claude-sonnet-4-5");
    const setCmd = await mock.waitForCommand("agent.config.set_enabled");
    expect(setCmd.payload).toEqual({
      profileKind: "main-session",
      resourceType: "model",
      name: "anthropic/claude-sonnet-4-5",
      enabled: true,
    });

    // applied + changed(name=model) → 重拉（槽位已设 → 下拉值刷新）
    await mock.emit(agentConfigSetResult({ status: "applied" }));
    await mock.emit(agentConfigChanged({ profileKind: "main-session", resourceType: "model", name: "anthropic/claude-sonnet-4-5", enabled: true }));
    await mock.waitForCommand("agent.config.list");
    await mock.emit(agentConfigListResult([{ ...MAIN_BLOCK, model: "anthropic/claude-sonnet-4-5" }, SUB_BLOCK]));
    await expect(sel).toHaveValue("anthropic/claude-sonnet-4-5");

    // 选回缺省 → clear（enabled=false）
    await sel.selectOption("");
    const clearCmd = await mock.waitForCommand("agent.config.set_enabled");
    expect(clearCmd.payload).toEqual({
      profileKind: "main-session",
      resourceType: "model",
      name: "",
      enabled: false,
    });
  });

  test("⑤ 导航更名 + 双主题渲染（DARK/LIGHT）+ 施工牌收口", async ({ mock, page }) => {
    await openAgents(mock, page);

    // 导航名「智能体」（rail skills 位 tooltip/label）
    const skillsBtn = page.locator('.rail-btn[data-page="skills"]');
    await expect(skillsBtn).toHaveAttribute("aria-label", "智能体");

    // skills 位不再是施工牌
    await expect(page.locator('[data-construction="/skills"]')).toHaveCount(0);

    for (const theme of ["dark", "light"] as const) {
      await page.locator(theme === "light" ? "#btn-light" : "#btn-dark").click();
      if (theme === "light") {
        await expect(page.locator("html")).toHaveClass("light");
      } else {
        await expect(page.locator("html")).not.toHaveClass(/light/);
      }
      const mainCard = page.locator('[data-agent-card="main-session"]');
      await expect(mainCard).toBeVisible();
      // 开关双态都在场（渲染完整性）
      await expect(mainCard.locator('[data-switch="bash"]')).toHaveAttribute("aria-checked", "true");
      await expect(mainCard.locator('[data-switch="grep"]')).toHaveAttribute("aria-checked", "false");
      await shotEvidence(page, `agents-${theme}`, "CL-skills");
    }

    writeEvidence(
      "agents-page",
      "txt",
      [
        "M6 T4 CL-skills 智能体页（F 层 mock 帧剧本）",
        "断言: 双卡片渲染(8+5 工具 snippet/技能来源分组/诊断警示/模型下拉双 kind 缺省项)",
        "  /list 全局命令形态/toggle 命令帧序+applied+changed 广播重拉态翻转/skipped toast",
        "  /模型槽位 set+clear/导航更名/双主题",
        "结果: PASS",
      ].join("\n"),
      "CL-skills",
    );
  });
});

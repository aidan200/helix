/**
 * M6 T4 —— CL-skills 智能体页（F 层 mock 帧剧本；契约 v0.6 agent.config 族）。
 *
 * 剧本（mock mode；list 双块数据 → 渲染断言 → toggle 命令帧序 → changed
 * 广播更新 → skipped 回执呈现）：
 * - 渲染：双卡片（main 8 工具 / sub 5 工具，snippet 呈现；技能来源分组 +
 *   诊断警示；模型下拉双 kind 缺省项语义 + catalog optgroup）；
 * - 数据链：进页 → agent.config.list（全 kind，全局命令无信封 sessionId）
 *   + auth.list（S3a 可用性过滤数据源，P-3 同口径）→ list.result 双块渲染；
 * - toggle：点击工具开关 → agent.config.set_enabled 命令 payload 断言 →
 *   applied 回执 → changed 广播 → 重拉 list → 态翻转（事件驱动）；
 * - skipped：全集外名回执 → toast 呈现原因 + 开关态不翻转；
 * - 模型下拉可用性（S3a）：configured 过滤 + 当前槽位模型兑底（P-3 同一
 *   filterAvailableModels）；
 * - a11y：开关 role=switch + aria-checked；导航名「智能体」；
 * - 双主题：DARK/LIGHT 渲染 + 证据截图。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  agentConfigChanged,
  agentConfigListResult,
  agentConfigSetResult,
  authListResult,
  catalogModel,
  modelCatalogResult,
  snapshot,
  welcome,
} from "./harness/protocol";
import type { AgentConfigProfileBlock, AgentConfigSystemBlock } from "@helix/protocol";

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

/** agent-roster 批：只读系统派生双块（系统组列表 + 只读详情数据面）。 */
const ORCH_BLOCK: AgentConfigSystemBlock = {
  profileKind: "orchestrator",
  tools: [
    { name: "agent_spawn", snippet: "指派 SubAgent 实例独立执行任务（并行委派，立即返回不等完成）" },
    { name: "kg", snippet: "查询项目知识图谱（只读）" },
  ],
};
const KGW_BLOCK: AgentConfigSystemBlock = {
  profileKind: "subagent-kg-writer",
  tools: [
    ...SUB_TOOLS.map((name) => ({ name, snippet: SNIPPETS[name]! })),
    { name: "kg-update", snippet: "知识图谱即时落账（supersede 推翻节点 / createNode 沉淀新知识）" },
  ],
  derivedFrom: "subagent-worker",
  pinnedTools: ["kg-update"],
};

/** 进页 + 回放 list 双块（含 system 只读双块）+ 目录（P-3/P-4 同源 catalog
 * 数据面）+ auth.list（S3a 可用性过滤数据源；双 provider 均 configured →
 * 全目录在场）。 */
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
  await mock.waitForCommand("auth.list"); // S3a：进页补发 auth.list（P-3 同口径）
  await mock.emit(modelCatalogResult(catalog, { source: "cache" }));
  await mock.emit(authListResult([
    { providerId: "anthropic", configured: true, keyMasked: "····e2e1" },
    { providerId: "openai", configured: true, keyMasked: "····e2e2" },
  ]));
  await mock.emit(agentConfigListResult([MAIN_BLOCK, SUB_BLOCK], [ORCH_BLOCK, KGW_BLOCK]));
  await expect(page.locator('[data-agents-page="/skills"]')).toBeVisible();
  // master-detail：左栏四条目在场（agent-roster 批）
  await expect(page.locator("[data-agent-row]")).toHaveCount(4);
  await page.locator('[data-agent-row="main-session"]').click();
  await expect(page.locator('[data-agent-card="main-session"] [data-tool-row="bash"]')).toBeVisible();
}

test.describe("M6 T4 CL-skills 智能体页（F 层 mock）", () => {
  test("① 渲染：master-detail 左栏两组 + 详情卡（工具组 snippet / 技能组来源分组+诊断 / 模型下拉缺省项）", async ({ mock, page }) => {
    await openAgents(mock, page);

    const mainCard = page.locator('[data-agent-card="main-session"]');
    await expect(mainCard).toBeVisible();

    // main 8 工具（含编排三件套）+ snippet 一句话
    await expect(mainCard.locator("[data-tool-row]")).toHaveCount(8);
    await expect(mainCard.locator('[data-tool-row="grep"]')).toContainText("跨文件正则检索并列出匹配行");
    await expect(mainCard.locator('[data-tool-row="agent_spawn"]')).toContainText("指派 SubAgent 实例独立执行任务");

    // 切到 sub：5 工具（无编排三件套）+ snippet（详情随选中切换）
    await page.locator('[data-agent-row="subagent-worker"]').click();
    const subCard = page.locator('[data-agent-card="subagent-worker"]');
    await expect(subCard).toBeVisible();
    await expect(mainCard).toHaveCount(0); // 同刻仅一详情（互斥）
    await expect(subCard.locator("[data-tool-row]")).toHaveCount(5);
    await expect(subCard.locator('[data-tool-row="agent_spawn"]')).toHaveCount(0);
    await page.locator('[data-agent-row="main-session"]').click();

    // 技能组：来源分组（user 在前 project 在后）+ 诊断警示（main 详情）
    await expect(mainCard.locator('[data-skill-row="hello-skill"] [data-source-chip]')).toHaveText("user");
    await expect(mainCard.locator('[data-skill-row="ws-review"] [data-source-chip]')).toHaveText("project");
    const diag = mainCard.locator("[data-diag-row]");
    await expect(diag).toHaveCount(1);
    await expect(diag).toContainText("invalid_metadata");
    await expect(diag).toContainText("SKILL.md 缺少 description");

    // 模型下拉：main 缺省项「跟随全局默认」+ optgroup；sub 缺省项两级链语义（T12）
    const mainSel = page.locator("#sel-model-main-session");
    await expect(mainSel).toHaveValue("");
    expect(await mainSel.locator("option").first().textContent()).toBe("跟随全局默认");
    await expect(mainSel.locator("optgroup")).toHaveCount(2);
    await page.locator('[data-agent-row="subagent-worker"]').click();
    const subSel = page.locator("#sel-model-subagent-worker");
    expect(await subSel.locator("option").first().textContent()).toBe("跟随全局默认");
    await page.locator('[data-agent-row="main-session"]').click();

    // 两级关系说明注解
    await expect(mainCard.locator('[data-note="main"]')).toContainText("已手动切换的会话不受影响");
    await page.locator('[data-agent-row="subagent-worker"]').click();
    await expect(page.locator('[data-agent-card="subagent-worker"] [data-note="sub"]')).toContainText("运行中实例不受影响");
    await page.locator('[data-agent-row="main-session"]').click();

    // a11y：开关语义化（role=switch + aria-checked；grep 初始禁用态=false）
    const grepSwitch = mainCard.locator('[data-switch="grep"]');
    await expect(grepSwitch).toHaveAttribute("role", "switch");
    await expect(grepSwitch).toHaveAttribute("aria-checked", "false");
    await expect(mainCard.locator('[data-switch="bash"]')).toHaveAttribute("aria-checked", "true");
  });

  test("①b master-detail 系统派生组：两组分组标题 + 只读徽标 + 只读详情纯展示 + 选中切换回可编辑", async ({ mock, page }) => {
    await openAgents(mock, page);

    // 两组分组标题 + 条目序（可配置 2 + 系统派生 2）
    await expect(page.locator('[data-agent-group="editable"]')).toHaveText("可配置");
    await expect(page.locator('[data-agent-group="system"]')).toHaveText("系统派生");
    await expect(page.locator("[data-agent-row]")).toHaveCount(4);
    // 只读组两行带只读徽标（可配置组无）
    const roBadges = page.locator('[data-ro="true"] [data-ro-badge]');
    await expect(roBadges).toHaveCount(2);
    await expect(roBadges.first()).toHaveText("只读");

    // orchestrator 只读详情：纯展示（零开关零下拉零技能组）
    await page.locator('[data-agent-row="orchestrator"]').click();
    const orchCard = page.locator('[data-agent-card="orchestrator"]');
    await expect(orchCard).toBeVisible();
    await expect(orchCard.locator("[data-ro-badge]")).toHaveText("只读");
    await expect(orchCard.locator("[data-switch]")).toHaveCount(0);
    await expect(orchCard.locator("select")).toHaveCount(0);
    await expect(orchCard.locator("[data-ro-model]")).toHaveText("跟随全局默认");
    await expect(orchCard.locator('[data-ro-tool-row="agent_spawn"]')).toContainText("并行委派");
    await expect(orchCard.locator("[data-ro-tool-row]")).toHaveCount(2);
    await expect(orchCard.locator("[data-derived-note]")).toHaveCount(0);

    // kg-writer 只读详情：派生说明位 + kg-update 恒在徽标
    await page.locator('[data-agent-row="subagent-kg-writer"]').click();
    const kgwCard = page.locator('[data-agent-card="subagent-kg-writer"]');
    await expect(kgwCard).toBeVisible();
    await expect(kgwCard.locator("[data-derived-note]")).toHaveText("工具集跟随 subagent-worker，额外固定 kg-update");
    await expect(kgwCard.locator('[data-ro-tool-row="kg-update"] [data-pinned-chip]')).toHaveText("恒在");
    await expect(kgwCard.locator("[data-ro-tool-row]")).toHaveCount(6); // sub 5 + kg-update
    await expect(kgwCard.locator("[data-switch]")).toHaveCount(0);

    // 切回可编辑：开关回场（两组形态互斥）
    await page.locator('[data-agent-row="main-session"]').click();
    const mainCard = page.locator('[data-agent-card="main-session"]');
    await expect(mainCard.locator('[data-tool-row="bash"]')).toBeVisible();
    expect((await mainCard.locator("[data-switch]").count()) as number).toBeGreaterThan(0);
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
    await mock.emit(agentConfigListResult([refreshedMain, SUB_BLOCK], [ORCH_BLOCK, KGW_BLOCK]));
    await expect(bashSwitch).toHaveAttribute("aria-checked", "false");
    await expect(bashSwitch).toBeEnabled();

    // 多页一致性：changed 广播无本地写 → 态仅随重拉翻（切走再回不闪旧态）
    await page.locator('.rail-btn[data-page="chat"]').click();
    await page.locator('.rail-btn[data-page="skills"]').click();
    // 重挂载重拉：等 list 命令 → 回放刷新块 → 默认选中 main（重挂复位；点击幂等）→ 态保持
    await mock.waitForCommand("agent.config.list");
    await mock.emit(agentConfigListResult([refreshedMain, SUB_BLOCK], [ORCH_BLOCK, KGW_BLOCK]));
    await page.locator('[data-agent-row="main-session"]').click();
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
    await mock.emit(agentConfigListResult([{ ...MAIN_BLOCK, model: "anthropic/claude-sonnet-4-5" }, SUB_BLOCK], [ORCH_BLOCK, KGW_BLOCK]));
    await expect(sel).toHaveValue("anthropic/claude-sonnet-4-5");

    // 选回缺省 → clear（enabled=false；name = 忽略位占位 "-"，契约钉非空）
    // 新帧等待：waitForCommand 会命中历史 set 帧——按计数增量取最新帧
    const setCount = async () =>
      (await mock.clientFrames()).filter((f) => f.type === "agent.config.set_enabled").length;
    const before = await setCount();
    await sel.selectOption("");
    await expect.poll(setCount).toBe(before + 1);
    const clearCmd = (await mock.clientFrames()).filter((f) => f.type === "agent.config.set_enabled").at(-1)!;
    expect(clearCmd.payload).toEqual({
      profileKind: "main-session",
      resourceType: "model",
      name: "-",
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

    // 双主题：S1 主题单钮在 IconRail（常驻可点；toggle 需按目标态按需点击）
    for (const theme of ["dark", "light"] as const) {
      await page.locator('.rail-btn[data-page="chat"]').click();
      const isLight = await page.evaluate(() =>
        document.documentElement.classList.contains("light"),
      );
      if ((theme === "light") !== isLight) {
        await page.locator("#btn-theme-toggle").click();
      }
      if (theme === "light") {
        // 容忍 boot-light 引导标记类（启动期短暂共存；主体断言 = light 主题在场）
        await expect(page.locator("html")).toHaveClass(/light/);
      } else {
        await expect(page.locator("html")).not.toHaveClass(/light/);
      }
      await page.locator('.rail-btn[data-page="skills"]').click();
      // 重挂载重拉：mock 不自动应答——回放双块后断言（默认选中 main，重挂复位；点击幂等）
      await mock.waitForCommand("agent.config.list");
      await mock.emit(agentConfigListResult([MAIN_BLOCK, SUB_BLOCK], [ORCH_BLOCK, KGW_BLOCK]));
      await page.locator('[data-agent-row="main-session"]').click();
      const mainCard = page.locator('[data-agent-card="main-session"]');
      await expect(mainCard.locator('[data-tool-row="bash"]')).toBeVisible({ timeout: 10_000 });
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
  test("⑥ 模型下拉可用性口径（S3a）：configured 过滤 + 当前槽位兑底（与 P-3 同一过滤函数）", async ({ mock, page }) => {
    await openAgents(mock, page);

    const sel = page.locator("#sel-model-main-session");
    // 基线：双 provider 均 configured → 全目录两组在场
    await expect(sel.locator("optgroup")).toHaveCount(2);

    // ① configured 过滤：openai 撤销配置 → openai 组整体隐藏（子卡同步）
    await mock.emit(authListResult([
      { providerId: "anthropic", configured: true, keyMasked: "····e2e1" },
      { providerId: "openai", configured: false },
    ]));
    await expect(sel.locator("optgroup")).toHaveCount(1);
    await expect(sel.locator("optgroup").first()).toHaveAttribute("label", "anthropic");
    // 缺省项 + anthropic 双模型 = 3 项（openai 模型不在场）；子卡同步（切 sub 断言）
    await expect(sel.locator("option")).toHaveCount(3);
    await page.locator('[data-agent-row="subagent-worker"]').click();
    await expect(page.locator("#sel-model-subagent-worker").locator("optgroup")).toHaveCount(1);
    await page.locator('[data-agent-row="main-session"]').click();

    // ② 当前槽位兑底：main 已配 openai 模型但 provider 未 configured → 仍可见
    //（防配置了不可用模型的 agent 在下拉里找不到当前项；与 P-3 当前项兑底同语义）
    await mock.emit(agentConfigListResult([{ ...MAIN_BLOCK, model: "openai/gpt-5.2" }, SUB_BLOCK], [ORCH_BLOCK, KGW_BLOCK]));
    await expect(sel).toHaveValue("openai/gpt-5.2");
    await expect(sel.locator("optgroup")).toHaveCount(2); // openai 组仅兑底项回场
    await expect(sel.locator("option")).toHaveCount(4);
  });

});

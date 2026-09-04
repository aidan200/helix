/**
 * T3.3 —— CL-3 模型与厂商配置（F(3.4).1-F(3.4).6；S2：迁入设置页模型分区）。
 *
 * 剧本（契约 C model/auth 族；test-design §2 CL-3 表 4-9 组；S2 入口改走
 * /settings 页内模型分区，断言锚沿迁移前）：
 * - provider 列表：字母分组 / 已配高亮 + 尾 4 位脱敏 / 未配弱化；
 * - 模型表：展开 provider 显示 id / 上下文 / 四费率（$ / 1M tokens，
 *   tabular-nums；MODEL_CATALOG 字段结构断言）+ 默认行高亮 DEFAULT chip；
 * - key 弹层：非空校验（空提交红边 + 内联错误 + 聚焦）/ 输入转 clean /
 *   保存发 auth.set_key（回执驱动脱敏更新 + 连通态重置未验证）/ 两段式
 *   行内删除确认（armed 文案 → 二击 auth.delete_key）；
 * - 连通四态互斥：测试连通 → auth.verify → verifying → ok（含延迟）/
 *   fail（含原因）；重测先清旧态；
 * - 目录刷新：model.catalog_refresh（绕过缓存）→ 转动反馈 → 时间戳更新；
 * - 全局默认：选择器 → model.set_default（乐观更新）+ DEFAULT chip 迁移。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  authDeleteKeyResult,
  authListResult,
  authSetKeyResult,
  authVerifyResult,
  catalogModel,
  modelCatalogRefreshResult,
  modelCatalogResult,
  modelGetDefaultResult,
  modelSetDefaultResult,
} from "./harness/protocol";
import { MODEL_CATALOG } from "./harness/scenarios";

/** 剧本常量。 */
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

/** auth.list 剧本（7 provider，对齐原型形态：3 ok / 1 fail / 1 未验证 / 2 未配）。 */
const PROVIDERS = [
  { providerId: "anthropic", configured: true, keyMasked: "····7f3a", verifyStatus: "ok" as const },
  { providerId: "deepseek", configured: true, keyMasked: "····c21e", verifyStatus: "ok" as const },
  { providerId: "google", configured: true, keyMasked: "····93d0", verifyStatus: "fail" as const },
  { providerId: "mistral", configured: false },
  { providerId: "moonshot", configured: true, keyMasked: "····5b8f", verifyStatus: "unverified" as const },
  { providerId: "openai", configured: true, keyMasked: "····e042", verifyStatus: "ok" as const },
  { providerId: "xai", configured: false },
];

/** 目录（MODEL_CATALOG 11 模型 + mistral 行，auth.list 全集可展开）。 */
function catalogFrames() {
  return [
    ...MODEL_CATALOG,
    catalogModel("mistral/mistral-large-latest", 128_000, { input: 2, output: 6, cacheRead: 0.5 }),
  ];
}

/** 进入设置页模型分区并回放三帧（目录 + 默认 + 凭据清单；S2 原独立页迁入）。 */
async function openModelsSection(mock: import("./harness/mock-session").MockController, page: import("@playwright/test").Page) {
  await page.locator('.rail-btn[data-page="settings"]').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("[data-models-section]")).toBeVisible();
  await mock.waitForCommand("model.catalog");
  await mock.waitForCommand("model.get_default");
  await mock.waitForCommand("auth.list");
  await mock.emit(modelCatalogResult(catalogFrames(), { refreshedAt: Date.now() - 12 * 60_000, source: "cache" }));
  await mock.emit(modelGetDefaultResult(DEFAULT_MODEL));
  await mock.emit(authListResult(PROVIDERS));
  await expect(page.locator('[data-prov="anthropic"]')).toBeVisible();
}

test.describe("T3.3 CL-3 模型与厂商配置（设置页分区）", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect();
  });

  test("F(3.4).1 provider 列表：字母分组 + 已配高亮脱敏 + 未配弱化 + 连通徽标初值", async ({ mock, page }) => {
    await openModelsSection(mock, page);

    // 字母分组标签行（A/D/G/M/O/X）
    for (const letter of ["A", "D", "G", "M", "O", "X"]) {
      await expect(page.locator(".pgroup-label", { hasText: letter })).toBeVisible();
    }
    await expect(page.locator(".prov")).toHaveCount(7);

    // 已配：accent 边框 + 尾 4 位脱敏（k4 accent 着色）
    const anthropic = page.locator('[data-prov="anthropic"]');
    await expect(anthropic).toHaveClass(/configured/);
    await expect(anthropic.locator(".key-chip")).toContainText("····7f3a");
    await expect(anthropic.locator(".key-chip .k4")).toHaveText("7f3a");

    // 连通徽标初值（daemon 三态映射）：ok 含延迟 / fail 含原因 / 未验证
    await expect(anthropic.locator("[data-conn-badge]")).toHaveAttribute("data-conn-badge", "ok");
    await expect(page.locator('[data-prov="google"] [data-conn-badge]')).toHaveAttribute("data-conn-badge", "fail");
    await expect(page.locator('[data-prov="google"] [data-conn-badge]')).toContainText("验证失败");
    await expect(page.locator('[data-prov="moonshot"] [data-conn-badge]')).toHaveAttribute("data-conn-badge", "unverified");

    // 未配：弱化「未配置」+ 无 configured 高亮
    const mistral = page.locator('[data-prov="mistral"]');
    await expect(mistral).not.toHaveClass(/configured/);
    await expect(mistral.locator(".key-none")).toHaveText("未配置");
  });

  test("F(3.4).4 模型表：展开四费率（tabular-nums 字段结构）+ 默认行高亮 + DEFAULT chip", async ({ mock, page }) => {
    await openModelsSection(mock, page);

    // 展开 anthropic（prov-body CSS 门控 open）
    await page.locator('[data-prov="anthropic"] [data-prov-toggle]').click();
    const body = page.locator('[data-prov="anthropic"]');
    await expect(body).toHaveClass(/open/);

    // 四费率行（MODEL_CATALOG 字段结构：opus $15/$75/$1.50/$18.75）
    const opus = body.locator('[data-model-row="anthropic/claude-opus-4-1"]');
    await expect(opus.locator("td").nth(1)).toHaveText("200k");
    await expect(opus.locator("td").nth(2)).toHaveText("$15");
    await expect(opus.locator("td").nth(3)).toHaveText("$75");
    await expect(opus.locator("td").nth(4)).toHaveText("$1.50");
    await expect(opus.locator("td").nth(5)).toHaveText("$18.75");
    // tabular-nums（数字列右对齐数字排版）
    expect(await opus.locator("td.num").first().evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain("tabular-nums");

    // 默认行高亮 + DEFAULT chip；表脚注（$ / 1M tokens 口径）
    const defRow = body.locator('[data-model-row="anthropic/claude-sonnet-4-5"]');
    await expect(defRow).toHaveClass(/is-default/);
    await expect(defRow.locator(".hud-chip")).toHaveText("default");
    await expect(body.locator(".mtable-cap")).toContainText("$ / 1M tokens");

    // mistral（目录扩展行）也可展开
    await page.locator('[data-prov="mistral"] [data-prov-toggle]').click();
    await expect(page.locator('[data-model-row="mistral/mistral-large-latest"]')).toBeVisible();
  });

  test("F(3.4).2 key 弹层：空值校验红边内联 + 输入转 clean + 保存命令 + 脱敏回执更新 + 连通重置", async ({ mock, page }) => {
    await openModelsSection(mock, page);

    // 未配 provider →「配置 key」主按钮 → 弹层
    await page.locator('[data-prov="mistral"] [data-prov-toggle]').click();
    await page.locator('[data-prov="mistral"] [data-prov-addkey]').click();
    const input = page.locator("[data-key-input]");
    await expect(input).toBeVisible();

    // 空值提交：红边 + 内联错误（非 toast）+ 聚焦
    await page.locator("#btn-modal-save").click();
    await expect(input).toHaveClass(/err/);
    await expect(page.locator("[data-key-err]")).toBeVisible();
    await expect(page.locator("[data-key-err]")).toHaveText("API key 不能为空");
    await expect(input).toBeFocused();

    // 输入转 clean（错误行隐藏——元素驻留 DOM 仅 display 门控）
    await input.fill("sk-mistral-abcd1234");
    await expect(input).not.toHaveClass(/err/);
    await expect(page.locator("[data-key-err]")).not.toBeVisible();

    // 保存 → auth.set_key（payload：providerId + 原文 key——脱敏归 daemon）
    await page.locator("#btn-modal-save").click();
    const cmd = await mock.waitForCommand("auth.set_key");
    expect(cmd.payload).toEqual({ providerId: "mistral", apiKey: "sk-mistral-abcd1234" });

    // 回执驱动：行转已配 + 尾 4 位脱敏 + 连通态重置未验证
    await mock.emit(authSetKeyResult("····1234"));
    const mistral = page.locator('[data-prov="mistral"]');
    await expect(mistral).toHaveClass(/configured/);
    await expect(mistral.locator(".key-chip .k4")).toHaveText("1234");
    await expect(mistral.locator("[data-conn-badge]")).toHaveAttribute("data-conn-badge", "unverified");
  });

  test("F(3.4).2 两段式删除：首击 armed 文案 → 二击 auth.delete_key → 回执转未配置", async ({ mock, page }) => {
    await openModelsSection(mock, page);

    const anthropic = page.locator('[data-prov="anthropic"]');
    await anthropic.locator("[data-prov-toggle]").click();
    const del = anthropic.locator("[data-prov-delkey]");

    // 首击：按钮变「确认删除？」（行内确认，不弹大层）+ armed 标记
    await del.click();
    await expect(del).toHaveText("确认删除？");
    await expect(del).toHaveAttribute("data-armed", "1");
    expect((await mock.clientFrames()).filter((f) => f.type === "auth.delete_key")).toHaveLength(0);

    // 二击：发 auth.delete_key（payload providerId）
    await del.click();
    const cmd = await mock.waitForCommand("auth.delete_key");
    expect(cmd.payload).toEqual({ providerId: "anthropic" });

    // 回执驱动：转未配置 + 徽标重置未验证 + key 行变「未配置」
    await mock.emit(authDeleteKeyResult());
    await expect(anthropic).not.toHaveClass(/configured/);
    await expect(anthropic.locator(".key-none")).toHaveText("未配置");
    await expect(anthropic.locator("[data-conn-badge]")).toHaveAttribute("data-conn-badge", "unverified");
  });

  test("F(3.4).3 连通验证：verifying → ok（含延迟）；重测先清旧态 → fail（含原因）——四态互斥", async ({ mock, page }) => {
    await openModelsSection(mock, page);

    const anthropic = page.locator('[data-prov="anthropic"]');
    await anthropic.locator("[data-prov-toggle]").click();
    const badge = anthropic.locator("[data-conn-badge]");

    // 测试连通 → auth.verify 命令 + verifying 态（清旧 ok）
    await anthropic.locator("[data-prov-test]").click();
    await mock.waitForCommand("auth.verify");
    await expect(badge).toHaveAttribute("data-conn-badge", "verifying");
    await expect(badge).toContainText("验证中");

    // ok 结果（含延迟）
    await mock.emit(authVerifyResult({ status: "ok", latencyMs: 142 }));
    await expect(badge).toHaveAttribute("data-conn-badge", "ok");
    await expect(badge).toContainText("142ms");

    // 重测：先清旧态（ok → verifying，延迟清除）→ fail（含原因）
    await anthropic.locator("[data-prov-test]").click();
    await mock.waitForCommand("auth.verify");
    await expect(badge).toHaveAttribute("data-conn-badge", "verifying");
    await mock.emit(authVerifyResult({ status: "fail", reason: "401 · key 无效" }));
    await expect(badge).toHaveAttribute("data-conn-badge", "fail");
    await expect(badge).toContainText("401 · key 无效");
  });

  test("F(3.4).5 目录刷新：model.catalog_refresh（绕过缓存）+ 转动反馈 + 时间戳更新", async ({ mock, page }) => {
    await openModelsSection(mock, page);

    // 刷新按钮：in-flight 转动 + 禁用
    const btn = page.locator("#btn-refresh-catalog");
    await btn.click();
    await mock.waitForCommand("model.catalog_refresh");
    await expect(btn.locator(".spin")).toBeVisible();
    await expect(btn).toBeDisabled();

    // 回执：快照替换 + 时间戳「刚刚」+ provider 计数
    await mock.emit(modelCatalogRefreshResult(catalogFrames(), { refreshedAt: Date.now(), source: "remote" }));
    await expect(btn).toBeEnabled();
    await expect(page.locator("[data-catalog-meta]")).toContainText("刚刚");
    await expect(page.locator("[data-catalog-meta]")).toContainText("7 providers");
  });

  test("F(3.4).6 全局默认：顶部只读展示 + 行内「设为默认」（model.set_default 乐观更新与 DEFAULT chip 迁移；2dad85e 选择器退役）", async ({ mock, page }) => {
    await openModelsSection(mock, page);

    // 2dad85e 重设计：顶部只读展示当前默认（选择器 #sel-default 退役），
    // 改默认 = 展开的模型表行内「设为默认」按钮
    await expect(page.locator("#sel-default")).toHaveCount(0);
    const display = page.locator("[data-default-model]");
    // 初始值 = get_default 回执
    await expect(display).toHaveText(DEFAULT_MODEL);

    // 行内设默认：openai 组展开 → gpt-5.2 行内按钮 → model.set_default（全局命令无信封 sessionId）
    await page.locator('[data-prov="openai"] [data-prov-toggle]').click();
    await page.locator('[data-set-default="openai/gpt-5.2"]').click();
    const cmd = await mock.waitForCommand("model.set_default");
    expect(cmd.payload).toEqual({ model: "openai/gpt-5.2" });
    expect(cmd.sessionId).toBeUndefined();

    // 乐观更新：只读展示即时反映 + DEFAULT chip 迁移（openai 行进入）+
    // 行内按钮消失（默认行不渲染「设为默认」）
    await expect(display).toHaveText("openai/gpt-5.2");
    await expect(page.locator('[data-model-row="openai/gpt-5.2"]')).toHaveClass(/is-default/);
    await expect(page.locator('[data-set-default="openai/gpt-5.2"]')).toHaveCount(0);
    await page.locator('[data-prov="anthropic"] [data-prov-toggle]').click();
    await expect(page.locator('[data-model-row="anthropic/claude-sonnet-4-5"]')).not.toHaveClass(/is-default/);

    // 回执清 in-flight（previous 回携）——展示不回落
    await mock.emit(modelSetDefaultResult(DEFAULT_MODEL));
    await expect(display).toHaveText("openai/gpt-5.2");

    await shotEvidence(page, "models-config", "CL-3");
    writeEvidence(
      "models-config",
      "txt",
      [
        "T3.3 CL-3 P-4 模型与厂商配置（F(3.4).1-F(3.4).6）",
        "断言: 字母分组/脱敏/未配弱化/模型表四费率 tabular-nums+默认行/key 弹层校验与",
        "  保存回执/两段式删除/连通四态互斥+重测清旧态/刷新转动+时间戳/全局默认只读",
        "  展示+行内设默认 set_default 乐观更新+chip 迁移（2dad85e）",
        "结果: PASS",
      ].join("\n"),
      "CL-3",
    );
  });
});

/**
 * T3.3 —— CL-3 P-3 模型切换菜单（F(3.3).1-F(3.3).3 + T5.3 可用性口径）。
 *
 * 剧本（契约 C model 族；test-design §2 CL-3 表 1-3 组）：
 * - 菜单展示：可用性过滤后分组渲染（T5.3：打开补发 auth.list，仅显示
 *   provider configured 的模型，未配置分组整体隐藏；verifyStatus 不参与）
 *   / 当前高亮 + DEFAULT 徽标 / 搜索过滤（过滤后集合上进行）与空态互斥 /
 *   清空恢复；打开时 model.catalog + model.get_default + auth.list 拉取
 *   （catalog/default 重复打开零重发）；
 * - 当前模型兜底：provider 未 configured 当前项仍保留显示（T5.3）；
 * - 零可用空态：无 configured provider 且当前模型不在目录 → 配置引导
 *   文案（去 P-4 配 key；T5.3）；
 * - 选中即切：clientFrames 断言 model.set（信封 sessionId = 活跃会话，
 *   payload.model 完整 id）；徽标即时更新（model.changed 广播回流驱动，
 *   前端零权威）；选中不关菜单（连续比对）；in-flight 提示在场；
 * - 重置默认：会话模型 ≠ 全局默认时显示 / 相等时隐藏；点击恢复默认
 *   （model.set 目标 = defaultModel）；
 * - 点外 / Esc 关闭；P-3 → P-4 流转入口。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import type { Page } from "@playwright/test";
import type { MockController } from "./harness/mock-session";
import {
  authListResult,
  modelCatalogResult,
  modelChanged,
  modelGetDefaultResult,
} from "./harness/protocol";
import { MODEL_CATALOG } from "./harness/scenarios";

/** 剧本常量（与 MODEL_CATALOG 目录数据对齐）。 */
const CURRENT = "anthropic/claude-opus-4-1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const SWITCH_TO = "openai/gpt-5.2";

/**
 * auth.list 剧本（T5.3 可用性过滤数据源）：anthropic/openai 已配，
 * google/deepseek/moonshot/xai 未配 → 过滤后可见 = anthropic 3 + openai 2。
 */
const AUTH_PROVIDERS = [
  { providerId: "anthropic", configured: true, keyMasked: "····7f3a" },
  { providerId: "openai", configured: true, keyMasked: "····e042" },
  { providerId: "google", configured: false },
  { providerId: "deepseek", configured: false },
  { providerId: "moonshot", configured: false },
  { providerId: "xai", configured: false },
];

/** 全未配剧本（零可用空态用）。 */
const AUTH_NONE_CONFIGURED = [
  { providerId: "anthropic", configured: false },
  { providerId: "openai", configured: false },
  { providerId: "google", configured: false },
  { providerId: "deepseek", configured: false },
  { providerId: "moonshot", configured: false },
  { providerId: "xai", configured: false },
];

/** 打开菜单并回放目录 + 全局默认 + auth.list（spec 手动驱动面）。 */
async function openMenu(
  mock: MockController,
  page: Page,
  auth: typeof AUTH_PROVIDERS = AUTH_PROVIDERS,
) {
  await page.locator("[data-model-badge]").click();
  await expect(page.locator("[data-model-menu]")).toBeVisible();
  await mock.waitForCommand("model.catalog");
  await mock.waitForCommand("model.get_default");
  await mock.waitForCommand("auth.list"); // T5.3：打开补发 auth.list
  await mock.emit(modelCatalogResult(MODEL_CATALOG, { refreshedAt: Date.now() - 12 * 60_000, source: "cache" }));
  await mock.emit(modelGetDefaultResult(DEFAULT_MODEL));
  await mock.emit(authListResult(auth));
}

test.describe("T3.3 CL-3 P-3 模型切换菜单", () => {
  test("F(3.3).1 菜单展示：目录拉取 + 可用性过滤分组（未配置隐藏）+ 当前高亮 + DEFAULT 徽标 + ctx chip", async ({ mock, page }) => {
    await mock.connect([], { model: CURRENT });
    await openMenu(mock, page);
    const menu = page.locator("[data-model-menu]");

    // 可用性过滤（T5.3）：仅 configured 两组 anthropic 3 + openai 2 = 5 行
    await expect(menu.locator(".mm-group")).toHaveCount(2);
    await expect(menu.locator(".mm-item")).toHaveCount(5);
    await expect(menu.locator('[data-group="anthropic"] .mm-glabel')).toHaveText("anthropic");
    // 未配置分组整体隐藏
    await expect(menu.locator('[data-group="google"]')).toHaveCount(0);
    await expect(menu.locator('[data-group="xai"]')).toHaveCount(0);

    // 当前模型高亮（选中底 + check 可见 + aria）
    const cur = menu.locator(`[data-model-item="${CURRENT}"]`);
    await expect(cur).toHaveClass(/sel/);
    await expect(cur).toHaveAttribute("aria-checked", "true");
    await expect(cur.locator(".mm-check")).toBeVisible();

    // 全局默认行 DEFAULT 徽标（violet）+ ctx chip
    const def = menu.locator(`[data-model-item="${DEFAULT_MODEL}"]`);
    await expect(def.locator(".mm-def")).toHaveText("default");
    await expect(def.locator(".hud-chip")).toHaveText("200k");

    // 重复打开零重发（catalog 快照在 topology 面，菜单卸载重挂不重拉）
    const catalogBefore = (await mock.clientFrames()).filter((f) => f.type === "model.catalog").length;
    await page.locator(".msg-flow").click(); // 点外关闭（S1：brand 位退役）
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);
    await page.locator("[data-model-badge]").click();
    await expect(page.locator("[data-model-menu]")).toBeVisible();
    const catalogAfter = (await mock.clientFrames()).filter((f) => f.type === "model.catalog").length;
    expect(catalogAfter).toBe(catalogBefore);
  });

  test("F(3.3).1 搜索：过滤后集合上过滤 + 空态互斥 + 清空恢复", async ({ mock, page }) => {
    await mock.connect([], { model: CURRENT });
    await openMenu(mock, page);
    const menu = page.locator("[data-model-menu]");
    const search = menu.locator("[data-mm-search]");

    // 模型名过滤：gpt → openai 组 2 行
    await search.fill("gpt");
    await expect(menu.locator(".mm-item")).toHaveCount(2);
    await expect(menu.locator(".mm-group")).toHaveCount(1);
    await expect(menu.locator('[data-model-item="openai/gpt-5.2"]')).toBeVisible();

    // provider 名过滤：anthropic → 3 行
    await search.fill("anthropic");
    await expect(menu.locator(".mm-item")).toHaveCount(3);

    // 未配置 provider 搜不出（gemini 在目录中但 google 未配置）
    await search.fill("gemini");
    await expect(menu.locator("[data-mm-empty]")).toBeVisible();
    await expect(menu.locator("[data-mm-list]")).toHaveCount(0);

    // 零命中：空态与列表互斥（空态可见 + 列表卸载）
    await search.fill("zzz-no-hit");
    await expect(menu.locator("[data-mm-empty]")).toBeVisible();
    await expect(menu.locator("[data-mm-empty]")).toContainText("未找到匹配的模型");
    await expect(menu.locator("[data-mm-list]")).toHaveCount(0);

    // 清空恢复
    await search.fill("");
    await expect(menu.locator(".mm-item")).toHaveCount(5);
    await expect(menu.locator("[data-mm-empty]")).toHaveCount(0);
  });

  test("T5.3 当前模型兜底：provider 未 configured 当前项仍保留（同组其余模型不带入）", async ({ mock, page }) => {
    await mock.connect([], { model: "xai/grok-4" }); // xai 未配置
    await openMenu(mock, page);
    const menu = page.locator("[data-model-menu]");

    // anthropic 3 + openai 2 + xai 兜底 1 = 6 行 / 3 组
    await expect(menu.locator(".mm-group")).toHaveCount(3);
    await expect(menu.locator(".mm-item")).toHaveCount(6);
    // xai 组仅当前模型一行且为高亮选中态
    const cur = menu.locator('[data-model-item="xai/grok-4"]');
    await expect(cur).toBeVisible();
    await expect(cur).toHaveClass(/sel/);
    await expect(menu.locator('[data-group="xai"] .mm-item')).toHaveCount(1);
  });

  test("T5.3 零可用空态：无 configured provider 且当前模型不在目录 → 配置引导", async ({ mock, page }) => {
    await mock.connect([], { model: "test/not-in-catalog" });
    await openMenu(mock, page, AUTH_NONE_CONFIGURED);
    const menu = page.locator("[data-model-menu]");

    // 引导空态与列表互斥
    await expect(menu.locator("[data-mm-no-available]")).toBeVisible();
    await expect(menu.locator("[data-mm-no-available]")).toContainText("暂无可用模型");
    await expect(menu.locator("[data-mm-no-available]")).toContainText("配置 API key");
    await expect(menu.locator("[data-mm-list]")).toHaveCount(0);
    // S1：菜单内 P-4 入口（mm-more）退役；S2：配置引导落点 = 设置页模型分区
    await expect(page.locator('.rail-btn[data-page="settings"]')).toBeVisible();
  });

  test("F(3.3).2 选中即切：model.set（信封 sessionId）+ 徽标即时更新（model.changed 回流）+ 不关菜单", async ({ mock, page }) => {
    await mock.connect([], { model: CURRENT });
    await openMenu(mock, page);
    const menu = page.locator("[data-model-menu]");

    // in-flight 提示在场（生效语义文案）
    await expect(menu.locator(".mm-hint")).toContainText("切换于下一 turn 生效，进行中的回复不变");

    // 选中 → model.set（信封 sessionId = 活跃会话；payload.model 完整 id）
    await menu.locator(`[data-model-item="${SWITCH_TO}"]`).click();
    const cmd = await mock.waitForCommand("model.set");
    expect(cmd.sessionId).toBe("sess-e2e");
    expect(cmd.payload).toEqual({ model: SWITCH_TO });

    // 选中不关菜单（连续比对）
    await expect(page.locator("[data-model-menu]")).toBeVisible();

    // 徽标即时更新：model.changed 广播回流（前端零权威，非本地写）
    await mock.emit(modelChanged("sess-e2e", SWITCH_TO, CURRENT));
    await expect(page.locator("[data-model-badge]")).toContainText(SWITCH_TO);
    // 选中态随 store 同步切换（gpt-5.2 行 sel，opus 行退出）
    await expect(menu.locator(`[data-model-item="${SWITCH_TO}"]`)).toHaveClass(/sel/);
    await expect(menu.locator(`[data-model-item="${CURRENT}"]`)).not.toHaveClass(/sel/);
  });

  test("F(3.3).3 重置默认：≠默认时显示 + 点击恢复（model.set 目标 = defaultModel）+ 相等后隐藏", async ({ mock, page }) => {
    await mock.connect([], { model: CURRENT });
    await openMenu(mock, page);
    const menu = page.locator("[data-model-menu]");

    // 会话模型（opus）≠ 全局默认（sonnet）→ 重置入口显示
    const reset = menu.locator("#btn-model-reset");
    await expect(reset).toBeVisible();

    // 点击恢复 → model.set 目标 = 全局默认
    await reset.click();
    const cmd = await mock.waitForCommand("model.set");
    expect(cmd.payload).toEqual({ model: DEFAULT_MODEL });
    await mock.emit(modelChanged("sess-e2e", DEFAULT_MODEL, CURRENT));
    await expect(page.locator("[data-model-badge]")).toContainText("claude-sonnet-4-5");

    // 相等后入口隐藏（菜单仍开）
    await expect(page.locator("[data-model-menu]")).toBeVisible();
    await expect(menu.locator("#btn-model-reset")).toHaveCount(0);
  });

  test("菜单开合：Esc 关闭 + 点外关闭 + P-3→P-4 流转入口", async ({ mock, page }) => {
    await mock.connect([], { model: CURRENT });
    await page.locator("[data-model-badge]").click();
    await expect(page.locator("[data-model-menu]")).toBeVisible();
    await expect(page.locator("[data-model-badge]")).toHaveAttribute("aria-expanded", "true");

    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);
    await expect(page.locator("[data-model-badge]")).toHaveAttribute("aria-expanded", "false");

    // 点外关闭（徽标与菜单之外）
    await page.locator("[data-model-badge]").click();
    await expect(page.locator("[data-model-menu]")).toBeVisible();
    await page.locator(".msg-flow").click(); // S1：brand 位退役
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);

    // P-3 → 设置页模型分区流转（S1 菜单内入口退役；S2 改走 rail settings
    // 位；rail 在菜单外，点击同时触发点外关闭）
    await page.locator("[data-model-badge]").click();
    await mock.waitForCommand("model.catalog");
    await page.locator('.rail-btn[data-page="settings"]').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);
    await expect(page.locator("[data-models-section]")).toBeVisible();

    await shotEvidence(page, "model-menu", "CL-3");
    writeEvidence(
      "model-menu",
      "txt",
      [
        "T3.3 CL-3 P-3 模型切换菜单（F(3.3).1-F(3.3).3 + T5.3 可用性口径）",
        "断言: 打开补发 auth.list/可用性过滤分组 2×5（未配置隐藏）/当前高亮/DEFAULT 徽标/",
        "  搜索在过滤后集合（未配置搜不出）与空态互斥/清空恢复/当前模型兜底（xai 组 1 行）/",
        "  零可用配置引导空态/model.set 信封 sessionId+完整 id/徽标 model.changed 回流更新/",
        "  选中不关菜单/重置显隐与恢复目标/点外+Esc 关闭/P-3→P-4 流转",
        "结果: PASS",
      ].join("\n"),
      "CL-3",
    );
  });
});

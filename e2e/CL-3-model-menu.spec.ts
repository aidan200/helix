/**
 * T3.3 —— CL-3 P-3 模型切换菜单（F(3.3).1-F(3.3).3）。
 *
 * 剧本（契约 C model 族；test-design §2 CL-3 表 1-3 组）：
 * - 菜单展示：目录分组渲染 / 当前高亮 + DEFAULT 徽标 / 搜索过滤与空态
 *   互斥 / 清空恢复；打开时 model.catalog + model.get_default 拉取（重复
 *   打开零重发）；
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
import { modelCatalogResult, modelChanged, modelGetDefaultResult } from "./harness/protocol";
import { MODEL_CATALOG } from "./harness/scenarios";

/** 剧本常量（与 MODEL_CATALOG 目录数据对齐）。 */
const CURRENT = "anthropic/claude-opus-4-1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const SWITCH_TO = "openai/gpt-5.2";

/** 打开菜单并回放目录 + 全局默认（spec 手动驱动面）。 */
async function openMenu(mock: MockController, page: Page) {
  await page.locator("[data-model-badge]").click();
  await expect(page.locator("[data-model-menu]")).toBeVisible();
  await mock.waitForCommand("model.catalog");
  await mock.waitForCommand("model.get_default");
  await mock.emit(modelCatalogResult(MODEL_CATALOG, { refreshedAt: Date.now() - 12 * 60_000, source: "cache" }));
  await mock.emit(modelGetDefaultResult(DEFAULT_MODEL));
}

test.describe("T3.3 CL-3 P-3 模型切换菜单", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect([], { model: CURRENT });
  });

  test("F(3.3).1 菜单展示：目录拉取 + provider 分组 + 当前高亮 + DEFAULT 徽标 + ctx chip", async ({ mock, page }) => {
    await openMenu(mock, page);
    const menu = page.locator("[data-model-menu]");

    // 目录分组：6 provider 组 × 11 模型行（MODEL_CATALOG 剧本数据）
    await expect(menu.locator(".mm-group")).toHaveCount(6);
    await expect(menu.locator(".mm-item")).toHaveCount(11);
    await expect(menu.locator('[data-group="anthropic"] .mm-glabel')).toHaveText("anthropic");

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
    await page.locator(".brand").click(); // 点外关闭
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);
    await page.locator("[data-model-badge]").click();
    await expect(page.locator("[data-model-menu]")).toBeVisible();
    const catalogAfter = (await mock.clientFrames()).filter((f) => f.type === "model.catalog").length;
    expect(catalogAfter).toBe(catalogBefore);
  });

  test("F(3.3).1 搜索：过滤模型名/provider 名 + 空态互斥 + 清空恢复", async ({ mock, page }) => {
    await openMenu(mock, page);
    const menu = page.locator("[data-model-menu]");
    const search = menu.locator("[data-mm-search]");

    // 模型名过滤：gemini → google 组 2 行
    await search.fill("gemini");
    await expect(menu.locator(".mm-item")).toHaveCount(2);
    await expect(menu.locator(".mm-group")).toHaveCount(1);
    await expect(menu.locator('[data-model-item="google/gemini-3-pro"]')).toBeVisible();

    // provider 名过滤：anthropic → 3 行
    await search.fill("anthropic");
    await expect(menu.locator(".mm-item")).toHaveCount(3);

    // 零命中：空态与列表互斥（空态可见 + 列表卸载）
    await search.fill("zzz-no-hit");
    await expect(menu.locator("[data-mm-empty]")).toBeVisible();
    await expect(menu.locator("[data-mm-empty]")).toContainText("未找到匹配的模型");
    await expect(menu.locator("[data-mm-list]")).toHaveCount(0);

    // 清空恢复
    await search.fill("");
    await expect(menu.locator(".mm-item")).toHaveCount(11);
    await expect(menu.locator("[data-mm-empty]")).toHaveCount(0);
  });

  test("F(3.3).2 选中即切：model.set（信封 sessionId）+ 徽标即时更新（model.changed 回流）+ 不关菜单", async ({ mock, page }) => {
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
    await page.locator(".brand").click();
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);

    // P-3 → P-4 流转：菜单入口直达配置页（F(2.1).4 独立路由）
    await page.locator("[data-model-badge]").click();
    await mock.waitForCommand("model.catalog");
    await page.locator("[data-mm-more]").click();
    await expect(page).toHaveURL(/\/settings\/models$/);
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);
    await expect(page.locator("[data-p4-page]")).toBeVisible();

    await shotEvidence(page, "model-menu", "CL-3");
    writeEvidence(
      "model-menu",
      "txt",
      [
        "T3.3 CL-3 P-3 模型切换菜单（F(3.3).1-F(3.3).3）",
        "断言: 目录分组 6×11/当前高亮/DEFAULT 徽标/搜索过滤与空态互斥/清空恢复/",
        "  model.set 信封 sessionId+完整 id/徽标 model.changed 回流更新/选中不关菜单/",
        "  重置显隐与恢复目标/点外+Esc 关闭/P-3→P-4 流转",
        "结果: PASS",
      ].join("\n"),
      "CL-3",
    );
  });
});

/**
 * T3.3 —— CL-3 P-3/P-4 双主题关键态截图（验证证据，非像素 diff）。
 *
 * 暗色（默认）/ 亮色（html.light）两态各截：
 * - P-3 模型菜单弹出态（分组列表 + DEFAULT 徽标 + 重置入口）；
 * - P-4 配置页（工具卡 + provider 分组 + 展开模型表）。
 * 附 token 派生断言（mm-item 选中底 / prov 已配边框取自注册表通道）。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence } from "./harness/evidence";
import { computed } from "./harness/style-utils";
import {
  authListResult,
  modelCatalogResult,
  modelGetDefaultResult,
} from "./harness/protocol";
import { MODEL_CATALOG } from "./harness/scenarios";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const CURRENT = "anthropic/claude-opus-4-1";

const PROVIDERS = [
  { providerId: "anthropic", configured: true, keyMasked: "····7f3a", verifyStatus: "ok" as const },
  { providerId: "google", configured: true, keyMasked: "····93d0", verifyStatus: "fail" as const },
  { providerId: "mistral", configured: false },
  { providerId: "openai", configured: true, keyMasked: "····e042", verifyStatus: "ok" as const },
  { providerId: "xai", configured: false },
];

test.describe("T3.3 CL-3 双主题关键态（P-3/P-4）", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`P-3 菜单 + P-4 配置页（${theme}）`, async ({ mock, page }) => {
      await mock.connect([], { model: CURRENT });
      if (theme === "light") {
        await page.locator("#btn-light").click();
        await expect(page.locator("html")).toHaveClass("light");
      }

      // P-3 弹出态
      await page.locator("[data-model-badge]").click();
      await mock.waitForCommand("model.catalog");
      await mock.waitForCommand("model.get_default");
      await mock.emit(modelCatalogResult(MODEL_CATALOG, { refreshedAt: Date.now() - 12 * 60_000, source: "cache" }));
      await mock.emit(modelGetDefaultResult(DEFAULT_MODEL));
      await expect(page.locator(".mm-item")).toHaveCount(11);

      // token 派生：选中行左边条 = accent 注册表通道
      const accentChannel = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim(),
      );
      const selBorder = await computed(page, `[data-model-item="${CURRENT}"]`, "border-left-color");
      expect(selBorder).toBe(`rgb(${accentChannel.split(/\s+/).join(", ")})`);

      await shotEvidence(page, `model-dual-theme-p3-${theme}`, "CL-3");

      // P-4 配置页（展开 anthropic 模型表 + google fail 徽标）
      await page.keyboard.press("Escape");
      await page.locator("#btn-settings").click();
      await mock.waitForCommand("auth.list");
      await mock.emit(authListResult(PROVIDERS));
      await expect(page.locator('[data-prov="anthropic"]')).toBeVisible();
      await page.locator('[data-prov="anthropic"] [data-prov-toggle]').click();
      await expect(page.locator('[data-model-row="anthropic/claude-sonnet-4-5"]')).toHaveClass(/is-default/);

      await shotEvidence(page, `model-dual-theme-p4-${theme}`, "CL-3");
    });
  }
});

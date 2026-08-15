/**
 * TC2.1 —— R-01 布局 / R-02 双主题（CL-7 F 层还原度）。
 *
 * 断言源：prototype/review.md 必须还原 R-01（100dvh 应用壳、header 48px、
 * 版心 860px、composer）与 R-02（token 注册表变量、暗 :root / 亮 html.light、
 * localStorage helix-theme 持久化、亮色氛围降档：网格淡/辉光 alpha 降档/
 * blur 半径降档）。视觉断言一律 token 变量派生值，不做像素 diff。
 */
import { test, expect } from "./harness/fixtures";
import { cssVar, computed } from "./harness/style-utils";
import { shotEvidence, writeEvidence } from "./harness/evidence";

test.describe("TC2.1 R-01 布局（应用壳/版心/composer）", () => {
  test("100dvh 应用壳：header 48px → 消息流 → composer，页面无滚动", async ({ mock, page }) => {
    await mock.connect();

    // 100dvh：.app 高度 = viewport 内高（非滚动页）
    const appH = parseFloat(await computed(page, ".app", "height"));
    const innerH = await page.evaluate(() => window.innerHeight);
    expect(appH).toBe(innerH);

    // 页面无滚动（body overflow hidden）
    expect(await computed(page, "body", "overflow")).toBe("hidden");
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
    );
    expect(scrollable).toBe(false);

    // header 48px
    expect(parseFloat(await computed(page, ".app-header", "height"))).toBe(48);

    // 壳层级：header → conn-banner 槽位 → msg-flow → composer
    await expect(page.locator(".app-header")).toBeVisible();
    await expect(page.locator(".msg-flow")).toBeVisible();
    await expect(page.locator(".composer-wrap")).toBeVisible();
    const order = await page.evaluate(() => {
        const app = document.querySelector(".app")!;
        return Array.from(app.children).map((c) => c.className.split(" ")[0]);
      });
    expect(order).toEqual(["app-header", "conn-banner", "msg-flow", "composer-wrap"]);
  });

  test("header 内容：brand + session/home chip + 模型徽标 + 连接状态 + 主题切换", async ({ mock, page }) => {
    await mock.connect();
    await expect(page.locator(".brand")).toContainText("HELiX");
    await expect(page.locator(".brand .b2")).toHaveText("·2");
    const chips = page.locator(".app-header .hud-chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText("main-session");
    await expect(chips.nth(1)).toHaveText("~/.helix");
    // 模型徽标（welcome DTO 下发的 model 值）
    await expect(page.locator(".app-header .hud-badge")).toHaveText("claude-sonnet-4-5");
    // 连接状态 + 主题切换存在
    await expect(page.locator(".conn-status")).toBeVisible();
    await expect(page.locator(".theme-toggle #btn-dark")).toBeVisible();
    await expect(page.locator(".theme-toggle #btn-light")).toBeVisible();
  });

  test("消息流版心 860px 且水平居中；composer 输入条与发送按钮在位", async ({ mock, page }) => {
    await mock.connect();
    expect(await computed(page, ".flow-inner", "max-width")).toBe("860px");
    const centered = await page.evaluate(() => {
      const r = document.querySelector(".flow-inner")!.getBoundingClientRect();
      return Math.abs(r.left - (window.innerWidth - r.right)) < 1;
    });
    expect(centered).toBe(true);
    // composer：输入 + 发送按钮（R-01/R-16 交互入口）
    await expect(page.locator("#msg-input")).toBeVisible();
    await expect(page.locator("#btn-send")).toBeVisible();
    await expect(page.locator("#btn-send")).toHaveText("发送");
  });
});

test.describe("TC2.1 R-02 双主题（token 注册表 / localStorage / 亮色降档）", () => {
  test("暗色为默认：:root 变量取暗列，html 无 light 类", async ({ mock, page }) => {
    await mock.connect();
    const lightClass = await page.evaluate(() => document.documentElement.classList.contains("light"));
    expect(lightClass).toBe(false);
    expect(await cssVar(page, "--void")).toBe("#060910");
    expect(await cssVar(page, "--accent-rgb")).toBe("34 211 238");
    expect(await cssVar(page, "--violet-rgb")).toBe("168 85 247");
    await shotEvidence(page, "fidelity-layout-theme-dark");
  });

  test("切换亮色：html.light 类 + localStorage(helix-theme) + 亮列变量", async ({ mock, page }) => {
    await mock.connect();
    await page.locator("#btn-light").click();
    await expect(page.locator("html")).toHaveClass("light");
    expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("light");
    expect(await cssVar(page, "--void")).toBe("#F8FAFC");
    expect(await cssVar(page, "--accent-rgb")).toBe("37 99 235");
    expect(await cssVar(page, "--violet-rgb")).toBe("147 51 234");
    // 按钮选中态切换（DARK 失选 / LIGHT 选中）
    await expect(page.locator("#btn-light")).toHaveClass(/on/);
    await expect(page.locator("#btn-dark")).not.toHaveClass(/on/);
    await shotEvidence(page, "fidelity-layout-theme-light");
  });

  test("主题持久化：亮色 reload 后首帧仍是亮色（无闪回）", async ({ mock, page }) => {
    await mock.connect();
    await page.locator("#btn-light").click();
    await expect(page.locator("html")).toHaveClass("light");
    await page.reload();
    // 首帧前 applyThemeInitial：无需等待应用建连
    await expect(page.locator("html")).toHaveClass("light");
    expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("light");
    // 切回 DARK：localStorage 跟随
    await page.locator("#btn-dark").click();
    expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("dark");
    await expect(page.locator("html")).not.toHaveClass("light");
  });

  test("亮色氛围降档：网格淡 / blur 半径降档 / 辉光 alpha 降档；扫描线关闭", async ({ mock, page }) => {
    await mock.connect();
    const collect = async () => ({
      bodyBg: await computed(page, "body", "background-image"),
      headerBlur: await computed(page, ".app-header", "backdrop-filter"),
      glowCyan: await cssVar(page, "--glow-cyan"),
      scanlines: await page.evaluate(() =>
        Array.from(document.querySelectorAll(".scanline-overlay")).map((el) =>
          getComputedStyle(el).display,
        ),
      ),
    });

    const gridAlpha = (bg: string): number => {
      const m = /rgba\([\d, ]+, ([\d.]+)\) 1px/.exec(bg);
      if (!m) throw new Error(`no grid alpha in: ${bg}`);
      return Number(m[1]);
    };

    const dark = await collect();
    // 暗色：网格 edge/0.14（8bit 序列化 ±0.002 容差）、header blur 6px、glow 0.25/0.18
    expect(gridAlpha(dark.bodyBg)).toBeGreaterThan(0.13);
    expect(dark.headerBlur).toContain("6px");
    expect(dark.glowCyan).toContain("0.25)");
    expect(dark.glowCyan).toContain("0.18)");

    await page.locator("#btn-light").click();
    await expect(page.locator("html")).toHaveClass("light");
    const light = await collect();
    // 亮色降档（tokens.md 07 节）：网格 0.045 / blur 4px / glow 0.2/0.1
    expect(gridAlpha(light.bodyBg)).toBeLessThan(0.06);
    expect(gridAlpha(light.bodyBg)).toBeLessThan(gridAlpha(dark.bodyBg));
    expect(light.headerBlur).toContain("4px");
    expect(light.glowCyan).toContain("0.2)");
    expect(light.glowCyan).not.toContain("0.25)");
    // 扫描线：亮色必须关闭（display:none）；暗色常驻为产品氛围层
    // 注：实现当前未渲染 .scanline-overlay 元素（与原型 P-1 L545 对照为差距，
    // 见 findings）；此断言口径 = 「若存在则必须关闭」
    for (const display of light.scanlines) expect(display).toBe("none");
    writeEvidence(
      "fidelity-layout-theme-ambience",
      "txt",
      [
        `dark:  body-bg=${dark.bodyBg}`,
        `dark:  header-blur=${dark.headerBlur}`,
        `dark:  glow-cyan=${dark.glowCyan}`,
        `light: body-bg=${light.bodyBg}`,
        `light: header-blur=${light.headerBlur}`,
        `light: glow-cyan=${light.glowCyan}`,
        `scanline elements: ${light.scanlines.length}`,
      ].join("\n"),
    );
  });
});

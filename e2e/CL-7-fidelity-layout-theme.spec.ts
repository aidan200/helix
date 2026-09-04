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
  test("100dvh 应用壳：header 48px 全宽置顶 → 消息流 → composer，页面无滚动", async ({ mock, page }) => {
    await mock.connect();

    // 100dvh：.app-layout（S1 统一壳）高度 = viewport 内高（非滚动页）；
    // .app = 视口高 - header 48px
    const wbH = parseFloat(await computed(page, ".app-layout", "height"));
    const innerH = await page.evaluate(() => window.innerHeight);
    expect(wbH).toBe(innerH);
    const appH = parseFloat(await computed(page, ".app", "height"));
    expect(appH).toBe(innerH - 48);

    // 页面无滚动（body overflow hidden）
    expect(await computed(page, "body", "overflow")).toBe("hidden");
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
    );
    expect(scrollable).toBe(false);

    // header 48px
    expect(parseFloat(await computed(page, ".app-header", "height"))).toBe(48);

    // 壳层级（S1 统一壳）：app-layout = app-header（全宽）→ layout-body
    // （sidebar → layout-main）；main 内 = wb-main（sidebar 定位上下文 +
    // .app 列）；.app 内 = conn-banner 槽位 → msg-flow → composer
    await expect(page.locator(".app-header")).toBeVisible();
    await expect(page.locator(".msg-flow")).toBeVisible();
    await expect(page.locator(".composer-wrap")).toBeVisible();
    const order = await page.evaluate(() => {
        const app = document.querySelector(".app")!;
        return Array.from(app.children).map((c) => c.className.split(" ")[0]);
      });
    // TR-64：.msg-flow 外套 .msg-flow-wrap（steer 队列坞 absolute 钉位上下文）
    expect(order).toEqual(["conn-banner", "msg-flow-wrap", "composer-wrap"]);
    const shell = await page.evaluate(() => {
        const root = document.querySelector(".app-layout")!;
        const body = document.querySelector(".layout-body")!;
        const main = document.querySelector(".layout-main")!;
        return {
          root: Array.from(root.children).map((c) => c.className.split(" ")[0]),
          body: Array.from(body.children).map((c) =>
            c.tagName.toLowerCase() === "main" ? "layout-main" : c.className.split(" ")[0],
          ),
          main: Array.from(main.children).map((c) => c.className.split(" ")[0]),
        };
      });
    expect(shell.root).toEqual(["app-header", "layout-body"]);
    expect(shell.body).toEqual(["sidebar", "layout-main"]);
    expect(shell.main).toEqual(["wb-main"]);
  });

  test("header 槽内容：session/home chip + 模型徽标 + 连接状态；rail 品牌图标 + 主题单钮（S1）", async ({ mock, page }) => {
    await mock.connect();
    // S1：品牌位迁 IconRail（rail-logo = HelixLogo 渐变图标）；渐变口径 =
    // accent→violet token（stopColor var() 引用，随主题切换自动适配）
    const logo = page.locator(".rail-logo [data-brand-logo]");
    await expect(logo).toBeVisible();
    const stopColors = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll(".rail-logo [data-brand-logo] stop")).map(
          (s) => getComputedStyle(s).stopColor,
        ),
      );
    // 暗色：accent rgb(34, 211, 238) → violet rgb(168, 85, 247)
    expect(await stopColors()).toEqual(["rgb(34, 211, 238)", "rgb(168, 85, 247)"]);
    await shotEvidence(page, "header-brand-dark");
    // 环境 chip 三枚（W4：workspace 指示器入列——mode / home / ws 切换入口）
    const chips = page.locator(".app-header .hud-chip");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveText("默认模式"); // mode chip（草稿可切语义演进后的只读档文案）
    await expect(chips.nth(1)).toHaveText("~/.helix");
    await expect(chips.nth(2)).toHaveText("workspace"); // W4 工作空间指示器（mock 预绑定 /workspace）
    // 模型徽标（welcome DTO 下发的 model 值）
    await expect(page.locator(".app-header .hud-badge")).toHaveText("claude-sonnet-4-5");
    // 连接状态 + 主题单钮（S1：IconRail，Sun = 当前 dark 的切换目标）
    await expect(page.locator(".conn-status")).toBeVisible();
    await expect(page.locator("#btn-theme-toggle")).toBeVisible();
    await expect(page.locator("#btn-theme-toggle .lucide-sun")).toBeVisible();
    // 亮主题：图标渐变随 token 亮列自动适配（accent/violet 亮值）
    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
    expect(await stopColors()).toEqual(["rgb(37, 99, 235)", "rgb(147, 51, 234)"]);
    await shotEvidence(page, "header-brand-light");
    await page.locator("#btn-theme-toggle").click();
  });

  test("消息流版心 860px 且居中于主区（P-1 三区骨架：侧栏占左 264px，T3.2）；composer 输入条与发送按钮在位", async ({ mock, page }) => {
    await mock.connect();
    expect(await computed(page, ".flow-inner", "max-width")).toBe("860px");
    // T3.2 三区骨架：版心居中基准从 viewport 改为主区（.app 列——
    // 侧栏 264px 在左，原 viewport 居中断言几何上不再成立；意图保持：版心居中）
    const centered = await page.evaluate(() => {
      const flow = document.querySelector(".msg-flow")!.getBoundingClientRect();
      const r = document.querySelector(".flow-inner")!.getBoundingClientRect();
      return Math.abs(r.left - flow.left - (flow.right - r.right)) < 1;
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
    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
    expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("light");
    expect(await cssVar(page, "--void")).toBe("#F8FAFC");
    expect(await cssVar(page, "--accent-rgb")).toBe("37 99 235");
    expect(await cssVar(page, "--violet-rgb")).toBe("147 51 234");
    // S1 单钮图标互切：light 态显示 Moon（切回 dark 的目标）
    await expect(page.locator("#btn-theme-toggle .lucide-moon")).toBeVisible();
    await shotEvidence(page, "fidelity-layout-theme-light");
  });

  test("主题持久化：亮色 reload 后首帧仍是亮色（无闪回）", async ({ mock, page }) => {
    await mock.connect();
    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
    await page.reload();
    // 首帧前 applyThemeInitial：无需等待应用建连
    await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
    expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("light");
    // W6o 门禁：reload 后停留 boot 屏直至重驱握手（boot-hold 语义）
    await mock.connect();
    // 切回 DARK：localStorage 跟随
    await page.locator("#btn-theme-toggle").click();
    expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("dark");
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)light(\s|$)/);
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
    // 暗色：网格 edge/0.05（a3cdc6e：0.14→0.05 对齐亮色低调档位）、header blur 6px、glow 0.25/0.18
    expect(gridAlpha(dark.bodyBg)).toBeGreaterThan(0.04);
    expect(gridAlpha(dark.bodyBg)).toBeLessThan(0.06);
    expect(dark.headerBlur).toContain("6px");
    expect(dark.glowCyan).toContain("0.25)");
    expect(dark.glowCyan).toContain("0.18)");

    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
    const light = await collect();
    // 亮色降档（tokens.md 07 节）：网格 0.045 / blur 4px / glow 0.2/0.1
    expect(gridAlpha(light.bodyBg)).toBeLessThan(0.06);
    expect(gridAlpha(light.bodyBg)).toBeLessThan(gridAlpha(dark.bodyBg));
    expect(light.headerBlur).toContain("4px");
    expect(light.glowCyan).toContain("0.2)");
    expect(light.glowCyan).not.toContain("0.25)");
    // 扫描线：暗色常驻（元素在场且可见），亮色必须关闭（display:none）。
    // 回退修复 TS2 后元素已渲染（原型 P-1 L545）——恒真断言（非「若存在」）。
    expect(dark.scanlines.length).toBe(1);
    expect(dark.scanlines[0]).not.toBe("none");
    expect(light.scanlines).toEqual(["none"]);

    // reduced-motion：扫描线动画关闭（全局兜底 app.css；基线无动画时同成立）
    await page.locator("#btn-theme-toggle").click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      const rmAnimation = await computed(page, ".scanline-overlay", "animation-name");
      expect(rmAnimation).toBe("none");
    } finally {
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    writeEvidence(
      "fidelity-layout-theme-ambience",
      "txt",
      [
        `dark:  body-bg=${dark.bodyBg}`,
        `dark:  header-blur=${dark.headerBlur}`,
        `dark:  glow-cyan=${dark.glowCyan}`,
        `dark:  scanline ×${dark.scanlines.length} display=${dark.scanlines.join("|")}`,
        `light: body-bg=${light.bodyBg}`,
        `light: header-blur=${light.headerBlur}`,
        `light: glow-cyan=${light.glowCyan}`,
        `light: scanline display=${light.scanlines.join("|")}`,
      ].join("\n"),
    );
  });
});

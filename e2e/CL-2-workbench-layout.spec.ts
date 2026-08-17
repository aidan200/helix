/**
 * T3.2 —— CL-2 P-1 工作台骨架 + 侧栏折叠记忆（F(2.1).1/F(2.1).2）。
 * T5.2 用户裁决重组：header 48px 全宽置顶（横跨侧栏与主区）+ 侧栏/主区
 * 同处 header 之下；折叠 = 56px 窄条最小控件集（新建 + 展开把手，无每
 * 会话入口——折叠态不可切会话）；localStorage 记忆；折叠只 display 切
 * 换不做 width 过渡。
 */
import { test, expect } from "./harness/fixtures";
import { computed } from "./harness/style-utils";
import { shotEvidence } from "./harness/evidence";
import { sessionListResult, v02Snapshot } from "./harness/protocol";
import { agentInstance } from "./harness/protocol";
import { multiSessionList } from "./harness/scenarios";

test.describe("T3.2 CL-2 三区骨架 + 折叠记忆", () => {
  test("header 全宽置顶 + 侧栏 264 在 header 之下 + 主区（.app 列序保持）；折叠 56px 窄条（无会话按钮）+ localStorage 记忆（刷新保持）", async ({ mock, page }) => {
    await mock.connect();
    await mock.emit(sessionListResult(multiSessionList()));

    // ── 骨架：header 全宽置顶，侧栏 264px 与主区同处 header 之下 ──
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).toBeVisible();
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(264);
    expect(parseFloat(await computed(page, ".app-header", "height"))).toBe(48);
    expect(await computed(page, ".workbench", "display")).toBe("flex");
    expect(await computed(page, ".workbench", "flex-direction")).toBe("column");
    // header 横跨全宽；侧栏与主区顶缘 = header 底缘（48px）
    const geom = await page.evaluate(() => {
      const header = document.querySelector(".app-header")!.getBoundingClientRect();
      const sb = document.querySelector(".sidebar")!.getBoundingClientRect();
      const app = document.querySelector(".app")!.getBoundingClientRect();
      return {
        headerLeft: header.left,
        headerWidth: header.width,
        headerBottom: header.bottom,
        sbTop: sb.top,
        sbRight: sb.right,
        appLeft: app.left,
        appTop: app.top,
        innerWidth: window.innerWidth,
      };
    });
    expect(geom.headerLeft).toBe(0);
    expect(geom.headerWidth).toBe(geom.innerWidth); // header 全宽（横跨侧栏）
    expect(geom.sbTop).toBe(48); // 侧栏在 header 之下
    expect(geom.appTop).toBe(48); // 主区同处 header 之下
    expect(geom.headerBottom).toBe(48);
    expect(geom.appLeft).toBe(geom.sbRight); // 主区在侧栏右侧
    // 侧栏结构：logo + 新建按钮 + Sessions 标签 + 卡片列表
    await expect(page.locator(".sb-full .sb-logo")).toContainText("HE");
    await expect(page.locator("#btn-new-session")).toBeVisible();
    await expect(page.locator(".sb-label")).toContainText("Sessions");
    await expect(page.locator('[data-session-card="sess-multi-a"]')).toBeVisible();
    await shotEvidence(page, "workbench-layout-dark");
    // 双主题关键态：亮色同布局（token 覆盖自动生效，氛围降档）
    await page.locator("#btn-light").click();
    await expect(page.locator("html")).toHaveClass("light");
    await shotEvidence(page, "workbench-layout-light");
    await page.locator("#btn-dark").click();

    // ── 抽屉关闭态竖条（P-1 布局构成：实例在场时 26px rail + 计数；点击展开 M2 抽屉）──
    await mock.emit(
      v02Snapshot("sess-e2e", {
        instances: [agentInstance("agent-rail", { state: "running", task: "抽屉竖条验证实例" })],
      }),
    );
    const rail = page.locator("[data-drawer-rail]");
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute("data-rail-count", "1");
    expect(parseFloat(await computed(page, ".drawer-rail", "width"))).toBe(26);
    await expect(rail.locator(".rail-count"));
    await rail.click();
    await expect(page.locator(".drawer")).toBeVisible(); // M2 既有抽屉展开
    await page.locator(".d-close").click();
    await expect(page.locator(".drawer")).toHaveCount(0);

    // ── 折叠：264 → 56 窄条（sb-full 隐藏 / sb-mini 显现）──
    await page.locator("#btn-collapse-sidebar").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "1");
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(56);
    await expect(page.locator(".sb-full")).toBeHidden();
    await expect(page.locator(".sb-mini")).toBeVisible();
    // localStorage 记忆（AG-14 白名单键）
    expect(await page.evaluate(() => localStorage.getItem("helix-sidebar-collapsed"))).toBe("1");

    // 窄条最小控件集（T5.2 去按钮化）：仅 mini logo + 新建 + 展开把手，
    // 无每会话入口（折叠态不可切会话）
    await expect(page.locator("[data-mini-session]")).toHaveCount(0);
    await expect(page.locator(".sb-mini .sb-logo.mini")).toHaveText("H");
    await expect(page.locator("#btn-mini-new")).toBeVisible();
    await expect(page.locator("#btn-expand-sidebar")).toBeVisible();
    await expect(page.locator(".sb-mini .mini-item")).toHaveCount(2); // 新建 + 展开把手
    await shotEvidence(page, "workbench-layout-collapsed");

    // ── 刷新保持折叠 ──
    await page.reload();
    await mock.awaitReady();
    await expect(page.locator(".sidebar")).toHaveAttribute("data-collapsed", "1");
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(56);

    // ── 展开：窄条复原 + 记忆更新 ──
    await page.locator("#btn-expand-sidebar").click();
    await expect(page.locator(".sidebar")).not.toHaveAttribute("data-collapsed", "1");
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(264);
    expect(await page.evaluate(() => localStorage.getItem("helix-sidebar-collapsed"))).toBe("0");
    await shotEvidence(page, "workbench-layout-expanded");
  });
});

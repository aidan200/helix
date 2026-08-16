/**
 * T3.2 —— CL-2 P-1 工作台三区骨架 + 侧栏折叠记忆（F(2.1).1/F(2.1).2；
 * review.md 必须还原：侧栏 264px 可折叠 56px 图标条 + 顶栏 48px + 主区
 * 聊天流/输入/抽屉；localStorage 记忆；折叠只 display 切换不做 width 过渡）。
 */
import { test, expect } from "./harness/fixtures";
import { computed } from "./harness/style-utils";
import { shotEvidence } from "./harness/evidence";
import { sessionListResult, v02Snapshot } from "./harness/protocol";
import { agentInstance } from "./harness/protocol";
import { multiSessionList } from "./harness/scenarios";

test.describe("T3.2 CL-2 三区骨架 + 折叠记忆", () => {
  test("三区布局：侧栏 264 + 顶栏 48 + 主区（.app 列序保持）；折叠 56px 图标条 + localStorage 记忆（刷新保持）", async ({ mock, page }) => {
    await mock.connect();
    await mock.emit(sessionListResult(multiSessionList()));

    // ── 三区：workbench 行布局，侧栏 264px，顶栏 48px ──
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).toBeVisible();
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(264);
    expect(parseFloat(await computed(page, ".app-header", "height"))).toBe(48);
    expect(await computed(page, ".workbench", "display")).toBe("flex");
    // 主区在侧栏右侧（行布局几何）
    const geom = await page.evaluate(() => {
      const sb = document.querySelector(".sidebar")!.getBoundingClientRect();
      const app = document.querySelector(".app")!.getBoundingClientRect();
      return { sbRight: sb.right, appLeft: app.left, appTop: app.top };
    });
    expect(geom.appLeft).toBe(geom.sbRight);
    expect(geom.appTop).toBe(0);
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

    // ── 折叠：264 → 56 图标条（sb-full 隐藏 / sb-mini 显现）──
    await page.locator("#btn-collapse-sidebar").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "1");
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(56);
    await expect(page.locator(".sb-full")).toBeHidden();
    await expect(page.locator(".sb-mini")).toBeVisible();
    // localStorage 记忆（AG-14 白名单键）
    expect(await page.evaluate(() => localStorage.getItem("helix-sidebar-collapsed"))).toBe("1");

    // 图标条：每会话入口 + 状态点（运行态会话带 .md 小方块）
    const miniA = page.locator('[data-mini-session="sess-multi-a"]');
    const miniB = page.locator('[data-mini-session="sess-multi-b"]');
    await expect(miniA).toBeVisible();
    await expect(miniB).toBeVisible();
    // B = streaming（multiSessionList）→ 状态点在场；A = idle → 无
    await expect(miniB.locator(".md")).toHaveCount(1);
    await expect(miniA.locator(".md")).toHaveCount(0);

    // ── 刷新保持折叠 ──
    await page.reload();
    await mock.awaitReady();
    await expect(page.locator(".sidebar")).toHaveAttribute("data-collapsed", "1");
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(56);

    // ── 展开：图标条复原 + 记忆更新 ──
    await page.locator("#btn-expand-sidebar").click();
    await expect(page.locator(".sidebar")).not.toHaveAttribute("data-collapsed", "1");
    expect(parseFloat(await computed(page, ".sidebar", "width"))).toBe(264);
    expect(await page.evaluate(() => localStorage.getItem("helix-sidebar-collapsed"))).toBe("0");
  });
});

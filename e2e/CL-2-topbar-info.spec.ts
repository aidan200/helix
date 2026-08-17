/**
 * T3.2 —— CL-2 顶栏信息区（F(2.1).3）：左 = 会话标题（随切换同步）+
 * daemon 状态徽标（连接语义沿既有连接状态剧本）；右 = 模型徽标位（渲染
 * topology 面 model 态；P-3 行为 T3.3）+ 设置齿轮（P-4 路由入口位）。
 */
import { test, expect } from "./harness/fixtures";
import { computed } from "./harness/style-utils";
import { sessionListResult, v02Snapshot, welcome } from "./harness/protocol";
import { msgEntry } from "./harness/protocol";
import { MULTI_SESSION_A, MULTI_SESSION_B, MULTI_TITLE_A, MULTI_TITLE_B, multiSessionList } from "./harness/scenarios";

test.describe("T3.2 CL-2 顶栏信息区", () => {
  test("会话标题随切换同步 + daemon 徽标语义 + 模型徽标位 + 齿轮入口", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: MULTI_SESSION_A, model: "anthropic/claude-sonnet-4-5" }),
      v02Snapshot(MULTI_SESSION_A, { model: "anthropic/claude-sonnet-4-5", tail: [msgEntry("a-1", "user", "A 内容", { ts: 1 })] }),
      sessionListResult(multiSessionList()),
    ]);
    await mock.waitForConn("connected");

    // 标题 = 活跃会话清单元数据标题；daemon 徽标沿既有连接态语义（connected）
    await expect(page.locator("[data-session-title]")).toHaveText(MULTI_TITLE_A);
    await expect(page.locator(".conn-status")).toContainText("已连接");
    await expect(page.locator(".conn-status .hud-dot-ok")).toHaveCount(1);

    // 模型徽标位（F(2.1).3 右区；topology 面 model 态；P-3 入口 T3.3 接行为）
    const modelBadge = page.locator("[data-model-badge]");
    await expect(modelBadge).toBeVisible();
    await expect(modelBadge).toHaveText("anthropic/claude-sonnet-4-5");
    await expect(modelBadge.locator(".mb-dot")).toHaveCount(1);
    await expect(modelBadge.locator(".mb-chev")).toHaveCount(1);

    // 齿轮（P-4 路由入口位）
    await expect(page.locator("#btn-settings")).toBeVisible();

    // ── 切换 B：标题随切换同步（loading 期即切目标会话标题；快照到达后保持）──
    await page.locator(`[data-session-card="${MULTI_SESSION_B}"]`).click();
    await mock.waitForCommand("session.subscribe");
    await expect(page.locator("[data-session-title]")).toHaveText(MULTI_TITLE_B);
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, { model: "anthropic/claude-sonnet-4-5", tail: [msgEntry("b-1", "user", "B 内容", { ts: 1 })] }),
    );
    await expect(page.locator("[data-session-title]")).toHaveText(MULTI_TITLE_B);

    // 顶栏 48px + 模型徽标 pill 形态（原型 F(2.1).3：胶囊形）
    expect(parseFloat(await computed(page, ".app-header", "height"))).toBe(48);
    expect(await computed(page, "[data-model-badge]", "border-radius")).toContain("999");

    // ── 断线徽标语义沿既有（disconnected → 已断开 + error 脉冲点）；标题不受影响 ──
    await mock.netClose();
    await mock.waitForConn("disconnected");
    await expect(page.locator(".conn-status")).toContainText("已断开");
    await expect(page.locator(".conn-status .hud-dot-error")).toHaveCount(1);
    await expect(page.locator("[data-session-title]")).toHaveText(MULTI_TITLE_B);
  });
});

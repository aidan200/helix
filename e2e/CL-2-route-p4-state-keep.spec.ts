/**
 * T3.2 —— CL-2 页面路由：工作台 ↔ 设置页（F(2.1).4；S2 模型配置迁入设置页）。
 *
 * rail settings 位进设置页独立 URL（history 路由）；工作台常驻 DOM（display
 * 切换）——返回后活跃会话/输入草稿/滚动位全保留；路由切换不重建 WS（无新
 * hello）；独立 URL 直接可达（刷新仍设置页）。设置页内模型分区（原 P-4
 * 迁入）在场即背书（交互断言归 CL-3-models-config）。
 */
import { test, expect } from "./harness/fixtures";
import { sessionListResult, v02Snapshot, welcome } from "./harness/protocol";
import { msgEntry } from "./harness/protocol";
import { MULTI_SESSION_A, multiSessionList } from "./harness/scenarios";

test.describe("T3.2 CL-2 路由（工作台 ↔ 设置页）", () => {
  test("rail settings 位进设置页独立 URL + 返回状态保留（输入/滚动位）+ 路由切换不重建 WS", async ({ mock, page }) => {
    // ── 工作台：长内容（可滚动）+ 输入草稿 ──
    const tail = Array.from({ length: 30 }, (_, i) =>
      msgEntry(`r-${i + 1}`, i % 2 === 0 ? "user" : "assistant", `路由保留验证消息 ${i + 1}`, { ts: i + 1 }),
    );
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: MULTI_SESSION_A }),
      v02Snapshot(MULTI_SESSION_A, { tail }),
      sessionListResult(multiSessionList()),
    ]);
    await mock.waitForConn("connected");
    await expect(page.locator(".msg-flow .msg")).toHaveCount(30);

    // 输入草稿（未发送）+ 滚动到中部
    await page.locator("#msg-input").fill("路由往返后必须保留的输入草稿");
    await page.locator(".msg-flow").evaluate((el) => {
      el.scrollTop = Math.floor(el.scrollHeight / 2);
    });
    const scrollTopBefore = await page.locator(".msg-flow").evaluate((el) => el.scrollTop);
    expect(scrollTopBefore).toBeGreaterThan(0);
    const helloCountBefore = (await mock.clientFrames()).filter((f) => f.type === "hello").length;

    // ── rail settings → 设置页：独立 URL + AppLayout 壳；工作台隐藏但常驻 DOM ──
    await page.locator('.rail-btn[data-page="settings"]').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('[data-settings-page="/settings"]')).toBeVisible();
    // 设置页实页化（S2）：分区导航首项 = 模型设置（原 P-4 迁入）
    await expect(page.locator('[data-settings-nav] [data-section="models"]')).toBeVisible();
    // 工作台常驻 DOM（display 切换，非卸载；.route-layer 作用域——设置页
    // 亦用 .app-layout 壳）
    await expect(page.locator(".route-layer .app-layout")).toBeAttached();
    await expect(page.locator('[data-route="off"] .app-layout')).toBeAttached();
    // WS 不重建（无新 hello）
    const helloCountDuring = (await mock.clientFrames()).filter((f) => f.type === "hello").length;
    expect(helloCountDuring).toBe(helloCountBefore);

    // ── 返回工作台：URL 回根 + 状态保留（输入/滚动位/活跃会话；同一 WS）──
    await page.locator('.rail-btn[data-page="chat"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".route-layer .app-layout")).toBeVisible();
    await expect(page.locator("[data-settings-page]")).toHaveCount(0);
    await expect(page.locator("#msg-input")).toHaveValue("路由往返后必须保留的输入草稿");
    const scrollTopAfter = await page.locator(".msg-flow").evaluate((el) => el.scrollTop);
    expect(scrollTopAfter).toBe(scrollTopBefore);
    // 活跃会话保留（侧栏活跃卡数据面）
    await expect(page.locator(`[data-session-card="${MULTI_SESSION_A}"]`)).toHaveAttribute("data-active", "1");
    // 路由往返零新 hello（同一 WS，不重建连接）
    const helloCountAfter = (await mock.clientFrames()).filter((f) => f.type === "hello").length;
    expect(helloCountAfter).toBe(helloCountBefore);

    // ── 独立 URL 直接可达：设置页路由下刷新仍是设置页（SPA 回退 + 路由初始化）──
    await page.locator('.rail-btn[data-page="settings"]').click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.reload();
    await mock.awaitReady();
    await expect(page).toHaveURL(/\/settings$/);
    // W6o 门禁：reload 后停留 boot 屏直至重驱握手（fake transport env 形态兜底生效）
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
    await mock.connect();
    await expect(page.locator('[data-settings-page="/settings"]')).toBeVisible();
  });
});

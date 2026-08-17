/**
 * T3.2 —— CL-2 删除会话二次确认全流程（F(1.2).4；Q-4④）。
 *
 * hover 显现 trash → confirming 态（红边确认条 + 「取消全部执行 + 不可恢复」
 * 文案 + 正文降透明；一次仅一张卡）→ 确认发 session.delete（信封 sessionId）/
 * 取消复原；删活跃会话 → 主区即切草稿空态；list_changed{deleted} 移除卡片。
 */
import { test, expect } from "./harness/fixtures";
import { sessionListChanged, sessionListResult, v02Snapshot, welcome } from "./harness/protocol";
import { msgEntry } from "./harness/protocol";
import { MULTI_SESSION_A, MULTI_SESSION_B, multiSessionList } from "./harness/scenarios";

test.describe("T3.2 CL-2 删除会话", () => {
  test("二次确认互斥 + session.delete 命令 + 删活跃切草稿 + 事件驱动移除", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: MULTI_SESSION_A }),
      v02Snapshot(MULTI_SESSION_A, { tail: [msgEntry("a-1", "user", "活跃会话内容", { ts: 1 })] }),
      sessionListResult(multiSessionList()),
    ]);
    await mock.waitForConn("connected");

    const cardA = page.locator(`[data-session-card="${MULTI_SESSION_A}"]`);
    const cardB = page.locator(`[data-session-card="${MULTI_SESSION_B}"]`);

    // ── trash → confirming：确认条文案（取消全部执行 + 不可恢复）──
    await cardA.locator(".ses-del").click();
    await expect(cardA).toHaveAttribute("data-confirming", "1");
    await expect(cardA.locator(".ses-confirm")).toBeVisible();
    await expect(cardA.locator(".sc-text")).toContainText("取消该会话全部执行");
    await expect(cardA.locator(".sc-text")).toContainText("不可恢复");

    // 互斥：另一卡进入 confirming → A 退出（一次仅一张卡）
    await cardB.locator(".ses-del").click();
    await expect(cardA).not.toHaveAttribute("data-confirming", "1");
    await expect(cardB).toHaveAttribute("data-confirming", "1");
    // 取消复原（无命令）
    const beforeCancel = (await mock.clientFrames()).length;
    await cardB.locator("[data-del-cancel]").click();
    await expect(cardB).not.toHaveAttribute("data-confirming", "1");
    expect((await mock.clientFrames()).length).toBe(beforeCancel);

    // ── 确认删除后台会话 B：session.delete 命令（信封 sessionId）；事件移除 ──
    await cardB.locator(".ses-del").click();
    await cardB.locator("[data-del-confirm]").click();
    const del = await mock.waitForCommand("session.delete");
    expect(del.sessionId).toBe(MULTI_SESSION_B);
    // 删非活跃：主区不受影响（A 会话内容照常）
    await expect(page.locator(".app")).toHaveAttribute("data-session", "active");
    // daemon 收口广播 → 卡片移除（前端零权威：非乐观删除）
    await expect(cardB).toHaveCount(1); // 事件未到：卡片仍在
    await mock.emit(sessionListChanged("deleted", { sessionId: MULTI_SESSION_B }));
    await expect(cardB).toHaveCount(0);

    // ── 确认删除活跃会话 A：主区即切草稿空态 + toast 交代 ──
    await cardA.locator(".ses-del").click();
    await cardA.locator("[data-del-confirm]").click();
    // 命令断言：两次 delete 按序（B → A），信封 sessionId 逐一对位
    await expect
      .poll(async () => (await mock.clientFrames()).filter((f) => f.type === "session.delete").length)
      .toBe(2);
    const dels = (await mock.clientFrames()).filter((f) => f.type === "session.delete");
    expect(dels.map((f) => f.sessionId)).toEqual([MULTI_SESSION_B, MULTI_SESSION_A]);
    // 删活跃 → 草稿空态（原型 F(1.2).4：视图即转，不等事件）
    await expect(page.locator('[data-session-card="draft"]')).toHaveCount(1);
    await expect(page.locator("[data-draft-empty]")).toBeVisible();
    await expect(page.locator("#msg-input")).toBeEnabled();
    // toast 交代（命令受理反馈；两次删除各一条，取含目标文案的首条在场即可）
    await expect(page.locator(".toast").filter({ hasText: "会话已删除" }).first()).toBeVisible();
    await mock.emit(sessionListChanged("deleted", { sessionId: MULTI_SESSION_A }));
    await expect(cardA).toHaveCount(0);
    // 全删后：草稿卡 + 空清单
    expect(await page.locator("#ses-count").innerText()).toBe("1");
  });
});

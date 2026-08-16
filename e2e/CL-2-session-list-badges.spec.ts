/**
 * T3.2 —— CL-2 P-2 会话列表徽标/未读/排序 + list_changed 三类推
 * （F(1.2).2 / F(1.0).5 呈现面；AD-4 列表数据面消费）。
 *
 * 断言：session.list 渲染卡片（标题/相对时间/运行态徽标三态）；按
 * lastActivityAt 降序；后台帧驱动未读 pill（badge-pop 纯 transform）；
 * list_changed created/state_changed/deleted 三类增量更新。
 */
import { test, expect } from "./harness/fixtures";
import { backgroundStreamDelta, sessionListChanged, sessionListResult, v02Snapshot, welcome } from "./harness/protocol";
import { sessionMeta } from "./harness/protocol";
import { MULTI_SESSION_A, MULTI_SESSION_B } from "./harness/scenarios";

test.describe("T3.2 CL-2 会话列表徽标 + list_changed 三类推", () => {
  test("清单渲染 + 排序 + 徽标三态 + 未读 pill；created/state_changed/deleted 增量更新", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: MULTI_SESSION_A }),
      v02Snapshot(MULTI_SESSION_A, { tail: [] }),
      sessionListResult([
        sessionMeta(MULTI_SESSION_B, { title: "后台跑 SUBAGENT 的会话", lastActivityAt: 900, runState: "subagent_running", loaded: false }),
        sessionMeta(MULTI_SESSION_A, { title: "活跃会话（空闲）", lastActivityAt: 500, runState: "idle", loaded: true }),
        sessionMeta("sess-c", { title: "流式中的后台会话", lastActivityAt: 100, runState: "streaming", loaded: false }),
      ]),
    ]);
    await mock.waitForConn("connected");

    // 排序：lastActivityAt 降序（B 900 > A 500 > C 100）
    const order = await page.locator("#ses-list [data-session-card]").evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.sessionCard),
    );
    expect(order).toEqual([MULTI_SESSION_B, MULTI_SESSION_A, "sess-c"]);
    expect(await page.locator("#ses-count").innerText()).toBe("3");

    // 徽标三态：subagent_running = violet 脉冲 / streaming = cyan 脉冲 / 活跃空闲 = off 静点
    const cardB = page.locator(`[data-session-card="${MULTI_SESSION_B}"]`);
    const cardC = page.locator('[data-session-card="sess-c"]');
    const cardA = page.locator(`[data-session-card="${MULTI_SESSION_A}"]`);
    await expect(cardB).toHaveAttribute("data-run-state", "subagent_running");
    await expect(cardB.locator(".hud-badge")).toContainText("跑 SUBAGENT");
    await expect(cardB.locator(".hud-dot-pulse")).toHaveCount(1);
    await expect(cardC).toHaveAttribute("data-run-state", "streaming");
    await expect(cardC.locator(".hud-badge")).toContainText("流式中");
    await expect(cardA).toHaveAttribute("data-run-state", "idle");
    await expect(cardA.locator(".hud-badge")).toContainText("空闲");
    await expect(cardA.locator(".hud-dot-pulse")).toHaveCount(0);

    // ── 后台帧驱动未读（F(1.0).5 呈现面）：B 收 2 帧内容 → pill 2 + badge-pop ──
    await mock.emit(backgroundStreamDelta(MULTI_SESSION_B, "bg-1", "后台增量一"));
    await mock.emit(backgroundStreamDelta(MULTI_SESSION_B, "bg-2", "后台增量二"));
    await expect(cardB.locator(".ses-unread")).toHaveCount(1);
    await expect(cardB.locator(".ses-unread")).toHaveText("2");
    await expect(cardB.locator(".ses-unread.pulse")).toHaveCount(1); // badge-pop（纯 transform）

    // ── list_changed 三类推 ──
    // ① created：新会话插入并按活动排序到顶
    await mock.emit(
      sessionListChanged("created", {
        sessionId: "sess-new",
        session: sessionMeta("sess-new", { title: "新建落库的会话", lastActivityAt: 9_000, runState: "idle" }),
      }),
    );
    await expect(page.locator('[data-session-card="sess-new"]')).toHaveCount(1);
    const orderAfterCreate = await page.locator("#ses-list [data-session-card]").evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.sessionCard),
    );
    expect(orderAfterCreate[0]).toBe("sess-new");
    expect(await page.locator("#ses-count").innerText()).toBe("4");

    // ② state_changed：C 转空闲 → 徽标/数据面同步
    await mock.emit(
      sessionListChanged("state_changed", {
        sessionId: "sess-c",
        session: sessionMeta("sess-c", { title: "流式中的后台会话", lastActivityAt: 8_000, runState: "idle" }),
      }),
    );
    await expect(cardC).toHaveAttribute("data-run-state", "idle");
    await expect(cardC.locator(".hud-badge")).toContainText("空闲");

    // ③ deleted：卡片移除 + 计数同步
    await mock.emit(sessionListChanged("deleted", { sessionId: "sess-c" }));
    await expect(page.locator('[data-session-card="sess-c"]')).toHaveCount(0);
    expect(await page.locator("#ses-count").innerText()).toBe("3");
    // 活跃会话不受删除他卡影响
    await expect(cardA).toHaveAttribute("data-active", "1");
  });
});

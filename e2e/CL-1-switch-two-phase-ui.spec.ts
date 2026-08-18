/**
 * T3.2 —— CL-1 切换两阶段 UI 呈现 + 分页胶囊（F(1.2).3；P-1s 状态模型；
 * AD-1 尾窗/分页）。T3.1 spec 走 probe 数据面断言；本 spec 断言真实 UI：
 * loading 骨架与最终布局同构（无通用 spinner）+ 状态行 + 输入禁用/
 * placeholder → 快照到达恢复；「加载更早的消息 · 已载 N / M」胶囊 → 骨架行
 * → 前插 + 计数更新 + 加载完禁用。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence } from "./harness/evidence";
import { loadHistoryResult, sessionListResult, v02Snapshot, welcome } from "./harness/protocol";
import {
  MULTI_HISTORY_TOTAL,
  MULTI_SESSION_A,
  MULTI_SESSION_B,
  MULTI_TAIL_WINDOW,
  MULTI_TITLE_B,
  multiHistoryEntries,
  multiSessionList,
  multiTail,
} from "./harness/scenarios";

test.describe("T3.2 CL-1 切换两阶段 UI + 分页胶囊", () => {
  test("切换 loading 骨架（同构 + 状态行 + 输入禁用）→ 快照恢复 → 分页胶囊全链（N>30 剧本）", async ({ mock, page }) => {
    // ── A 会话尾窗（无更早历史）+ 清单 ──
    const aTail = [ { kind: "message" as const, id: "a-1", role: "user" as const, content: "A 会话尾窗内容", ts: 1 } ];
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: MULTI_SESSION_A }),
      v02Snapshot(MULTI_SESSION_A, { tail: aTail, totalEntries: 1, tailStartCursor: null }),
      sessionListResult(multiSessionList()),
    ]);
    await mock.waitForConn("connected");
    // A 无更早历史：不出分页胶囊（paged=false）
    await expect(page.locator("[data-load-earlier]")).toHaveCount(0);

    // ── 点击 B 卡片切换：两阶段 loading ──
    const history = multiHistoryEntries(MULTI_HISTORY_TOTAL);
    const { tail, totalEntries, tailStartCursor } = multiTail(history);
    await page.locator(`[data-session-card="${MULTI_SESSION_B}"]`).click();
    // v0.3 先升后降：切换命令 = subscribe(B, full)（启动全图订阅的 subscribe
    // 帧在前——按 sessionId+tier 定位切换升档帧，不取首帧）
    await expect
      .poll(async () =>
        (await mock.clientFrames())
          .filter((f) => f.type === "session.subscribe")
          .map((f) => [f.sessionId, (f.payload as { tier?: string }).tier] as const),
      )
      .toEqual([
        [MULTI_SESSION_A, "full"],
        [MULTI_SESSION_B, "monitor"],
        [MULTI_SESSION_B, "full"],
      ]);

    // loading 骨架：与最终布局同构（骨架行在场）+ 状态行（cyan 脉冲点 + 尾窗 30）
    const skeleton = page.locator("[data-restore-skeleton]");
    await expect(skeleton).toBeVisible();
    await expect(page.locator(".app")).toHaveAttribute("data-view", "loading");
    await expect(skeleton.locator(".rs-status")).toContainText("正在恢复会话快照");
    await expect(skeleton.locator(".rs-status")).toContainText(`尾窗 ${MULTI_TAIL_WINDOW} 条`);
    await expect(skeleton.locator(".rs-status .hud-dot-pulse")).toHaveCount(1);
    // 骨架同构：用户气泡窄条（violet 头像 + user 圆角气泡）+ 助手方块（cyan 头像）+ 文字行
    await expect(skeleton.locator(".skel-av.violet")).toHaveCount(1);
    await expect(skeleton.locator(".skel-av.cyan")).toHaveCount(1);
    await expect(skeleton.locator(".skel.bubble-user")).toHaveCount(1);
    await expect(skeleton.locator(".skel")).not.toHaveCount(0);
    // 互斥：旧内容（success）不渲染
    await expect(page.locator(".session-active")).toBeHidden();
    await expect(page.locator(".session-empty")).toBeHidden();
    // 输入禁用 + placeholder「会话恢复中…」
    await expect(page.locator("#msg-input")).toBeDisabled();
    await expect(page.locator("#msg-input")).toHaveAttribute("placeholder", "会话恢复中…");
    await shotEvidence(page, "switch-loading-skeleton");

    // ── B 快照到达 → success：尾窗重建 + 输入恢复 + 胶囊（已载 30 / 45）──
    await mock.emit(v02Snapshot(MULTI_SESSION_B, { tail, totalEntries, tailStartCursor }));
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready");
    await expect(skeleton).toBeHidden();
    await expect(page.locator("#msg-input")).toBeEnabled();
    await expect(page.locator("#msg-input")).toHaveAttribute("placeholder", "输入消息，Enter 发送");
    await expect(page.locator(".msg-flow .msg")).toHaveCount(MULTI_TAIL_WINDOW);
    // 顶栏标题随切换同步
    await expect(page.locator("[data-session-title]")).toHaveText(MULTI_TITLE_B);

    // 分页胶囊：已载 30 / 45，可点
    const pill = page.locator("[data-load-earlier] .load-earlier");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText("加载更早的消息");
    await expect(pill).toContainText(`已载 ${MULTI_TAIL_WINDOW} / ${MULTI_HISTORY_TOTAL}`);
    await expect(pill).toBeEnabled();

    // 点击 → session.loadHistory 命令（游标 + 信封 sessionId）+ 3 行骨架
    await pill.click();
    const cmd = await mock.waitForCommand("session.loadHistory");
    expect(cmd.sessionId).toBe(MULTI_SESSION_B);
    expect((cmd.payload as { beforeEntryId: string }).beforeEntryId).toBe(tailStartCursor);
    await expect(page.locator("[data-load-earlier] .hist-loading .skel")).toHaveCount(3);
    await expect(pill).toBeDisabled(); // loading 期间防重复触发

    // result 到达：前插 + 计数更新 + 加载完禁用
    const earlier = history.slice(0, MULTI_HISTORY_TOTAL - MULTI_TAIL_WINDOW);
    await mock.emit(
      loadHistoryResult(MULTI_SESSION_B, { entries: earlier, hasMore: false, nextCursor: null }),
    );
    await expect(page.locator(".msg-flow .msg")).toHaveCount(MULTI_HISTORY_TOTAL);
    await expect(page.locator(".msg-flow .msg").first()).toContainText(`历史第 1 条（共 ${MULTI_HISTORY_TOTAL} 条）`);
    await expect(pill).toContainText(`已载 ${MULTI_HISTORY_TOTAL} / ${MULTI_HISTORY_TOTAL}`);
    await expect(pill).toBeDisabled(); // 加载完禁用
    await expect(page.locator("[data-load-earlier] .hist-loading")).toHaveCount(0);
  });
});

/**
 * T3.1 —— CL-1 切换两阶段 + 尾窗重建 + loadHistory 向上分页（F(1.2).3；
 * AD-1 尾窗/分页；P-1s 状态模型；契约 B §1.2/§1.3/§2.2/§2.3）。
 *
 * 剧本（超尾窗 N=45 > 尾窗 30，参数注入自 scenarios）：
 * ① A 会话尾窗快照（tailStartCursor 携带）→ probe data-history=more；
 * ② 滚动到顶 → session.loadHistory 命令（clientFrames 断言命令 + 游标 +
 *    信封 sessionId）→ result 前插（含重复条目去重）→ hasMore=false 禁用
 *    （再次滚顶不再发命令）；
 * ③ 清单下发 → probe 后台行出现；点击切换 → subscribe(新, full) 先升
 *    （v0.3 契约 §2.3 先升后降；clientFrames 断言）+ loading 骨架（旧内容
 *    不渲染——互斥）；
 * ④ B 快照到达（= subscribe ack）→ subscribe(旧, monitor) 降档收口 +
 *    success（输入恢复）+ mock 订阅簿记跟随（activeSession）。
 *
 * 断言纪律：断言值全部取自 harness/scenarios（K-4：断言相对参数）；
 * T5.2 起 probe（isDev 调试面）退役，断言面 = 正式 UI（.app data-view /
 * 侧栏会话卡 data-session-card · data-active · data-run-state /
 * 分页胶囊 .load-earlier data-state）。
 */
import { test, expect } from "./harness/fixtures";
import { loadHistoryResult, sessionListResult, v02Snapshot, welcome } from "./harness/protocol";
import {
  MULTI_B_TAIL_TEXT,
  MULTI_HISTORY_TOTAL,
  MULTI_SESSION_A,
  MULTI_SESSION_B,
  MULTI_TAIL_WINDOW,
  multiHistoryEntries,
  multiSessionList,
  multiTail,
} from "./harness/scenarios";

test.describe("T3.1 CL-1 切换两阶段 + 尾窗重建 + 向上分页", () => {
  test("尾窗快照 → 滚顶分页（命令+游标）→ 前插去重 → hasMore=false 禁用 → 切换两阶段互斥", async ({ mock, page }) => {
    // ── ① A 会话尾窗快照（N=45 > 尾窗 30；tailStartCursor 分页指示）──
    const history = multiHistoryEntries(MULTI_HISTORY_TOTAL);
    const { tail, totalEntries, tailStartCursor } = multiTail(history);
    expect(tail).toHaveLength(MULTI_TAIL_WINDOW); // 剧本自洽：尾窗参数生效
    expect(tailStartCursor).toBe(`e${MULTI_HISTORY_TOTAL - MULTI_TAIL_WINDOW + 1}`);

    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: MULTI_SESSION_A }),
      v02Snapshot(MULTI_SESSION_A, { tail, totalEntries, tailStartCursor }),
    ]);
    await mock.waitForConn("connected");

    const app = page.locator(".app");
    await expect(app).toHaveAttribute("data-session", "active");
    await expect(app).toHaveAttribute("data-view", "ready");
    // 分页胶囊（正式 UI 面）：快照携带 tailStartCursor → 有更早历史可载
    const pill = page.locator(".load-earlier");
    await expect(pill).toHaveAttribute("data-state", "more");
    // 尾窗重建：只渲染尾窗 30 条（不含更早历史）
    await expect(page.locator(".msg-flow .msg")).toHaveCount(MULTI_TAIL_WINDOW);
    // 输入可用（ready）
    await expect(page.locator("#msg-input")).toBeEnabled();

    // ── ② 滚动到顶 → session.loadHistory 命令（命令 + 游标 + 信封 sessionId）──
    const flow = page.locator(".msg-flow");
    await flow.evaluate((el) => {
      el.scrollTop = 0;
    });
    const historyCmd = await mock.waitForCommand("session.loadHistory");
    expect(historyCmd.sessionId).toBe(MULTI_SESSION_A);
    expect((historyCmd.payload as { beforeEntryId: string }).beforeEntryId).toBe(tailStartCursor);
    await expect(pill).toHaveAttribute("data-state", "loading");

    // ── ③ result 到达：历史前插（升序在前）+ 重复条目去重 → hasMore=false ──
    const earlier = history.slice(0, MULTI_HISTORY_TOTAL - MULTI_TAIL_WINDOW);
    const duplicated = tail.slice(0, 2); // 交叠下发（游标边界重发）→ 去重
    await mock.emit(
      loadHistoryResult(MULTI_SESSION_A, {
        entries: [...duplicated, ...earlier],
        hasMore: false,
        nextCursor: null,
      }),
    );
    await expect(page.locator(".msg-flow .msg")).toHaveCount(MULTI_HISTORY_TOTAL); // 30 尾窗 + 15 更早，零重复
    await expect(page.locator(".msg-flow .msg").first()).toContainText(`历史第 1 条（共 ${MULTI_HISTORY_TOTAL} 条）`);
    await expect(pill).toHaveAttribute("data-state", "exhausted");

    // hasMore=false 禁用：再次滚顶不再发命令（数据面断言）
    const historyCmdCount = (await mock.clientFrames()).filter((f) => f.type === "session.loadHistory").length;
    await flow.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    expect((await mock.clientFrames()).filter((f) => f.type === "session.loadHistory")).toHaveLength(historyCmdCount);

    // ── ④ 清单下发 → 切换 B：两阶段互斥（loading 骨架，旧内容不渲染）──
    await mock.emit(sessionListResult(multiSessionList()));
    const rowB = page.locator(`[data-session-card="${MULTI_SESSION_B}"]`);
    await expect(rowB).toHaveCount(1);
    await expect(rowB).toHaveAttribute("data-run-state", "streaming");

    await rowB.click();
    // 命令断言（v0.3 先升后降，契约 §2.3）：subscribe(B, full) 先升；零 unsubscribe；
    // 启动全图订阅已发 subscribe(A, full) + subscribe(B, monitor)
    const frames = await mock.clientFrames();
    const subs = frames
      .filter((f) => f.type === "session.subscribe")
      .map((f) => [f.sessionId, (f.payload as { tier?: string }).tier] as const);
    expect(subs).toEqual([
      [MULTI_SESSION_A, "full"],
      [MULTI_SESSION_B, "monitor"],
      [MULTI_SESSION_B, "full"],
    ]);
    // ack（快照）未达：旧活跃不降档（瞬时双 full 窗口）
    expect(frames.some((f) => f.type === "session.unsubscribe")).toBe(false);
    // mock 订阅簿记跟随（v0.3：full 档会话 = 切换目标）
    await expect(mock.activeSession()).resolves.toBe(MULTI_SESSION_B);
    // loading 骨架：success 内容不渲染（互斥）+ 输入禁用
    await expect(app).toHaveAttribute("data-view", "loading");
    // 活跃卡即刻切换到 B（侧栏正式 UI 面）
    await expect(rowB).toHaveAttribute("data-active", "1");
    await expect(app).toHaveAttribute("data-session", "empty");
    await expect(page.locator("#msg-input")).toBeDisabled();

    // ── ⑤ B 快照到达（= subscribe ack）→ success + 先升后降降档收口 ──
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [
          { kind: "message", id: "b-e1", role: "user", content: MULTI_B_TAIL_TEXT, ts: 1 },
        ],
        totalEntries: 1,
        tailStartCursor: null,
      }),
    );
    // ack 后才 subscribe(A, monitor)（严格序断言面）
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
        [MULTI_SESSION_A, "monitor"],
      ]);
    await expect(app).toHaveAttribute("data-view", "ready");
    await expect(page.locator(".msg.user", { hasText: MULTI_B_TAIL_TEXT })).toBeVisible();
    await expect(page.locator("#msg-input")).toBeEnabled();
    // 无更早历史：分页胶囊不渲染（tailStartCursor=null → paged=false）
    await expect(page.locator("[data-load-earlier]")).toHaveCount(0);
  });
});

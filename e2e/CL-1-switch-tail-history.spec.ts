/**
 * T3.1 —— CL-1 切换两阶段 + 尾窗重建 + loadHistory 向上分页（F(1.2).3；
 * AD-1 尾窗/分页；P-1s 状态模型；契约 B §1.2/§1.3/§2.2/§2.3）。
 *
 * 剧本（超尾窗 N=45 > 尾窗 30，参数注入自 scenarios）：
 * ① A 会话尾窗快照（tailStartCursor 携带）→ probe data-history=more；
 * ② 滚动到顶 → session.loadHistory 命令（clientFrames 断言命令 + 游标 +
 *    信封 sessionId）→ result 前插（含重复条目去重）→ hasMore=false 禁用
 *    （再次滚顶不再发命令）；
 * ③ 清单下发 → probe 后台行出现；点击切换 → unsubscribe 旧 + subscribe 新
 *    （clientFrames 断言）+ loading 骨架（旧内容不渲染——互斥）；
 * ④ B 快照到达 → success（输入恢复）+ mock 订阅簿记跟随（activeSession）。
 *
 * 断言纪律：断言值全部取自 harness/scenarios（K-4：断言相对参数）；
 * probe（isDev 门控最小验证入口，T3.1）为 store 层断言面——P-2 侧栏 UI
 * 归 T3.2 后替换为真实组件断言。
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

    const probe = page.locator("[data-topology]");
    await expect(probe).toHaveAttribute("data-active-session", MULTI_SESSION_A);
    await expect(probe).toHaveAttribute("data-view", "ready");
    await expect(probe).toHaveAttribute("data-history", "more");
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
    await expect(probe).toHaveAttribute("data-history", "loading");

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
    await expect(probe).toHaveAttribute("data-history", "exhausted");

    // hasMore=false 禁用：再次滚顶不再发命令（数据面断言）
    const historyCmdCount = (await mock.clientFrames()).filter((f) => f.type === "session.loadHistory").length;
    await flow.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    expect((await mock.clientFrames()).filter((f) => f.type === "session.loadHistory")).toHaveLength(historyCmdCount);

    // ── ④ 清单下发 → 切换 B：两阶段互斥（loading 骨架，旧内容不渲染）──
    await mock.emit(sessionListResult(multiSessionList()));
    const rowB = page.locator(`[data-bg-session="${MULTI_SESSION_B}"]`);
    await expect(rowB).toHaveCount(1);
    await expect(rowB).toHaveAttribute("data-run-state", "streaming");

    await rowB.click();
    // 命令断言：unsubscribe 旧 + subscribe 新（契约 B §1.2 定稿形态）
    const frames = await mock.clientFrames();
    const unsub = frames.find((f) => f.type === "session.unsubscribe");
    const sub = frames.find((f) => f.type === "session.subscribe");
    expect(unsub?.sessionId).toBe(MULTI_SESSION_A);
    expect(sub?.sessionId).toBe(MULTI_SESSION_B);
    // mock 订阅簿记跟随（daemon subscribeSession 语义镜像）
    await expect(mock.activeSession()).resolves.toBe(MULTI_SESSION_B);
    // loading 骨架：success 内容不渲染（互斥）+ 输入禁用
    await expect(probe).toHaveAttribute("data-view", "loading");
    await expect(probe).toHaveAttribute("data-active-session", MULTI_SESSION_B);
    await expect(page.locator(".app")).toHaveAttribute("data-session", "empty");
    await expect(page.locator("#msg-input")).toBeDisabled();

    // ── ⑤ B 快照到达 → success：尾窗重建可见 + 输入恢复 ──
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [
          { kind: "message", id: "b-e1", role: "user", content: MULTI_B_TAIL_TEXT, ts: 1 },
        ],
        totalEntries: 1,
        tailStartCursor: null,
      }),
    );
    await expect(probe).toHaveAttribute("data-view", "ready");
    await expect(page.locator(".msg.user", { hasText: MULTI_B_TAIL_TEXT })).toBeVisible();
    await expect(page.locator("#msg-input")).toBeEnabled();
    // 无更早历史：分页禁用（tailStartCursor=null）
    await expect(probe).toHaveAttribute("data-history", "exhausted");
  });
});

/**
 * T3.1 —— CL-1 多会话 mock：后台徽标脉冲 + 未读跳动（F(1.0).5 后台续跑；
 * AD-3 轻量 store 收帧驱动；契约 B §1.1/§2.1）。
 *
 * 剧本：A 活跃 + B 后台（清单播种）→
 * ① session.list.result → B 轻量行（标题/运行态徽标，unread=0）；
 * ② B 会话内容帧（信封 sessionId=B）→ 未读计数跳动（收帧驱动 +N）；
 *    活跃主消息流零污染（不渲染后台 entries）；
 * ③ session.list_changed{state_changed} → 运行态徽标翻转（元数据权威）；
 * ④ mock 剧本台账（scenarioSession）= 后台续跑活动断言面（daemon 侧视角）；
 * ⑤ 切回 B → 轻量态移除（未读消解）——双 store 拓扑的活跃/后台转换。
 *
 * probe（isDev 门控最小验证入口）为 store 层断言面；P-2 侧栏 UI 归 T3.2。
 */
import { test, expect } from "./harness/fixtures";
import {
  backgroundStreamDelta,
  sessionListChanged,
  sessionListResult,
  v02Snapshot,
  welcome,
} from "./harness/protocol";
import {
  MULTI_B_DELTAS,
  MULTI_B_MSG_ID,
  MULTI_SESSION_A,
  MULTI_SESSION_B,
  multiSessionList,
} from "./harness/scenarios";

test.describe("T3.1 CL-1 后台轻量 store（徽标脉冲 + 未读跳动）", () => {
  test("后台会话事件驱动轻量 store：未读 +1/帧、runState 徽标翻转、活跃主区零污染", async ({ mock, page }) => {
    // A 活跃连接（v0.2 信封章印：welcome/快照均指向 MULTI_SESSION_A）
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([welcome({ sessionId: MULTI_SESSION_A }), v02Snapshot(MULTI_SESSION_A, { tail: [] })]);
    await mock.waitForConn("connected");

    // ── ① 清单下发 → B 轻量行播种（unread=0）──
    await mock.emit(sessionListResult(multiSessionList()));
    const rowB = page.locator(`[data-bg-session="${MULTI_SESSION_B}"]`);
    await expect(rowB).toHaveCount(1);
    await expect(rowB).toHaveAttribute("data-unread", "0");
    await expect(rowB).toHaveAttribute("data-run-state", "streaming");

    // ── ② B 会话内容帧（信封 sessionId 章印）→ 未读跳动（收帧驱动）──
    for (const [i, delta] of MULTI_B_DELTAS.entries()) {
      await mock.emit(backgroundStreamDelta(MULTI_SESSION_B, MULTI_B_MSG_ID, delta));
      await expect(rowB).toHaveAttribute("data-unread", String(i + 1));
    }
    // 帧驱动运行态投影：streaming（徽标脉冲源）
    await expect(rowB).toHaveAttribute("data-run-state", "streaming");
    // 活跃主消息流零污染：B 的后台增量不进 A 的渲染面
    await expect(page.locator(".msg-flow .msg")).toHaveCount(0);

    // ── ③ list_changed{state_changed} → 徽标翻转（元数据权威面）──
    await mock.emit(
      sessionListChanged("state_changed", {
        sessionId: MULTI_SESSION_B,
        session: {
          sessionId: MULTI_SESSION_B,
          title: "后台续跑会话",
          lastActivityAt: 1_800,
          runState: "subagent_running",
          loaded: false,
        },
      }),
    );
    await expect(rowB).toHaveAttribute("data-run-state", "subagent_running");
    // 未读不因元数据同步重置（内容计数保持）
    await expect(rowB).toHaveAttribute("data-unread", String(MULTI_B_DELTAS.length));

    // ── ④ mock 剧本台账：后台续跑活动（daemon 侧视角断言面）──
    const ledger = await mock.scenarioSession(MULTI_SESSION_B);
    expect(ledger).toEqual({ sessionId: MULTI_SESSION_B, eventCount: MULTI_B_DELTAS.length });
    // 连接订阅簿记：未切换（首连不显式 subscribe）
    await expect(mock.activeSession()).resolves.toBeNull();

    // ── ⑤ 切回 B → 轻量态移除（转活跃，未读消解）；旧活跃 A 转轻量 ──
    await rowB.click();
    await expect(mock.activeSession()).resolves.toBe(MULTI_SESSION_B);
    await expect(page.locator(`[data-bg-session="${MULTI_SESSION_B}"]`)).toHaveCount(0);
    const rowA = page.locator(`[data-bg-session="${MULTI_SESSION_A}"]`);
    await expect(rowA).toHaveCount(1); // A 转后台轻量
    // B 快照到达 → 重建完成（收尾断言：两阶段闭合）
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [{ kind: "message", id: "b-1", role: "user", content: "B 重建完成", ts: 1 }],
      }),
    );
    await expect(page.locator("[data-topology]")).toHaveAttribute("data-view", "ready");
    await expect(page.locator("[data-topology]")).toHaveAttribute("data-active-session", MULTI_SESSION_B);
  });
});

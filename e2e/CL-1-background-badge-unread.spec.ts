/**
 * T3.1 —— CL-1 多会话 mock：后台徽标脉冲 + 未读跳动（F(1.0).5 后台续跑；
 * AD-3 轻量 store 收帧驱动；契约 B §1.1/§2.1）。v0.3（T3.2，契约 §2）同步：
 * 后台会话 = monitor 档订阅（启动 list 后全图订阅落地），未读真链路驱动面
 * = 白名单 message_end 帧（stream.delta 不进 monitor 档，过滤归 daemon/
 * fake 簿记）。
 *
 * 剧本：A 活跃 + B 后台（清单播种 + 全图订阅）→
 * ① session.list.result → B 轻量行（标题/运行态徽标，unread=0）+ 出站全图
 *    订阅（A full 为 welcome attach 静默登记零命令——契约依据 a4a182e；
 *    仅 B 补订 monitor 在命令流）；
 * ② B 会话 message_end 帧（monitor 档白名单，信封 sessionId=B）→ 未读计数
 *    跳动（收帧驱动 +N）；活跃主消息流零污染（不渲染后台 entries）；
 * ③ session.list_changed{state_changed} → 运行态徽标翻转（元数据权威）；
 * ④ mock 剧本台账（scenarioSession）= 后台续跑活动断言面（daemon 侧视角）；
 * ⑤ 切回 B → 轻量态移除（未读消解）——双 store 拓扑的活跃/后台转换
 *    （v0.3 先升后降：subscribe(B, full) → 快照 ack → subscribe(A, monitor)）。
 *
 * probe（isDev 调试面）已于 T5.2 退役：断言面 = P-2 侧栏会话卡
 * （data-session-card · data-run-state · data-unread · data-active）与
 * .app data-view（正式 UI 面）。
 */
import { test, expect } from "./harness/fixtures";
import {
  backgroundMessageCompleted,
  msgEntry,
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
    const rowB = page.locator(`[data-session-card="${MULTI_SESSION_B}"]`);
    await expect(rowB).toHaveCount(1);
    await expect(rowB).toHaveAttribute("data-unread", "0");
    await expect(rowB).toHaveAttribute("data-run-state", "streaming");

    // ── ② B 会话 message_end 帧（monitor 档白名单；信封 sessionId 章印）→ 未读跳动（收帧驱动）──
    for (const [i, delta] of MULTI_B_DELTAS.entries()) {
      await mock.emit(backgroundMessageCompleted(MULTI_SESSION_B, msgEntry(`${MULTI_B_MSG_ID}-${i}`, "assistant", delta, { ts: 100 + i })));
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
    // 连接订阅契约（a4a182e：welcome attach 静默登记活跃 full——零命令）：启动
    // 期命令流仅含非活跃补订 monitor，无 subscribe(A, full)；mock 侧命令驱动
    // 簿记因此读不到 full 档（activeSession()=null 属正确行为），活跃断言改读
    // welcome-attach 后 UI 态（侧栏正式面）。
    const startupSubs = (await mock.clientFrames())
      .filter((f) => f.type === "session.subscribe")
      .map((f) => [f.sessionId, (f.payload as { tier?: string }).tier] as const);
    expect(startupSubs).toEqual([[MULTI_SESSION_B, "monitor"]]);
    const rowA = page.locator(`[data-session-card="${MULTI_SESSION_A}"]`);
    await expect(rowA).toHaveAttribute("data-active", "1");

    // ── ⑤ 切回 B → 轻量态移除（转活跃，未读消解）；旧活跃 A 转轻量 ──
    //（v0.3 先升后降：click → subscribe(B, full)；快照 ack 后 subscribe(A, monitor)）
    await rowB.click();
    // 切换命令真实在发（subscribe(B, full)）→ mock 侧命令驱动簿记恢复可读
    await expect(mock.activeSession()).resolves.toBe(MULTI_SESSION_B);
    await expect(rowB).toHaveAttribute("data-active", "1"); // B 转活跃
    await expect(rowB).toHaveAttribute("data-unread", "0"); // 未读随活跃消解
    await expect(rowA).toHaveCount(1); // A 转后台轻量
    await expect(rowA).not.toHaveAttribute("data-active", "1");
    // B 快照到达 → 重建完成（收尾断言：两阶段闭合）
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [{ kind: "message", id: "b-1", role: "user", content: "B 重建完成", ts: 1 }],
      }),
    );
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready");
    await expect(rowB).toHaveAttribute("data-active", "1");
  });
});

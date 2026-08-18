/**
 * T3.2 —— CL-2 monitor 档订阅生命周期与未读徽标（契约 v0.3 §2；AD-2；
 * Q-2b①③④；TR-AD-23 订阅契约 / TR-AD-5 重连恢复 / TR-TEST-3 mock 契约等价）。
 *
 * 断言纪律：F 层出站命令序断言（fake transport clientFrames 簿记），不得以
 * UI 副作用推断顺序。四态剧本：
 * ① 启动：session.list.result → 全图订阅（活跃 full 先行 + 其余全部
 *    monitor，逐会话命令断言）；monitor 档 subscribe 的回推快照 = 纯 ack
 *    噪声 → 吞帧（后台会话不被顶成活跃）；created 补订 monitor /
 *    deleted 退订；
 * ② 切换先升后降：subscribe(new, full) 立即发 →（快照 ack 到达）→
 *    subscribe(old, monitor)——严格顺序断言 + 表现面迁移（新活跃未读清零
 *    pill 摘除；原活跃转后台保留运行态）；
 * ③ 未读真链路：后台 monitor 档 message_end 帧 → 既有路由 → pill 计数+1 +
 *    badge-pop（.ses-unread.pulse）；白名单过滤模拟（stream.delta 不达）；
 *    空闲后台首帧 pill 从无到有；活跃会话无 pill；reduced-motion 关停；
 * ④ 断连重连：netClose → 自动重连 → welcome 后重放全订阅图（活跃 full +
 *    后台 monitor 分档正确）；重放后 monitor 档过滤语义保持。
 */
import { test, expect } from "./harness/fixtures";
import type { MockController } from "./harness/mock-session";
import {
  agentStateChanged,
  backgroundMessageCompleted,
  backgroundStreamDelta,
  backgroundTurnCompleted,
  backgroundTurnStarted,
  messageCompleted,
  msgEntry,
  sessionListChanged,
  sessionListResult,
  sessionMeta,
  v02Snapshot,
  welcome,
} from "./harness/protocol";
import { MULTI_SESSION_A, MULTI_SESSION_B } from "./harness/scenarios";

const SESSION_C = "sess-monitor-c";
const SESSION_D = "sess-monitor-d";

/** 出站订阅命令投影：[type, sessionId, tier?] 三元组序（先升后降严格序断言面）。 */
async function subscriptionFrames(mock: MockController): Promise<[string, string | undefined, string | undefined][]> {
  return (await mock.clientFrames())
    .filter((f) => f.type === "session.subscribe" || f.type === "session.unsubscribe")
    .map((f) => [
      f.type,
      f.sessionId,
      (f.payload as { tier?: string } | undefined)?.tier,
    ] as [string, string | undefined, string | undefined]);
}

/** 等待出站订阅命令投影达到目标序列（poll，避免竞态）。 */
async function expectSubscriptions(
  mock: MockController,
  expected: [string, string | undefined, string | undefined][],
): Promise<void> {
  await expect.poll(() => subscriptionFrames(mock), { timeout: 5_000 }).toEqual(expected);
}

/** 标准起步：A 活跃建连 + 清单 [A + 其余]（session.list 命令先行确保时序）。 */
async function setupActiveA(mock: MockController, others: ReturnType<typeof sessionMeta>[]): Promise<void> {
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emitAll([welcome({ sessionId: MULTI_SESSION_A }), v02Snapshot(MULTI_SESSION_A, { tail: [] })]);
  await mock.waitForConn("connected");
  await mock.waitForCommand("session.list"); // 侧栏 connected 效果触发
  await mock.emit(
    sessionListResult([
      sessionMeta(MULTI_SESSION_A, { title: "活跃会话 A", lastActivityAt: 3_000, runState: "idle" }),
      ...others,
    ]),
  );
}

test.describe("T3.2 CL-2 monitor 档订阅生命周期（契约 v0.3 §2）", () => {
  test("启动全图订阅 + created 补订 + deleted 退订 + monitor ack 快照吞帧", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([welcome({ sessionId: MULTI_SESSION_A }), v02Snapshot(MULTI_SESSION_A, { tail: [] })]);
    await mock.waitForConn("connected");
    await mock.waitForCommand("session.list");
    // 清单未达：零 subscribe（启动不盲目订阅）
    expect(await subscriptionFrames(mock)).toEqual([]);

    // ── ① list 后全图订阅：活跃 full 先行 + 其余按清单序 monitor ──
    await mock.emit(
      sessionListResult([
        sessionMeta(MULTI_SESSION_A, { title: "活跃会话 A", lastActivityAt: 3_000, runState: "idle" }),
        sessionMeta(MULTI_SESSION_B, { title: "后台会话 B", lastActivityAt: 2_000, runState: "streaming", loaded: false }),
        sessionMeta(SESSION_C, { title: "后台会话 C", lastActivityAt: 1_000, runState: "idle", loaded: false }),
      ]),
    );
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", SESSION_C, "monitor"],
    ]);

    // ── monitor 档 subscribe 回推快照 = 纯 ack 噪声 → 吞帧（不顶活跃）──
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [msgEntry("b-ack", "user", "B 的 monitor ack 快照", { ts: 1 })],
      }),
    );
    await page.waitForTimeout(200); // 吞帧负断言需给渲染窗口
    await expect(page.locator(`[data-session-card="${MULTI_SESSION_A}"]`)).toHaveAttribute("data-active", "1");
    await expect(page.locator(`[data-session-card="${MULTI_SESSION_B}"]`)).not.toHaveAttribute("data-active", "1");
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready");
    // 吞帧不触发升档：无 subscribe(B, full) 抢发
    expect(await subscriptionFrames(mock)).toEqual([
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", SESSION_C, "monitor"],
    ]);

    // ── created 补订 monitor；deleted 退订 ──
    await mock.emit(
      sessionListChanged("created", {
        sessionId: SESSION_D,
        session: sessionMeta(SESSION_D, { title: "新建会话 D", lastActivityAt: 4_000, runState: "idle" }),
      }),
    );
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", SESSION_C, "monitor"],
      ["session.subscribe", SESSION_D, "monitor"],
    ]);
    await expect(page.locator(`[data-session-card="${SESSION_D}"]`)).toHaveCount(1);

    await mock.emit(sessionListChanged("deleted", { sessionId: SESSION_D }));
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", SESSION_C, "monitor"],
      ["session.subscribe", SESSION_D, "monitor"],
      ["session.unsubscribe", SESSION_D, undefined],
    ]);
    await expect(page.locator(`[data-session-card="${SESSION_D}"]`)).toHaveCount(0);
  });

  test("切换先升后降严格序：subscribe(new,full) → 快照 ack → subscribe(old,monitor) + 表现面迁移", async ({ mock, page }) => {
    await setupActiveA(mock, [
      sessionMeta(MULTI_SESSION_B, { title: "后台会话 B", lastActivityAt: 2_000, runState: "idle", loaded: false }),
    ]);
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
    ]);

    // A 进入流式（切走后运行态保留的表现面素材）+ B 先攒一条未读
    await mock.emit(agentStateChanged("running"));
    await expect(page.locator(`[data-session-card="${MULTI_SESSION_A}"]`)).toHaveAttribute("data-run-state", "streaming");
    await mock.emit(backgroundMessageCompleted(MULTI_SESSION_B, msgEntry("b-m1", "assistant", "B 后台消息", { ts: 2 })));
    const cardB = page.locator(`[data-session-card="${MULTI_SESSION_B}"]`);
    await expect(cardB).toHaveAttribute("data-unread", "1");

    // ── 点击切换：subscribe(B, full) 立即发；ack 前零降档（严格序）──
    await cardB.click();
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", MULTI_SESSION_B, "full"],
    ]);
    // 表现面：B 即转活跃（loading 骨架两阶段）+ 未读清零 pill 摘除
    await expect(cardB).toHaveAttribute("data-active", "1");
    await expect(cardB).toHaveAttribute("data-unread", "0");
    await expect(cardB.locator(".ses-unread")).toHaveCount(0);
    await expect(page.locator(".app")).toHaveAttribute("data-view", "loading");

    // ── 快照 ack 到达 → subscribe(A, monitor) 收口（瞬时双 full 闭合）──
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [msgEntry("b-t1", "user", "B 尾窗首条", { ts: 3 })],
        totalEntries: 1,
        tailStartCursor: null,
      }),
    );
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", MULTI_SESSION_B, "full"],
      ["session.subscribe", MULTI_SESSION_A, "monitor"],
    ]);
    // 表现面迁移：B ready；A 转后台保留运行态（streaming 照跑）
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready");
    const cardA = page.locator(`[data-session-card="${MULTI_SESSION_A}"]`);
    await expect(cardA).not.toHaveAttribute("data-active", "1");
    await expect(cardA).toHaveAttribute("data-run-state", "streaming");
  });

  test("未读真链路：monitor 档 message_end → pill+1 + badge-pop；白名单过滤；活跃无 pill；reduced-motion 关停", async ({ mock, page }) => {
    await setupActiveA(mock, [
      sessionMeta(MULTI_SESSION_B, { title: "后台流式会话 B", lastActivityAt: 2_000, runState: "streaming", loaded: false }),
      sessionMeta(SESSION_C, { title: "后台空闲会话 C", lastActivityAt: 1_000, runState: "idle", loaded: false }),
    ]);

    // ── 后台 B message_end → pill 计数+1 + badge-pop（.ses-unread.pulse）──
    const cardB = page.locator(`[data-session-card="${MULTI_SESSION_B}"]`);
    await mock.emit(backgroundMessageCompleted(MULTI_SESSION_B, msgEntry("bm-1", "assistant", "B 首条完成", { ts: 1 })));
    await expect(cardB).toHaveAttribute("data-unread", "1");
    await expect(cardB.locator(".ses-unread")).toHaveText("1");
    await expect(cardB.locator(".ses-unread.pulse")).toHaveCount(1);

    // ── 白名单过滤模拟（daemon 同规）：stream.delta 不进 monitor 档 → 未读不变 ──
    await mock.emit(backgroundStreamDelta(MULTI_SESSION_B, "bm-x", "被过滤的增量"));
    await page.waitForTimeout(200);
    await expect(cardB).toHaveAttribute("data-unread", "1");
    // 台账只记实际下发帧（被过滤帧不入账）
    await expect(mock.scenarioSession(MULTI_SESSION_B)).resolves.toEqual({ sessionId: MULTI_SESSION_B, eventCount: 1 });

    // ── 空闲后台 C：首帧（turn.started）pill 从无到有 → message_end 续涨 → turn.completed 回 idle ──
    const cardC = page.locator(`[data-session-card="${SESSION_C}"]`);
    await expect(cardC.locator(".ses-unread")).toHaveCount(0);
    await mock.emit(backgroundTurnStarted(SESSION_C, "c-t1"));
    await expect(cardC.locator(".ses-unread")).toHaveText("1");
    await mock.emit(backgroundMessageCompleted(SESSION_C, msgEntry("cm-1", "assistant", "C 完成", { ts: 2 })));
    await expect(cardC.locator(".ses-unread")).toHaveText("2");
    await mock.emit(backgroundTurnCompleted(SESSION_C, "c-t1"));
    await expect(cardC.locator(".ses-unread")).toHaveText("3");
    await expect(cardC).toHaveAttribute("data-run-state", "idle");

    // ── 活跃会话无 pill：A 的 message_end 进主流渲染，不计未读 ──
    await mock.emit(messageCompleted(msgEntry("am-1", "assistant", "A 活跃回复", { ts: 3 })));
    await expect(page.locator(".msg-flow .msg")).toHaveCount(1);
    const cardA = page.locator(`[data-session-card="${MULTI_SESSION_A}"]`);
    await expect(cardA).toHaveAttribute("data-unread", "0");
    await expect(cardA.locator(".ses-unread")).toHaveCount(0);

    // ── badge-pop reduced-motion 关停（纯 transform 动效可关断言）──
    await page.emulateMedia({ reducedMotion: "reduce" });
    const animationName = await cardB.locator(".ses-unread").evaluate((el) => getComputedStyle(el).animationName);
    expect(animationName).toBe("none");
  });

  test("断连重连：重放全订阅图（活跃 full + 后台 monitor）；重放后过滤语义保持", async ({ mock, page }) => {
    await setupActiveA(mock, [
      sessionMeta(MULTI_SESSION_B, { title: "后台会话 B", lastActivityAt: 2_000, runState: "idle", loaded: false }),
    ]);
    // 切到 B（先升后降收口）：B full / A monitor
    await page.locator(`[data-session-card="${MULTI_SESSION_B}"]`).click();
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [msgEntry("b-t1", "user", "B 尾窗", { ts: 1 })],
        totalEntries: 1,
        tailStartCursor: null,
      }),
    );
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", MULTI_SESSION_B, "full"],
      ["session.subscribe", MULTI_SESSION_A, "monitor"],
    ]);
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready");

    // ── 断连 → 自动重连 → welcome 后重放全订阅图（B full + A monitor）──
    await mock.netClose();
    await mock.waitForConn("disconnected");
    await mock.waitForConn("connecting", 8_000); // 自动重连（退避 800ms）
    await mock.open(); // 新实例 fireOpen → hello 重发（send 门控 OPEN 态）
    await expect
      .poll(async () => (await mock.clientFrames()).filter((f) => f.type === "hello").length, { timeout: 5_000 })
      .toBe(2);
    await mock.emit(welcome({ sessionId: MULTI_SESSION_B })); // daemon 自动 attach 当前会话
    await expectSubscriptions(mock, [
      ["session.subscribe", MULTI_SESSION_A, "full"],
      ["session.subscribe", MULTI_SESSION_B, "monitor"],
      ["session.subscribe", MULTI_SESSION_B, "full"],
      ["session.subscribe", MULTI_SESSION_A, "monitor"],
      // 重放（daemon tier 表随连接销毁 → 全图重建，幂等收敛）
      ["session.subscribe", MULTI_SESSION_B, "full"],
      ["session.subscribe", MULTI_SESSION_A, "monitor"],
    ]);

    // 重连快照（自动 attach 回推）→ 活跃重建照常
    await mock.emit(
      v02Snapshot(MULTI_SESSION_B, {
        tail: [msgEntry("b-t1", "user", "B 尾窗", { ts: 1 })],
        totalEntries: 1,
        tailStartCursor: null,
      }),
    );
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready");
    await expect(page.locator(`[data-session-card="${MULTI_SESSION_B}"]`)).toHaveAttribute("data-active", "1");

    // ── 重放后 monitor 过滤语义保持：A message_end 未读+1；delta 被过滤 ──
    const cardA = page.locator(`[data-session-card="${MULTI_SESSION_A}"]`);
    await mock.emit(backgroundMessageCompleted(MULTI_SESSION_A, msgEntry("am-r1", "assistant", "A 重连后完成", { ts: 2 })));
    await expect(cardA).toHaveAttribute("data-unread", "1");
    await mock.emit(backgroundStreamDelta(MULTI_SESSION_A, "am-x", "被过滤的增量"));
    await page.waitForTimeout(200);
    await expect(cardA).toHaveAttribute("data-unread", "1");
  });
});

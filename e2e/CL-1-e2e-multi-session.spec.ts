/**
 * T4.2 —— CL-1 多会话闭环（真 daemon，E 层；AD-4 / 契约 B §1）。
 *
 * 四段断言（决策消解口径）：
 * ① 草稿建会话：#btn-new-session → draft 卡（零建会话帧）→ 首条消息
 *    chat.send{draft:true} → list_changed{created} + 快照（草稿卡消隐、
 *    会话卡出现，title = 首条用户消息截断）；
 * ② 并行两会话：乙 17 轮（含两次 agent_spawn：一 done 一挂起）→ 末轮慢速
 *    流式中切回甲 → 乙后台续跑（数据面判据：切走后 turn 完成——乙卡
 *    runState streaming → idle，由 list_changed{state_changed} 系统广播驱动）；
 * ③ 切换恢复：切回乙 → 尾窗快照（data-history=more）+ per-instance（done/
 *    running 卡片 + 抽屉骨架/closure 尾卡）→ 滚顶分页（更早历史前插 +
 *    exhausted 禁用）；
 * ④ 删除收口：删活跃乙（含挂起 SubAgent——daemon 取消链 kill 收口 → 删库
 *    → list_changed{deleted}）→ 卡片移除 + 本地转草稿态 + 甲仍可切换恢复。
 *
 * 未读徽标为 F 层呈现断言（AD-4 单订阅下后台帧不达前端——E 层验数据面：
 * 切走后 turn 完成 + 切回完整可见），不在本 spec 断言。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { reply, slowReply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** 通用前置：建 home+沙箱。 */
function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl1-multi-"));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

/** 消息级轮次等待（挂起 SubAgent 卡自带 stream-cursor，不可用全局 waitForTurnDone）。 */
async function waitComposerIdle(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
}

test.describe("T4.2 CL-1 多会话闭环（真 daemon）", () => {
  test("草稿建会话 → 并行两会话后台续跑 → 切换恢复（尾窗/分页/per-instance）→ 删除收口", async ({ e2e, page }) => {
    test.setTimeout(240_000);
    const home = prepHome();

    // ── 剧本（乙会话 17 轮；甲会话仅首轮与乙共用 e0——各会话独立引擎独立
    //    消费队列副本）────────────────────────────────────────────
    const A_FIRST = "甲会话首条消息";
    const B_FIRST = "乙会话首条消息";
    const E0 = "首条回复：会话已建立。（完E0）";
    const B_SLOW_END = "（完E16）";
    const B_SLOW = `乙后台长回复：切走后本 turn 继续执行并完整落库，切回可见全文。${"流式占位".repeat(9)}${B_SLOW_END}`; // turn16（e16）
    const script: DaemonScript = {
      entries: [
        reply(E0), // e0：甲/乙首轮共用
        reply("乙回合二回复。（完E1）"), // e1
        toolCall("agent_spawn", { task: "乙调研一" }), // e2（turn3）
        reply("乙已派出调研一。（完E3）"), // e3
        reply("乙回合四回复。（完E4）"), // e4
        reply("乙回合五回复。（完E5）"), // e5
        reply("乙回合六回复。（完E6）"), // e6
        reply("乙回合七回复。（完E7）"), // e7
        reply("乙回合八回复。（完E8）"), // e8
        reply("乙回合九回复。（完E9）"), // e9
        reply("乙回合十回复。（完E10）"), // e10
        reply("乙回合十一回复。（完E11）"), // e11
        reply("乙回合十二回复。（完E12）"), // e12
        reply("乙回合十三回复。（完E13）"), // e13
        reply("乙回合十四回复。（完E14）"), // e14
        reply("乙回合十五回复。（完E15）"), // e15
        slowReply(B_SLOW, 350, 4), // e16（turn16：慢速流式 ≈ 4s，后台续跑载体）
        toolCall("agent_spawn", { task: "乙挂起任务" }), // e17（turn17）
        reply("乙已派出挂起任务。（完E18）"), // e18
      ],
    };
    // SubAgent 剧本（按 launch 次序）：调研一 600ms done；挂起任务 null（running）
    const subagentScript = [{ delayMs: 600, result: "done" as const, summary: "乙调研一完成：结论 Y" }, null];

    const d = await e2e.startDaemon({ script, home, subagentScript });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── ① 草稿建会话（甲）─────────────────────────────────────
    await page.locator("#btn-new-session").click();
    const draftCard = page.locator('[data-session-card="draft"]');
    await expect(draftCard).toBeVisible();
    await e2e.send(page, A_FIRST);
    // 草稿卡消隐 + 甲会话卡出现（title = 首条用户消息截断）
    await expect(draftCard).toHaveCount(0);
    const cardA = page.locator(".ses", { hasText: A_FIRST.slice(0, 8) });
    await expect(cardA).toHaveCount(1, { timeout: 10_000 });
    await expect(cardA).toHaveAttribute("data-active", "1");
    await e2e.waitForTurnDone(page, "（完E0）");
    await shotEvidence(page, "cl1-multi-draft-create", "CL-1");

    // ── ② 并行两会话：乙 17 轮 → 末轮慢速流式中切回甲 ─────────
    await page.locator("#btn-new-session").click();
    await expect(draftCard).toBeVisible();
    await e2e.send(page, B_FIRST);
    await expect(draftCard).toHaveCount(0);
    const cardB = page.locator(".ses", { hasText: B_FIRST.slice(0, 8) });
    await expect(cardB).toHaveCount(1, { timeout: 10_000 });
    await expect(cardB).toHaveAttribute("data-active", "1");
    await expect(cardA).not.toHaveAttribute("data-active"); // 甲转后台

    await e2e.waitForTurnDone(page, "（完E0）"); // 乙 turn1（与甲共用 e0 文案）
    // turn2（e1）
    await e2e.send(page, "乙回合二的输入");
    await e2e.waitForAssistantText(page, "（完E1）", 20_000);
    await waitComposerIdle(page);
    // turn3：agent_spawn 调研一（e2 工具 + e3 回复）→ 600ms 剧本收口 done
    await e2e.send(page, "乙回合三的输入");
    await e2e.waitForAssistantText(page, "（完E3）", 20_000);
    await waitComposerIdle(page);
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 10_000 });
    // closure 注入自动轮（e4）：SubAgent done → closure failed/done 经 SteerQueue
    // 注入 → idle 主线自动 drain 开新 turn（不发送，消耗下一条剧本）
    await e2e.waitForAssistantText(page, "（完E4）", 20_000);
    await waitComposerIdle(page);
    // turn5..turn15（e5..e15）：一发送一回复 1:1
    for (let n = 5; n <= 15; n++) {
      await e2e.send(page, `乙回合${n}的输入`);
      await e2e.waitForAssistantText(page, `（完E${n}）`, 20_000);
      await waitComposerIdle(page);
    }
    // turn16：慢速流式（≈4s）——流式中切回甲（乙转后台续跑）
    await e2e.send(page, "乙回合十六的输入");
    await expect(cardB).toHaveAttribute("data-run-state", "streaming", { timeout: 10_000 });
    await cardA.click();
    // 切换两阶段：loading → ready（快照尾窗重建甲视图）
    await expect(cardA).toHaveAttribute("data-active", "1", { timeout: 10_000 });
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready", { timeout: 10_000 });
    // 甲视图完整：首轮 user + assistant 在场（切换恢复）
    await expect(page.locator(".msg.user", { hasText: A_FIRST })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: "（完E0）" })).toBeVisible();
    await expect(page.locator("#msg-input")).toBeEnabled();
    // 乙后台续跑（数据面判据）：后台卡运行态投影（帧驱动：delta → streaming）
    // → 完成后 idle（list_changed{state_changed} 元数据权威同步）
    await expect(cardB).toHaveAttribute("data-run-state", "streaming", { timeout: 10_000 });
    await expect(cardB).toHaveAttribute("data-run-state", "idle", { timeout: 30_000 });
    await shotEvidence(page, "cl1-multi-background-done", "CL-1");

    // ── ③ 切换恢复：乙尾窗 + per-instance + 向上分页 ───────────
    await cardB.click();
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready", { timeout: 10_000 });
    await expect(cardB).toHaveAttribute("data-active", "1");
    // 后台完成的 turn16 完整可见（切走后照常执行 + 落库 + 切回快照重建）
    await expect(page.locator(".msg.user", { hasText: "乙回合十六的输入" })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: B_SLOW_END })).toBeVisible();
    // 尾窗：16 轮（含 closure 注入轮）> 30 条主时间轴 → 有更早历史
    await expect(page.locator(".load-earlier")).toHaveAttribute("data-state", "more");
    // per-instance 恢复：done 卡（closure 记录随快照重建；running 卡在下方
    // turn17 spawn 后断言）
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 10_000 });
    // 抽屉骨架：done 实例 spawned/模型解析行 + closure 尾卡（per-instance 全流）
    // T4.1：dispatchEvent 代替 click——click 的 scrollIntoViewIfNeeded 会把这张
    // 近顶部卡滚动入视口，msg-flow scrollTop 触 ≤0 时滚动监听（MessageFlow
    // onScroll）自动触发 loadEarlierHistory，在下方手动滚顶分页前把仅剩的
    // 更早页提前载完（pill 提前 exhausted → beforeCount 竞态的真实源头，
    // OI-VER-1/OI-DEV-1④）。抽屉行为断言（开/关/内容）语义不变。
    await page.locator(".sa-card.done").dispatchEvent("click");
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.lc-row[data-lc="spawned"]')).toHaveCount(1);
    await expect(drawer.locator('.lc-row[data-lc="modelResolved"]')).toHaveCount(1);
    await expect(drawer.locator('.closure-card[data-kind="closure"]')).toHaveAttribute("data-status", "done");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await shotEvidence(page, "cl1-multi-switch-restore", "CL-1");

    // turn17：agent_spawn 挂起任务（null 剧本 → running 保持；per-instance 面）
    await e2e.send(page, "乙回合十七的输入");
    await e2e.waitForAssistantText(page, "（完E18）");
    await waitComposerIdle(page);
    await expect(page.locator(".sa-card.running")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".sa-card")).toHaveCount(2); // done + running
    await shotEvidence(page, "cl1-multi-two-sessions", "CL-1");

    // 向上分页：滚顶 → loadHistory（更早历史前插）→ exhausted 禁用
    const flow = page.locator(".msg-flow");
    const msgSel = page.locator(".msg-flow .msg");
    // 时序锚定（T4.1）：捕获与触发间加同步屏障，根治 beforeCount 竞态——
    // 屏障① 分页胶囊就位：load-earlier 渲染条件 = paged（存在更早页），
    //   仅证明可分页，不证明尾窗计数已稳定；先锚定其 data-state=more。
    await expect(page.locator(".load-earlier")).toHaveAttribute("data-state", "more");
    // 屏障② 计数稳定采样：连续两次 poll 采样（间隔 ≥ poll 周期）相等才视为
    //   稳定（复用 harness expect.poll 收敛原语，无裸 sleep）——turn17 落库后
    //   尾窗裁剪/追加的异步 DOM 变动全部落定后，才允许进入捕获。
    let prevCount = -1;
    await expect
      .poll(
        async () => {
          const cur = await msgSel.count();
          const stable = cur > 0 && cur === prevCount;
          prevCount = cur;
          return stable;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    // 屏障③ 捕获即触发：beforeCount 与滚顶在同一 evaluate 内原子完成，
    //   两者之间零间隙（不存在可被异步渲染插入的窗口）。
    const beforeCount = await flow.evaluate((el) => {
      el.scrollTop = 0;
      return el.querySelectorAll(".msg").length;
    });
    // loading 为瞬态（本地 daemon 往返快于轮询——F 层已覆盖），直接断言
    // 结果面：更早历史前插（首条 = 乙首条）→ exhausted 禁用
    await expect(page.locator(".msg-flow .msg").first()).toContainText(B_FIRST, { timeout: 10_000 });
    const afterCount = await page.locator(".msg-flow .msg").count();
    expect(afterCount).toBeGreaterThan(beforeCount);
    await expect(page.locator(".load-earlier")).toHaveAttribute("data-state", "exhausted");
    await shotEvidence(page, "cl1-multi-pagination", "CL-1");

    // ── ④ 删除收口（SubAgent 终态：挂起实例 kill 收口 → 删库）──
    await cardB.locator(".ses-del").click();
    await expect(cardB).toHaveAttribute("data-confirming", "1");
    await cardB.locator("[data-del-confirm]").click();
    // 本地即转草稿（删活跃会话）+ 卡片移除由 list_changed{deleted} 驱动
    await expect(draftCard).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".ses", { hasText: B_FIRST.slice(0, 8) })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".sa-card")).toHaveCount(0); // 乙实例随会话消隐
    await shotEvidence(page, "cl1-multi-deleted", "CL-1");

    // 甲仍可切换恢复（删乙不动甲）
    await cardA.click();
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready", { timeout: 10_000 });
    await expect(page.locator(".msg.user", { hasText: A_FIRST })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: "（完E0）" })).toBeVisible();

    await d.stop();
    writeEvidence(
      "cl1-multi-session",
      "txt",
      [
        "T4.2 CL-1 多会话闭环：PASS",
        "① 草稿建会话: draft 卡 → chat.send{draft:true} → 甲卡出现（title 截断）+ 首轮往返",
        "② 并行两会话: 乙 17 轮（含两次 agent_spawn）+ 慢速末轮流式中切回甲;",
        "   乙后台续跑数据面: 乙卡 runState streaming → idle（list_changed{state_changed} 广播）",
        "③ 切换恢复: 乙尾窗快照（分页胶囊 data-state=more）+ turn17 完整可见 + sa-card done/running",
        "   + 抽屉 spawned/modelResolved/closure 尾卡; 滚顶分页前插（首条 = 乙首条）→ exhausted",
        "④ 删除收口: 挂起 SubAgent 随删 kill 收口 → 乙卡移除 → 转草稿态 → 甲仍可恢复",
      ].join("\n"),
      "CL-1",
    );
  });
});

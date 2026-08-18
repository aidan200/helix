/**
 * T3.2 —— CL-2 monitor 档真链路（真 daemon，E 层；契约 v0.3 §2；AD-2/Q-2b③④；
 * TR-AD-23 / TR-AD-5）。
 *
 * 剧本（各会话独立引擎独立消费队列副本）：
 * ① 甲建会话（e0）→ 乙建会话（e0 副本）→ 乙第二轮 = 慢速流式（≈4s）；
 * ② 流式中切回甲：先升后降（subscribe(甲, full) → 快照 ack →
 *    subscribe(乙, monitor)），乙转后台 monitor 档续跑；
 * ③ monitor 档白名单帧（turn 生命周期 + message_end）真事件流 → 乙卡未读
 *    pill 真实跳动（badge-pop）；流式 delta 被 daemon 过滤不达；后台 turn
 *    完成 → 运行态回 idle；
 * ④ 不串台：甲主区零乙内容；不丢帧：切回乙 → 未读清零 + 后台完成轮全文
 *    可见（快照尾窗重建）。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence } from "./harness/evidence";
import { reply, slowReply, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

test.describe("T3.2 CL-2 monitor 档真链路（真 daemon）", () => {
  test("后台 monitor 档事件流驱动未读真实跳动；切换（瞬时双 full）不丢帧不串台", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl2-monitor-"));
    mkdirSync(path.join(home, "sandbox"), { recursive: true });

    const A_FIRST = "甲会话首条消息";
    const B_FIRST = "乙会话首条消息";
    const B_SLOW_END = "（完乙1）";
    const script: DaemonScript = {
      entries: [
        reply("首轮回复：会话已建立。（完0）"), // e0：甲/乙首轮共用（独立队列副本）
        slowReply(`乙后台长回复：切走后本 turn 继续执行并落库。${"流式占位".repeat(9)}${B_SLOW_END}`, 350, 4), // e1：乙第二轮慢速流式（≈4s 后台续跑载体）
      ],
    };

    const d = await e2e.startDaemon({ script, home });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── ① 甲建会话 → 乙建会话 → 乙第二轮慢速流式 ──
    await page.locator("#btn-new-session").click();
    await e2e.send(page, A_FIRST);
    const cardA = page.locator(".ses", { hasText: A_FIRST.slice(0, 8) });
    await expect(cardA).toHaveCount(1, { timeout: 10_000 });
    await e2e.waitForTurnDone(page, "（完0）");

    await page.locator("#btn-new-session").click();
    await e2e.send(page, B_FIRST);
    const cardB = page.locator(".ses", { hasText: B_FIRST.slice(0, 8) });
    await expect(cardB).toHaveCount(1, { timeout: 10_000 });
    await e2e.waitForTurnDone(page, "（完0）"); // 乙首轮（e0 副本）

    await e2e.send(page, "乙第二轮的输入");
    await expect(cardB).toHaveAttribute("data-run-state", "streaming", { timeout: 10_000 });

    // ── ② 流式中切回甲（先升后降；瞬时双 full 窗口内乙帧不丢）──
    await cardA.click();
    await expect(cardA).toHaveAttribute("data-active", "1", { timeout: 10_000 });
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready", { timeout: 10_000 });

    // ── ③ monitor 档真事件流 → 乙卡未读 pill 真实跳动；完成回 idle ──
    await expect(cardB.locator(".ses-unread")).toBeVisible({ timeout: 30_000 });
    await expect(cardB.locator(".ses-unread.pulse")).toHaveCount(1); // badge-pop
    await expect(cardB).toHaveAttribute("data-run-state", "idle", { timeout: 30_000 });
    const unread = Number(await cardB.locator(".ses-unread").innerText());
    expect(unread).toBeGreaterThan(0); // message_end/turn 帧收帧计数（真 daemon 过滤后白名单帧）
    await shotEvidence(page, "cl2-monitor-background-unread", "CL-2");

    // ── ④ 不串台（甲主区零乙内容）+ 不丢帧（切回乙全文可见、未读清零）──
    await expect(page.locator(".msg.assistant", { hasText: B_SLOW_END })).toHaveCount(0);
    await cardB.click();
    await expect(page.locator(".app")).toHaveAttribute("data-view", "ready", { timeout: 10_000 });
    await expect(cardB).toHaveAttribute("data-active", "1");
    await expect(cardB).toHaveAttribute("data-unread", "0");
    await expect(cardB.locator(".ses-unread")).toHaveCount(0);
    await expect(page.locator(".msg.user", { hasText: "乙第二轮的输入" })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: B_SLOW_END })).toBeVisible();
    await shotEvidence(page, "cl2-monitor-switch-back-intact", "CL-2");

    await d.stop();
  });
});

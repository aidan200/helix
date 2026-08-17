/**
 * T5.1 —— CL-1 切换快照盖章回归（真 daemon，E 层；AD-2/AD-4；RCA
 * debug/session-switch-state-overwrite-root-cause.md）。
 *
 * 场景：A 流式中切到 idle 热会话 B——原 bug（快照 agentState/model 经
 * system.getStatus() 全局最近活跃投影盖章）下 B 的视图会盖上 A 的章。
 *
 * 三面断言（切换瞬间，A 仍后台流式）：
 * ① B 活跃卡运行徽标 = idle（B 自身状态，非 A 的 streaming）；
 * ② 顶栏模型徽标 = B 的 per-session 模型（fake/model，非 A 切过的 TARGET）；
 * ③ A 后台卡运行徽标 = streaming（A 真实状态不被误改）。
 * 辅助面：切换前 A 活跃时徽标 = TARGET（per-session 模型区分成立——②的
 * 非平凡前提）；A 后台续跑完成 → A 卡 runState 回落 idle（数据面）。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { reply, slowReply, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const TARGET = "anthropic/claude-haiku-4-5"; // A 切换后的 per-session 模型
const A_FIRST = "甲会话首条消息";
const B_FIRST = "乙会话首条消息";
const A_SECOND = "甲回合二的输入";
const A_SLOW = `甲后台长回复：切换后本 turn 继续执行。${"流式占位".repeat(70)}（完S1）`;

/** 通用前置：建 home+沙箱；预置 anthropic 凭据（T5.3 菜单可用性口径——
 *  provider 未配置的模型不在 P-3 菜单显示，TARGET 所属 anthropic 需已配）。 */
function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl1-stamp-"));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "sk-e2e-seed-stamp" } }),
    { mode: 0o600 },
  );
  return home;
}

test.describe("T5.1 CL-1 切换快照盖章回归（真 daemon）", () => {
  test("A 流式中切到 idle 热会话 B：B 卡=idle + 模型徽标=B 模型 + A 卡=streaming", async ({ e2e, page }) => {
    test.setTimeout(120_000);
    const home = prepHome();
    // 每会话独立引擎独立消费队列副本：A 消费 e0（首轮）+ e1（慢速轮）；
    // B 仅消费 e0
    const script: DaemonScript = {
      entries: [
        reply("首条回复：会话已建立。（完S0）"), // e0：A/B 首轮共用
        slowReply(A_SLOW, 100, 4), // e1：A 慢速轮（≈7s 流式窗口）
      ],
    };
    // 死代理：模型菜单目录刷新快失 → builtin fallback（K-1 同形，零外网）
    const deadProxy = { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };

    const d = await e2e.startDaemon({ script, home, env: deadProxy });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    const badge = page.locator("[data-model-badge]");
    const app = page.locator(".app");

    // ── A 建会话 + 首轮 + per-session 切模型 ─────────────────
    await page.locator("#btn-new-session").click();
    const draftCard = page.locator('[data-session-card="draft"]');
    await expect(draftCard).toBeVisible();
    await e2e.send(page, A_FIRST);
    await expect(draftCard).toHaveCount(0);
    const cardA = page.locator(".ses", { hasText: A_FIRST.slice(0, 8) });
    await expect(cardA).toHaveCount(1, { timeout: 10_000 });
    await expect(cardA).toHaveAttribute("data-active", "1");
    await e2e.waitForTurnDone(page, "（完S0）");
    // A 切模型（下一 turn 生效；徽标即时更新 = model.changed 广播）
    await badge.click();
    const menu = page.locator(".model-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(`[data-model-item="${TARGET}"]`)).toBeVisible({ timeout: 15_000 });
    await menu.locator(`[data-model-item="${TARGET}"]`).click();
    await expect(badge).toHaveText(TARGET, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // ── B 建会话 + 首轮（B 模型 = 默认 fake/model）───────────
    await page.locator("#btn-new-session").click();
    await expect(draftCard).toBeVisible();
    await e2e.send(page, B_FIRST);
    await expect(draftCard).toHaveCount(0);
    const cardB = page.locator(".ses", { hasText: B_FIRST.slice(0, 8) });
    await expect(cardB).toHaveCount(1, { timeout: 10_000 });
    await expect(cardB).toHaveAttribute("data-active", "1");
    await expect(cardA).not.toHaveAttribute("data-active");
    await e2e.waitForTurnDone(page, "（完S0）");
    await expect(badge).toHaveText("fake/model"); // B 自身模型徽标

    // ── 切回 A → 发慢速轮 → A 流式中 ─────────────────────────
    await cardA.click();
    await expect(app).toHaveAttribute("data-view", "ready", { timeout: 10_000 });
    await expect(badge).toHaveText(TARGET); // per-session 区分成立（②的非平凡前提）
    await e2e.send(page, A_SECOND);
    await expect(cardA).toHaveAttribute("data-run-state", "streaming", { timeout: 10_000 });

    // ── A 流式中切到 idle 热会话 B：三面断言 ──────────────────
    await cardB.click();
    await expect(cardB).toHaveAttribute("data-active", "1", { timeout: 10_000 });
    await expect(app).toHaveAttribute("data-view", "ready", { timeout: 10_000 });
    await expect(page.locator(".msg.user", { hasText: B_FIRST })).toBeVisible(); // B 视图本体正确
    await expect(cardB).toHaveAttribute("data-run-state", "idle"); // ① B 活跃卡 = B 自身态
    await expect(badge).toHaveText("fake/model"); // ② 顶栏模型徽标 = B 的模型
    await expect(cardA).toHaveAttribute("data-run-state", "streaming"); // ③ A 后台卡 = 流式中
    await shotEvidence(page, "cl1-switch-stamp-three-faces", "CL-1");

    // ── 数据面：A 后台续跑完成 → A 卡回落 idle ────────────────
    await expect(cardA).toHaveAttribute("data-run-state", "idle", { timeout: 30_000 });
    await shotEvidence(page, "cl1-switch-stamp-background-done", "CL-1");

    await d.stop();
    writeEvidence(
      "cl1-switch-state-stamp",
      "txt",
      [
        "T5.1 CL-1 切换快照盖章回归：PASS",
        "A 流式中切到 idle 热会话 B（切换瞬间三面）：",
        "① B 活跃卡 data-run-state=idle（B 自身态，非 A 的 streaming）",
        "② 顶栏模型徽标=fake/model（B 的 per-session 模型，非 A 的 TARGET）",
        "③ A 后台卡 data-run-state=streaming（A 真实状态）",
        "辅助：A 活跃时徽标=TARGET（per-session 区分前提）；A 后台续跑完成回落 idle",
      ].join("\n"),
      "CL-1",
    );
  });
});

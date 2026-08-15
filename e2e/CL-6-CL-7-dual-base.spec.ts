/**
 * TC3.4 —— TP-CL6-7 / F(6).3 标准 2（AD-8 开发/打包双形态零迁移）：
 * 同一关键路径双基址参数化一致——
 * - 基线 A：vite dev（http://127.0.0.1:5210，源码直跑，直连 daemon WS）；
 * - 基线 B：daemon static serve（http://127.0.0.1:5333，globalSetup 以
 *   VITE_HELIX_PORT=5333 构建的 apps/shell/dist——构建输出非生产源码）。
 *
 * 关键路径：连接成功（真 dev-token + 真 WS 握手）→ 消息往返（流式回复）
 * → 工具卡一例（read 真实执行）。双基线收集行为指纹并断言一致。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { replyFromResult, slowReply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import type { DaemonProcess } from "./harness/daemon-fixture";

const READ_MARKER = "HELIX-DUAL-BASE-READ-42";
const USER_TEXT = "读取 note.txt 并复述内容";

const script: DaemonScript = {
  entries: [
    toolCall("read", { path: "note.txt" }),
    replyFromResult("读取到的内容是：{last}", { chunkSize: 8, chunkDelayMs: 30 }),
  ],
};

interface BehaviorFingerprint {
  origin: string;
  connected: boolean;
  wsHandshake: boolean; // welcome 后 data-conn=connected（真 WS 握手 + token 通过）
  userBubble: boolean;
  assistantReply: string;
  toolCardCount: number;
  toolCardState: string;
  toolResultSnippet: string;
}

async function runCriticalPath(
  page: Page,
  daemon: DaemonProcess,
  origin: string,
): Promise<BehaviorFingerprint> {
  await page.goto(origin + "/");
  await expect(page.locator(".app")).toBeVisible();

  // 连接成功：真 token 端点 + 真 WS（welcome + snapshot → connected）
  await expect
    .poll(() => page.locator(".app").getAttribute("data-conn"), { timeout: 15_000 })
    .toBe("connected");

  // 消息往返 + 工具卡一例
  const input = page.locator("#msg-input");
  await input.fill(USER_TEXT);
  await input.press("Enter");
  await expect(page.locator(".msg.user", { hasText: USER_TEXT })).toBeVisible();
  const card = page.locator(".tool-card").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".t-name")).toHaveText("read");
  await expect(card).toHaveClass(/done/, { timeout: 10_000 });
  await card.locator(".t-head").click();
  const resultText = (await card.locator(".t-section").nth(1).locator(".t-pre").textContent()) ?? "";
  await expect(page.locator(".msg.assistant .md-body", { hasText: READ_MARKER })).toBeVisible({
    timeout: 15_000,
  });
  const reply = (await page.locator(".msg.assistant .md-body").last().textContent()) ?? "";

  return {
    origin,
    connected: true,
    wsHandshake: true,
    userBubble: true,
    assistantReply: reply.trim(),
    toolCardCount: await page.locator(".tool-card").count(),
    toolCardState: "done",
    toolResultSnippet: resultText.trim().slice(0, 80),
  };
}

test.describe("TC3.4 CL-6×CL-7 双基线一致（vite dev 直连 / daemon static serve）", () => {
  test("同一关键路径在双基址行为一致：连接 + 消息往返 + 工具卡一例", async ({ e2e, page }) => {
    test.setTimeout(120_000);
    const fingerprints: BehaviorFingerprint[] = [];

    // ── 基线 A：vite dev（源码直跑） ───────────────────────────
    {
      const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-dual-a-"));
      const sandbox = path.join(home, "sandbox");
      mkdirSync(sandbox, { recursive: true });
      writeFileSync(path.join(sandbox, "note.txt"), `双基线夹具\n${READ_MARKER} 内容\n`, "utf8");
      const daemon = await e2e.startDaemon({ script, home });
      expect(daemon.port).toBe(e2e.daemonPort);
      fingerprints.push(await runCriticalPath(page, daemon, e2e.viteBase));
      await shotEvidence(page, "dual-base", "CL-6-CL-7");
      await daemon.stop();
    }

    // ── 基线 B：daemon static serve（dist 构建产物） ───────────
    {
      const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-dual-b-"));
      const sandbox = path.join(home, "sandbox");
      mkdirSync(sandbox, { recursive: true });
      writeFileSync(path.join(sandbox, "note.txt"), `双基线夹具\n${READ_MARKER} 内容\n`, "utf8");
      const daemon = await e2e.startDaemon({ script, home, staticDir: e2e.shellDist });
      // static serve 激活：基线 B 页面由 daemon 自己提供
      const resp = await page.request.get(e2e.daemonBase + "/");
      expect(resp.status()).toBe(200);
      expect(await resp.text()).toContain("<div id=\"root\">");
      fingerprints.push(await runCriticalPath(page, daemon, e2e.daemonBase));
      await shotEvidence(page, "dual-base", "CL-6-CL-7");
      await daemon.stop();
    }

    // ── 双基线一致断言（行为指纹逐字段相等） ───────────────────
    const [a, b] = fingerprints;
    expect(a!.connected).toBe(true);
    expect(b!.connected).toBe(true);
    expect(a!.wsHandshake).toBe(b!.wsHandshake);
    expect(a!.userBubble).toBe(b!.userBubble);
    expect(a!.assistantReply).toBe(b!.assistantReply); // 同剧本同回复
    expect(a!.toolCardCount).toBe(b!.toolCardCount);
    expect(b!.toolCardCount).toBe(1);
    expect(a!.toolCardState).toBe(b!.toolCardState);
    // 工具卡结果同为真实执行输出（同一沙箱夹具文件内容）
    expect(a!.toolResultSnippet).toBe(b!.toolResultSnippet);
    expect(a!.toolResultSnippet).toContain(READ_MARKER);

    writeEvidence(
      "dual-base",
      "txt",
      [
        "TC3.4 CL-6×CL-7 双基线一致（TP-CL6-7 / F(6).3 标准 2）",
        `基线 A vite dev: ${a!.origin} → connected=${a!.connected} 卡=${a!.toolCardCount} 状态=${a!.toolCardState}`,
        `基线 B static serve: ${b!.origin} → connected=${b!.connected} 卡=${b!.toolCardCount} 状态=${b!.toolCardState}`,
        `回复一致: ${JSON.stringify(a!.assistantReply)}`,
        `工具结果片段一致: ${JSON.stringify(a!.toolResultSnippet)}`,
        "结果: PASS（双基线行为指纹一致）",
      ].join("\n"),
      "CL-6-CL-7",
    );
  });
});

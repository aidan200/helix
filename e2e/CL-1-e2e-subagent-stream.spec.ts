/**
 * T4.2 —— CL-1 SubAgent message_update 流式真供给（真 daemon，E 层）。
 *
 * 撤 OI-3 同款假信心模式：E 层既有剧本的 SubAgent 均为进程内 Scripted Runner
 * （closure 定时器，无消息流）——SubAgent 消息的流式供给从未在真链路上验
 * 过。本 spec 用真子进程（SubagentLauncher + ChildMain + FakeEngineScript）：
 * agent_spawn → detached 子进程真实 spawn → K3 剧本引擎逐片流出 →
 * transport 事件行上行 → SchedulerService message_update → publishDelta →
 * chat.stream.delta(instanceId) → 抽屉 live 气泡渐进增长（无任何 mock 推帧）。
 *
 * 断言链：①真子进程在场（ps 特征）②抽屉 live 气泡 data-streaming=1 且文本
 * **渐进增长**（两次读取长度递增——逐片 delta 到达的机械判据）③流式完成
 * → live 槽清空 + channel 消息定稿（全文含 closure 协议块原文）④子进程
 * closure 解析 done → 卡片终态 + closure 尾卡 + 主线注入。
 */
import { test, expect } from "./harness/daemon-fixture";
import { findResidueProcesses } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { reply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const TASK = "流式供给验证任务";
/** 真子进程流式正文：长文本 + closure 协议块（120ms/4 字符 ≈ 5s 流式窗）。 */
const SA_TEXT =
  "真子进程流式供给正文：" +
  "子进程 K3 剧本引擎逐片流出，经 transport 事件行上行、SchedulerService " +
    "message_update 转发、publishDelta 广播，最终以 chat.stream.delta(instanceId) " +
  "到达前端实例通道——全程无 mock 推帧。".repeat(2) +
  '\n<<<CLOSURE\n{"status":"done","summary":"流式供给验证完成","reportPath":null,"findings":[],"taskId":null}\nCLOSURE>>>';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 通用前置：建 home+沙箱。 */
function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl1-sa-stream-"));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

test.describe("T4.2 CL-1 SubAgent message_update 流式真供给（真子进程）", () => {
  test("真子进程流式：live 气泡渐进增长 → 定稿全文 → closure done 注入主线", async ({ e2e, page }) => {
    test.setTimeout(150_000);
    const home = prepHome();
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: TASK }), // turn1：spawn 真子进程
        reply("主线已派出流式验证实例。（完S1）"), // turn1 续写
        reply("closure 注入自动轮收口。（完C）"), // closure 注入自动轮
      ],
    };

    const d = await e2e.startDaemon({ script, home, realSubagent: { engineScript: { replies: [SA_TEXT], chunkDelayMs: 120 } } });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 派发：spawn → 主线续写收口（消息级等待——running 卡自带 cursor）──
    await e2e.send(page, "派出流式验证 SubAgent");
    await e2e.waitForAssistantText(page, "（完S1）", 30_000);
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    const card = page.locator(".sa-card.running");
    await expect(card).toHaveCount(1, { timeout: 10_000 });

    // ── ① 真子进程在场（ps 特征扫描——非 mock 的物理证据）──────
    let childPid = -1;
    for (let i = 0; i < 100 && childPid < 0; i++) {
      const hit = findResidueProcesses().find((p) => p.command.includes("ChildMain.ts"));
      if (hit) childPid = hit.pid;
      else await sleep(100);
    }
    expect(childPid).toBeGreaterThan(0);

    // ── ② 抽屉 live 气泡：真流式 delta 渐进增长 ────────────────
    await card.click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    const live = drawer.locator('.ch-msg[data-kind="ch-message"][data-streaming="1"]');
    await expect(live).toBeVisible({ timeout: 15_000 });
    await expect(live.locator(".bubble")).toContainText("真子进程流式供给正文", { timeout: 15_000 });
    const len1 = (await live.locator(".bubble").innerText()).length;
    await sleep(700);
    const len2 = (await live.locator(".bubble").innerText()).length;
    expect(len2, `live 气泡应渐进增长（${len1} → ${len2}）`).toBeGreaterThan(len1);
    const len3 = (await live.locator(".bubble").innerText()).length;
    expect(len3).toBeGreaterThanOrEqual(len2); // 持续到达（非一次推齐）
    await shotEvidence(page, "cl1-sa-stream-live", "CL-1");
    writeEvidence(
      "cl1-sa-stream-growth",
      "txt",
      [
        "live 气泡渐进增长（真子进程 message_update 逐片到达）：",
        `t0 长度 ${len1} → +700ms ${len2} → 再读 ${len3}（单调不减且严格增长）`,
      ].join("\n"),
      "CL-1",
    );

    // ── ③ 流式完成：live 槽清空 + channel 消息定稿（全文）──────
    const finalMsg = drawer.locator('.ch-msg[data-kind="ch-message"]').filter({ hasNot: live });
    await expect(live).toHaveCount(0, { timeout: 30_000 }); // 流式槽收口
    const settled = drawer.locator('.ch-msg[data-kind="ch-message"]');
    await expect(settled).toHaveCount(1, { timeout: 30_000 });
    await expect(settled.locator(".bubble")).toContainText("全程无 mock 推帧");
    await expect(settled.locator(".bubble")).toContainText("<<<CLOSURE"); // closure 协议块原文透传

    // ── ④ closure done：卡片终态 + 尾卡 + 主线注入 ─────────────
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 30_000 });
    await expect(drawer.locator('.closure-card[data-kind="closure"]')).toHaveAttribute("data-status", "done");
    await expect(drawer.locator(".cl-summary")).toContainText("流式供给验证完成");
    // 主线注入（closure → SteerQueue → 自动轮消耗 e2）
    await expect(page.locator(".msg.assistant", { hasText: "（完C）" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    await shotEvidence(page, "cl1-sa-stream-done", "CL-1");

    await d.stop();
    writeEvidence(
      "cl1-sa-stream",
      "txt",
      [
        "T4.2 CL-1 SubAgent message_update 流式真供给：PASS",
        `① 真子进程在场: ps 命中 ChildMain.ts（pid=${childPid}）`,
        `② live 气泡渐进增长: ${len1} → ${len2} → ${len3}（chat.stream.delta(instanceId) 逐片到达）`,
        "③ 定稿: live 槽清空 + channel 消息全文（含 <<<CLOSURE 协议块原文）",
        "④ closure done: 卡片终态 + 尾卡 + 主线注入自动轮（（完C））",
        "链路: ChildMain(K3 剧本) → transport 事件行 → SchedulerService message_update",
        "  → publishDelta → chat.stream.delta(instanceId) → channelStreams（零 mock 推帧）",
      ].join("\n"),
      "CL-1",
    );
  });
});

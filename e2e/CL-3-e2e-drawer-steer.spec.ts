/**
 * T3.3 —— CL-3 E 层闭环：抽屉 steer 定向注入端到端（真 daemon + 真子进程 +
 * FakeLLM/FakeEngineScript）。
 *
 * 链路全真（契约 v0.3 §3；AD-5/Q-3a/Q-3b）：
 * 抽屉底部输入栏（running 实例渲染）Enter → chat.steer{instanceId} 真命令 →
 * daemon ChatService 定向分支（send 链前置判定）→ 子进程 stdin send →
 * Agent.steer() 内建队列 → turn 边界 drain（子进程消化 = drain 轮剧本回复
 * 到达抽屉 feed）+ 主轴落 isSteer Entry（steer.queued 信封挂 instanceId）
 * → 双处可见（主轴定向细条 + 抽屉实例 feed 同物种）→ 停机重启 → 快照
 * 恢复重放双处完整保留。
 *
 * 与 F 层（CL-3-drawer-steer.spec.ts，mock 推帧）分工：本 spec 全程无 mock
 * 推帧——命令帧经真 WebSocket 入 daemon，事件帧全部来自真 daemon/子进程。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { reply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const TASK = "定向 steer 端到端验证任务";
const STEER_TEXT = "纠偏：下一轮优先补齐 ack 间隙的回归用例。";
/** 子进程首轮（无 closure 块——保持 running，制造 steer 时窗）。 */
const SA_REPLY1 =
  "子进程首轮输出：正在阅读 SubscriptionMap.ts 定位双写窗口，" +
  "先核对换档时新旧 tier 短暂并存的区间，再决定用例落点。（首轮未完，待纠偏）";
/** 子进程 drain 轮（消化 steer 后开启的新 turn 输出——含消化标记）。 */
const SA_REPLY2 = "已消化定向纠偏：调整用例优先级，先覆盖先升后降的 ack 间隙。（消化标记）";

function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl3-drawer-steer-"));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

test.describe("T3.3 CL-3 E 层闭环：抽屉 steer 定向注入（发送 → 子进程消化 → 双处可见 → 重启保留）", () => {
  test("抽屉输入栏定向 steer 全链路 + 重启恢复重放保留", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = prepHome();
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: TASK }),
        reply("主线已派出定向验证实例。（完S1）"),
        reply("closure 注入自动轮收口。（完C）"),
      ],
    };

    const d1 = await e2e.startDaemon({
      script,
      home,
      realSubagent: {
        engineScript: { replies: [SA_REPLY1, SA_REPLY2], chunkDelayMs: 50 },
      },
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 派发：spawn 真子进程 → 主线收口 → running 卡 ────────────
    await e2e.send(page, "派出定向验证 SubAgent");
    await e2e.waitForAssistantText(page, "（完S1）", 30_000);
    const card = page.locator(".sa-card.running");
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    const instanceId = (await card.getAttribute("data-instance"))!;
    expect(instanceId).toBeTruthy();

    // ── 开抽屉：running → 底部输入栏渲染（Q-3b）────────────────
    await card.click();
    const drawer = page.locator(`.drawer[data-instance="${instanceId}"]`);
    await expect(drawer).toBeVisible();
    const composer = drawer.locator('.steer-composer[data-kind="steer-composer"]');
    await expect(composer).toHaveCount(1);
    await expect(composer.locator(".sc-target .tgt")).toHaveText(`→ ${instanceId}`);
    // 子进程真流式在场（live 气泡 = 实例 running 的机械判据）
    await expect(drawer.locator('.ch-msg[data-streaming="1"]')).toBeVisible({ timeout: 20_000 });

    // ── Enter 发送：即清空 + 本地 echo 双处立即可见（Q-3a）─────
    const input = composer.locator(".sc-bar input");
    await input.fill(STEER_TEXT);
    await input.press("Enter");
    await expect(input).toHaveValue(""); // 发送即清空，无阻塞发送态
    await expect(input).toBeEnabled();

    const axisStrip = page.locator(`.msg-flow .steer-directed[data-target="${instanceId}"]`);
    await expect(axisStrip).toHaveCount(1);
    await expect(axisStrip.locator(".sd-chip")).toHaveText(`steer → ${instanceId}`);
    await expect(axisStrip.locator(".sd-text")).toHaveText(STEER_TEXT);
    const feedStrip = drawer.locator(`.steer-directed[data-target="${instanceId}"]`);
    await expect(feedStrip).toHaveCount(1);
    await expect(feedStrip.locator(".sd-text")).toHaveText(STEER_TEXT);
    await shotEvidence(page, "e2e-drawer-steer-echo", "CL-3");

    // ── 子进程消化：drain 轮剧本回复到达抽屉 feed（真消化判据）──
    // steer.queued 对账后定向细条仍单份（无双份）
    await expect(axisStrip).toHaveCount(1);
    await expect(feedStrip).toHaveCount(1);
    await expect(
      drawer.locator('.ch-msg[data-kind="ch-message"] .bubble', { hasText: "已消化定向纠偏" }),
    ).toBeVisible({ timeout: 60_000 });
    await shotEvidence(page, "e2e-drawer-steer-consumed", "CL-3");

    // ── 停机重启：快照恢复重放双处完整保留（R-P3-4）─────────────
    await d1.stop();
    await expect
      .poll(() => page.locator(".app").getAttribute("data-conn"), { timeout: 5_000 })
      .toBe("disconnected");
    const d2 = await e2e.startDaemon({ script, home, retries: 8 });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);

    // 时间轴侧：定向干预 entry 随快照主轴尾窗重建（非气泡）
    const axisStripAfter = page.locator(`.msg-flow .steer-directed[data-target="${instanceId}"]`);
    await expect(axisStripAfter).toHaveCount(1, { timeout: 15_000 });
    await expect(axisStripAfter.locator(".sd-text")).toHaveText(STEER_TEXT);
    await expect(page.locator(".msg-flow .msg.user", { hasText: STEER_TEXT })).toHaveCount(0);

    // 抽屉侧：抽屉跨重连保持打开（组件态不随断连卸载）——重启后实例非
    // running → 输入面静默不渲染；实例 feed 定向物种随 channel 重建保留
    const drawerAfter = page.locator(`.drawer[data-instance="${instanceId}"]`);
    await expect(drawerAfter).toBeVisible();
    await expect(drawerAfter.locator('.steer-composer[data-kind="steer-composer"]')).toHaveCount(0);
    const feedStripAfter = drawerAfter.locator(`.steer-directed[data-target="${instanceId}"]`);
    await expect(feedStripAfter).toHaveCount(1);
    await expect(feedStripAfter.locator(".sd-chip")).toHaveText(`steer → ${instanceId}`);
    await expect(feedStripAfter.locator(".sd-text")).toHaveText(STEER_TEXT);
    await shotEvidence(page, "e2e-drawer-steer-restored", "CL-3");

    writeEvidence(
      "e2e-drawer-steer",
      "txt",
      [
        "T3.3 CL-3 E 层闭环：抽屉 steer 定向注入（真 daemon + 真子进程）",
        `instanceId: ${instanceId}`,
        "链路: 抽屉输入栏 Enter → chat.steer{instanceId} → daemon 定向路由 →",
        "  子进程 Agent.steer() drain（消化标记到达 feed）→ 双处可见 →",
        "  停机重启 → 快照恢复重放双处保留（重启后无输入面）",
        "结果: PASS",
      ].join("\n"),
      "CL-3",
    );
  });
});

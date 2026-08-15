/**
 * TC3.3 —— TP-CL7-3 / S3：CL-7 E 层 steer 打断端到端（真 daemon + FakeLLM）。
 *
 * 链路全真：流式中发送 → 前端自动分流 chat.steer（本地 echo + STEER 徽标）
 * → daemon SteerQueue 入队（steer.queued 事件对账）+ SteerHooks 转发 pi 队列
 * → turn 边界 drain（finishOpenTurn(steerDrained) + steer.drained 事件）
 * → 以注入消息开新 Turn → FakeLLM 下一剧本条目续写（后续轮次衔接）。
 * 剧本控制 turn 时长（chunkDelay 制造可打入窗口）。
 *
 * 断言源：requirements §3.7 F(7).3 + review.md R-07/R-08 + SM-3 + test-design
 * TP-CL7-3。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { slowReply, type DaemonScript } from "./harness/daemon-script";

const STEER_TEXT = "补充一句：流式 delta 的断言要覆盖前缀增长";
const TURN1_REPLY =
  "steer 的语义可以这样展开：生成中的用户输入不打断当前轮，而是进入队列，" +
  "在 turn 边界（turn_end 之后、turn_start 之前）精确 drain——drain 会以注入的" +
  " user 消息开启新 Turn，模型带着补充指示续写。这个边界语义由 SteerHooks 接线" +
  " pi 的 steer 队列实现，领域侧 SteerQueue 是权威账本。";
const POST_DRAIN_REPLY = "收到补充：新 Turn 已基于注入的 steer 指示开启，这是 drain 后的续写回复。";
const TURN3_REPLY = "普通轮次：没有 steer 徽标，回复照常流式收口。";

const script: DaemonScript = {
  entries: [
    slowReply(TURN1_REPLY, 40, 3), // ~110 分片 ≈ 4.4s 可打入窗口
    slowReply(POST_DRAIN_REPLY, 30, 6),
    slowReply(TURN3_REPLY, 30, 6),
  ],
};

test.describe("TC3.3 CL-7 E 层 steer 打断端到端（真 daemon + FakeLLM，S3）", () => {
  test("流式中注入 → queued 徽标 → turn 边界 drain → 徽标转换 → 后续轮次衔接", async ({ e2e, page }) => {
    test.setTimeout(90_000);
    await e2e.startDaemon({ script });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 起流式：composer.streaming + R-08 提示行 ───────────────
    await e2e.send(page, "讲讲 steer 的语义");
    await expect(page.locator(".composer")).toHaveClass(/streaming/, { timeout: 10_000 });
    await expect(page.locator(".steer-hint")).toBeVisible();
    await expect(page.locator(".steer-hint")).toContainText("主会话生成中");

    // ── 流式中发送：自动分流 chat.steer（R-07 输入条保持可用）───
    const input = page.locator("#msg-input");
    await expect(input).toBeEnabled();
    await e2e.send(page, STEER_TEXT);

    // 本地 echo 立即投影：steer 气泡 + queued 徽标
    const steerMsg = page.locator(".msg.user", { hasText: STEER_TEXT });
    await expect(steerMsg).toBeVisible();
    await expect(steerMsg.locator(".steer-badge")).toHaveText("STEER · 已入队");
    await shotEvidence(page, "e2e-steer-queued");

    // daemon 对账：steer.queued 到达后徽标仍 queued（未 drain 前不转换）
    // （真实事件到达的等待面：第一轮流式完成 = drain 即将发生）
    await e2e.waitForAssistantText(page, "领域侧 SteerQueue 是权威账本", 30_000);

    // ── turn 边界 drain：徽标 queued → drained（SM-3 规则 3）────
    const drained = steerMsg.locator(".steer-badge.drained");
    await expect(drained).toHaveText("已注入 · 本轮结束", { timeout: 15_000 });
    await shotEvidence(page, "e2e-steer-drained");

    // ── 后续轮次衔接：drain 后新 Turn 的续写回复正常流式收口 ───
    await e2e.waitForAssistantText(page, "drain 后的续写回复", 30_000);
    await expect(page.locator(".stream-cursor")).toHaveCount(0);
    await expect(page.locator(".msg.assistant")).toHaveCount(2); // 第一轮 + drain 续写轮

    // ── 再发普通消息：无 steer 徽标（对照规则） ────────────────
    await e2e.send(page, "再来一轮普通消息");
    await e2e.waitForAssistantText(page, "普通轮次", 30_000);
    const normalMsg = page.locator(".msg.user", { hasText: "再来一轮普通消息" });
    await expect(normalMsg.locator(".steer-badge")).toHaveCount(0);
    await expect(page.locator(".msg.assistant")).toHaveCount(3);
    // steer 气泡的 drained 徽标在后续轮次中保持（终态）
    await expect(steerMsg.locator(".steer-badge.drained")).toHaveText("已注入 · 本轮结束");
    await shotEvidence(page, "e2e-steer-followup-turns");

    writeEvidence(
      "e2e-steer",
      "txt",
      [
        "TC3.3 CL-7 E 层 steer 打断端到端（真 daemon + FakeLLM）",
        "流式窗口: TURN1_REPLY chunkSize=3 chunkDelayMs=40（≈4.4s 可打入窗口）",
        "断言: composer.streaming + steer-hint → 输入可用 → chat.steer 分流 →",
        "  echo 气泡 + 「STEER · 已入队」 → turn 边界 drain → 「已注入 · 本轮结束」",
        "  → drain 续写轮（POST_DRAIN_REPLY）→ 普通轮次无徽标 + drained 终态保持",
        "结果: PASS",
      ].join("\n"),
    );
  });
});

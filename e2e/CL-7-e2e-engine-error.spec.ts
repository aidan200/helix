/**
 * 终验热修 —— engine.error 透传链路（真 daemon + FakeLLM error 剧本 + 真 WS）。
 *
 * 修复前缺陷（用户首次真实 LLM 联调暴露，429 限额场景）：pi-ai 将 provider
 * 失败规范化为流内 error 帧（不抛异常）→ helix 四层全断（adapter 无 error
 * 分类 / 协议无 engine.error / reducer 无 case / UI 无卡片）→ 静默无响应
 * （零 usage + reason=completed 假完成）。
 *
 * 本 spec 断言修复后的完整链路：
 * ① error 剧本帧 → agentLoop 收口 stopReason=error → adapter engine_error；
 * ② ChatService → engine.error 领域事件 → DtoMapper 下发 engine.error 帧；
 * ③ 前端 reducer → state.engineError → 聊天流错误卡片可见（provider 原文）；
 * ④ 会话不崩：turn 收口、agentState 回 idle、零值 usage 不入账、下一轮正常。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { errorReply, slowReply, type DaemonScript } from "./harness/daemon-script";

// P2 ⑦ 网络重试批：429 现属瞬时类（会触发引擎级退避重试，剧本会被重试
// 消费），本 spec 验证的是错误透传链路非限流语义——改用永久类 401 鉴权
// 错误保首帧即失败（透传链路断言面不变）。
const ERROR_TEXT = "401: {\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}";
const ERROR_FRAGMENT = "invalid x-api-key";

const script: DaemonScript = {
  entries: [
    errorReply(ERROR_TEXT), // 第一轮：provider 失败
    slowReply("已恢复，这是重试后的正常回复", 30, 6), // 第二轮：恢复（错误卡清除 + 正常链路）
  ],
};

test.describe("终验热修 engine.error 透传（真 daemon + FakeLLM）", () => {
  test("provider 失败 → 错误卡片可见 + 原文透传 + 会话不崩 + 下一轮恢复", async ({ e2e, page }) => {
    test.setTimeout(90_000);
    await e2e.startDaemon({ script });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 第一轮：provider 失败 ──────────────────────────────
    await e2e.send(page, "第一轮：触发限额");

    // 错误卡片出现：标题 + provider 原文（领域数据透传）
    const card = page.locator(".engine-error-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveAttribute("role", "alert");
    await expect(card.locator(".ee-title, .ee-head")).toContainText("生成失败");
    await expect(card.locator(".ee-body")).toContainText(ERROR_FRAGMENT);

    // 会话不崩：生成中状态收口（composer 恢复可发送 = agentState 回 idle）
    await expect(page.locator("#msg-input")).toBeEnabled({ timeout: 15_000 });

    // 无假完成：失败轮不产 assistant 气泡（error 消息空 content 不投影）
    await expect(page.locator(".msg.assistant:not(.streaming)")).toHaveCount(0);

    // ── 第二轮：恢复（错误转正为原位红条常驻 + 正常流式链路回归）──────
    // error entry 批（f9d9254）：瞬态卡在 error.entry 帧到达即清除，同一错误
    // 转正为时间轴原位红条（落盘条目，刷新/后续轮次不消失——同一 DOM 类名
    // .engine-error-card 复用红系视觉）；新轮 turn.started 只清瞬态兜底。
    await e2e.send(page, "第二轮：重试");
    const reply = page.locator(".msg.assistant:not(.streaming)").last();
    await expect(reply).toContainText("已恢复，这是重试后的正常回复", { timeout: 20_000 });
    // 原位红条常驻（历史面）：第一轮失败条目仍在时间轴原位（非瞬态未清）
    await expect(page.locator(".engine-error-card")).toHaveCount(1);
    await expect(page.locator(".engine-error-card .ee-body")).toContainText(ERROR_FRAGMENT);
    await expect(page.locator("#msg-input")).toBeEnabled({ timeout: 15_000 });

    await shotEvidence(page, "e2e-engine-error-recovered");
    writeEvidence(
      "e2e-engine-error",
      "txt",
      [
        "终验热修 engine.error 透传链路（真 daemon + FakeLLM error 剧本 + 真 WS）",
        "断言: 流内 error 帧→错误卡（原文透传+重试 hint）/error entry 批原位红条常驻/",
        "  retry 后正常回复",
        "结果: PASS",
      ].join("\n"),
    );
  });

  // ── P2 ⑦ 网络重试批：瞬时错误 → 引擎级退避重试 → 恢复（等待可见）──
  test("瞬时网络错误 → 重试状态卡可见（第 N/3 次）→ 等待后自动恢复（零用户动作）", async ({ e2e, page }) => {
    test.setTimeout(120_000); // 首次退避 10s 为真实等待
    await e2e.startDaemon({
      script: {
        entries: [
          errorReply("fetch failed"), // 第一轮首次调用：瞬时网络错
          slowReply("网络恢复后的重试回答", 30, 6), // 重试调用剧本成功
        ],
      },
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    await e2e.send(page, "触发网络抖动");

    // 重试状态卡出现：第 1/3 次 + 约 10s 后（engine.retrying 帧 → 前端投影）
    const retryCard = page.locator(".network-retry-card");
    await expect(retryCard).toBeVisible({ timeout: 10_000 });
    await expect(retryCard).toHaveAttribute("role", "status");
    await expect(retryCard.locator(".nr-head")).toContainText("网络重试中（第 1/3 次，约 10s 后）");
    await expect(retryCard.locator(".nr-body")).toContainText("fetch failed");

    // 等待期无错误卡（未到最终失败）；等待后自动恢复：重试剧本成功流式回复
    await expect(page.locator(".engine-error-card")).toHaveCount(0);
    const reply = page.locator(".msg.assistant:not(.streaming)").last();
    await expect(reply).toContainText("网络恢复后的重试回答", { timeout: 30_000 });
    // 流恢复后重试状态卡清除
    await expect(page.locator(".network-retry-card")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator("#msg-input")).toBeEnabled({ timeout: 15_000 });

    await shotEvidence(page, "e2e-network-retry-recovered");
  });
});

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
import { errorReply, slowReply, type DaemonScript } from "./harness/daemon-script";

const ERROR_TEXT = "429: {\"code\":\"1308\",\"message\":\"已达到 5 小时的使用上限。\"}";

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
    await expect(card.locator(".ee-body")).toContainText("已达到 5 小时的使用上限");

    // 会话不崩：生成中状态收口（composer 恢复可发送 = agentState 回 idle）
    await expect(page.locator("#msg-input")).toBeEnabled({ timeout: 15_000 });

    // 无假完成：失败轮不产 assistant 气泡（error 消息空 content 不投影）
    await expect(page.locator(".msg.assistant:not(.streaming)")).toHaveCount(0);

    // ── 第二轮：恢复（错误卡瞬态清除 + 正常流式链路回归）──────
    await e2e.send(page, "第二轮：重试");
    await expect(page.locator(".engine-error-card")).toHaveCount(0, { timeout: 10_000 });
    const reply = page.locator(".msg.assistant:not(.streaming)").last();
    await expect(reply).toContainText("已恢复，这是重试后的正常回复", { timeout: 20_000 });
    await expect(page.locator("#msg-input")).toBeEnabled({ timeout: 15_000 });
  });
});

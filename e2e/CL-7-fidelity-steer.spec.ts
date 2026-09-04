/**
 * TC2.4 —— R-07 steer 可输入与徽标两态 / R-08 steer 提示行（CL-7 F 层还原度）。
 *
 * 断言源：review.md steer UI 语义三规则（SM-3）+ 必须还原 R-07（streaming
 * 输入条不 disabled；drain 落盘后时间轴条目带 success 徽标「已注入 · 本轮
 * 结束」；普通消息无徽标）与 R-08（streaming 时 composer 内 violet 提示行
 * chat.steer.hint，非 streaming 隐藏）。
 * 演进（TR-64 / bbae57e steer 队列坞）：queued 不再上时间轴（旧「steer 气泡
 * + STEER · 已入队徽标」形态退役）——排队期 echo 收左下角浮动坞（待确认 →
 * 已入队对账），turn 边界 drain 落盘后条目原位上轴。
 * 剧本 S3（流式中注入 → steer.queued 对账 → turn 边界 drain → 续轮）。
 */
import { test, expect } from "./harness/fixtures";
import { computed } from "./harness/style-utils";
import { shotEvidence } from "./harness/evidence";
import { messageCompleted, msgEntry, steerDrained, steerQueued, streamDelta } from "./harness/protocol";
import { S3_STEER_ENTRY_ID, S3_TURN1_REPLY, S3_TURN2_REPLY, S3_USER_STEER } from "./harness/scenarios";

test.describe("TC2.4 R-07/R-08/SM-3 steer UI 语义（S3）", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect();
  });

  test("R-08 提示行：非 streaming 隐藏，streaming 中出现（violet + 脉冲点 + hint 文案）", async ({ mock, page }) => {
    // 反例：建连后（非 streaming）提示行不可见
    expect(await computed(page, ".steer-hint", "display")).toBe("none");
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/);

    // 起流式（chat.send → user 投影 → delta）
    await mock.sendUserMessage("讲讲 steer 的语义");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "讲讲 steer 的语义")));
    await mock.emit(streamDelta("m-1", "steer 的意思是"));

    // streaming：composer.streaming + 提示行可见 + 文案 + 脉冲点
    await expect(page.locator(".composer")).toHaveClass(/streaming/);
    await expect(page.locator(".steer-hint")).toBeVisible();
    await expect(page.locator(".steer-hint")).toContainText(
      "主会话生成中 · 发送的消息进入 steer 队列，本轮结束后注入",
    );
    await expect(page.locator(".steer-hint .q-dot")).toBeVisible();
    // violet 提示行
    const violet = await page.evaluate(() =>
      getComputedStyle(document.querySelector(".steer-hint")!).color,
    );
    expect(violet).toBe("rgb(168, 85, 247)");
  });

  test("R-07/SM-3 三规则：streaming 可输入 → 队列坞排队 → drain 原位落轴转换；普通消息无徽标", async ({ mock, page }) => {
    // 第一轮（普通消息路径）
    await mock.sendUserMessage("讲讲 steer 的语义");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "讲讲 steer 的语义")));
    await mock.emit(streamDelta("m-1", S3_TURN1_REPLY));

    // 规则 1：生成中输入条保持可用（不 disabled、保持 focus 可输入）
    const input = page.locator("#msg-input");
    await expect(input).toBeEnabled();
    // 等 streaming 表象提交（并发下 React 渲染可能晚于 emit，先等再发送）
    await expect(page.locator(".composer")).toHaveClass(/streaming/);

    // 发送 → chat.steer 命令（发送语义自动分流）
    const cmd = await mock.sendUserMessage(S3_USER_STEER, "chat.steer");
    expect(cmd.payload).toEqual({ text: S3_USER_STEER });

    // 规则 2（TR-64 队列坞语义）：queued 不上时间轴——零 .msg.user echo 增长；
    // 本地 echo 收左下角浮动坞（待确认），计数 chip + 脉冲点
    await expect(page.locator(".msg.user", { hasText: S3_USER_STEER })).toHaveCount(0);
    const dock = page.locator('[data-kind="steer-dock"]');
    await expect(dock).toBeVisible();
    await expect(dock.locator(".sdq-toggle")).toContainText("1 条注入排队中");
    await expect(dock.locator(".sdq-toggle .q-dot")).toBeVisible();
    expect(await computed(page, '[data-kind="steer-dock"] .sdq-toggle', "color")).toBe("rgb(168, 85, 247)");
    await dock.locator(".sdq-toggle").click();
    await expect(dock.locator(".sdq-item .sdq-text")).toHaveText(S3_USER_STEER);
    await expect(dock.locator(".sdq-item .sdq-state")).toHaveText("待确认");

    // daemon 对账：steer.queued（echo id 换预分配 entryId，坞内状态翻已入队）
    await mock.emit(steerQueued(S3_STEER_ENTRY_ID));
    await expect(dock.locator(".sdq-item .sdq-state")).toHaveText("STEER · 已入队");

    // 规则 3：turn 边界 drain → 坞内出账 + drain 落盘条目上时间轴原位
    // （success 徽标「已注入 · 本轮结束」）
    await mock.emit(messageCompleted(msgEntry("m-1", "assistant", S3_TURN1_REPLY)));
    await mock.emit(steerDrained(S3_STEER_ENTRY_ID));
    await mock.emit(
      messageCompleted(msgEntry(S3_STEER_ENTRY_ID, "user", S3_USER_STEER, { steerState: "drained" })),
    );
    await expect(dock).toHaveCount(0);
    const steerMsg = page.locator(".msg.user", { hasText: S3_USER_STEER });
    await expect(steerMsg).toBeVisible();
    const drained = steerMsg.locator(".steer-badge.drained");
    await expect(drained).toHaveText("已注入 · 本轮结束");
    expect(await computed(page, ".steer-badge.drained", "color")).toBe("rgb(52, 211, 153)");

    // drain 后提示行隐藏（非 streaming）
    await expect(page.locator(".steer-hint")).toBeHidden();

    // SM-3 反例：普通消息（第一轮 user 投影）无徽标
    const normalMsg = page.locator(".msg.user", { hasText: "讲讲 steer 的语义" });
    await expect(normalMsg.locator(".steer-badge")).toHaveCount(0);
    await shotEvidence(page, "fidelity-steer-drained");
  });

  test("S3 后续轮次衔接：drain 后新 turn 正常流式回复", async ({ mock, page }) => {
    await mock.sendUserMessage("讲讲 steer 的语义");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "讲讲 steer 的语义")));
    await mock.emit(streamDelta("m-1", S3_TURN1_REPLY));
    await expect(page.locator(".composer")).toHaveClass(/streaming/);
    await mock.sendUserMessage(S3_USER_STEER, "chat.steer");
    await mock.emit(steerQueued(S3_STEER_ENTRY_ID));
    await mock.emit(messageCompleted(msgEntry("m-1", "assistant", S3_TURN1_REPLY)));
    await mock.emit(steerDrained(S3_STEER_ENTRY_ID));

    // 注入消息驱动的第二轮：delta + 终态
    await mock.emit(streamDelta("m-2", "收到注入消息"));
    await expect(page.locator(".msg.assistant.streaming")).toBeVisible();
    await mock.emit(messageCompleted(msgEntry("m-2", "assistant", S3_TURN2_REPLY)));
    await expect(page.locator(".msg.assistant", { hasText: "session.subscribe" })).toBeVisible();
    // 输入条恢复普通占位（可继续发送）
    await expect(page.locator("#msg-input")).toBeEnabled();
  });
});

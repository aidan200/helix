/**
 * T1.3 —— CLS 流式首帧占位断言骨架（F(4.0).6 顺手批次）。
 *
 * 定位（exploration-reports 报告 4 §A-6）：M2 实测 CLS 0.0796 余量偏小的
 * 两个跳动源之一 = 流式首帧零占位——首帧到达后正文在一行内继续增长时气泡
 * 高度应保持不变（min-height 一行占位，app.css .msg.assistant.streaming）。
 *
 * 本迭代只做占位测试骨架（非 0.0796→0.1 硬门槛——那是 CLS 优化验收值，
 * 不在本任务范围）；断言面：首帧（单字符）→ 行内增长（数十字符）高度差
 * ≤ 阈值 1px + 占位高度 ≥ 一行正文高。
 */
import { test, expect } from "./harness/fixtures";
import { streamDelta } from "./harness/protocol";
import { shotEvidence, writeEvidence } from "./harness/evidence";

/** 行内增长的追加文本（合计仍 < 一行容量，不触发换行增长）。 */
const SAME_LINE_APPEND = "这是流式首帧占位断言：首帧之后正文继续在一行内增长，气泡高度应保持不变。";

test.describe("T1.3 CLS 流式首帧 min-height 占位（断言骨架）", () => {
  test("首帧单字符 → 行内增长：气泡高度差 ≤ 1px；占位 ≥ 一行正文高", async ({ mock, page }) => {
    await mock.connect();
    await mock.emit(streamDelta("cls-m1", "首"));

    const bubble = page.locator(".msg.assistant.streaming .bubble");
    await expect(bubble).toBeVisible();
    const first = (await bubble.boundingBox())!;

    // 占位生效：首帧（单字符）气泡即达一行正文高（13px 正文 × 1.6 行高 + 16px 上下 padding ≈ 37px）
    expect(first.height).toBeGreaterThanOrEqual(36);

    // 行内增长（不换行）：高度差 ≤ 1px（亚像素容差）
    await mock.emit(streamDelta("cls-m1", SAME_LINE_APPEND));
    const grown = (await bubble.boundingBox())!;
    expect(Math.abs(grown.height - first.height)).toBeLessThanOrEqual(1);

    await shotEvidence(page, "cls-first-frame-placeholder");
    writeEvidence(
      "cls-first-frame",
      "txt",
      [
        "T1.3 CLS 流式首帧占位断言骨架（F(4.0).6）",
        `首帧（单字符）气泡高: ${first.height}px（min-height 占位 ≥ 一行正文高）`,
        `行内增长后气泡高: ${grown.height}px（高度差 ${Math.abs(grown.height - first.height)}px ≤ 1px）`,
        "注: 本骨架断言 min-height 占位生效面；CLS 0.1 硬门槛优化不在本迭代范围",
        "结果: PASS",
      ].join("\n"),
    );
  });
});

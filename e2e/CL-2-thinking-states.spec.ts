/**
 * T4.4 S3 —— CL-2 thinking 三态（F2.3 streaming/complete-collapsed/无块 + F2.4 展开回看）。
 *
 * 剧本（契约 §5.2，test-design §4.2 S3）：
 * turn 开始 → thinking.stream.delta × N（逐帧断言流式推进 + 光标）→
 * thinking.completed{entry}（折叠条 Ns · N tokens + 实例 chip，不可逆）→
 * 展开/折叠 → 下一 turn 无 thinking 事件（零 thinking 块渲染）。
 *
 * token 档位显示：fmtTokens 整数 k 档（1_200 → 1k）；秒取整（3_200ms → 3s）。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  messageCompleted,
  msgEntry,
  streamDelta,
  thinkingCompleted,
  thinkingDelta,
} from "./harness/protocol";
import { THINK_ENTRY, THINK_FRAMES, THINK_FULL_TEXT, THINK_REPLY, THINK_TURN2_REPLY } from "./harness/scenarios";

test.describe("T4.4 S3 CL-2 thinking 三态", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect();
  });

  test("streaming 态：delta 逐帧推进（主消息流伴随块 + 光标 + 「思考中」标签）", async ({ mock, page }) => {
    await mock.sendUserMessage("讲讲 thinking 三态的投影规则");
    await mock.emit(messageCompleted(msgEntry("u-think-1", "user", "讲讲 thinking 三态的投影规则")));

    // 逐帧：每帧到达后断言文本按前缀累积（流式推进，非最后一帧直出）
    let acc = "";
    for (const frame of THINK_FRAMES) {
      acc += frame;
      await mock.emit(thinkingDelta("main", frame));
      const live = page.locator(".think-live");
      await expect(live).toBeVisible();
      await expect(live.locator(".tl-text")).toHaveText(acc);
    }
    const live = page.locator(".think-live");
    await expect(live).toHaveAttribute("data-kind", "thinking-live");
    await expect(live.locator(".tl-label")).toContainText("思考中");
    await expect(live.locator(".stream-cursor")).toBeVisible();
    // thinking 期间无 assistant 气泡（思考先于回复的伴随块语义）
    await expect(page.locator(".msg.assistant")).toHaveCount(0);
  });

  test("complete-collapsed 态：completed 落折叠条（标题 + 实例 chip），流式块不可逆消失", async ({ mock, page }) => {
    await mock.emitAll([
      messageCompleted(msgEntry("u-think-1", "user", "讲讲 thinking 三态的投影规则")),
      thinkingDelta("main", THINK_FRAMES.join("")),
    ]);
    await expect(page.locator(".think-live")).toBeVisible();

    // completed：落 ThinkingEntryDto → 💭 折叠条（F2.3 不可逆）
    await mock.emit(thinkingCompleted(THINK_ENTRY));
    const folded = page.locator('.fb-wrap[data-kind="thinking"]');
    await expect(folded).toHaveCount(1);
    await expect(folded.locator(".fb-text")).toHaveText("已思考 3s"); // CAND-35：reasoningTokens 退役，折叠条不再带 token 档
    await expect(folded.locator(".who-chip")).toHaveText("main");
    await expect(page.locator(".think-live")).toHaveCount(0);

    // 后续 assistant 回复正常入流（thinking 与回复相邻）
    await mock.emit(streamDelta("m-think-1", THINK_REPLY));
    await mock.emit(messageCompleted(msgEntry("m-think-1", "assistant", THINK_REPLY)));
    await expect(page.locator(".msg.assistant", { hasText: THINK_REPLY })).toBeVisible();
  });

  test("F2.4 展开回看：折叠条点击展开全文（pre 风），再点折叠", async ({ mock, page }) => {
    await mock.emit(messageCompleted(msgEntry("u-think-1", "user", "讲讲 thinking 三态的投影规则")));
    await mock.emit(thinkingCompleted(THINK_ENTRY));
    const folded = page.locator('.fb-wrap[data-kind="thinking"]');
    await expect(folded).toBeVisible();
    await expect(folded.locator(".flow-bar")).toHaveAttribute("aria-expanded", "false");

    await folded.locator(".flow-bar").click();
    await expect(folded.locator(".flow-bar")).toHaveAttribute("aria-expanded", "true");
    await expect(folded.locator(".flow-body")).toBeVisible();
    await expect(folded.locator(".flow-body")).toHaveText(THINK_FULL_TEXT);

    await folded.locator(".flow-bar").click();
    await expect(folded.locator(".flow-bar")).toHaveAttribute("aria-expanded", "false");
    await expect(folded.locator(".flow-body")).toBeHidden();
  });

  test("无块态：下一 turn 无 thinking 事件 → 零 thinking 块渲染（不残留）", async ({ mock, page }) => {
    // 第一轮：有 thinking（折叠条 1 条）
    await mock.sendUserMessage("第一轮：带思考的回复");
    await mock.emit(messageCompleted(msgEntry("u-think-1", "user", "第一轮：带思考的回复")));
    await mock.emit(thinkingCompleted(THINK_ENTRY));
    await expect(page.locator('.fb-wrap[data-kind="thinking"]')).toHaveCount(1);

    // 第二轮：无任何 thinking 事件 → thinking 块计数不变、无流式块（F2.3 无块态）
    await mock.sendUserMessage("第二轮：不需要思考");
    await mock.emit(messageCompleted(msgEntry("u-think-2", "user", "第二轮：不需要思考")));
    await mock.emit(streamDelta("m-think-2", THINK_TURN2_REPLY));
    await mock.emit(messageCompleted(msgEntry("m-think-2", "assistant", THINK_TURN2_REPLY)));
    await expect(page.locator(".msg.assistant", { hasText: THINK_TURN2_REPLY })).toBeVisible();
    await expect(page.locator(".think-live")).toHaveCount(0);
    await expect(page.locator('.fb-wrap[data-kind="thinking"]')).toHaveCount(1); // 仅第一轮历史

    await shotEvidence(page, "thinking-states-three", "CL-2");
    writeEvidence(
      "thinking-states",
      "txt",
      [
        "T4.4 S3 CL-2 thinking 三态（streaming/折叠/无块）",
        "断言: delta 逐帧+光标/completed 折叠不可逆+展开回看/下一轮无 thinking 零渲染",
        "结果: PASS",
      ].join("\n"),
      "CL-2",
    );
  });
});

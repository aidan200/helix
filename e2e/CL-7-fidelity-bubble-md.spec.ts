/**
 * TC2.2 —— R-03 气泡形态 / R-04 流式光标 / R-05 markdown（CL-7 F 层还原度）。
 *
 * 断言源：review.md 必须还原 R-03（user=violet 右上角/assistant=cyan 左上角
 * + who/时间戳 micro 档）、R-04（streaming 尾部 violet 方块光标 + 边框
 * accent/0.4，流停消失）、R-05（段落/加粗/行内 code chip/violet marker/
 * hud-code 语言标签行）。剧本 S1（多轮富 markdown，test-design §5.2）。
 *
 * 契约等价：chat.send 后 daemon 会推 user 的 chat.message.completed +
 * turn.started（ChatService.sendMessage 实测序），mock 剧本保持一致。
 */
import { test, expect } from "./harness/fixtures";
import { cssVar, computed, computedPseudo, rgbaFromChannel, radiusCorners } from "./harness/style-utils";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { messageCompleted, msgEntry, streamDelta } from "./harness/protocol";
import {
  S1_DELTAS,
  S1_MODEL,
  S1_REPLY_MD,
  S1_TURN2_REPLY,
  S1_TURN2_USER,
} from "./harness/scenarios";

const M1 = "m-turn1";

test.describe("TC2.2 R-03/R-04/R-05 气泡·流式光标·markdown（S1）", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect([], { model: S1_MODEL });
  });

  test("R-03 user 气泡：violet 语义槽位（边/底/右上小角/28px 描边头像/who+时间戳）", async ({ mock, page }) => {
    await mock.sendUserMessage("先讲讲 v0 协议的设计");
    // 契约等价剧本：daemon 投影 user entry
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "先讲讲 v0 协议的设计")));

    const bubble = page.locator(".msg.user .bubble").first();
    await expect(bubble).toBeVisible();

    const violet = await cssVar(page, "--violet-rgb");
    expect(await computed(page, ".msg.user .bubble", "border-color")).toBe(rgbaFromChannel(violet, 0.2));
    expect(await computed(page, ".msg.user .bubble", "background-color")).toBe(rgbaFromChannel(violet, 0.06));
    // 右上角 2px 小角（user 侧）：[TL 8, TR 2, BR 8, BL 8]
    expect(radiusCorners(await computed(page, ".msg.user .bubble", "border-radius"))).toEqual([8, 2, 8, 8]);

    // 28px violet 描边头像（文本 U）
    const avatar = page.locator(".msg.user .avatar").first();
    await expect(avatar).toHaveText("U");
    expect(parseFloat(await computed(page, ".msg.user .avatar", "width"))).toBe(28);
    expect(parseFloat(await computed(page, ".msg.user .avatar", "height"))).toBe(28);
    expect(await computed(page, ".msg.user .avatar", "border-color")).toBe(rgbaFromChannel(violet, 0.4));

    // who + 时间戳 micro 档（text-faint）
    const meta = page.locator(".msg.user .meta").first();
    await expect(meta.locator(".who")).toHaveText("用户");
    await expect(meta.locator(".ts")).toHaveText(/^\d{2}:\d{2}$/);
    expect(await computed(page, ".msg.user .meta .who", "font-size")).toBe("10px");
  });

  test("R-03 assistant 气泡：cyan 语义槽位（左上小角/panel 底/glow 头像）", async ({ mock, page }) => {
    await mock.sendUserMessage("先讲讲 v0 协议的设计");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "先讲讲 v0 协议的设计")));
    await mock.emit(messageCompleted(msgEntry("a-1", "assistant", "协议 v0 是两端同源的。")));

    await expect(page.locator(".msg.assistant .bubble").first()).toBeVisible();
    const accent = await cssVar(page, "--accent-rgb");
    const panel = await cssVar(page, "--panel-solid-rgb");

    expect(await computed(page, ".msg.assistant .bubble", "border-color")).toBe(rgbaFromChannel(accent, 0.2));
    expect(await computed(page, ".msg.assistant .bubble", "background-color")).toBe(rgbaFromChannel(panel, 0.35));
    // 左上角 2px 小角（assistant 侧）：[TL 2, TR 8, BR 8, BL 8]
    expect(radiusCorners(await computed(page, ".msg.assistant .bubble", "border-radius"))).toEqual([2, 8, 8, 8]);

    // HX 头像 + cyan 辉光
    await expect(page.locator(".msg.assistant .avatar").first()).toHaveText("HX");
    expect(await computed(page, ".msg.assistant .avatar", "color")).toBe(
      `rgb(${(await cssVar(page, "--accent-rgb")).split(/\s+/).join(", ")})`,
    );
    const avatarShadow = await computed(page, ".msg.assistant .avatar", "box-shadow");
    expect(avatarShadow).not.toBe("none");

    await expect(page.locator(".msg.assistant .meta .who").first()).toHaveText("主会话");
  });

  test("R-04 流式光标：streaming 中出现（violet 方块 1.1s steps 闪烁 + 边框 accent/0.4），完成后消失", async ({ mock, page }) => {
    await mock.sendUserMessage("先讲讲 v0 协议的设计");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "先讲讲 v0 协议的设计")));

    // 流式第一段：光标出现 + 边框提亮
    await mock.emit(streamDelta(M1, S1_DELTAS[0]));
    const streamingMsg = page.locator(".msg.assistant.streaming").first();
    await expect(streamingMsg).toBeVisible();
    await expect(streamingMsg.locator(".stream-cursor")).toBeVisible();
    await expect(streamingMsg.locator(".md-body")).toContainText("单一定义点");

    const accent = await cssVar(page, "--accent-rgb");
    expect(await computed(page, ".msg.assistant.streaming .bubble", "border-color")).toBe(
      rgbaFromChannel(accent, 0.4),
    );

    // 光标形态：violet 方块（≈0.55em×1.05em）+ cursor-blink 动画
    const violet = await cssVar(page, "--violet-rgb");
    expect(await computed(page, ".stream-cursor", "background-color")).toBe(rgbaFromChannel(violet, 0.75));
    expect((await computed(page, ".stream-cursor", "animation-name")).toLowerCase()).toContain("cursor");

    // 第二段：文本累积、光标仍在
    await mock.emit(streamDelta(M1, S1_DELTAS[1]));
    await expect(streamingMsg.locator(".md-body")).toContainText("workspace 路由字段位预留");

    // 流结束（message.completed + turn.completed）：光标消失、无 streaming 类
    await mock.emit(messageCompleted(msgEntry(M1, "assistant", S1_REPLY_MD)));
    await expect(page.locator(".stream-cursor")).toHaveCount(0);
    await expect(page.locator(".msg.assistant.streaming")).toHaveCount(0);
    await shotEvidence(page, "fidelity-bubble-md-stream-done");
  });

  test("R-05 markdown 渲染：加粗/行内 code chip/violet 列表 marker/代码块语言标签", async ({ mock, page }) => {
    await mock.sendUserMessage("先讲讲 v0 协议的设计");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "先讲讲 v0 协议的设计")));
    await mock.emit(messageCompleted(msgEntry("a-1", "assistant", S1_REPLY_MD)));

    const bubble = page.locator(".msg.assistant .bubble").first();

    // 加粗
    const strong = bubble.locator("strong").first();
    await expect(strong).toContainText("协议是两端同源的单一定义点。");

    // 行内 code chip（.bubble code.inline）
    const chips = bubble.locator("code.inline");
    await expect(chips.first()).toContainText("packages/protocol/src/envelope.ts");
    // 剧本 inline code：envelope.ts / Enveloped / v / type（代码块内 code 不计）
    expect(await chips.count()).toBeGreaterThanOrEqual(4);
    const chipAccent = await cssVar(page, "--accent-rgb");
    expect(await computed(page, ".msg.assistant .bubble code.inline", "border-color")).toBe(
      rgbaFromChannel(chipAccent, 0.15),
    );

    // 无序列表 + violet marker
    const items = bubble.locator("ul li");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("统一信封");
    const markerColor = await computedPseudo(page, ".msg.assistant .bubble ul li", "::marker", "color");
    expect(markerColor).toBe(
      `rgb(${(await cssVar(page, "--violet-rgb")).split(/\s+/).join(", ")})`,
    );

    // 代码块（hud-code：语言标签行 + pre）
    const codeBlock = bubble.locator(".md-code");
    await expect(codeBlock).toHaveCount(1);
    await expect(codeBlock.locator(".c-lang span").first()).toHaveText("ts");
    await expect(codeBlock.locator("pre")).toContainText("const frame: EventEnvelope");
    expect(await computed(page, ".md-code", "border-radius")).toBe("5px");

    writeEvidence(
      "fidelity-bubble-md-structure",
      "txt",
      [
        `code.inline count: ${await chips.count()}`,
        `marker color: ${markerColor}`,
        `md-code radius: ${await computed(page, ".md-code", "border-radius")}`,
      ].join("\n"),
    );
    await shotEvidence(page, "fidelity-bubble-md");
  });

  test("S1 多轮可持续：第二轮发送 → 流式 → 终态渲染（Enter 发送路径）", async ({ mock, page }) => {
    // 第一轮
    await mock.sendUserMessage("先讲讲 v0 协议的设计");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "先讲讲 v0 协议的设计")));
    await mock.emit(messageCompleted(msgEntry("a-1", "assistant", S1_REPLY_MD)));

    // 第二轮（Enter 真实键盘路径；输入草稿清空）
    await mock.sendUserMessage(S1_TURN2_USER);
    await mock.emit(messageCompleted(msgEntry("u-2", "user", S1_TURN2_USER)));
    await mock.emit(streamDelta("m-2", "grep 走 `ripgrep` 语义"));
    await expect(page.locator(".msg.assistant.streaming .md-body")).toContainText("ripgrep");
    await mock.emit(messageCompleted(msgEntry("m-2", "assistant", S1_TURN2_REPLY)));
    await expect(page.locator(".msg.assistant .bubble").nth(1)).toContainText("ripgrep");
    await expect(page.locator("#msg-input")).toHaveValue("");

    // 消息流条目：2 user + 2 assistant
    await expect(page.locator(".msg.user")).toHaveCount(2);
    await expect(page.locator(".msg.assistant")).toHaveCount(2);
  });
});

/**
 * TC3.1 —— TP-CL7-1 / S1：CL-7 E 层多轮流式对话（真 daemon + FakeLLM + 真 WS）。
 *
 * 链路全真：浏览器 → vite dev 页面 → dev-token 端点（真 HTTP）→ 真 WebSocket
 * 握手（hello/welcome/snapshot）→ chat.send → daemon 真事件流（chat.stream.delta
 * 逐帧）→ 流式光标出现/消失 → markdown 渲染 → chat.message.completed 收口。
 * 断言源：requirements §3.7 F(7).1 + prototype/review.md R-03/R-04/R-05 +
 * test-design TP-CL7-1；剧本文本取 harness/scenarios S1（数据呈现断言源）。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { slowReply, type DaemonScript } from "./harness/daemon-script";
import { S1_REPLY_MD, S1_TURN2_REPLY } from "./harness/scenarios";

const TURN3_USER = "第三轮：把 chat.stream.delta 的下发语义说一遍";
const TURN3_REPLY =
  "delta 是**中间态**：daemon 逐帧下发 `chat.stream.delta`，不落盘（AD-16）；" +
  "完成以 `chat.message.completed` 收口，前端以其 entry 覆盖流式中间态。";

const script: DaemonScript = {
  entries: [
    slowReply(S1_REPLY_MD, 40, 8), // ~38 分片 ≈ 1.5s 流式窗口
    slowReply(S1_TURN2_REPLY, 40, 4),
    slowReply(TURN3_REPLY, 40, 4),
  ],
};

/** 流式逐段渲染采样：窗口内收集 .md-body 文本快照，证明 delta 逐段累积。 */
async function sampleStreamingTexts(page: import("@playwright/test").Page, durationMs: number): Promise<string[]> {
  return page.evaluate(
    (duration) =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const t0 = Date.now();
        const timer = setInterval(() => {
          const el = document.querySelector(".msg.assistant.streaming .md-body");
          if (el?.textContent) {
            const text = el.textContent;
            if (seen[seen.length - 1] !== text) seen.push(text);
          }
          if (Date.now() - t0 >= duration) {
            clearInterval(timer);
            resolve(seen);
          }
        }, 30);
      }),
    durationMs,
  );
}

test.describe("TC3.1 CL-7 E 层多轮流式对话（真 daemon + FakeLLM，S1）", () => {
  test("三轮对话：delta 逐段渲染 + 流式光标生命周期 + markdown + 轮次可持续", async ({ e2e, page }) => {
    test.setTimeout(90_000);
    await e2e.startDaemon({ script });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 第一轮：富 markdown（S1_REPLY_MD）──────────────────────
    await e2e.send(page, "第一轮：讲讲协议设计");

    // 流式窗口内：光标可见 + 文本逐段渲染（≥3 个不同快照 = delta 逐帧到达；
    // markdown 部分文本会重排——如 ** 未闭合→闭合成 strong——不做逐字符前缀断言）
    const cursor = page.locator(".msg.assistant.streaming .stream-cursor");
    // 采样与光标观测并行（流式窗口 ~1.5s，串行会错过光标生命周期）
    const [streamTexts] = await Promise.all([
      sampleStreamingTexts(page, 1_600),
      expect.poll(() => cursor.isVisible(), { timeout: 6_000 }).toBe(true),
    ]);
    expect(streamTexts.length).toBeGreaterThanOrEqual(3);
    expect(streamTexts[0]!.length).toBeLessThan(S1_REPLY_MD.length); // 首快照是中间态（未完成）

    // 终态：光标消失 + 完整文本（R-04 streaming 完成后光标移除）
    const turn1 = await e2e.waitForAssistantText(page, "workspace 路由字段位预留");
    await expect(page.locator(".msg.assistant.streaming")).toHaveCount(0);
    await expect(page.locator(".stream-cursor")).toHaveCount(0);

    // R-05 markdown 结构：加粗 / 行内 code chip / 列表 / 代码块 + 语言标签
    const bubble = page.locator(".msg.assistant", { hasText: "单一定义点" }).last();
    await expect(bubble.locator(".md-body strong").first()).toContainText("协议是两端同源的单一定义点");
    await expect(bubble.locator(".md-body code.inline").first()).toHaveText("packages/protocol/src/envelope.ts");
    await expect(bubble.locator(".md-body ul li")).toHaveCount(3);
    const code = bubble.locator(".md-code");
    await expect(code).toHaveCount(1);
    await expect(code.locator(".c-lang span").first()).toHaveText("ts");
    await expect(code.locator("pre")).toContainText("EventEnvelope");
    await shotEvidence(page, "e2e-chat-turn1-md");

    // user 气泡由 daemon 事件投影（turn 模式无本地 echo）
    await expect(page.locator(".msg.user", { hasText: "第一轮：讲讲协议设计" })).toBeVisible();

    // ── 第二轮：短回复，轮次可持续（composer 恢复可用）──────────
    await expect(page.locator("#msg-input")).toBeEnabled();
    await e2e.send(page, "第二轮：再把 grep 工具的匹配规则讲一下");
    await e2e.waitForAssistantText(page, "ripgrep");
    await expect(page.locator(".msg.user", { hasText: "第二轮" })).toBeVisible();

    // ── 第三轮：再次长流式，验证多轮后流式路径不劣化 ────────────
    await e2e.send(page, TURN3_USER);
    const streamTexts3 = await sampleStreamingTexts(page, 1_000);
    expect(streamTexts3.length).toBeGreaterThanOrEqual(3);
    await e2e.waitForAssistantText(page, "中间态");
    await expect(page.locator(".stream-cursor")).toHaveCount(0);

    // ── 收口：三轮 user/assistant 气泡各三，输入仍可用 ──────────
    await expect(page.locator(".msg.user")).toHaveCount(3);
    await expect(page.locator(".msg.assistant")).toHaveCount(3);
    await expect(page.locator("#msg-input")).toBeEnabled();
    await shotEvidence(page, "e2e-chat-three-turns");

    writeEvidence(
      "e2e-chat",
      "txt",
      [
        "TC3.1 CL-7 E 层多轮流式对话（真 daemon + FakeLLM）",
        `turn1 流式快照数: ${streamTexts.length}（逐段前缀增长）`,
        `turn1 首快照: ${JSON.stringify(streamTexts[0])}`,
        `turn3 流式快照数: ${streamTexts3.length}`,
        "断言: 三轮往返 / 光标出现消失 / markdown（strong+inline code+ul+md-code ts）/ 轮次可持续",
        "结果: PASS",
      ].join("\n"),
    );
  });
});

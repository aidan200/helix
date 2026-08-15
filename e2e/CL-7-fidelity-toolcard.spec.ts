/**
 * TC2.3 —— R-06 工具卡三态 / R-16 交互 / SM-4 折叠契约（CL-7 F 层还原度）。
 *
 * 断言源：review.md 必须还原 R-06（全宽 8px 圆角卡、头部结构、三态边框
 * running=accent/30 / done=success/25 / error=error/40、done·error 展开
 * 「参数/结果」pre 块、结果区 max-height 220px 滚动、running 无展开）+
 * SM-4（三态互斥与折叠契约）+ R-16（点击展开折叠 / Enter 发送）。
 * 剧本 S2：read/bash/edit/write/grep 各一，bash 变体 exit≠0。
 */
import { test, expect } from "./harness/fixtures";
import { cssVar, computed, expectBorderColor } from "./harness/style-utils";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { messageCompleted, msgEntry, toolResult, toolStarted } from "./harness/protocol";
import { S2_TOOLS } from "./harness/scenarios";

const runningTool = (id: string, name: string, args: string) =>
  toolStarted({ kind: "tool-call", id, name, args, state: "running", ts: Date.now() });

test.describe("TC2.3 R-06/R-16/SM-4 工具卡三态与交互（S2）", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect();
    await mock.sendUserMessage("跑一轮工作区体检");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "跑一轮工作区体检")));
  });

  test("SM-4 running 态：accent 边框 + spinner + 执行中徽标，点击头部不可展开", async ({ mock, page }) => {
    const t = S2_TOOLS.read;
    await mock.emit(runningTool(t.id, t.name, t.args));

    const running = page.locator(".tool-card.running");
    await expect(running).toHaveCount(1);
    await expect(running.locator(".t-name")).toHaveText("read");
    await expect(running.locator(".t-state .lab")).toHaveText("执行中");
    await expect(running.locator(".t-spinner")).toBeVisible();

    // 三态边框：running = accent/0.3（token 派生）
    await expectBorderColor(page, ".tool-card.running", await cssVar(page, "--accent-rgb"), 0.3);

    // running 无 body：不可展开（无 chevron / 无 aria-expanded / 点击无反应）
    await expect(running.locator(".t-chev")).toHaveCount(0);
    await expect(running.locator(".t-body")).toHaveCount(0);
    expect(await running.locator(".t-head").getAttribute("aria-expanded")).toBeNull();
    await running.locator(".t-head").click();
    await expect(running.locator(".t-body")).toHaveCount(0); // SM-4：仍无 body
    await shotEvidence(page, "fidelity-toolcard-running");
  });

  test("R-06 done 态：success 边框 + 展开「参数/结果」双 pre + 220px 滚动 + 再点折叠", async ({ mock, page }) => {
    const t = S2_TOOLS.read;
    await mock.emit(runningTool(t.id, t.name, t.args));
    await mock.emit(
      toolResult({ kind: "tool-call", id: t.id, name: t.name, args: t.args, state: "done", result: t.result, durationMs: t.durationMs, ts: Date.now() }),
    );

    const done = page.locator(".tool-card.done");
    await expect(done).toHaveCount(1);
    await expect(done.locator(".t-state .lab")).toHaveText("完成");
    await expect(done.locator(".t-dur")).toHaveText("0.2s"); // formatDuration(240)

    // 三态边框：done = success/0.25
    await expectBorderColor(page, ".tool-card.done", await cssVar(page, "--success-rgb"), 0.25);

    // 全宽 8px 圆角卡
    expect(await computed(page, ".tool-card", "border-radius")).toBe("8px");
    const fullWidth = await page.evaluate(() => {
      const card = document.querySelector(".tool-card")!.getBoundingClientRect();
      const inner = document.querySelector(".flow-inner")!.getBoundingClientRect();
      return Math.abs((card.right - card.left) - (inner.right - inner.left - 40)) < 2; // 减 flow-inner 左右 padding 20×2
    });
    expect(fullWidth).toBe(true);

    // 初始折叠 → 点击头部展开：aria-expanded + 参数/结果双 pre
    await expect(done).not.toHaveClass(/open/);
    await done.locator(".t-head").click();
    await expect(done).toHaveClass(/open/);
    await expect(done.locator(".t-head")).toHaveAttribute("aria-expanded", "true");

    const sections = done.locator(".t-section");
    await expect(sections).toHaveCount(2);
    await expect(sections.nth(0).locator(".t-sec-label")).toHaveText("参数");
    await expect(sections.nth(0).locator(".t-pre")).toContainText('"path": "packages/protocol/src/envelope.ts"');
    await expect(sections.nth(1).locator(".t-sec-label")).toHaveText("结果");
    await expect(sections.nth(1).locator(".t-pre")).toContainText("export interface Envelope");

    // 结果区 max-height 220px + 滚动
    expect(await computed(page, ".tool-card.done .t-pre", "max-height")).toBe("220px");
    expect(await computed(page, ".tool-card.done .t-pre", "overflow-y")).toBe("auto");
    await shotEvidence(page, "fidelity-toolcard-done-open");

    // 再次点击 → 折叠（t-body 隐藏）
    await done.locator(".t-head").click();
    await expect(done).not.toHaveClass(/open/);
  });

  test("R-06 error 态（bash exit 1）：error 边框 + 失败徽标 + 「结果 · exit 1」错误结果", async ({ mock, page }) => {
    const t = S2_TOOLS.bash;
    await mock.emit(runningTool(t.id, t.name, t.args));
    await mock.emit(
      toolResult({ kind: "tool-call", id: t.id, name: t.name, args: t.args, state: "error", result: t.result, durationMs: t.durationMs, ts: Date.now() }),
    );

    const err = page.locator(".tool-card.error");
    await expect(err).toHaveCount(1);
    await expect(err.locator(".t-state .lab")).toHaveText("失败");

    const errorRgb = await cssVar(page, "--error-rgb");
    await expectBorderColor(page, ".tool-card.error", errorRgb, 0.4);

    // 展开错误结果：结果 label 带 exit code + pre 错误色
    await err.locator(".t-head").click();
    await expect(err).toHaveClass(/open/);
    const sections = err.locator(".t-section");
    await expect(sections.nth(1).locator(".t-sec-label")).toHaveText("结果 · exit 1");
    await expect(sections.nth(1).locator(".t-pre")).toContainText("process exited with exit 1");
    expect(await computed(page, ".tool-card.error .t-pre", "color")).toBe(
      `rgb(${errorRgb.split(/\s+/).join(", ")})`,
    );
    await shotEvidence(page, "fidelity-toolcard-error-open");
  });

  test("S2 五工具齐全：read/bash/edit/write/grep 各一张卡 + 参数省略行 ellipsis + Enter 发送", async ({ mock, page }) => {
    // 五工具 started → result（edit/write/grep done；read done；bash error）
    for (const key of ["read", "edit", "write", "grep"] as const) {
      const t = S2_TOOLS[key];
      await mock.emit(runningTool(t.id, t.name, t.args));
      await mock.emit(
        toolResult({ kind: "tool-call", id: t.id, name: t.name, args: t.args, state: "done", result: t.result, durationMs: t.durationMs, ts: Date.now() }),
      );
    }
    const b = S2_TOOLS.bash;
    await mock.emit(runningTool(b.id, b.name, b.args));
    await mock.emit(
      toolResult({ kind: "tool-call", id: b.id, name: b.name, args: b.args, state: "error", result: b.result, durationMs: b.durationMs, ts: Date.now() }),
    );

    // 五卡齐全 + 名称集合
    await expect(page.locator(".tool-card")).toHaveCount(5);
    const names = await page.locator(".tool-card .t-name").allTextContents();
    expect(new Set(names)).toEqual(new Set(["read", "bash", "edit", "write", "grep"]));
    // 头部 20px 方图标格（mono 大写字母）
    await expect(page.locator(".tool-card .t-icon").first()).toHaveText("R");
    expect(await computed(page, ".tool-card .t-icon", "width")).toBe("20px");

    // 参数省略行：单行省略（text-overflow ellipsis + nowrap + overflow hidden）
    expect(await computed(page, ".tool-card .t-args", "text-overflow")).toBe("ellipsis");
    expect(await computed(page, ".tool-card .t-args", "white-space")).toBe("nowrap");
    expect(await computed(page, ".tool-card .t-args", "overflow")).toBe("hidden");

    // 状态分布：4 done + 1 error（三态互斥投影）
    await expect(page.locator(".tool-card.done")).toHaveCount(4);
    await expect(page.locator(".tool-card.error")).toHaveCount(1);

    // R-16：Enter 发送（真实键盘路径），payload 契约
    const cmd = await mock.sendUserMessage("继续，把失败的原因讲一下");
    expect(cmd.payload).toEqual({ text: "继续，把失败的原因讲一下" });

    writeEvidence(
      "fidelity-toolcard-summary",
      "txt",
      [`tool names: ${names.join(", ")}`, `done=4 error=1`].join("\n"),
    );
    await shotEvidence(page, "fidelity-toolcard-five");
  });
});

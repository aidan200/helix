/**
 * TC2.6 —— R-15 empty 态 / R-17 动效契约（CL-7 F 层还原度）。
 *
 * 断言源：review.md 必须还原 R-15（connected 空投影：HX 方标 violet 辉光 +
 * 「等待第一条指令」+ 方块光标 + 建议 chip 三枚 + 点击回填；发送后回 active）
 * 与 R-17（prefers-reduced-motion 下 pulse/光标/spinner/扫描线动画全关；
 * 新消息 log-rise；动画仅 transform/opacity）。剧本 S7（空快照）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect } from "./harness/fixtures";
import { computed } from "./harness/style-utils";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { messageCompleted, msgEntry, streamDelta } from "./harness/protocol";

test.describe("TC2.6 R-15 empty 态（S7 空快照）", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect(); // 空快照 → connected + empty
  });

  test("空投影：HX 方标 + 等待第一条指令 + 光标 + 建议 chip 三枚（点击回填聚焦）", async ({ mock, page }) => {
    await expect(mock.app()).toHaveAttribute("data-session", "empty");
    await expect(mock.app()).toHaveAttribute("data-conn", "connected");

    const empty = page.locator(".session-empty");
    await expect(empty).toBeVisible();
    await expect(page.locator(".session-active")).toBeHidden();

    // HX 方标：violet 辉光
    await expect(page.locator(".empty-logo")).toHaveText("HX");
    expect(await computed(page, ".empty-logo", "color")).toBe("rgb(168, 85, 247)");
    expect(await computed(page, ".empty-logo", "box-shadow")).not.toBe("none");

    // 呼吸文案 + violet 方块光标
    await expect(page.locator(".empty-await")).toContainText("等待第一条指令");
    await expect(page.locator(".empty-cursor")).toBeVisible();

    // 建议 chip 三枚（zh-CN 文案表）
    const chips = page.locator(".empty-suggest button");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveText("读一下 packages/protocol 的结构");
    await expect(chips.nth(1)).toHaveText("跑一遍 workspace 测试");
    await expect(chips.nth(2)).toHaveText("搜下握手相关的 TODO");
    await shotEvidence(page, "fidelity-empty-state");

    // 点击 chip：预填输入框 + 聚焦（R-16 chip 回填路径）
    await chips.nth(1).click();
    await expect(page.locator("#msg-input")).toHaveValue("跑一遍 workspace 测试");
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe("msg-input");
  });

  test("R-15 发送后回 active：empty 态消失，消息流接管", async ({ mock, page }) => {
    await expect(page.locator(".session-empty")).toBeVisible();
    await mock.sendUserMessage("第一条指令");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "第一条指令")));
    await expect(mock.app()).toHaveAttribute("data-session", "active");
    await expect(page.locator(".session-empty")).toBeHidden();
    await expect(page.locator(".session-active .msg")).toHaveCount(1);
  });
});

test.describe("TC2.6 R-17 动效（reduced-motion / log-rise / 属性白名单）", () => {
  test("prefers-reduced-motion: reduce 下动画全关（dot 脉冲/光标/spinner/呼吸）", async ({ mock, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });

    // W6o 首启门禁：未建连恒 boot 屏（conn-status 未渲染）——connecting 态
    // 动效断言移重连腿（首启后 phase 不回退，壳在 connecting 覆盖层照常）
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
    // connected 空态：呼吸文案/光标闪烁关
    await mock.connect();
    await expect(page.locator(".session-empty")).toBeVisible();
    expect(await computed(page, ".empty-await", "animation-name")).toBe("none");
    expect(await computed(page, ".empty-cursor", "animation-name")).toBe("none");

    // 重连 connecting 态：状态点脉冲关 + 覆盖层 spinner 关
    await mock.netClose();
    await mock.waitForConn("connecting", 8_000);
    await expect(page.locator(".conn-status .hud-dot-pulse")).toBeVisible();
    expect(await computed(page, ".conn-status .hud-dot-pulse", "animation-name")).toBe("none");
    expect(await computed(page, ".conn-spinner", "animation-name")).toBe("none");
    // 恢复连接（后续流式断言需要 connected 态输入可用）：新 socket 需
    // 控制面 fireOpen 才进 OPEN 态（fake transport connect() 为剧本驱动空转，
    // 未 fireOpen 时客户端帧按 WebSocket 语义丢弃）
    await mock.open();
    await mock.waitForCommand("hello");
    const { snapshot, welcome } = await import("./harness/protocol");
    await mock.emitAll([welcome(), snapshot([])]);
    await mock.waitForConn("connected");

    // 流式光标 + 新消息进入动画关
    await mock.sendUserMessage("动效检查");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "动效检查")));
    await mock.emit(streamDelta("m-1", "流式中的文本"));
    await expect(page.locator(".stream-cursor")).toBeVisible();
    expect(await computed(page, ".stream-cursor", "animation-name")).toBe("none");
    expect(await computed(page, ".msg", "animation-name")).toBe("none");
    await shotEvidence(page, "fidelity-reduced-motion");
  });

  test("正常模式：新消息 log-rise / 流式光标 blink / 呼吸文案（动画存在）", async ({ mock, page }) => {
    await mock.connect();
    expect(await computed(page, ".empty-await", "animation-name")).toContain("breathe");
    expect(await computed(page, ".empty-cursor", "animation-name")).toContain("cursor");

    await mock.sendUserMessage("动效检查");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "动效检查")));
    await mock.emit(streamDelta("m-1", "流式中的文本"));
    // 新消息 log-rise 进入（先等 React 提交投影，再读 computed）
    await expect(page.locator(".session-active .msg").first()).toBeVisible();
    expect(await computed(page, ".session-active .msg", "animation-name")).toContain("log-rise");
    expect(await computed(page, ".stream-cursor", "animation-name")).toContain("cursor");
    // 0.24s 时长（log-rise 契约）
    expect(await computed(page, ".session-active .msg", "animation-duration")).toBe("0.24s");
  });

  test("R-17 动画属性白名单：app.css 全部 @keyframes 仅动 transform/opacity", async () => {
    const cssPath = path.resolve(
      __dirname,
      "../apps/shell/src/shared/ui/styles/app.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    const blocks = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)];
    expect(blocks.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const [, name, body] of blocks) {
      const props = [...body.matchAll(/^\s*(?:[\d.]+%,\s*)*[\d.%,\s]*\{\s*([^}]+)\}/gm)]
        .flatMap((m) => [...m[1].matchAll(/([a-zA-Z-]+)\s*:/g)].map((p) => p[1]))
        .filter((p) => p !== "transform" && p !== "opacity");
      if (props.length > 0) offenders.push(`@keyframes ${name}: ${props.join(", ")}`);
    }
    writeEvidence(
      "fidelity-motion-whitelist",
      "txt",
      [
        `keyframes scanned: ${blocks.map((b) => b[1]).join(", ")}`,
        offenders.length === 0 ? "all animations only transform/opacity ✓" : `offenders:\n${offenders.join("\n")}`,
      ].join("\n"),
    );
    expect(offenders, `非 transform/opacity 动画属性：${offenders.join("; ")}`).toEqual([]);
  });
});

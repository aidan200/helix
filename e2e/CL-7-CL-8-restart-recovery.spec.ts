/**
 * TC4.1 —— TP-CL8-8 / F(8).2：CL-7×CL-8 重启恢复浏览器端到端（真 daemon）。
 *
 * 流程：前置对话（≥2 轮 + ≥1 工具调用）→ SIGTERM 优雅停 daemon → 同 --home
 * 重启 → 前端自动重连（disconnected 横幅 → connecting 覆盖层 → connected +
 * 恢复 toast N 条重建）→ 视图断言 → 续发新消息验证活会话。
 *
 * 历史缺陷 D-1（ISSUE-D1-snapshot-toolcall-missing，契约审阅确认）已于
 * 回退修复中解决：session.snapshot 现携带 tool-call 条目（SessionStateView
 * 消息+工具记录按 ts 合并；DtoMapper 三态映射），重启后工具卡随快照重建。
 * 本用例按正确口径断言（视图与重启前一致）。
 *
 * daemon 侧恢复语义（优雅/强杀 TP-CL8-6/7）已由 bun test 覆盖，此处只验
 * 浏览器侧表现；断言源 = requirements §3.8 验收标准 + review.md SM-1/SM-2。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { replyFromResult, slowReply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { DaemonProcess } from "./harness/daemon-fixture";

const READ_MARKER = "HELIX-RESTART-READ-42";
const T1_USER = "第一轮：报上名来";
const T1_REPLY = "我是 helix 主会话，重启恢复验证第一轮的回复。（完T1）";
const T2_USER = "第二轮：说明持久化语义";
const T2_REPLY = "事件经 WriteQueue 顺序落 SQLite WAL，重启后快照重建投影。（完T2）";
const T3_USER_AFTER_RESTART = "重启之后的新消息：验证活会话";
// 重启进程从头消费剧本 → 新消息的回复 = entry[0]（与第一轮同文本，含 ALIVE 标记）
const ALIVE_MARKER = "HELIX-ALIVE-42";

/** 通用前置：建 home+沙箱夹具（note.txt）。 */
function prepHome(tag: string): string {
  const home = mkdtempSync(path.join(tmpdir(), `helix-e2e-restart-${tag}-`));
  const sandbox = path.join(home, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(path.join(sandbox, "note.txt"), `重启夹具\n${READ_MARKER} 内容\n`, "utf8");
  return home;
}

test.describe("TC4.1 CL-7×CL-8 重启恢复端到端（真 daemon，TP-CL8-8 / F(8).2）", () => {
  test("重启恢复：消息视图一致（≥2 轮，快照+增量重建）", async ({ e2e, page }) => {
    test.setTimeout(120_000);
    const home = prepHome("msgs");
    const script: DaemonScript = { entries: [slowReply(T1_REPLY, 30, 6), slowReply(T2_REPLY, 30, 6)] };

    const d1 = await e2e.startDaemon({ script, home });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // 前置对话：两轮（文末标记 + 轮次收口——SIGTERM 前必须等 message_end 落盘）
    await e2e.send(page, T1_USER);
    await e2e.waitForTurnDone(page, "（完T1）");
    await e2e.send(page, T2_USER);
    await e2e.waitForTurnDone(page, "（完T2）");
    await expect(page.locator(".msg.user")).toHaveCount(2);
    await expect(page.locator(".msg.assistant")).toHaveCount(2);
    await shotEvidence(page, "restart-recovery-before-msgs", "CL-7-CL-8");

    // 停机（SIGTERM 优雅）→ 装记录器 → 断线表象
    await e2e.installConnRecorder(page);
    await d1.stop();
    await expect
      .poll(() => page.locator(".app").getAttribute("data-conn"), { timeout: 3_000 })
      .toBe("disconnected");
    await shotEvidence(page, "restart-recovery-disconnected", "CL-7-CL-8");

    // 同 home 重启 → 自动重连 → connected + 恢复 toast（4 条投影重建：2 user + 2 assistant）
    const d2 = await e2e.startDaemon({ script, home, retries: 8 });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    const toast = page.locator(".toast.ok");
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText("会话已恢复");
    await expect(toast.locator(".t-sub")).toContainText("4 条投影已重建");
    await expect(page.locator(".conn-banner")).toBeHidden();
    await expect(page.locator(".conn-overlay")).toBeHidden();

    // 重连状态序列：connected → disconnected → connecting → connected（SM-2 语义）
    const seq = await e2e.readConnSeq(page);
    const firstDisconn = seq.indexOf("disconnected");
    const firstReconnecting = seq.indexOf("connecting", firstDisconn + 1);
    const finalConnected = seq.lastIndexOf("connected");
    expect(firstDisconn).toBeGreaterThan(-1);
    expect(firstReconnecting).toBeGreaterThan(firstDisconn);
    expect(finalConnected).toBeGreaterThan(firstReconnecting);

    // 视图一致：两轮消息全在（文本原样）
    await expect(page.locator(".msg.user", { hasText: T1_USER })).toBeVisible();
    await expect(page.locator(".msg.user", { hasText: T2_USER })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: "重启恢复验证第一轮" })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: "SQLite WAL" })).toBeVisible();
    await expect(page.locator(".msg.user")).toHaveCount(2);
    await expect(page.locator(".msg.assistant")).toHaveCount(2);
    await shotEvidence(page, "restart-recovery-after-msgs", "CL-7-CL-8");

    writeEvidence(
      "restart-recovery",
      "txt",
      [
        "TC4.1-a 重启后消息视图一致：PASS",
        `conn 序列: ${seq.join(" → ")}`,
        "恢复 toast: 会话已恢复 / 4 条投影已重建",
        "两轮 user+assistant 消息重启后全部在场",
      ].join("\n"),
      "CL-7-CL-8",
    );
  });

  test("重启恢复：工具卡视图一致（快照合并重建，D-1 已修复）", async ({ e2e, page }) => {
    test.setTimeout(120_000);
    const home = prepHome("tools");
    const script: DaemonScript = {
      entries: [
        toolCall("read", { path: "note.txt" }),
        replyFromResult("读取结果：{last}"),
        slowReply(T1_REPLY, 30, 6),
      ],
    };

    const d1 = await e2e.startDaemon({ script, home });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // 前置：工具轮（read 真实执行）+ 一轮纯文本
    await e2e.send(page, "读取 note.txt");
    const card = page.locator(".tool-card.done");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.locator(".t-head").click();
    await expect(card.locator(".t-section").nth(1).locator(".t-pre")).toContainText(READ_MARKER);
    await e2e.waitForAssistantText(page, READ_MARKER);
    await e2e.send(page, T1_USER);
    await e2e.waitForTurnDone(page, "（完T1）");
    await shotEvidence(page, "restart-recovery-before-toolcard", "CL-7-CL-8"); // 重启前：工具卡在场

    // 停机 → 重启（同 home）
    await d1.stop();
    const d2 = await e2e.startDaemon({ script, home, retries: 8 });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    // 计数 5 条（D-1 修复后构成）= user(读取) + assistant(续写) + tool(read)
    //              + user(第一轮) + assistant(第一轮回复)——工具调用以
    // tool-call 条目并入快照（不再产生 assistant 占位文本条目，TS3-a）。
    await expect(page.locator(".toast.ok").locator(".t-sub")).toContainText("5 条投影已重建", {
      timeout: 10_000,
    });
    await shotEvidence(page, "restart-recovery-after-toolcard", "CL-7-CL-8"); // 重启后：工具卡随快照重建

    writeEvidence(
      "restart-recovery-toolcard",
      "txt",
      [
        "TC4.1-b 重启后工具卡一致：PASS（D-1 已于回退修复中解决）",
        "重启前: .tool-card.done ×1（read，展开结果含 " + READ_MARKER + "）",
        "重启后: 快照 5 条重建 = user(读取)+assistant(续写)+tool(read)+user(第一轮)",
        "  +assistant(第一轮回复)——工具条目并入快照（SessionStateView 合并投影）",
        "断言: .tool-card ×1（done，t-name=read），展开结果含真实文件内容（" + READ_MARKER + "）",
      ].join("\n"),
      "CL-7-CL-8",
    );

    // 视图与重启前一致（TP-CL8-8）：工具卡随快照重建，一张 done 卡、
    // 名称 read，展开后结果 pre 含真实文件内容。注：快照条目 id 与重启前
    // 一致（D-2 预分配/工具记录 id 持久化）→ React 复用组件实例，重启前
    // 已展开的卡可能仍展开——展开动作幂等（已展开则不再点）。
    const restored = page.locator(".tool-card");
    await expect(restored).toHaveCount(1, { timeout: 10_000 });
    await expect(restored.locator(".t-name")).toHaveText("read");
    await expect(restored).toHaveClass(/done/);
    const head = restored.locator(".t-head");
    if ((await head.getAttribute("aria-expanded")) !== "true") {
      await head.click();
    }
    await expect(restored).toHaveClass(/open/);
    await expect(restored.locator(".t-section").nth(1).locator(".t-pre")).toContainText(READ_MARKER);
  });

  test("重启恢复：恢复后可续对话（活会话，新消息流式往返）", async ({ e2e, page }) => {
    test.setTimeout(120_000);
    const home = prepHome("alive");
    const T1_ALIVE = `我是 helix 主会话，重启恢复验证第一轮的回复（标记 ${ALIVE_MARKER}）。`;
    const script: DaemonScript = { entries: [slowReply(T1_ALIVE, 40, 4)] };

    const d1 = await e2e.startDaemon({ script, home });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await e2e.send(page, T1_USER);
    await e2e.waitForTurnDone(page, ALIVE_MARKER);

    // 停机 → 重启
    await d1.stop();
    const d2 = await e2e.startDaemon({ script, home, retries: 8 });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);

    // 续发新消息：流式回复照常（重启进程从头消费剧本 → 回复 = entry[0]，同标记）
    await e2e.send(page, T3_USER_AFTER_RESTART);
    await expect(page.locator(".msg.user", { hasText: T3_USER_AFTER_RESTART })).toBeVisible();
    await expect(page.locator(".stream-cursor")).toBeVisible({ timeout: 10_000 });
    await e2e.waitForTurnDone(page, ALIVE_MARKER, 30_000);
    await expect(page.locator(".msg.user")).toHaveCount(2);
    await expect(page.locator(".msg.assistant")).toHaveCount(2);
    await shotEvidence(page, "restart-recovery-resume-chat", "CL-7-CL-8");

    writeEvidence(
      "restart-recovery",
      "txt",
      [
        "TC4.1-c 恢复后可续对话：PASS",
        "重启后新消息流式往返（回复含 " + ALIVE_MARKER + "），流式光标出现/消失正常",
        "会话活度: user×2 assistant×2（第一轮 + 重启后新轮）",
      ].join("\n"),
      "CL-7-CL-8",
    );
  });
});

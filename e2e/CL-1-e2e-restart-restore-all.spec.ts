/**
 * T4.2 —— CL-1×CL-8 重启恢复全部会话 + SubAgent 历史（真 daemon，E 层）。
 *
 * 撤 TR-AD-19「恢复重建面」边界声明的行为面证据（T2.1 已落地
 * SessionProjection：SubAgent Entry 进聚合 + 快照 instances[].channels 完整
 * 分组；本 spec 验浏览器投影——重启后抽屉 = 卡片骨架 + closure 尾卡 +
 * **SubAgent 消息历史重放**，不再只有骨架）。
 *
 * 剧本：甲（两轮纯对话）→ 乙（agent_spawn 真子进程：FakeEngineScript 流式
 * 回复含 CLOSURE 块 → done 收口，channel 留下真实消息历史）→ SIGTERM 优雅
 * 停机 → 同 home 重启 → ①session.list 全量（甲乙双卡）②乙为最近活跃 →
 * welcome 快照恢复乙主线 + sa-card.done ③抽屉重放：spawned/模型解析行 +
 * SubAgent 消息条目（真子进程产物）+ closure 尾卡 ④切甲恢复完整对话 ⑤活
 * 会话可续（新消息流式往返）。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { reply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const A_T1 = "甲第一轮：建立基线";
const A_T2 = "甲第二轮：持久化语义";
const S_R1 = "首轮回复。（完S1）"; // 甲/乙 turn1 共用（per-session 队列从头消费）
const S_R2 = "次轮回复。（完S2）"; // 甲/乙 turn2 共用
const B_TASK = "乙调研任务";
/** 真子进程回复：正文 + closure 协议块（ChildMain 解析 done 收口）。 */
const SA_REPLY =
  "调研完成：结论 Z——SubAgent 历史经 SessionProjection 进聚合，重启后抽屉可重放。\n" +
  '<<<CLOSURE\n{"status":"done","summary":"乙调研完成：结论 Z","reportPath":null,"findings":[],"taskId":null}\nCLOSURE>>>';
const A_AFTER = "重启后甲新轮回复。（完RA）";

/** 通用前置：建 home+沙箱。 */
function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl1-restore-all-"));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

test.describe("T4.2 CL-1×CL-8 重启恢复全部会话 + SubAgent 历史", () => {
  test("两会话 + SubAgent 历史 → 重启 → session.list 全量 + 抽屉历史重放 + 活会话可续", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = prepHome();

    // 剧本按轮次对齐（每会话引擎独立队列从头消费：turn N → e(N-1)）：
    // 甲 turn1/2 = e0/e1；乙 turn1 = e0、turn2 = e2(spawn)+e3(续写)；
    // e4 = closure 注入自动轮（乙，重启前落盘无碍）；乙 t3 = e2+e3
    const script: DaemonScript = {
      entries: [
        reply(S_R1), // e0：甲/乙 turn1 共用
        reply(S_R2), // e1：甲/乙 turn2 共用
        toolCall("agent_spawn", { task: B_TASK }), // e2：乙 turn2（真子进程）
        reply("乙主线确认调研完成。（完B1）"), // e3：乙 turn2 续写
        reply("closure 注入自动轮（乙）。（完B0）"), // e4：乙 closure 自动轮
      ],
    };
    // 真子进程剧本：一条流式回复（30ms/片）含 CLOSURE 块 → done 收口
    const engineScript = { replies: [SA_REPLY], chunkDelayMs: 30 };

    const d1 = await e2e.startDaemon({ script, home, realSubagent: { engineScript } });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 前置：甲（草稿建会话 + 两轮）──────────────────────────
    await page.locator("#btn-new-session").click();
    const cardA = page.locator(".ses", { hasText: "甲第一轮：建立基线".slice(0, 8) });
    await e2e.send(page, A_T1);
    await expect(cardA).toHaveCount(1, { timeout: 10_000 });
    await e2e.waitForTurnDone(page, "（完S1）");
    await e2e.send(page, A_T2);
    await e2e.waitForTurnDone(page, "（完S2）");

    // ── 前置：乙（草稿建会话 + agent_spawn 真子进程）──────────
    await page.locator("#btn-new-session").click();
    const cardB = page.locator(".ses", { hasText: "乙会话首轮：派发调研".slice(0, 8) });
    await e2e.send(page, "乙会话首轮：派发调研");
    await expect(cardB).toHaveCount(1, { timeout: 10_000 });
    await e2e.waitForTurnDone(page, "（完S1）");
    // 乙 turn2（e1，与甲 t2 共用文案）
    await e2e.send(page, "乙会话次轮：普通一轮");
    await e2e.waitForTurnDone(page, "（完S2）");
    // 乙 turn3：agent_spawn 真子进程（e2 工具 + e3 续写同一 turn）
    await e2e.send(page, "乙会话三轮：派发调研");
    await e2e.waitForAssistantText(page, "（完B1）", 30_000);
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    // 真子进程 done 收口（流式回复 → closure 解析 → 卡片终态）
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 20_000 });
    // 重启前抽屉：SubAgent 真实消息历史在场（对照组）
    await page.locator(".sa-card.done").click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.ch-msg[data-kind="ch-message"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(drawer.locator(".ch-msg .bubble")).toContainText("调研完成：结论 Z");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    // closure 注入自动轮收口后再停机（SIGTERM 前保证 message_end 落盘）
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    await shotEvidence(page, "cl1-restore-all-before", "CL-1");

    // ── 重启（SIGTERM 优雅 → 同 home 同端口）─────────────────
    await d1.stop();
    const d2 = await e2e.startDaemon({
      script: { entries: [reply(A_AFTER)] }, // 重启进程从头消费：甲续轮回复
      home,
      subagentScript: [],
      retries: 8,
    });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".toast.ok")).toBeVisible({ timeout: 10_000 });

    // ── ① session.list 全量：甲乙双卡在场 ────────────────────
    await expect(cardA).toBeVisible({ timeout: 10_000 });
    await expect(cardB).toBeVisible({ timeout: 10_000 });
    const probe = page.locator("[data-topology]");

    // ── ② 显式切乙：快照恢复主线 + sa-card.done ───────────────
    //（welcome 恢复目标 = 重启时最近活动会话，不在此钉死；两会话恢复
    //  完整性由显式切换逐一验证——「重启恢复全部会话」的判据）
    await cardB.click();
    await expect(probe).toHaveAttribute("data-view", "ready", { timeout: 15_000 });
    await expect(probe).toHaveAttribute("data-active-session", (await cardB.getAttribute("data-session-card"))!);
    await expect(page.locator(".msg.user", { hasText: "乙会话首轮" })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: "（完B1）" })).toBeVisible();
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 10_000 });
    await shotEvidence(page, "cl1-restore-all-after-b", "CL-1");

    // ── ③ 抽屉重放（撤 TR-AD-19 行为面）：SubAgent 消息历史 ──
    await page.locator(".sa-card.done").click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.lc-row[data-lc="spawned"]')).toHaveCount(1);
    await expect(drawer.locator('.lc-row[data-lc="modelResolved"]')).toHaveCount(1);
    // 真子进程消息条目随快照重放（不再只有骨架 + closure 尾卡）
    await expect(drawer.locator('.ch-msg[data-kind="ch-message"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(drawer.locator(".ch-msg .bubble")).toContainText("调研完成：结论 Z");
    await expect(drawer.locator('.closure-card[data-kind="closure"]')).toHaveAttribute("data-status", "done");
    await expect(drawer.locator(".cl-summary")).toContainText("乙调研完成：结论 Z");
    await shotEvidence(page, "cl1-restore-all-drawer-history", "CL-1");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // ── ④ 切甲：完整对话恢复 ─────────────────────────────────
    await cardA.click();
    await expect(probe).toHaveAttribute("data-view", "ready", { timeout: 10_000 });
    await expect(page.locator(".msg.user", { hasText: A_T1 })).toBeVisible();
    await expect(page.locator(".msg.user", { hasText: A_T2 })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: "（完S1）" })).toBeVisible();
    await expect(page.locator(".msg.assistant", { hasText: "（完S2）" })).toBeVisible();
    await shotEvidence(page, "cl1-restore-all-after-a", "CL-1");

    // ── ⑤ 活会话可续：甲新轮流式往返 ─────────────────────────
    await e2e.send(page, "重启后继续甲会话");
    await e2e.waitForTurnDone(page, "（完RA）", 30_000);
    await expect(page.locator(".msg.assistant", { hasText: "（完RA）" })).toBeVisible();

    await d2.stop();
    writeEvidence(
      "cl1-restore-all",
      "txt",
      [
        "T4.2 CL-1×CL-8 重启恢复全部会话 + SubAgent 历史：PASS",
        "前置: 甲两轮 + 乙 agent_spawn 真子进程（FakeEngineScript 流式回复含 CLOSURE）→ done 收口",
        "重启前抽屉: ch-message ×1（真子进程消息历史在场——对照组）",
        "重启后: ①甲乙双卡（session.list 全量）②乙快照恢复主线 + sa-card.done",
        "③抽屉重放: spawned/modelResolved + ch-message ×1（SubAgent 历史）+ closure done 尾卡",
        "  ——撤 TR-AD-19「重启后抽屉 = 卡片骨架 + closure 尾卡」边界的行为面证据",
        "④切甲完整对话恢复 ⑤甲活会话可续（新轮流式往返）",
      ].join("\n"),
      "CL-1",
    );
  });
});

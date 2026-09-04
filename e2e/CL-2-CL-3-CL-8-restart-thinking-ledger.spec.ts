/**
 * T5.3 —— CL-2 × CL-3 × CL-8：重启恢复增例 R4/R5（AD-10 R4/R5 载体 + AD-4
 * 账目完整恢复）。
 *
 * R4（thinking 回看，F2.4）：多轮含 thinking 完成 → SIGTERM → 重启 →
 * 折叠条在场（数量与重启前一致）、逐条展开可见全文、reasoning 计入账目
 * （popover main 行 reasoning sub 与重启前逐字一致）。
 *
 * R5（账目完整恢复，F3.5）：R1+R2 组合（主线多 turn + SubAgent done 收口 +
 * SubAgent running 挂起）→ SIGTERM → 重启 → header 合计徽标与 popover
 * per-instance 明细与重启前**逐字段一致**（快照 usage 聚合重建——数值非
 * 近似；行 state 的收口变化是 R2 语义面，不属账目字段，单独断言）。
 *
 * R6（首迭代基线）由既有 CL-7-CL-8-restart-recovery（3 用例）+ 本迭代
 * CL-1-CL-8-restart-orchestration（R1~R3）全绿承载——收口任务全量连跑验证。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  slowReply,
  thinkingReply,
  toolCall,
  type DaemonScript,
} from "./harness/daemon-script";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";

/** 通用前置：建 home+沙箱。 */
function prepHome(tag: string): string {
  const home = mkdtempSync(path.join(tmpdir(), `helix-e2e-t53-${tag}-`));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

/** 账目投影快照（R5 逐字段对比源）：徽标文本 + popover 合计 + 每行
 *  {id, nums(tok+cost), 行内 sub 文本}。state（idle/running→failed 收口语义）
 * 不是账目字段，不采集——R2/R3 已承载。
 * 演进（2788cc5）：sp-sub 并入行内（.sp-row .sub），不再是紧随兄弟节点。 */
async function readLedgerProjection(page: Page): Promise<{
  badge: string;
  total: string;
  rows: { id: string | null; nums: string; sub: string | null }[];
}> {
  const badge = (await page.locator(".stats-btn .sb-text").innerText()).trim();
  await page.locator(".stats-btn").click();
  await expect(page.locator(".stats-pop")).toBeVisible();
  const total = (await page.locator(".stats-pop .sp-title .total").innerText()).trim();
  const rows = await page.locator(".stats-pop .sp-row").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-row-id"),
      nums: (el.querySelector(".nums")?.textContent ?? "").trim().replace(/\s+/g, " "),
      sub: (el.querySelector(".sub")?.textContent ?? null)?.trim() ?? null,
    })),
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".stats-pop")).toHaveCount(0);
  return { badge, total, rows };
}

test.describe("T5.3 CL-2×CL-3×CL-8 重启恢复增例（R4/R5）", () => {
  test("R4 thinking 回看：折叠条在/展开全文/reasoning 计入账目", async ({ e2e, page }) => {
    test.setTimeout(150_000);
    const home = prepHome("r4");
    const THINK_1 =
      "R4 第一轮思考：确认重启恢复数据链路——ThinkingEntry 随事件流落盘，" +
      "重启后经快照重建为折叠条（前端零自恢复，纯投影）；reasoning tokens " +
      "随 turn usage 入账，重启后从 usage 聚合恢复。";
    const THINK_2 =
      "R4 第二轮思考：账目维度核对——剧本每轮 reasoning=7，两轮合计应为 14；" +
      "折叠条应恰两条，均不可逆折叠态且可展开回看全文。";
    const script: DaemonScript = {
      entries: [
        thinkingReply(THINK_1, "R4 第一轮正文回复。（完R4a）"),
        thinkingReply(THINK_2, "R4 第二轮正文回复。（完R4b）"),
      ],
    };

    const d1 = await e2e.startDaemon({ script, home });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // 前置：两轮含 thinking 的对话完成（文末标记 + 轮次收口后才停机）
    await e2e.send(page, "第一问：边想边答");
    await e2e.waitForTurnDone(page, "（完R4a）");
    await e2e.send(page, "第二问：再想一轮");
    await e2e.waitForTurnDone(page, "（完R4b）");

    // 重启前基线：两条折叠条 + reasoning 账目（每轮 7 → sub 合计 14）
    const barsBefore = page.locator('.fb-wrap[data-kind="thinking"]');
    await expect(barsBefore).toHaveCount(2);
    const ledgerBefore = await readLedgerProjection(page);
    // 主实例行按 kind 语义钉（id = agent-<hex> 唯一串，T10；不再用 "main" 字面）
    expect(ledgerBefore.rows.find((r) => r.id?.startsWith("agent-"))?.sub).toBe("reasoning 14");
    await shotEvidence(page, "t53-r4-before", "CL-2");

    // 停机 → 重启（同 home；空剧本——重启后无待续对话）
    await d1.stop();
    const d2 = await e2e.startDaemon({ script: { entries: [] }, home, retries: 8 });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".toast.ok")).toBeVisible({ timeout: 10_000 });
    // 快照重建消息 6 条：2 user + 2 assistant + 2 thinking（thinking 随快照在场）
    await expect(page.locator(".toast.ok").locator(".t-sub")).toContainText("消息 6 条 · 实例/通道/账目投影已重建");

    // 折叠条在场（数量一致，不可逆折叠态）
    const bars = page.locator('.fb-wrap[data-kind="thinking"]');
    await expect(bars).toHaveCount(2);
    await expect(bars.nth(0).locator(".flow-bar")).toHaveAttribute("aria-expanded", "false");
    await expect(bars.nth(1).locator(".flow-bar")).toHaveAttribute("aria-expanded", "false");

    // 逐条展开回看：全文与重启前一致（F2.4 展开语义）
    await bars.nth(0).locator(".flow-bar").click();
    await expect(bars.nth(0).locator(".flow-body")).toBeVisible();
    await expect(bars.nth(0).locator(".flow-body")).toHaveText(THINK_1);
    await bars.nth(1).locator(".flow-bar").click();
    await expect(bars.nth(1).locator(".flow-body")).toBeVisible();
    await expect(bars.nth(1).locator(".flow-body")).toHaveText(THINK_2);
    await shotEvidence(page, "t53-r4-after", "CL-2");

    // reasoning 计入账目：popover main 行 sub 与重启前逐字一致
    const ledgerAfter = await readLedgerProjection(page);
    // reasoning 计入账目：popover 主实例行 sub 与重启前逐字一致
    expect(ledgerAfter.rows.find((r) => r.id?.startsWith("agent-"))?.sub).toBe("reasoning 14");
    expect(ledgerAfter.badge).toBe(ledgerBefore.badge); // 合计同源恢复

    writeEvidence(
      "t53-r4",
      "txt",
      [
        "R4 thinking 回看：PASS",
        "重启前: thinking 折叠条 ×2 + main 行 sub「reasoning 14」（两轮 reasoning=7 累计）",
        "重启后: 快照 6 条投影重建（含 2 条 thinking Entry）；折叠条 ×2 在场（aria-expanded=false）",
        "展开回看: 两条 .flow-body 全文与重启前逐字一致（F2.4）",
        "账目: main 行 sub「reasoning 14」+ 徽标合计与重启前一致（reasoning 计入账目，F3.5）",
      ].join("\n"),
      "CL-2",
    );
  });

  test("R5 账目完整恢复：R1+R2 组合 → 重启 → header 合计与 popover 明细逐字段一致", async ({ e2e, page }) => {
    test.setTimeout(150_000);
    const home = prepHome("r5");
    const TASK_A = "R5 完成调研的 SubAgent";
    const TASK_B = "R5 挂起运行的 SubAgent";
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: TASK_A }),
        slowReply("主线确认 A 已派出。（完R5a）", 30, 6),
        // A closure（600ms done）注入主线 → idle 立即新 turn 消费（R1 同构）
        slowReply("主线收到 A closure 结论。（完R5c）", 30, 6),
        toolCall("agent_spawn", { task: TASK_B }),
        slowReply("主线确认 B 运行中。（完R5b）", 30, 6),
      ],
    };
    const subagentScript = [{ delayMs: 600, result: "done" as const, summary: "R5 A 调研完成：结论 Y" }];

    const d1 = await e2e.startDaemon({ script, home, subagentScript });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // 前置（R1+R2 组合）：spawn A → turn1 → A done closure 注入 turn → spawn B → turn2
    // （spawn 后 running 卡在场自带 stream-cursor——消息级等待，R2 同构）
    await e2e.send(page, "派一个完成调研的 SubAgent");
    await e2e.waitForAssistantText(page, "（完R5a）");
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    await e2e.waitForAssistantText(page, "（完R5c）", 30_000);
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 10_000 });
    await e2e.send(page, "再派一个挂起的 SubAgent");
    await e2e.waitForAssistantText(page, "（完R5b）");
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    await expect(page.locator(".sa-card.running")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".sa-card")).toHaveCount(2);

    // 重启前账目投影（徽标 + 合计 + 三行明细：主实例 + 两个 SubAgent，id 均为 agent-<hex> 唯一串，T10）
    const before = await readLedgerProjection(page);
    expect(before.rows.map((r) => r.id)).toHaveLength(3);
    for (const id of before.rows.map((r) => r.id)) expect(id).toMatch(/^agent-[0-9a-f]+$/);
    expect(new Set(before.rows.map((r) => r.id)).size).toBe(3); // 互异（含主实例）
    expect(before.badge).toMatch(/tok · \$/); // 徽标格式 sanity（与 popover 合计同源由 CL-3 S4 承载）
    await shotEvidence(page, "t53-r5-before", "CL-3");

    // 停机 → 重启（陷阱剧本：被自动消费即失败——R5 场景无应续对话）
    await d1.stop();
    const d2 = await e2e.startDaemon({
      script: { entries: [slowReply("陷阱：不应被自动消费。（TRAP-R5）", 30, 6)] },
      home,
      subagentScript: [],
      retries: 8,
    });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".toast.ok")).toBeVisible({ timeout: 10_000 });

    // R2 收口语义先行确认：A done 保持、B running → failed 收口
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".sa-card.failed")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".sa-card")).toHaveCount(2);

    // 账目完整恢复（F3.5 主断言）：逐字段一致（徽标/合计/每行 nums/sub——数值相等非近似）
    const after = await readLedgerProjection(page);
    expect(after).toEqual(before);
    await shotEvidence(page, "t53-r5-after", "CL-3");

    // 零新事件流守护（陷阱剧本未被消费——账目未被动过）
    await new Promise((r) => setTimeout(r, 2000));
    const settledLedger = await readLedgerProjection(page);
    expect(settledLedger).toEqual(before);
    await expect(page.locator(".msg.assistant", { hasText: "TRAP-R5" })).toHaveCount(0);

    writeEvidence(
      "t53-r5",
      "txt",
      [
        "R5 账目完整恢复：PASS",
        `重启前: 徽标「${before.badge}」+ 行 main/agent-1/agent-2（nums/sub 采集）`,
        `重启后: 徽标「${after.badge}」——逐字段 toEqual 一致（快照 usage 聚合重建）`,
        "收口语义: agent-1 done 保持 + agent-2 running→failed（R2 面）；陷阱剧本未被消费（2s 观察窗账目稳定）",
      ].join("\n"),
      "CL-3",
    );
  });
});

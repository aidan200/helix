/**
 * T4.4 S6 —— 快照投影重建（重启模拟的 F 层变体；混合闭环 CL-1 卡片 +
 * CL-2 thinking + CL-3 账目；F1.8/F2.4/F3.5 的纯投影面——重启语义本体在
 * E 层 restart 套件）。
 *
 * 剧本（契约 §6.2，test-design §4.2 S6）：直接推 session.snapshot（含
 * thinking entries / instances 清单 / usage 聚合）→ 断言重建投影：
 * 折叠可展开（thinking/compaction）/ 卡片终态（done/failed）/ 账目明细
 * （popover 行 + 合计 = 徽标）/ 抽屉 channel 历史回放（六物种齐全）。
 *
 * 前端零自恢复：全部产物 = 快照字段纯投影（AD-16），断言即重建正确性。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  msgEntry,
  snapshot,
  thinkingEntry,
  welcome,
} from "./harness/protocol";
import { fmtTokens } from "../apps/shell/src/shared/lib/format";
import {
  REBUILD_AGENT1,
  REBUILD_AGENT1_TOOL,
  REBUILD_AGENT1_USER_MSG,
  REBUILD_AGENT2,
  REBUILD_COMPACT_ENTRY,
  REBUILD_INSTANCES,
  REBUILD_MAIN_USAGE,
  REBUILD_THINK_ENTRY,
  REBUILD_USAGE,
} from "./harness/scenarios";
import type { EntryDto } from "../../packages/protocol/src/index";

const badgeText = (tokens: number, cost: number) => `${fmtTokens(tokens)} tok · $${cost.toFixed(2)}`;

/** 快照 entries：主线（user/thinking/assistant/compaction）+ agent-1 归属（user→steer、thinking、tool、assistant）。 */
const REBUILD_ENTRIES: EntryDto[] = [
  msgEntry("rb-u1", "user", "重启前的用户指令"),
  REBUILD_THINK_ENTRY,
  msgEntry("rb-a1", "assistant", "重启前的助手回复"),
  REBUILD_COMPACT_ENTRY,
  REBUILD_AGENT1_USER_MSG,
  thinkingEntry("rb-a1-think", "实例思考：回放可用。", { instanceId: "agent-1", durationMs: 2_100 }),
  { ...msgEntry("rb-a1-sub", "assistant", "实例回复：channel 历史回放", { instanceId: "agent-1" }) },
  REBUILD_AGENT1_TOOL,
];

test.beforeEach(async ({ mock }) => {
  // 直接推重建快照：握手 → welcome → snapshot（instances/usage/entries 全量）
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emitAll([welcome(), snapshot(REBUILD_ENTRIES, { instances: REBUILD_INSTANCES, usage: REBUILD_USAGE })]);
  await mock.waitForConn("connected");
});

test.describe("T4.4 S6 快照投影重建（卡片/thinking/账目/抽屉回放）", () => {
  test("F1.8 卡片终态重建：done/failed 双终态卡（task/closure 摘要/徽标），非空会话", async ({ page }) => {
    await expect(page.locator(".session-empty")).toBeHidden(); // 空态互斥（entries 存在）
    await expect(page.locator(".sa-card")).toHaveCount(2);

    const done = page.locator('.sa-card.done[data-instance="agent-1"]');
    await expect(done).toHaveCount(1);
    await expect(done.locator(".sa-task")).toHaveText("重启前完成的任务");
    await expect(done.locator(".cl-badge")).toHaveText("closure · done");
    await expect(done.locator(".sa-sub")).toContainText("重启前已收口：报告与结论已落盘。");

    const failed = page.locator('.sa-card.failed[data-instance="agent-2"]');
    await expect(failed).toHaveCount(1);
    await expect(failed.locator(".sa-task")).toHaveText("重启前失败的任务");
    await expect(failed.locator(".cl-badge")).toHaveText("failed");
    await expect(failed.locator(".sa-sub")).toContainText("重启前崩溃收口：引擎异常。");
  });

  test("F2.4/F4.1 折叠条重建：thinking 与 compaction 里程碑可展开回看", async ({ page }) => {
    const think = page.locator('.fb-wrap[data-kind="thinking"]');
    await expect(think).toHaveCount(1);
    await expect(think.locator(".fb-text")).toHaveText("已思考 4s"); // CAND-35：reasoningTokens 退役，折叠条不再带 token 档
    await think.locator(".flow-bar").click();
    await expect(think.locator(".flow-body")).toBeVisible();
    await expect(think.locator(".flow-body")).toHaveText("重启前的思考全文：快照重建后仍可展开回看。");

    const compact = page.locator('.fb-wrap[data-kind="compaction"]');
    await expect(compact).toHaveCount(1);
    await expect(compact.locator(".fb-text")).toHaveText("上下文已压缩 340k→20k");
    await compact.locator(".flow-bar").click();
    await expect(compact.locator(".flow-body")).toBeVisible();
  });

  test("F3.5 账目重建：徽标 = 快照聚合 = popover Σ行（含 compaction 独立行与 sub）", async ({ mock, page }) => {
    // 原始数自洽核算：Σ（main + 两实例 + compaction）= 快照 total
    expect(
      REBUILD_MAIN_USAGE.totalTokens +
        REBUILD_AGENT1.usage!.totalTokens +
        REBUILD_AGENT2.usage!.totalTokens +
        REBUILD_COMPACT_ENTRY.usage.totalTokens,
    ).toBe(REBUILD_USAGE.total.totalTokens);

    await expect(page.locator(".stats-btn .sb-text")).toHaveText(
      badgeText(REBUILD_USAGE.total.totalTokens, REBUILD_USAGE.total.cost),
    );

    await page.locator(".stats-btn").click();
    const pop = page.locator(".stats-pop");
    await expect(pop).toBeVisible();
    await expect(pop.locator(".sp-title .total")).toHaveText(
      badgeText(REBUILD_USAGE.total.totalTokens, REBUILD_USAGE.total.cost),
    );

    // 行明细：main（reasoning sub）/ agent-1（done + cache sub）/ agent-2（failed）
    await expect(pop.locator(".sp-row")).toHaveCount(4);
    await expect(pop.locator(".sp-row[data-row-id='main'] .nums")).toContainText("$0.03");
    await expect(pop.locator(".sp-row[data-row-id='main'] .sub")).toHaveText("reasoning 900");
    await expect(pop.locator(".sp-row[data-row-id='agent-1'] .sp-state")).toHaveText("done");
    await expect(pop.locator(".sp-row[data-row-id='agent-1'] .sub")).toHaveText("cache R 12k · W 4k");
    await expect(pop.locator(".sp-row[data-row-id='agent-2'] .sp-state")).toHaveText("failed");

    // compaction 独立行（快照 entries 含里程碑 → 行出现；小计 = usage.compaction）
    await expect(pop.locator(".sp-row[data-row-id='compaction'] .nums")).toContainText("$0.02");
    await expect(pop.locator(".sp-row[data-row-id='compaction'] .sub")).toHaveText("main 340k→20k");

    // 实例行 chip = 快照终态（重建后状态机一致）
    await expect(pop.locator(".sp-row[data-row-id='agent-1']")).toContainText("SubAgent");
    await page.keyboard.press("Escape");
  });

  test("F1.8 抽屉历史回放：done 卡点击 → channel 五物种 + closure 尾卡五字段", async ({ mock, page }) => {
    await page.locator('.sa-card.done[data-instance="agent-1"]').click();
    const sub = await mock.waitForCommand("agent.subscribe");
    expect(sub.payload).toEqual({ agentId: "agent-1" });

    const drawer = page.locator('.drawer[data-instance="agent-1"]');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "done");

    const channel = drawer.locator(".d-channel");
    // ① lifecycle 开行：spawned + 模型解析（声明槽位）
    await expect(channel.locator('.lc-row[data-lc="spawned"]')).toHaveCount(1);
    await expect(channel.locator('.lc-row[data-lc="modelResolved"]')).toContainText(
      "模型解析 · anthropic/claude-sonnet-4-5（profile.model 声明值）",
    );
    // ② steer 注入标记（快照 user 消息 → steer 回放）③ SA 消息 ④ thinking 折叠 ⑤ 工具卡（done）
    await expect(channel.locator('.steer-mark[data-kind="steer-mark"] .sm-text')).toHaveText(
      "抽屉回放：主线注入的用户消息",
    );
    await expect(channel.locator(".ch-msg .bubble").first()).toHaveText("实例回复：channel 历史回放");
    await expect(channel.locator('.fb-wrap[data-kind="thinking"]')).toHaveCount(1);
    await expect(channel.locator(".tool-card.done")).toHaveCount(1);
    // closure 尾卡（五字段：reportPath/findings 3/taskId）
    const closureCard = channel.locator('.closure-card[data-kind="closure"]');
    await expect(closureCard).toHaveAttribute("data-status", "done");
    await expect(closureCard.locator(".cl-badge")).toHaveText("closure · done");
    await expect(closureCard.locator(".cl-meta")).toContainText("reportPath reports/sess-e2e/agent-1.md");
    await expect(closureCard.locator(".cl-meta")).toContainText("findings 3");
    await expect(closureCard.locator(".cl-meta")).toContainText("taskId T-44");
    // queued 空态不渲染（done 实例）
    await expect(channel.locator('[data-kind="queued-hint"]')).toHaveCount(0);

    await shotEvidence(page, "snapshot-rebuild-mixed", "CL-1-CL-2-CL-3");
    writeEvidence(
      "snapshot-rebuild",
      "txt",
      [
        "T4.4 S6 快照投影重建（CL-1 卡片 + CL-2 thinking + CL-3 账目混合闭环）",
        "断言: 折叠可展开/卡片终态/账目明细合计自洽/抽屉 channel 历史回放六物种",
        "  /queued 空态不渲染",
        "结果: PASS",
      ].join("\n"),
      "CL-1-CL-2-CL-3",
    );
  });
});

/**
 * T4.4 S4 —— CL-3 usage 账目（F3.3 徽标格式/冻结/刷新+flash；F3.4 popover
 * 行结构/sub 行/合计自洽/开合交互/行尾跳转）。
 *
 * 剧本（契约 §5.2/§6.2，test-design §4.2 S4）：多实例 usage.recorded 累计 →
 * 徽标；流式期间只发 delta（账面冻结）；turn 完成刷新 + flash；popover
 * 分组行（main + SubAgent join 状态机）+ cache/reasoning sub + 合计自洽。
 *
 * 数字自洽（test-design §4.3）：原始数 Σ行 = 徽标（spec 内核算
 * USAGE_TOTAL）；展示层统一 fmtTokens 整数 k 档（3_000→3k · 5_000→5k ·
 * 4_000→4k，行显示之和 = 徽标显示 12k，双层级自洽）。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  agentCompleted,
  agentSpawned,
  closure,
  messageCompleted,
  msgEntry,
  streamDelta,
  usageRecorded,
} from "./harness/protocol";
import { fmtTokens } from "../apps/shell/src/shared/lib/format";
import {
  USAGE_AGENT1,
  USAGE_AGENT2,
  USAGE_AGENT2_A,
  USAGE_AGENT2_B,
  USAGE_MAIN_TURN,
  USAGE_TOTAL,
} from "./harness/scenarios";

/** 徽标/合计显示串（单一格式化函数，与 UI 同源）。 */
const badgeText = (tokens: number, cost: number) => `${fmtTokens(tokens)} tok · $${cost.toFixed(2)}`;

test.describe("T4.4 S4 CL-3 usage 徽标与 popover", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect();
  });

  test("F3.3 徽标：初始零账面 → 流式中冻结 → usage.recorded 刷新 + flash → 多实例累计", async ({ mock, page }) => {
    const badge = page.locator(".stats-btn .sb-text");
    await expect(badge).toHaveText("0 tok · $0.00");

    // 流式中冻结：只发 delta，不发 usage.recorded → 徽标不动（reducer 结构性保证）
    await mock.sendUserMessage("跑一轮统计");
    await mock.emit(messageCompleted(msgEntry("u-usage-1", "user", "跑一轮统计")));
    await mock.emit(streamDelta("m-usage-1", "回复正文中"));
    await expect(page.locator(".composer")).toHaveClass(/streaming/);
    await expect(badge).toHaveText("0 tok · $0.00");
    await expect(page.locator(".sb-flash")).toHaveCount(0);

    // turn 完成入账：徽标刷新 + flash 辉光层挂载
    await mock.emit(usageRecorded("main", USAGE_MAIN_TURN));
    await expect(badge).toHaveText(badgeText(USAGE_MAIN_TURN.totalTokens, USAGE_MAIN_TURN.cost));
    await expect(page.locator(".sb-flash")).toHaveCount(1);

    // 多实例累计：agent-1 + agent-2（两笔分次入账）
    await mock.emit(agentSpawned("agent-1", "统计实例甲"));
    await mock.emit(usageRecorded("agent-1", USAGE_AGENT1));
    await expect(badge).toHaveText(
      badgeText(USAGE_MAIN_TURN.totalTokens + USAGE_AGENT1.totalTokens, +(USAGE_MAIN_TURN.cost + USAGE_AGENT1.cost).toFixed(2)),
    );
    await mock.emit(agentSpawned("agent-2", "统计实例乙"));
    await mock.emit(usageRecorded("agent-2", USAGE_AGENT2_A));
    await mock.emit(usageRecorded("agent-2", USAGE_AGENT2_B));
    await expect(badge).toHaveText(badgeText(USAGE_TOTAL.totalTokens, USAGE_TOTAL.cost));
  });

  test("F3.4 popover：行结构 + cache/reasoning sub + 合计自洽（Σ行=徽标）", async ({ mock, page }) => {
    // 原始数核算：Σ行 = 徽标（数字自洽，test-design §4.3）
    expect(
      USAGE_MAIN_TURN.totalTokens + USAGE_AGENT1.totalTokens + USAGE_AGENT2.totalTokens,
    ).toBe(USAGE_TOTAL.totalTokens);
    expect(+(USAGE_MAIN_TURN.cost + USAGE_AGENT1.cost + USAGE_AGENT2.cost).toFixed(2)).toBe(
      USAGE_TOTAL.cost,
    );

    // main turn 入账 + agent-1 收口 done（cache sub 为 done 行专属）后入账
    await mock.emit(usageRecorded("main", USAGE_MAIN_TURN));
    await mock.emit(agentSpawned("agent-1", "账目实例甲"));
    await mock.emit(agentCompleted("agent-1", closure("done", "甲完成。")));
    await mock.emit(usageRecorded("agent-1", USAGE_AGENT1));
    await mock.emit(agentSpawned("agent-2", "账目实例乙"));
    await mock.emit(usageRecorded("agent-2", USAGE_AGENT2_A));
    await mock.emit(usageRecorded("agent-2", USAGE_AGENT2_B));

    await page.locator(".stats-btn").click();
    const pop = page.locator(".stats-pop");
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute("aria-label", "会话账目 · 分实例");

    // 合计行 = 徽标同一状态源派生（显示级自洽：3k + 5k + 4k = 12k）
    await expect(pop.locator(".sp-title .total")).toHaveText(badgeText(USAGE_TOTAL.totalTokens, USAGE_TOTAL.cost));

    // main 行：kind/model/chip 空闲/reasoning sub
    const mainRow = pop.locator('.sp-row[data-row-id="main"]');
    await expect(mainRow).toContainText("主会话");
    await expect(mainRow.locator(".sp-state")).toHaveText("空闲");
    await expect(mainRow.locator(".nums")).toContainText("$0.04");
    const mainSub = pop.locator(".sp-row[data-row-id='main'] .sub");
    await expect(mainSub).toHaveText("reasoning 800");

    // agent-1 行：done chip + cache R/W sub；行尾动作（button 语义）
    const a1 = pop.locator('.sp-row[data-row-id="agent-1"]');
    await expect(a1).toContainText("SubAgent");
    await expect(a1.locator(".sp-state")).toHaveText("done");
    await expect(a1).toHaveAttribute("data-row-id", "agent-1");
    const a1Sub = pop.locator(".sp-row[data-row-id='agent-1'] .sub");
    await expect(a1Sub).toHaveText("cache R 12k · W 4k");

    // agent-2 行：running chip、无 cache sub（done 行专属）
    const a2 = pop.locator('.sp-row[data-row-id="agent-2"]');
    await expect(a2.locator(".sp-state")).toHaveText("running");
    await expect(pop.locator(".sp-row[data-row-id='agent-2'] .sub")).toHaveCount(0);
  });

  test("F3.4 交互：aria-expanded 开合 / Esc / 点外关闭 / SubAgent 行尾跳转抽屉", async ({ mock, page }) => {
    await mock.emit(agentSpawned("agent-1", "跳转实例甲"));

    const btn = page.locator(".stats-btn");
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".stats-pop")).toBeVisible();

    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect(page.locator(".stats-pop")).toHaveCount(0);
    await expect(btn).toHaveAttribute("aria-expanded", "false");

    // 点外关闭（popover 与徽标之外）
    await btn.click();
    await expect(page.locator(".stats-pop")).toBeVisible();
    await page.locator(".msg-flow").click(); // S1：brand 位退役，点主区关闭
    await expect(page.locator(".stats-pop")).toHaveCount(0);

    // SubAgent 行尾 → 抽屉（T4.3 接线）；popover 随动作关闭
    await btn.click();
    await page.locator('.sp-row[data-row-id="agent-1"]').click();
    await expect(page.locator(".stats-pop")).toHaveCount(0);
    await expect(page.locator('.drawer[data-instance="agent-1"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".drawer")).toHaveCount(0);
  });

  test("main 行 chip 随生成态：流式中「生成中」→ turn 收口回「空闲」", async ({ mock, page }) => {
    await page.locator(".stats-btn").click();
    const chip = page.locator('.sp-row[data-row-id="main"] .sp-state');
    await expect(chip).toHaveText("空闲");

    await mock.sendUserMessage("chip 状态验证");
    await mock.emit(messageCompleted(msgEntry("u-chip-1", "user", "chip 状态验证")));
    await mock.emit(streamDelta("m-chip-1", "生成中……"));
    await expect(chip).toHaveText("生成中");

    await mock.emit(messageCompleted(msgEntry("m-chip-1", "assistant", "生成中……（完）")));
    await expect(chip).toHaveText("空闲");

    await shotEvidence(page, "usage-badge-popover", "CL-3");
    writeEvidence(
      "usage-badge-popover",
      "txt",
      [
        "T4.4 S4 CL-3 usage 账目（徽标/冻结/刷新+flash/popover）",
        "断言: 徽标格式档位取整/流式冻结 turn 完成刷新+flash/popover 分组行+",
        "  cache/reasoning sub+合计自洽+行尾跳转/main 生成中·空闲 chip",
        "结果: PASS",
      ].join("\n"),
      "CL-3",
    );
  });
});

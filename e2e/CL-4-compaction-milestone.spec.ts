/**
 * T4.4 S5 —— CL-4 compaction（F4.1 里程碑条 + F3.4 compaction 账目行）。
 *
 * 剧本（契约 §5.2/§6.1，test-design §4.2 S5）：
 * compaction.completed{entry} → 里程碑条（折叠+展开+usage meta）→
 * usage.recorded(source=compaction) → popover compaction 独立行（归属 main
 * 说明 sub）+ main 行不吸收（AD-9③：摘要调用不进实例小计，防双计）→
 * 行点击锚点滚动到最后一条里程碑条。
 *
 * 数字自洽：main turn 2_200 + compaction 1_800 = 4_000（显示 2k + 2k = 4k）。
 */
import { test, expect } from "./harness/fixtures";
import { compactionCompleted, messageCompleted, msgEntry, usageRecorded } from "./harness/protocol";
import { fmtTokens } from "../apps/shell/src/shared/lib/format";
import { COMPACT_ENTRY, COMPACT_MAIN_TURN } from "./harness/scenarios";

const badgeText = (tokens: number, cost: number) => `${fmtTokens(tokens)} tok · $${cost.toFixed(2)}`;

/** 铺底消息文本（推高滚动容器，使首条里程碑条离开视口；batch 后缀区分两批）。 */
const PAD_TEXTS = Array.from({ length: 8 }, (_, i) => `铺底消息 ${i + 1}：会话上下文持续增长。`);

test.describe("T4.4 S5 CL-4 compaction 里程碑与账目行", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.connect();
    await mock.emit(usageRecorded("main", COMPACT_MAIN_TURN));
  });

  test("F4.1 里程碑条：⇄ 折叠（340k→20k + 实例 chip + usage meta）→ 展开 summary + 保留尾注", async ({ mock, page }) => {
    await mock.emit(compactionCompleted(COMPACT_ENTRY));

    const bar = page.locator('.fb-wrap[data-kind="compaction"]');
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveClass(/compact/); // violet 色调（区别 thinking accent）
    await expect(bar.locator(".fb-text")).toHaveText("上下文已压缩 340k→20k");
    // meta：实例 chip + 入账值（entry.usage 展示面；账目聚合在 usage.recorded）
    await expect(bar.locator(".who-chip")).toHaveText("main");
    await expect(bar.locator(".fb-meta")).toContainText("2k tok · $0.02");
    // 折叠默认
    await expect(bar.locator(".flow-bar")).toHaveAttribute("aria-expanded", "false");
    await expect(bar.locator(".flow-body")).toBeHidden();

    // 展开回看：summary 全文 + 保留尾注（usage 已入账指引）
    await bar.locator(".flow-bar").click();
    await expect(bar.locator(".flow-bar")).toHaveAttribute("aria-expanded", "true");
    await expect(bar.locator(".flow-body")).toBeVisible();
    await expect(bar.locator(".flow-body")).toContainText("会话上下文已压缩：保留最近任务的关键结论与工具产出。");
    await expect(bar.locator(".fb-note")).toContainText(
      "保留尾部消息与 SubAgent 卡片状态 · 摘要调用 usage 已入账（见账目 popover compaction 行）",
    );
  });

  test("F3.4 compaction 入账：popover 独立行 + 归属 main 说明 + main 行不吸收（防双计）", async ({ mock, page }) => {
    await mock.emit(compactionCompleted(COMPACT_ENTRY));
    await mock.emit(usageRecorded("main", COMPACT_ENTRY.usage, "compaction"));

    // 数字自洽：total = main turn + compaction（原始数与显示档位双自洽）
    expect(COMPACT_MAIN_TURN.totalTokens + COMPACT_ENTRY.usage.totalTokens).toBe(4_000);
    await expect(page.locator(".stats-btn .sb-text")).toHaveText(badgeText(4_000, 0.05));

    await page.locator(".stats-btn").click();
    const pop = page.locator(".stats-pop");
    await expect(pop).toBeVisible();
    await expect(pop.locator(".sp-title .total")).toHaveText(badgeText(4_000, 0.05));

    // main 行不吸收 compaction 用量（AD-9③：保持 2.2k/0.03 → 2k/$0.03）
    const mainRow = pop.locator('.sp-row[data-row-id="main"]');
    await expect(mainRow.locator(".nums")).toContainText("2k");
    await expect(mainRow.locator(".nums")).toContainText("$0.03");

    // compaction 独立行：kind/model/数值/chip + 归属 main 的 before→after sub
    const compactRow = pop.locator('.sp-row[data-row-id="compaction"]');
    await expect(compactRow).toHaveCount(1);
    await expect(compactRow).toContainText("compaction");
    await expect(compactRow.locator(".nums")).toContainText("2k");
    await expect(compactRow.locator(".nums")).toContainText("$0.02");
    await expect(compactRow.locator(".sp-state")).toHaveText("done");
    const compactSub = pop.locator(".sp-row[data-row-id='compaction'] + .sp-sub");
    await expect(compactSub).toHaveText("main 340k→20k");
  });

  test("compaction 行点击：锚点滚动到最后一条里程碑条（popover 随动作关闭）", async ({ mock, page }) => {
    // 两条里程碑条 + 铺底消息拉开距离（首条离开视口）
    for (const [i, text] of PAD_TEXTS.entries()) {
      await mock.emit(messageCompleted(msgEntry(`pad-a-${i}`, "assistant", text)));
    }
    await mock.emit(compactionCompleted(COMPACT_ENTRY));
    for (const [i, text] of PAD_TEXTS.entries()) {
      await mock.emit(messageCompleted(msgEntry(`pad-b-${i}`, "assistant", text)));
    }
    await mock.emit(
      compactionCompleted({ ...COMPACT_ENTRY, id: "compact-2", createdAt: new Date().toISOString() }),
    );
    await expect(page.locator('.fb-wrap[data-kind="compaction"]')).toHaveCount(2);

    await page.locator(".stats-btn").click();
    // 滚回顶部（脱离自动贴底），行点击后断言平滑滚动落在最后一条
    await page.evaluate(() => {
      const el = document.querySelector(".msg-flow");
      if (el) el.scrollTop = 0;
    });
    await page.locator('.sp-row[data-row-id="compaction"]').click();
    await expect(page.locator(".stats-pop")).toHaveCount(0);

    const bars = page.locator('.fb-wrap[data-kind="compaction"]');
    const last = bars.nth(1);
    await expect(last).toBeVisible();
    // 铆点语义验证：滚离顶部且最后一条进入 msg-flow 可视带（末端目标
    // block:center 被滚动容器钳制为贴底——断言以「落在可视带」为准）
    await expect
      .poll(
        () => page.evaluate(() => document.querySelector(".msg-flow")?.scrollTop ?? 0),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(100); // 从 0 滚下（铆点动作发生）
    // 平滑滚动落定后再验可视带（poll 条形位置，避免动画中途采样）
    await expect
      .poll(
        async () => {
          const rect = await last.boundingBox();
          return rect ? Math.round(rect.y + rect.height) : -1;
        },
        { timeout: 5_000 },
      )
      .toBeLessThan(720); // 底边进入视口
    const rect = (await last.boundingBox())!;
    expect(rect.y).toBeGreaterThan(40); // 在 msg-flow 可视带（header 48px 以下）
  });
});

/**
 * T2.3 —— CL-5 TracePage 还原度（fidelity）套件（mock mode，无 daemon；
 * ?fakeTransport=1 标准入口，trace.query 自动剧本由 fake-transport 承载）。
 *
 * 断言源 = 本迭代 prototype/review.md（iter-20260819-erio P-1 TracePage）
 * 「必须还原」清单 8 项（注意：与本仓既有 CL-5-prototype-fidelity.spec.ts 的
 * R-P1~R-P4 编号不同源——那是前迭代 mq5a 的工作台四页清单；本文件
 * R-P1-1~R-P1-8 专指本迭代 review.md §四 必须还原 8 条目的序）：
 *   R-P1-1 布局：IconRail 壳 + 控制条 + 双栏主体（面板 264px 固定左栏）
 *        + 应用式固定壳（页面不出窗口，仅结果框内滚——用户裁决取代原型
 *        sticky/页级滚动：客户端形态 header/菜单栏不可滑出窗口）
 *   R-P1-2 F5.1 实例面板（徽标/模型/状态/起止时长/计数 + 全部实例混排入口）
 *   R-P1-3 F5.2 执行上下文卡（快照折叠/工具 chips/模型/compaction 主有 Sub 无
 *          /spawn task blockquote + 变更轨迹时间线 + 快照缺失降级 + 纯快照）
 *   R-P1-4 F5.3 事件流表格（混排四列/详情三列 + 行展开 payload + 分对着色
 *          + engine.error err-row 错误色系）
 *   R-P1-5 F5.4 组合过滤（三维交集下推：payload 断言 + 命中计数口径）
 *   R-P1-6 F5.5 分页（加载更多 → 已加载全部收口 + footer 计数同步）
 *   R-P1-7 状态面五态互斥（骨架/空态双文案/error role=alert/断连 overlay 正交）
 *   R-P1-8 双主题 token 引用（无硬编码 hex 扫描）+ IconRail /trace 高亮
 *
 * 断言边界（test-design §三）：原型标注 data-proto-annotation 应已剥离
 * （断言其不存在，不期待其存在）；原型演示控制台已全链移除（T5：
 * 组件/dev 管道/样式/i18n 清零，右下角不再有 PROTO CONSOLE）；
 * 空态双文案（会话无事件 vs 筛选后空）属产品内容，纳入 empty 断言
 * （session flavor 与 error 态断言下沉 TracePage.test.tsx 单测层——
 * fake 剧本对任意 sessionId 同构返回 78 条，无法以协议驱动会话空态）。
 *
 * mock 剧本常量（fake-transport traceScenario 确定性场景）：主 + 三 Sub
 * （A=failed 含 engine.error / B=快照缺失 / C=纯快照），总事件 78 条
 * （main 70 / A 4 / B 2 / C 2），message.completed 18，时间零点 =
 * 2026-08-19T13:47:57.802+08:00 + 2_320_000ms。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect } from "./harness/fixtures";
import type { MockController } from "./harness/mock-session";
import type { Page } from "@playwright/test";
import { computed, cssVar } from "./harness/style-utils";
import { evidencePath } from "./harness/evidence";
import {
  sessionListResult,
  sessionMeta,
  v02Snapshot,
  welcome,
} from "./harness/protocol";
import {
  assertFidelityGreen,
  checkPrototypeFidelity,
  type FidelityCheck,
} from "./harness/prototype-fidelity";

const SID = "sess-trace-fidelity";
const SID_B = "sess-trace-fidelity-b";
const SUB_A = "agt_F1X2E88DQ9LM"; // phase-coder · failed（engine.error 行）
const SUB_B = "agt_K65K629RNMQG"; // phase-explorer · completed · 快照缺失
const SUB_C = "agt_P70SC41BE0K2"; // phase-coder · completed（纯快照）
/** 剧本时间零点（fake-transport TRACE_MOCK_BASE_MS 同值）。 */
const BASE_MS = Date.parse("2026-08-19T13:47:57.802+08:00");
const LATEST_TS_ISO = new Date(BASE_MS + 2_320_000).toISOString();

const SHELL_STYLES = path.resolve(__dirname, "..", "apps", "shell", "src", "shared", "ui", "styles");

/** 证据落当前迭代 evidence/e2e（T4.2 / F(5).1：统一走 harness/evidence.ts
 *  迭代感知单点；保留 Buffer 返回供像素比对消费）。 */
function shotLocal(page: Page, name: string): Promise<Buffer> {
  return page.screenshot({
    path: evidencePath(name, "png", "CL-5"),
    fullPage: false,
  });
}

/** 标准进页面流程：建连 → 会话清单 → IconRail 进 /trace → 自动查询收口 success。 */
async function openTrace(mock: MockController, page: Page): Promise<void> {
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emitAll([welcome({ sessionId: SID }), v02Snapshot(SID, { tail: [] })]);
  await mock.waitForConn("connected");
  await mock.waitForCommand("session.list");
  await mock.emit(
    sessionListResult([
      sessionMeta(SID, { title: "trace 还原会话", lastActivityAt: 2_000 }),
      sessionMeta(SID_B, { title: "第二会话", lastActivityAt: 1_000, loaded: false }),
    ]),
  );
  await page.locator('.rail-btn[data-page="trace"]').click();
  await expect(page.locator(".p1-page")).toBeVisible();
  // 自动查询（fake 延迟 120ms 应答）→ success：首页 50 行 + footer 计数
  await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(50, { timeout: 10_000 });
}

/** 五态互斥断言：恰一态呈现（success = 表格行在场；断连 overlay 正交不入判）。 */
async function assertMutualExclusion(
  page: Page,
  on: "skeleton" | "empty" | "error" | "success",
): Promise<void> {
  const actual = {
    skeleton: await page.locator(".p1-skel").count(),
    empty: await page.locator(".p1-empty").count(),
    error: await page.locator(".p1-error").count(),
    success: (await page.locator(".p1-tbody .p1-entry").count()) > 0 ? 1 : 0,
  };
  const expected = { skeleton: 0, empty: 0, error: 0, success: 0, [on]: 1 };
  expect(actual, `状态面互斥：应恰 ${on} 一态在场`).toEqual(expected);
}

/** 最近一次 trace.query 客户端帧（下推断言数据源）。 */
async function lastTraceQuery(mock: MockController): Promise<Record<string, unknown>> {
  const frames = await mock.clientFrames();
  const queries = frames.filter((f) => f.type === "trace.query");
  expect(queries.length).toBeGreaterThan(0);
  return (queries[queries.length - 1]!.payload ?? {}) as Record<string, unknown>;
}

// ── R-P1-1/2/3/4：布局 / 实例面板 / 上下文卡 / 事件流表格 ──────

test.describe("T2.3 CL-5 fidelity：结构还原（R-P1-1~4）", () => {
  test("布局 + 实例面板 + 上下文卡 + 事件流表格（含分对着色与行展开）", async ({ mock, page }) => {
    await openTrace(mock, page);

    const checks: FidelityCheck[] = [
      {
        id: "R-P1-1",
        title: "布局：IconRail 壳 + 控制条四件 + 双栏主体（面板 264px 固定左栏 + 结果框内滚）",
        run: async () => {
          await expect(page.locator("nav.icon-rail")).toBeVisible();
          await expect(page.locator(".p1-title")).toHaveText("事件追溯");
          // 控制条：会话选择器 / 时间范围 / 类型 chips 组均可交互
          await expect(page.locator("#p1-sel-session")).toBeEnabled();
          await expect(page.locator("#p1-sel-range")).toBeEnabled();
          const chips = page.locator(".type-chips .tchip");
          await expect(chips).toHaveCount(8);
          await expect(chips.first()).toBeEnabled();
          // 第四件 = 实例选择面（实例面板 全部实例/实例项均可点）
          await expect(page.locator(".ip-item.ip-all")).toBeEnabled();
          // 双栏主体：264px 左栏；应用式固定壳（用户裁决取代原型 sticky：
          // 页面本体不出窗口，仅结果框 .p1-tbody 内滚，高度随窗口自适应）
          const cols = await computed(page, ".p1-body", "grid-template-columns");
          expect(cols.startsWith("264px")).toBe(true);
          expect(await computed(page, ".p1-page", "overflow-y")).toBe("hidden");
          expect(await computed(page, ".p1-tbody", "overflow-y")).toBe("auto");
        },
      },
      {
        id: "R-P1-2",
        title: "F5.1 实例面板：徽标/模型/状态/起止/计数 + 全部实例混排入口 + 选中切换",
        run: async () => {
          await expect(page.locator(".ip-title")).toHaveText("实例");
          await expect(page.locator(".ip-count")).toHaveText("4 实例");
          // 全部实例入口（混排）：计数 = 78（70+4+2+2）
          const all = page.locator(".ip-item.ip-all");
          await expect(all).toContainText("全部实例");
          await expect(all).toContainText("全会话事件混排");
          await expect(all).toContainText("78 条");
          await expect(all).toHaveAttribute("aria-pressed", "true");
          // 实例项 ×4：主 accent 徽标 + running 脉冲；Sub violet 徽标 + 状态
          const items = page.locator(".ip-item:not(.ip-all)");
          await expect(items).toHaveCount(4);
          const main = items.filter({ hasText: "主实例" });
          await expect(main.locator(".ii-pk.main-pk")).toHaveText("main-session");
          await expect(main).toHaveAttribute("data-status", "running");
          await expect(main.locator(".ii-status")).toHaveText("运行中");
          expect(await computed(page, '.ip-item[data-status="running"] .ii-dot', "animation-name")).toBe(
            "dot-pulse",
          );
          await expect(main.locator(".ii-model")).toHaveText("zhipu/glm-4.6");
          const subA = items.filter({ hasText: SUB_A });
          await expect(subA).toHaveAttribute("data-status", "failed");
          await expect(subA.locator(".ii-status")).toHaveText("失败");
          await expect(subA.locator(".ii-pk")).toHaveText("phase-coder");
          await expect(subA.locator(".ii-pk")).not.toHaveClass(/main-pk/);
          await expect(subA.locator(".ii-model")).toHaveText("zai/glm-5.3");
          await expect(subA.locator(".ii-name")).toContainText("Extend FakeEngineScript");
          await expect(subA.locator(".ii-cnt")).toHaveText("4 条");
          // 选中切换 → 详情视图（表头三列，实例列省略）+ 上下文卡进场
          await subA.click();
          await expect(subA).toHaveAttribute("aria-pressed", "true");
          await expect(all).toHaveAttribute("aria-pressed", "false");
          await expect(page.locator(".p1-thead")).not.toContainText("实例");
          await expect(page.locator(".p1-thead")).toContainText("时间");
          await expect(page.locator(".p1-thead")).toContainText("类型");
          await expect(page.locator(".p1-thead")).toContainText("摘要");
          await expect(page.locator(".ctx-card")).toBeVisible();
        },
      },
      {
        id: "R-P1-3",
        title: "F5.2 执行上下文卡：快照折叠/工具/模型/compaction 主有 Sub 无/task 引用块 + 时间线 + 降级",
        run: async () => {
          // Sub A（接 R-P1-2 选中态）：task blockquote + 快照 + 无 compaction + 无时间线
          const card = page.locator(".ctx-card");
          await expect(card.locator("blockquote.ctx-task")).toContainText("Extend FakeEngineScript");
          await expect(card.locator("blockquote.ctx-task .cite")).toHaveText("spawn task · 首条 user 消息");
          await expect(card.locator(".ctx-tools .hud-chip")).toHaveCount(6);
          await expect(card.locator(".ctx-facts")).toContainText("zai/glm-5.3");
          await expect(card.locator(".ctx-facts")).not.toContainText("compaction");
          await expect(card.locator(".ctx-tl")).toHaveCount(0);
          // systemPrompt 折叠：folded 3 行（max-height 62px）+ 字数 + 展开/收起
          const promptBody = card.locator(".cp-body");
          await expect(promptBody).toHaveClass(/folded/);
          expect(await computed(page, ".cp-body.folded", "max-height")).toBe("62px");
          await expect(card.locator(".cp-count")).toContainText("字");
          const toggle = card.locator(".cp-head .hud-btn");
          await expect(toggle).toHaveText("展开全文");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expect(promptBody).not.toHaveClass(/folded/);
          await expect(promptBody).toContainText("Closure protocol");
          await toggle.click();
          await expect(promptBody).toHaveClass(/folded/);

          // 主实例：compaction 有 + 变更轨迹（model from→to 当前高亮 + compaction 里程碑）
          await page.locator(".ip-item:not(.ip-all)").filter({ hasText: "主实例" }).click();
          await expect(card.locator(".ctx-facts")).toContainText("compaction");
          await expect(card.locator(".ctx-facts")).toContainText("96,000");
          await expect(card.locator(".ctx-facts")).toContainText("32,000");
          await expect(card.locator(".ctx-tools .hud-chip")).toHaveCount(8);
          await expect(card.locator(".cf-v").first()).toContainText("deepseek/deepseek-chat");
          await expect(card.locator(".cf-note").first()).toContainText("基准 zhipu/glm-4.6 · 已切换 1 次");
          const tl = card.locator(".ctx-tl");
          await expect(tl).toBeVisible();
          await expect(tl.locator(".tl-row")).toHaveCount(2);
          const cur = tl.locator(".tl-cur");
          await expect(cur).toContainText("zhipu/glm-4.6");
          await expect(cur).toContainText("deepseek/deepseek-chat");
          await expect(cur).toContainText("当前");
          await expect(tl).toContainText("96,412 → 38,200 tok");

          // Sub B：快照缺失降级（卡保留 + 标注，无 prompt 段）
          await page.locator(".ip-item:not(.ip-all)").filter({ hasText: SUB_B }).click();
          await expect(card.locator(".ctx-missing .hud-badge")).toHaveText("快照缺失");
          await expect(card.locator(".ctx-missing-hint")).toContainText("执行上下文不可回溯");
          await expect(card.locator(".cp-body")).toHaveCount(0);

          // Sub C：单发纯快照（快照在、无变更轨迹段）
          await page.locator(".ip-item:not(.ip-all)").filter({ hasText: SUB_C }).click();
          await expect(card.locator(".cp-body")).toBeVisible();
          await expect(card.locator(".ctx-tl")).toHaveCount(0);
          await expect(card.locator("blockquote.ctx-task")).toContainText("Contract v0.4 porting");
        },
      },
      {
        id: "R-P1-4",
        title: "F5.3 事件流表格：混排四列 + 分对着色 + engine.error 错误色系 + 行展开 payload/收起",
        run: async () => {
          // 回混排视图
          await page.locator(".ip-item.ip-all").click();
          await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(50);
          const thead = page.locator(".p1-thead");
          await expect(thead).toContainText("时间");
          await expect(thead).toContainText("实例");
          await expect(thead).toContainText("类型");
          await expect(thead).toContainText("摘要");
          await expect(thead.locator(".hit")).toHaveText("命中 78 条");
          // 分对着色（token 派生值）：主 accent vs Sub violet（暗色列）
          const mainBadgeColor = await page
            .locator(".inst-badge.main")
            .first()
            .evaluate((el) => getComputedStyle(el).color);
          const subBadgeColor = await page
            .locator(".inst-badge.sub")
            .first()
            .evaluate((el) => getComputedStyle(el).color);
          expect(mainBadgeColor).toBe("rgb(34, 211, 238)"); // --accent-rgb 暗列
          expect(subBadgeColor).toBe("rgb(168, 85, 247)"); // --violet-rgb 暗列
          // engine.error 行：err-row 着色（--error-rgb token 引用）+ 类型徽标 + 摘要 error 色
          const errEntry = page.locator(".p1-entry.err-row");
          await expect(errEntry).toHaveCount(1);
          await expect(errEntry.locator(".p1-tt-engineerr")).toHaveText("engine.error");
          expect(await computed(page, ".p1-entry.err-row .err-text", "color")).toBe("rgb(248, 113, 113)");
          const errShadow = await page
            .locator(".p1-entry.err-row .p1-row")
            .evaluate((el) => getComputedStyle(el).boxShadow);
          expect(errShadow).toContain("rgba(248, 113, 113, 0.55)"); // inset 2px --error-rgb/0.55
          // chip 选中态 error 色系（--error-rgb；初始全选 = on）
          expect(
            await computed(page, '.tchip.on[data-type="engine.error"]', "color"),
          ).toBe("rgb(248, 113, 113)");
          // 行展开：payload JSON + 复制入口；手风琴单开；再点收起
          const firstRow = page.locator(".p1-entry").first().locator(".p1-row");
          await firstRow.click();
          await expect(firstRow).toHaveAttribute("aria-expanded", "true");
          const payload = page.locator(".p1-entry.open .p1-payload");
          await expect(payload).toBeVisible();
          await expect(payload.locator(".hud-code")).toContainText('"from": "zhipu/glm-4.6"');
          await expect(payload.locator(".hud-btn")).toHaveText("复制 JSON");
          // 手风琴：开 err 行 → 首行收
          await errEntry.locator(".p1-row").click();
          await expect(firstRow).toHaveAttribute("aria-expanded", "false");
          await expect(errEntry.locator(".p1-row")).toHaveAttribute("aria-expanded", "true");
          await expect(page.locator(".p1-entry.open .hud-code")).toContainText("account quota exhausted");
          // 再点收起
          await errEntry.locator(".p1-row").click();
          await expect(errEntry.locator(".p1-row")).toHaveAttribute("aria-expanded", "false");
          await expect(page.locator(".p1-payload")).toHaveCount(0);
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));
    await shotLocal(page, "fidelity-trace-structure");
  });
});

// ── R-P1-5/6：组合过滤下推 + 分页收口 ─────────────────────────

test.describe("T2.3 CL-5 fidelity：过滤与分页（R-P1-5/6）", () => {
  test("组合过滤三维交集下推（payload 断言）+ 缺省全量 + 分页收口", async ({ mock, page }) => {
    await openTrace(mock, page);

    const checks: FidelityCheck[] = [
      {
        id: "R-P1-5",
        title: "F5.4 组合过滤：实例 × 类型 × 时间范围交集下推（filterEcho 口径），缺省 = 全量",
        run: async () => {
          // 缺省全量：hit 78
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 78 条");
          // 类型单选（plain 点击 = 单选该类目）：message → 18
          await page.locator('.tchip[data-type="message"]').click();
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 18 条");
          let payload = await lastTraceQuery(mock);
          expect(payload.types).toEqual(["message.completed"]);
          expect(payload.instanceIds).toBeUndefined();
          // 多选（modifier = 集合 toggle）：+ engine.error → 19
          await page.locator('.tchip[data-type="engine.error"]').click({ modifiers: ["Shift"] });
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 19 条");
          payload = await lastTraceQuery(mock);
          expect(payload.types).toEqual(["message.completed", "engine.error"]);
          // 实例维交集：选 Sub A（message 1 + engine.error 1 = 2）
          await page.locator(".ip-item:not(.ip-all)").filter({ hasText: SUB_A }).click();
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 2 条");
          payload = await lastTraceQuery(mock);
          expect(payload.instanceIds).toEqual([SUB_A]);
          expect(payload.types).toEqual(["message.completed", "engine.error"]);
          // 时间维交集：最近 5 分钟（参考零点 = 会话最新事件 ts；A 的事件在窗外 → 0）
          await page.locator("#p1-sel-range").selectOption("300");
          await expect(page.locator(".p1-empty")).toContainText("当前筛选无匹配事件");
          payload = await lastTraceQuery(mock);
          const tr = payload.timeRange as { from: string; to: string };
          expect(tr.to).toBe(LATEST_TS_ISO);
          expect(Date.parse(tr.to) - Date.parse(tr.from)).toBe(300_000);
          // 撤回时间窗 → 回 2 条
          await page.locator("#p1-sel-range").selectOption("all");
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 2 条");
          // 会话切换 = 新查询（控制条可交互 + sessionId 下推；fake 双会话同构场景）
          await page.locator("#p1-sel-session").selectOption(SID_B);
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 78 条");
          payload = await lastTraceQuery(mock);
          expect(payload.sessionId).toBe(SID_B);
          expect(payload.instanceIds).toBeUndefined(); // 切会话筛选归零
          expect(payload.types).toBeUndefined();
        },
      },
      {
        id: "R-P1-6",
        title: "F5.5 分页：加载更多步进追加 → 已加载全部收口（禁用）+ footer 计数同步",
        run: async () => {
          await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(50);
          await expect(page.locator(".p1-foot .meta")).toHaveText("已加载 50 / 78 条 · 每页 50 条");
          const more = page.locator(".p1-foot .hud-btn");
          await expect(more).toHaveText("加载更多");
          await expect(more).toBeEnabled();
          await more.click();
          await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(78);
          await expect(page.locator(".p1-foot .meta")).toHaveText("已加载 78 / 78 条 · 每页 50 条");
          await expect(more).toHaveText("已加载全部");
          await expect(more).toBeDisabled();
          // id 降序拼接：首行 = 最新（agent.model.changed），末行 = id 1（agent.instantiated）
          await expect(page.locator(".p1-entry").first().locator(".p1-tt")).toHaveText("agent.model.changed");
          await expect(page.locator(".p1-entry").last().locator(".p1-tt")).toHaveText("agent.instantiated");
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));
    await shotLocal(page, "fidelity-trace-filter-paging");
  });
});

// ── R-P1-7：状态面五态互斥 + 断连 overlay 正交 ────────────────

test.describe("T2.3 CL-5 fidelity：状态面（R-P1-7）", () => {
  test("真实路径：success/loading/筛选后空互斥 + 断连 overlay 正交 + 断连重连重查", async ({
    mock,
    page,
  }) => {
    await openTrace(mock, page);

    const checks: FidelityCheck[] = [
      {
        id: "R-P1-7",
        title: "状态面（真实路径）：五态互斥 + loading 表格同形骨架 + 筛选后空文案 + 断连 overlay 正交",
        run: async () => {
          // success：恰一态
          await assertMutualExclusion(page, "success");

          // loading：筛选变更 → 先清旧态 → 表格同形骨架（非通用 spinner）
          await page.locator('.tchip[data-type="tool"]').click();
          await expect(page.locator(".p1-skel")).toBeVisible();
          await assertMutualExclusion(page, "skeleton");
          expect((await page.locator(".p1-skel-row").count()) >= 1).toBe(true);
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 16 条"); // tool ×16
          await assertMutualExclusion(page, "success");
          // 回全量（再点单选类目 = 归一全量）
          await page.locator('.tchip[data-type="tool"]').click();
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 78 条");

          // empty（filtered flavor，真实筛选路径）：全不选 = 空结果
          for (const key of ["message", "tool", "thinking", "usage", "lifecycle", "engine.error", "compaction.completed", "model.changed"]) {
            await page.locator(`.tchip[data-type="${key}"]`).click({ modifiers: ["Shift"] });
          }
          await expect(page.locator(".p1-empty")).toBeVisible();
          await expect(page.locator(".p1-empty .e-title")).toContainText("当前筛选无匹配事件");
          await expect(page.locator(".p1-empty .e-hint")).toContainText("调整实例 / 类型 / 时间范围");
          await assertMutualExclusion(page, "empty");
          await page.locator('.tchip[data-type="message"]').click(); // 单选回 success
          await expect(page.locator(".p1-thead .hit")).toHaveText("命中 18 条");
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));

    // 真实断连 → 重连（非控制台）：overlay 起 → 重连后回 success 并重查
    await mock.netClose();
    await mock.waitForConn("disconnected");
    await expect(page.locator(".p1-conn")).toBeVisible();
    await expect(page.locator(".p1-conn .hud-btn")).toContainText("重新连接");
    await expect(page.locator(".p1-tbody .p1-entry").first()).toBeAttached(); // 正交：内容不清
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([welcome({ sessionId: SID }), v02Snapshot(SID, { tail: [] })]);
    await mock.waitForConn("connected");
    await expect(page.locator(".toast.ok", { hasText: "已重新连接 daemon" })).toBeVisible();
    await expect(page.locator(".p1-conn")).toHaveCount(0);
    await expect(page.locator(".p1-thead .hit")).toHaveText("命中 18 条"); // 重查回收（筛选保留）
    await shotLocal(page, "fidelity-trace-states");
  });
});

// ── R-P1-8：双主题 token + IconRail 高亮 + 断言边界 ───────────

test.describe("T2.3 CL-5 fidelity：主题与高亮（R-P1-8）", () => {
  test("双主题 token 引用（无硬编码 hex 扫描）+ IconRail /trace aria-selected", async ({
    mock,
    page,
  }) => {
    // 先切亮主题（S1：主题单钮在 IconRail，常驻可点），再进 /trace
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([welcome({ sessionId: SID }), v02Snapshot(SID, { tail: [] })]);
    await mock.waitForConn("connected");
    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass("light");
    await mock.waitForCommand("session.list");
    await mock.emit(sessionListResult([sessionMeta(SID, { title: "trace 还原会话" })]));
    await page.locator('.rail-btn[data-page="trace"]').click();
    await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(50, { timeout: 10_000 });

    const checks: FidelityCheck[] = [
      {
        id: "R-P1-8",
        title: "双主题 token 引用（亮/暗关键色值取 CSS 变量）+ 无硬编码 hex + IconRail /trace 高亮",
        run: async () => {
          // IconRail：/trace 恰一高亮
          await expect(page.locator('.rail-btn[data-page="trace"]')).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await expect(page.locator('.rail-btn[aria-selected="true"]')).toHaveCount(1);
          // 亮主题（V4）：accent/violet 亮列 token 派生值
          expect(await cssVar(page, "--accent-rgb")).toBe("37 99 235");
          const chipColorLight = await page
            .locator(".tchip.on")
            .first()
            .evaluate((el) => getComputedStyle(el).color);
          expect(chipColorLight).toBe("rgb(37, 99, 235)");
          const subBadgeLight = await page
            .locator(".inst-badge.sub")
            .first()
            .evaluate((el) => getComputedStyle(el).color);
          expect(subBadgeLight).toBe("rgb(147, 51, 234)"); // --violet-rgb 亮列
          // 无硬编码 hex 直写扫描（trace.css 源级）
          const css = fs.readFileSync(path.join(SHELL_STYLES, "trace.css"), "utf8");
          expect(css.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
          // 断言边界：原型标注已剥离（不期待存在）+ /trace 非施工牌
          await expect(page.locator("[data-proto-annotation]")).toHaveCount(0);
          await expect(page.locator('[data-construction="/trace"]')).toHaveCount(0);
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));
    await shotLocal(page, "fidelity-trace-light-theme");
  });

  test("暗主题 token 派生值（V1 列）", async ({ mock, page }) => {
    await openTrace(mock, page);
    expect(await cssVar(page, "--accent-rgb")).toBe("34 211 238");
    const chipColorDark = await page
      .locator(".tchip.on")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(chipColorDark).toBe("rgb(34, 211, 238)");
    const mainBadge = await page
      .locator(".inst-badge.main")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(mainBadge).toBe("rgb(34, 211, 238)");
  });
});

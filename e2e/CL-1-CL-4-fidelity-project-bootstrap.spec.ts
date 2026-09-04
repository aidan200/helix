/**
 * TS2 —— F 层 fidelity：P-1 /project bootstrap 扩展（CL-1 发起 + CL-4 产出
 * 呈现与事后修正；mock mode on，无 daemon）。
 *
 * 断言源（不靠猜）：
 * - prototype/review.md P-1「必须还原」R-10~R-18（V-1 修订语义：bootstrap
 *   无 draft，产出落盘即 confirmed；无审阅/转正/进度；R-17 已移除）；
 * - review.md P-1 状态模型（主区 empty/absent/building/graph 互斥；入口
 *   hidden/guide/building/ready/launched 互斥；切项目先清旧态；呈现内联
 *   态互斥）；
 * - F 行为规则（F1.1 准入两条件、F1.2 内容卡、F4.1 三级分组、F4.2 修正
 *   动作、F4.3 连带标记）；
 * - mock 数据（kg-mock.ts 四态项目 + helix 产出 3 节点/2 阶段/2 批次 +
 *   E-B3→E-B2 引用边推导连带）；
 * - testing/test-design.md CL-1-T1/T2/T3/T8（fidelity 部分）
 *   + verification/test-plan TS2 TC2.1~TC2.2；
 * - 演进注记：CL-4 产出呈现族（TC2.3~TC2.5）随 E-118「产出呈现 tab 移除」
 *   （8d3889f）退役——见文末碑注。
 *
 * 断言边界：只断产品内容。原型标注 data-proto-annotation 断言不存在
 * （pi-src 注明块在实现态无对应物——mock 项目集无 pi-src 已有图谱行，
 * helix 既有图谱行承担「入口静默不渲染」用例）。
 */
import { test, expect } from "./harness/fixtures";
import type { MockController } from "./harness/mock-session";
import type { Page } from "@playwright/test";
import { shotEvidence } from "./harness/evidence";
import { welcome } from "./harness/protocol";
import { assertFidelityGreen, checkPrototypeFidelity, type FidelityCheck } from "./harness/prototype-fidelity";

const SID = "sess-boot-fidelity";

/** 全页可见文本（AD-4 机械核对载体：.app-layout 树）。 */
function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector(".app-layout")!.textContent ?? "");
}

/** 标准进页面：建连 → welcome → IconRail 进 /project → 14 行项目列表收口。 */
async function openProject(mock: MockController, page: Page): Promise<void> {
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emit(welcome({ sessionId: SID }));
  await mock.waitForConn("connected");
  await page.locator('.rail-btn[data-page="project"]').click();
  await expect(page.locator('[data-p1-project="/project"]')).toBeVisible();
  await expect(page.locator(".pj-row")).toHaveCount(14, { timeout: 10_000 }); // 3 已建索引（helix/feifei/legacy）+ 11 absent
}

/** 选中项目进 graph 态（选中自动折叠域——先展开窄轨再点行）。 */
async function enterGraph(page: Page, name: string): Promise<void> {
  if (await page.locator('[data-pj-rail="collapsed"]').isVisible().catch(() => false)) {
    await page.locator(".pj-rail-name").click();
  }
  await page.locator(`.pj-row[data-name="${name}"]`).click();
  await expect(page.locator("[data-kg-head]")).toContainText(`知识图谱 · ${name}`, { timeout: 10_000 });
}

test.describe("TS2 TC2.1 入口准入四态（R-11 + CL-1-T1/T8）", () => {
  test("准入两条件矩阵：synced/degraded∧知识层为空 → ready；已有图谱静默；absent 引导态；切项目重新判定", async ({ mock, page }) => {
    await openProject(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-11-ready（synced∧空）",
        title: "legacy（synced+知识层为空）：入口卡 ready + 准入条件行如实呈现 + 启动钮；无降级 warning",
        run: async () => {
          await enterGraph(page, "legacy");
          const entry = page.locator('[data-boot-entry="ready"]');
          await expect(entry).toBeVisible();
          await expect(entry).toContainText("创建知识图谱（bootstrap）");
          await expect(entry).toContainText("准入条件");
          await expect(entry).toContainText("索引已同步 / 降级 且 知识层为空");
          await expect(entry.locator("[data-launch-btn]")).toBeVisible();
          expect(await entry.locator("[data-boot-degraded-warn]").count()).toBe(0);
          expect(await entry.locator(".kg-sev-badge.warn").count()).toBe(0);
        },
      },
      {
        id: "R-11-ready（degraded∧空）",
        title: "feifei（degraded+知识层为空）：可发起但 warning 条如实（L2 锚精度降为路径级）+ 索引降级徽章",
        run: async () => {
          await enterGraph(page, "feifei");
          const entry = page.locator('[data-boot-entry="ready"]');
          await expect(entry).toBeVisible();
          await expect(entry.locator("[data-boot-degraded-warn]")).toContainText("L2 实体层的锚点精度将降为路径级");
          await expect(entry.locator(".kg-sev-badge.warn")).toHaveText("索引降级");
          await expect(entry.locator("[data-launch-btn]")).toBeVisible(); // 降级仍可发起
        },
      },
      {
        id: "R-11-hidden（CL-1-T8）",
        title: "helix（synced+已有图谱 17 节点）：入口静默不渲染——无降级态、无提示文案、无启动钮",
        run: async () => {
          await enterGraph(page, "helix");
          expect(await page.locator("[data-boot-entry]").count()).toBe(0);
          expect(await page.locator("[data-launch-btn]").count()).toBe(0);
          const text = await visibleText(page);
          expect(text).not.toContain("创建知识图谱（bootstrap）");
          expect(text).not.toContain("前置条件未满足");
        },
      },
      {
        id: "R-11-guide",
        title: "codegraph（absent）：引导态——前置条件未满足徽章+说明+构建索引钮（无启动钮）；切项目准入重新判定",
        run: async () => {
          await page.locator(".pj-rail-name").click();
          await page.locator('.pj-row[data-name="codegraph"]').click();
          const guide = page.locator('[data-boot-entry="guide"]');
          await expect(guide).toBeVisible({ timeout: 10_000 });
          await expect(guide.locator(".pb-absent").nth(1)).toHaveText("前置条件未满足");
          await expect(guide).toContainText("需要先完成一次机械构建");
          await expect(guide.locator("[data-build-cta]")).toHaveText("构建索引");
          expect(await page.locator("[data-launch-btn]").count()).toBe(0);
          // 切回 legacy：准入重新判定 → ready 入口卡复现（旧 guide 态清场）
          await enterGraph(page, "legacy");
          await expect(page.locator('[data-boot-entry="ready"]')).toBeVisible();
          expect(await page.locator('[data-boot-entry="guide"]').count()).toBe(0);
        },
      },
      {
        id: "断言边界",
        title: "原型标注 data-proto-annotation 全页不存在",
        run: async () => {
          expect(await page.locator("[data-proto-annotation]").count()).toBe(0);
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc2-1-entry-matrix", "CL-1");
    assertFidelityGreen(report);
  });
});

test.describe("TS2 TC2.2 absent 引导链与内容卡（R-11/R-12 + CL-1-T2/T3）", () => {
  test("构建索引→building→synced→入口卡出现（构建完成前不可发起）+ 内容卡六件 + 启动 → ok-strip → 前往任务页", async ({ mock, page }) => {
    await openProject(mock, page);
    await page.locator('.pj-row[data-name="codegraph"]').click();
    const checks: FidelityCheck[] = [
      {
        id: "CL-1-T2",
        title: "引导链：构建索引钮 → building 进度态（完成前无启动钮）→ synced → graph + 入口卡 ready 出现",
        run: async () => {
          await expect(page.locator('[data-boot-entry="guide"]')).toBeVisible({ timeout: 10_000 });
          await page.locator("[data-build-cta]").click();
          await expect(page.locator('[data-pj-main="building"]')).toBeVisible();
          await expect(page.locator(".pj-build-panel")).toContainText("构建索引 · codegraph");
          // 构建完成前不可发起：主区无入口卡无启动钮
          expect(await page.locator("[data-launch-btn]").count()).toBe(0);
          expect(await page.locator('[data-boot-entry="ready"]').count()).toBe(0);
          // 完成（mock 时基 3200ms + 轮询 750ms）→ graph + 入口卡 + toast
          await expect(page.locator('[data-pj-main="graph"]')).toBeVisible({ timeout: 15_000 });
          await expect(page.locator('[data-boot-entry="ready"]')).toBeVisible({ timeout: 10_000 });
          await expect(page.locator(".toast-zone")).toContainText("索引构建完成：codegraph");
        },
      },
      {
        id: "R-12",
        title: "任务内容卡：任务说明（含 confirmed 无草稿如实）+目标项目（名+路径）+范围参数+三阶段计划+启动钮（一次确认位）",
        run: async () => {
          const entry = page.locator('[data-boot-entry="ready"]');
          await expect(entry).toContainText("任务说明");
          await expect(entry).toContainText("产出以代码事实落盘知识图谱（confirmed 正式知识，无草稿）");
          await expect(entry).toContainText("目标项目");
          await expect(entry).toContainText("codegraph");
          await expect(entry).toContainText("/ws/codegraph");
          await expect(entry).toContainText("范围参数");
          await expect(entry).toContainText("全仓（默认） · 预计 3 阶段");
          // 三阶段计划 L0/L1/L2 序号行 + 各层职责
          const plan = entry.locator(".kbe-plan-row");
          await expect(plan).toHaveCount(3);
          await expect(plan.nth(0)).toContainText("L0 核心层");
          await expect(plan.nth(0)).toContainText("架构基线与全局规范");
          await expect(plan.nth(1)).toContainText("L1 领域层");
          await expect(plan.nth(2)).toContainText("L2 实体层");
          await expect(plan.nth(2)).toContainText("以 L0+L1 为锚");
          await expect(entry.locator("[data-launch-btn]")).toHaveText("启动任务");
          await expect(entry).toContainText("阶段计划确认后冻结");
        },
      },
      {
        id: "CL-1-T3-launch",
        title: "启动 → ok-strip + 「前往『任务』页观察 →」→ /tasks；启动后启动钮让位",
        run: async () => {
          await page.locator("[data-launch-btn]").click();
          const strip = page.locator("[data-boot-launched]");
          await expect(strip).toBeVisible({ timeout: 10_000 });
          await expect(strip).toContainText("任务「codegraph 知识图谱创建」已创建并进入执行。");
          await expect(page.locator(".toast-zone")).toContainText("任务已创建：codegraph 知识图谱创建");
          // 入口卡翻 launched 态
          await expect(page.locator('[data-boot-entry="launched"]')).toBeVisible();
          // 前往任务页 → /tasks 路由
          await strip.locator("[data-goto-tasks]").click();
          await expect(page.locator('[data-p2-task="/tasks"]')).toBeVisible({ timeout: 10_000 });
          expect(new URL(page.url()).pathname).toBe("/tasks");
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc2-2-guide-launch", "CL-1");
    assertFidelityGreen(report);
  });
});

// ─── TS2 TC2.3/TC2.4/TC2.5（产出呈现三级分组/修正动作/空态复位）已退役 ───
// 「产出呈现」tab 随 E-118 裁决移除（8d3889f：产出=单次 bootstrap 快照无独立
// 呈现价值；daemon 侧 produce/update/supersede/impact 命令保留、暂无 UI 消费者）。
// 原三组用例的覆盖对象（kg-produce-pane）已不存在，无法在不虚构 UI 的前提下
// 保持断言——删除即覆盖意图的如实收口；若产出呈现面重做，按新设计重写。

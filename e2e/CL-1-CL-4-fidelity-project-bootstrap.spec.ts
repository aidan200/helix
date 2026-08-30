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
 * - testing/test-design.md CL-1-T1/T2/T3/T8 + CL-4-T1~T4/T6（fidelity 部分）
 *   + verification/test-plan TS2 TC2.1~TC2.5。
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

/** 进产出呈现 tab 并等 success 态收口。 */
async function enterProduce(page: Page): Promise<void> {
  await page.locator('[data-tab="produce"]').click();
  await expect(page.locator('[data-produce-pane="success"]')).toBeVisible({ timeout: 10_000 });
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

test.describe("TS2 TC2.3 产出呈现分组与条目（R-13/R-14 + CL-4-T1/T2）", () => {
  test("任务→阶段→批次三级分组 + 条目人类可读投影 + 展开四段 + 裸 id 零出现 + 无审阅残留", async ({ mock, page }) => {
    await openProject(mock, page);
    await enterGraph(page, "helix");
    await enterProduce(page);
    const checks: FidelityCheck[] = [
      {
        id: "R-13",
        title: "三级分组：任务（标题+任务详情链接）→阶段（layer 名+chip）→批次（scope+n 节点）；confirmed 尾注；无审阅进度/待审计数",
        run: async () => {
          const group = page.locator('[data-produce-group][data-id="job-mock-1"]');
          await expect(group.locator(".kpn-group-title")).toHaveText("helix 知识图谱创建");
          await expect(group.locator("[data-goto-tasks]")).toHaveText("任务详情 →");
          await expect(page.locator('[data-produce-stage="L0"]')).toHaveCount(0); // data-layer 承载
          const l0 = page.locator('[data-produce-stage][data-layer="L0"]');
          await expect(l0.locator(".kpn-stage-name")).toHaveText("L0 核心层");
          await expect(l0.locator(".hud-chip").first()).toHaveText("L0");
          const l1 = page.locator('[data-produce-stage][data-layer="L1"]');
          await expect(l1.locator(".kpn-stage-name")).toHaveText("L1 领域层");
          const b1 = page.locator('[data-produce-batch][data-id="b-mock-1"]');
          await expect(b1.locator(".kpn-batch-name")).toHaveText("批次：架构基线与全局规范");
          await expect(b1.locator(".hud-chip")).toHaveText("1 节点");
          const b2 = page.locator('[data-produce-batch][data-id="b-mock-2"]');
          await expect(b2.locator(".hud-chip")).toHaveText("2 节点");
          // confirmed 说明尾注（V-1 无 draft）
          await expect(page.locator(".kpn-note")).toContainText("产出落盘即 confirmed（正式知识）");
          await expect(page.locator(".kpn-note")).toContainText("只标记不自动处置");
          // 无审阅进度/待审计数/转正措辞
          const text = await page.locator('[data-produce-pane="success"]').textContent();
          expect(text).not.toMatch(/已审|待审|审阅进度|转正|否决|draft|草稿/i);
        },
      },
      {
        id: "D-3-L2-stage",
        title: "layer 三值枚举 L2 变体（D-3）：L2 实体层分组同构渲染（阶段名+chip+批次 scope/计数）",
        run: async () => {
          const l2 = page.locator('[data-produce-stage][data-layer="L2"]');
          await expect(l2).toHaveCount(1);
          await expect(l2.locator(".kpn-stage-name")).toHaveText("L2 实体层");
          await expect(l2.locator(".hud-chip").first()).toHaveText("L2");
          const b3 = page.locator('[data-produce-batch][data-id="b-mock-3"]');
          await expect(b3.locator(".kpn-batch-name")).toHaveText("批次：实体与契约锚定");
          await expect(b3.locator(".hud-chip")).toHaveText("1 节点");
        },
      },
      {
        id: "D-3-anchor-line-null",
        title: "anchors[].line:null 变体（D-3）：无行号锚点渲染为纯路径（无 :行号 后缀），有行号锚点保持 路径:行号",
        run: async () => {
          const n4 = page.locator('[data-produce-node][data-id="E-B4"]');
          await expect(n4.locator(".kpn-name")).toHaveText("kg 写面单事务入口");
          await n4.locator('[data-act="toggle"]').click();
          const detail = n4.locator(".kpn-detail");
          await expect(detail).toBeVisible();
          await expect(detail.locator(".kpn-anchor")).toHaveCount(2);
          await expect(detail.locator(".kpn-anchor-path").nth(0)).toHaveText(
            "apps/daemon/src/services/kg/KgWriteService.ts:88",
          );
          // line:null → 仅路径，无 :行号 后缀（索引降级路径级精度形态）
          await expect(detail.locator(".kpn-anchor code").nth(1)).toHaveText("kgWriteTransaction");
          await expect(detail.locator(".kpn-anchor-path").nth(1)).toHaveText(
            "apps/daemon/src/services/kg/KgWriteService.ts",
          );
        },
      },
      {
        id: "R-14",
        title: "节点条目：粗体 name+kind 徽章+状态徽章（正式知识）+digest 首行单行截断；展开=正文/锚点（符号+路径:行号）/为什么存在/来源",
        run: async () => {
          const n1 = page.locator('[data-produce-node][data-id="TR-B1"]');
          await expect(n1.locator(".kpn-name")).toHaveText("连接私有读面不进会话 store");
          await expect(n1.locator(".kpn-name")).toHaveCSS("font-weight", "700");
          await expect(n1.locator(".kpn-kind")).toHaveText("rule");
          await expect(n1.locator(".st-confirmed")).toHaveText("正式知识");
          // digest 首行单行截断（mock digest 两行——只显首行）
          await expect(n1.locator(".kpn-digest")).toHaveText(
            "页面私有数据面（任务/图谱/产出）走连接级听众转发，dispatcher 零写入。",
          );
          // 展开 E-B2 四段
          const n2 = page.locator('[data-produce-node][data-id="E-B2"]');
          await n2.locator('[data-act="toggle"]').click();
          const detail = n2.locator(".kpn-detail");
          await expect(detail).toBeVisible();
          await expect(detail).toContainText("正文");
          await expect(detail).toContainText("graph 态单页 master-detail 组件");
          await expect(detail).toContainText("锚点");
          await expect(detail.locator(".kpn-anchor code")).toHaveText("KgViewer");
          await expect(detail.locator(".kpn-anchor-path")).toHaveText("apps/shell/src/pages/P-1/kg-viewer.tsx:44");
          await expect(detail).toContainText("为什么存在");
          await expect(detail).toContainText("V-3 单页裁决");
          await expect(detail).toContainText("来源：helix 知识图谱创建 · 批次：会话域");
          // 裸 id 零出现（机械核对：TR-B*/E-B*/job-mock/b-mock 均只见 data-id）
          const text = await visibleText(page);
          expect(text).not.toMatch(/\b(TR|E)-B\d+\b/);
          expect(text).not.toMatch(/\bjob-mock-\d+\b/);
          expect(text).not.toMatch(/\bb-mock-\d+\b/);
          // 任务详情链接出口 → /tasks
          await page.locator('[data-produce-group] [data-goto-tasks]').click();
          await expect(page.locator('[data-p2-task="/tasks"]')).toBeVisible({ timeout: 10_000 });
          expect(new URL(page.url()).pathname).toBe("/tasks");
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc2-3-produce-groups", "CL-4");
    assertFidelityGreen(report);
  });
});

test.describe("TS2 TC2.4 修正动作与连带标记（R-15/R-16 + CL-4-T3/T4）", () => {
  test("supersede：理由必填拦截 → 留史降档 + 理由展示 + 动作按钮消失 + 下游连带标记 + toast 数量", async ({ mock, page }) => {
    await openProject(mock, page);
    await enterGraph(page, "helix");
    await enterProduce(page);
    const checks: FidelityCheck[] = [
      {
        id: "R-15-supersede",
        title: "supersede：空理由拦截提示；填理由确认 → 已废弃徽章+理由留史展示+动作按钮消失+toast",
        run: async () => {
          const n2 = page.locator('[data-produce-node][data-id="E-B2"]');
          await n2.locator('[data-act="sup"]').click();
          const box = page.locator('[data-sup-box][data-id="E-B2"]');
          await expect(box).toBeVisible();
          await expect(box).toContainText("supersede 理由（必填");
          // 空理由拦截：不发送、条目保持 confirmed
          await box.locator('[data-act="supYes"]').click();
          await expect(box.locator("[data-sup-empty]")).toHaveText("supersede 需要填写理由");
          await expect(n2.locator(".st-confirmed")).toHaveText("正式知识");
          // 填理由 → 确认 → 留史降档
          await box.locator("[data-sup-reason]").fill("已被 V-3 单页裁决的新认知取代");
          await box.locator('[data-act="supYes"]').click();
          await expect(n2).toHaveAttribute("data-node-status", "superseded", { timeout: 10_000 });
          await expect(n2.locator(".st-superseded")).toHaveText("已废弃");
          await expect(n2.locator(".kpn-meta")).toContainText("已 supersede（留史可查）：已被 V-3 单页裁决的新认知取代");
          // 动作按钮消失（仅保留展开 toggle）
          expect(await n2.locator('[data-act="edit"]').count()).toBe(0);
          expect(await n2.locator('[data-act="sup"]').count()).toBe(0);
          await expect(page.locator(".toast-zone")).toContainText("已 supersede：知识图谱查看器");
        },
      },
      {
        id: "R-16",
        title: "连带标记：下游 E-B3 标「受影响待复核」（warning 徽章+条目 warning 态）+ toast 连带数量；只标记不自动处置",
        run: async () => {
          const n3 = page.locator('[data-produce-node][data-id="E-B3"]');
          await expect(n3).toHaveAttribute("data-affected", "true", { timeout: 10_000 });
          await expect(n3.locator(".kpn-aff")).toHaveText("⚠ 受影响待复核");
          await expect(n3.locator(".kpn-aff")).toHaveClass(/kg-sev-badge warn/);
          await expect(page.locator(".toast-zone")).toContainText("1 个下游节点标记「受影响待复核」");
          // 只标记不自动处置：E-B3 状态仍为 confirmed、动作按钮仍在
          await expect(n3).toHaveAttribute("data-node-status", "confirmed");
          await expect(n3.locator(".st-confirmed")).toHaveText("正式知识");
          await expect(n3.locator('[data-act="edit"]')).toBeVisible();
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc2-4-supersede-impact", "CL-4");
    assertFidelityGreen(report);
  });

  test("修改：内联编辑 digest+正文保存即 updateNode（保持 confirmed）+ 内联面互斥 + 无转正/批量转正/否决", async ({ mock, page }) => {
    await openProject(mock, page);
    await enterGraph(page, "helix");
    await enterProduce(page);
    const checks: FidelityCheck[] = [
      {
        id: "R-15-edit",
        title: "修改：内联编辑框（打开即展开节点）→ 保存即 updateNode → digest 更新 + 节点保持正式知识 + toast",
        run: async () => {
          const n1 = page.locator('[data-produce-node][data-id="TR-B1"]');
          await n1.locator('[data-act="edit"]').click();
          const box = page.locator('[data-edit-box][data-id="TR-B1"]');
          await expect(box).toBeVisible();
          await expect(box).toContainText("保存即更新（节点保持正式知识");
          await expect(n1.locator(".kpn-detail")).toBeVisible(); // edit 打开即展开
          await box.locator("[data-edit-digest]").fill("连接私有读面不进会话 store（修订版：补 AG-15 出处）。");
          await box.locator('[data-act="editYes"]').click();
          await expect(page.locator(".toast-zone")).toContainText("已修改：连接私有读面不进会话 store", { timeout: 10_000 });
          // digest 首行更新 + 状态保持 confirmed
          await expect(n1.locator(".kpn-digest")).toHaveText("连接私有读面不进会话 store（修订版：补 AG-15 出处）。");
          await expect(n1.locator(".st-confirmed")).toHaveText("正式知识");
          await expect(n1).toHaveAttribute("data-node-status", "confirmed");
        },
      },
      {
        id: "R-15-inline-mutex",
        title: "修正面内联态互斥：supersede 理由框 / 修改编辑框开一个清其余",
        run: async () => {
          const n1 = page.locator('[data-produce-node][data-id="TR-B1"]');
          const n3 = page.locator('[data-produce-node][data-id="E-B3"]');
          // 开 E-B3 编辑框 → 再开 TR-B1 supersede 框：编辑框消失
          await n3.locator('[data-act="edit"]').click();
          await expect(page.locator('[data-edit-box][data-id="E-B3"]')).toBeVisible();
          await n1.locator('[data-act="sup"]').click();
          await expect(page.locator('[data-sup-box][data-id="TR-B1"]')).toBeVisible();
          expect(await page.locator('[data-edit-box][data-id="E-B3"]').count()).toBe(0);
          // 取消 supersede → 全开另一编辑框：supersede 框消失
          await page.locator('[data-sup-box][data-id="TR-B1"] [data-act="cancel"]').click();
          await n3.locator('[data-act="edit"]').click();
          await expect(page.locator('[data-edit-box][data-id="E-B3"]')).toBeVisible();
          expect(await page.locator("[data-sup-box]").count()).toBe(0);
        },
      },
      {
        id: "R-15-no-promote",
        title: "无转正/批量转正/否决（V-1 无 draft 无审阅流）；每节点动作恰为 修改/supersede/展开",
        run: async () => {
          const labels = await page.locator('[data-produce-pane="success"] button').evaluateAll((bs) =>
            bs.map((b) => (b.textContent ?? "").trim()),
          );
          expect(labels.filter((x) => /转正|否决|批量/.test(x))).toHaveLength(0);
          const n3 = page.locator('[data-produce-node][data-id="E-B3"]');
          await expect(n3.locator('[data-act="edit"]')).toHaveText("修改");
          await expect(n3.locator('[data-act="sup"]')).toHaveText("supersede");
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc2-4-edit-inline", "CL-4");
    assertFidelityGreen(report);
  });
});

test.describe("TS2 TC2.5 空态与切项目复位（R-18 + CL-4-T6）", () => {
  test("无产出空态 + 切项目内联/展开/启动标记全复位", async ({ mock, page }) => {
    await openProject(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-18",
        title: "无产出空态（legacy）：「无 bootstrap 产出」+ 产出如何出现说明（分组+落盘即 confirmed+可修正）",
        run: async () => {
          await enterGraph(page, "legacy");
          await page.locator('[data-tab="produce"]').click();
          const empty = page.locator('[data-produce-pane="empty"]');
          await expect(empty).toBeVisible({ timeout: 10_000 });
          await expect(empty).toContainText("无 bootstrap 产出");
          await expect(empty).toContainText("按 任务 / 阶段 / 批次 分组呈现");
          await expect(empty).toContainText("落盘即 confirmed（正式知识）");
          await expect(empty).toContainText("修改或 supersede");
        },
      },
      {
        id: "CL-4-T6-reset",
        title: "切项目复位：helix 上开的内联面/展开态切走再切回全复位（kgToken 重挂 + produce 状态重建）",
        run: async () => {
          await enterGraph(page, "helix");
          await enterProduce(page);
          // 造旧态：E-B2 展开 + TR-B1 supersede 内联面
          const n2 = page.locator('[data-produce-node][data-id="E-B2"]');
          await n2.locator('[data-act="toggle"]').click();
          await expect(n2.locator(".kpn-detail")).toBeVisible();
          await page.locator('[data-produce-node][data-id="TR-B1"] [data-act="sup"]').click();
          await expect(page.locator('[data-sup-box][data-id="TR-B1"]')).toBeVisible();
          // 切走再切回
          await enterGraph(page, "feifei");
          await enterGraph(page, "helix");
          await enterProduce(page);
          // 内联面/展开态全复位
          expect(await page.locator("[data-sup-box]").count()).toBe(0);
          expect(await page.locator('[data-edit-box]').count()).toBe(0);
          expect(await page.locator(".kpn-node.open").count()).toBe(0);
          expect(await page.locator(".kpn-detail").count()).toBe(0);
        },
      },
      {
        id: "CL-4-T6-launched-reset",
        title: "切项目复位（入口区）：legacy 启动后 ok-strip 在；切走再切回 launched 标记复位（ready 卡+启动钮复现）",
        run: async () => {
          await enterGraph(page, "legacy");
          await page.locator("[data-launch-btn]").click();
          await expect(page.locator("[data-boot-launched]")).toBeVisible({ timeout: 10_000 });
          await expect(page.locator('[data-boot-entry="launched"]')).toBeVisible();
          // 切走再切回 → 启动标记复位（会话内标记不跨项目泄漏）
          await enterGraph(page, "helix");
          await enterGraph(page, "legacy");
          await expect(page.locator('[data-boot-entry="ready"]')).toBeVisible();
          await expect(page.locator("[data-launch-btn]")).toBeVisible();
          expect(await page.locator("[data-boot-launched]").count()).toBe(0);
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc2-5-empty-reset", "CL-1");
    assertFidelityGreen(report);
  });
});

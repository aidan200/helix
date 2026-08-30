/**
 * TS1 —— F 层 fidelity：P-2 任务页（CL-3；mock mode on，无 daemon）。
 *
 * 断言源（不靠猜）：
 * - prototype/review.md P-2「必须还原」R-1~R-9 + R-19（产品内容：视觉+行为
 *   规则；F3.6 删除为 V-1 新增续号）；
 * - review.md P-2 状态模型（loading/empty/filter-empty/success 互斥；选任务
 *   重置三件套）；
 * - F 行为规则（F3.1 过滤/排序、F3.2 阶段条、F3.3 批次 plan、F3.4 结果只读、
 *   F3.5 生命周期门控+两步确认、F3.6 终态删除）；
 * - mock 数据（tasks-mock.ts 六任务六态 + 多项目徽章 + 开放阶段类型 t6）；
 * - testing/test-design.md CL-3-T1~T12（fidelity 部分）+ verification/test-plan
 *   TS1 TC1.1~TC1.6。
 *
 * 断言边界：只断产品内容。原型标注 data-proto-annotation 断言不存在；
 * dev 演示控件（data-demo 全状态/空列表 seg，isDev 门控）只验可用性。
 *
 * 用例映射：
 * - TC1.1 布局与列表组织（R-1/R-2/R-9）
 * - TC1.2 过滤器与空态（R-3 + CL-1-T7 零创建）
 * - TC1.3 阶段条与批次 plan（R-4/R-5 + CL-3-T3/T4/T5 + WS task.changed 驱动）
 * - TC1.4 结果查询 tab（R-6 + CL-3-T6）
 * - TC1.5 生命周期门控与删除（R-7/R-19 + CL-3-T7/T12）
 * - TC1.6 事件导向进度与状态模型（R-8 + CL-3-T8/T10/T11 + 竞态复核）
 */
import { test, expect } from "./harness/fixtures";
import type { MockController } from "./harness/mock-session";
import type { Page } from "@playwright/test";
import { computed } from "./harness/style-utils";
import { evidencePath, shotEvidence } from "./harness/evidence";
import { welcome } from "./harness/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import { assertFidelityGreen, checkPrototypeFidelity, type FidelityCheck } from "./harness/prototype-fidelity";

const SID = "sess-tasks-fidelity";

/** 六任务 wire 序（运行中置顶 + 创建时间倒序，契约 §2 服务端排序镜像）。 */
const ORDER = ["job-8f21", "job-b90d", "job-71c4", "job-3ad6", "job-e55a", "job-04f7"];

/** 全页可见文本（AD-4 机械核对载体：.app-layout 树）。 */
function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector(".app-layout")!.textContent ?? "");
}

/** task.changed 推送帧（fake transport 注入；契约 §3 形状）。 */
function taskChanged(jobId: string, changed: "job" | "stage" | "batch" | "work_item", status?: string): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    type: "task.changed",
    sessionId: SYSTEM_SESSION_ID,
    channel: "notification",
    payload: { jobId, changed, ...(status !== undefined ? { status } : {}) },
  } as EventEnvelope;
}

/** 标准进页面：建连 → welcome → IconRail 进 /tasks → 六行列表收口。 */
async function openTasks(mock: MockController, page: Page): Promise<void> {
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emit(welcome({ sessionId: SID }));
  await mock.waitForConn("connected");
  await page.locator('.rail-btn[data-page="tasks"]').click();
  await expect(page.locator('[data-p2-task="/tasks"]')).toBeVisible();
  await expect(page.locator(".tk-row")).toHaveCount(6, { timeout: 10_000 });
}

/** 选中任务并等详情头收口。 */
async function selectTask(page: Page, jobId: string): Promise<void> {
  await page.locator(`.tk-row[data-id="${jobId}"]`).click();
  await expect(page.locator(`[data-tk-detail][data-id="${jobId}"]`)).toBeVisible({ timeout: 10_000 });
}

/** 详情头动作按钮集（data-act 序）。 */
async function headActions(page: Page): Promise<string[]> {
  return page.locator("[data-tk-actions] button").evaluateAll((bs) =>
    bs.map((b) => (b as HTMLElement).dataset.act ?? ""),
  );
}

test.describe("TS1 TC1.1 布局与列表组织（R-1/R-2/R-9）", () => {
  test("页顶栏/左栏 380px/双 tab + 排序 + 行六要素 + 详情元信息双宿主", async ({ mock, page }) => {
    await openTasks(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-1",
        title: "布局：页顶栏（页名+主题切换，48px）+左栏 380px 列表+右区详情（头+进度/结果查询双 tab）；IconRail 三页面域",
        run: async () => {
          await expect(page.locator(".app-header:visible")).toHaveCount(1);
          await expect(page.locator(".app-header:visible .tk-page-title")).toHaveText("任务");
          await expect(page.locator(".app-header:visible [data-theme-toggle]")).toBeVisible();
          await expect(page.locator(".app-header:visible")).toHaveCSS("height", "48px");
          expect(await computed(page, ".tk-side", "width")).toBe("380px");
          await expect(page.locator('[data-tk-tab="progress"]')).toHaveText("进度");
          await expect(page.locator('[data-tk-tab="result"]')).toHaveText("结果查询");
          // IconRail 全局导航三页面域（会话/项目/任务）在列
          for (const p of ["chat", "project", "tasks"]) {
            await expect(page.locator(`.rail-btn[data-page="${p}"]`)).toBeVisible();
          }
        },
      },
      {
        id: "R-2-sort",
        title: "列表组织：全局平铺，运行中置顶 + 创建时间倒序",
        run: async () => {
          const ids = await page.locator(".tk-row").evaluateAll((rows) =>
            rows.map((r) => (r as HTMLElement).dataset.id),
          );
          expect(ids).toEqual(ORDER);
          // 计数行
          await expect(page.locator("[data-tk-count]")).toHaveText("共 6 个任务 · 运行中置顶");
        },
      },
      {
        id: "R-2-row",
        title: "行六要素：类型徽章+六态徽章（running 脉冲点）+粗体标题+进度条/阶段·批次 x/y+项目徽章 0..n+时间",
        run: async () => {
          const t1 = page.locator('.tk-row[data-id="job-8f21"]');
          await expect(t1.locator("[data-task-type]")).toHaveText("kg-bootstrap");
          await expect(t1.locator('[data-task-status="running"]')).toContainText("运行中");
          await expect(t1.locator(".tk-dot-run")).toBeVisible(); // 脉冲点
          await expect(t1.locator(".tk-row-title")).toHaveText("helix 知识图谱创建");
          await expect(t1.locator(".tk-row-title")).toHaveCSS("font-weight", "600");
          await expect(t1.locator(".tk-progress")).toBeVisible();
          await expect(t1.locator(".tk-row-prog-t")).toHaveText("L1 领域层 · 批次 3/5");
          await expect(t1.locator('[data-proj="helix"]')).toBeVisible();
          await expect(t1.locator(".tk-time")).toContainText("创建");
          // 项目徽章 0..n：t6 双项目 chip（helix + web-access）
          const t6 = page.locator('.tk-row[data-id="job-04f7"]');
          await expect(t6.locator(".hud-chip[data-proj]")).toHaveCount(2);
          // 六态徽章语义文案各就位
          await expect(page.locator('.tk-row[data-id="job-b90d"] [data-task-status="pending"]')).toHaveText("装配中");
          await expect(page.locator('.tk-row[data-id="job-71c4"] [data-task-status="paused"]')).toHaveText("已暂停");
          await expect(page.locator('.tk-row[data-id="job-3ad6"] [data-task-status="done"]')).toHaveText("已完成");
          await expect(page.locator('.tk-row[data-id="job-e55a"] [data-task-status="failed"]')).toHaveText("失败");
          await expect(page.locator('.tk-row[data-id="job-04f7"] [data-task-status="cancelled"]')).toHaveText("已取消");
        },
      },
      {
        id: "R-9",
        title: "详情元信息：项目 chip+创建时间+时长+发起来源（「项目」页发起 / 会话发起 双宿主如实）",
        run: async () => {
          // list-result 自动选中首行 job-8f21（createdBy=page）
          const head = page.locator('[data-tk-detail][data-id="job-8f21"]');
          await expect(head).toBeVisible({ timeout: 10_000 });
          await expect(head.locator('[data-proj="helix"]')).toBeVisible();
          await expect(head.locator("[data-tk-created]")).toContainText("创建");
          await expect(head.locator("[data-tk-duration]")).toContainText("已运行");
          await expect(head.locator("[data-tk-source]")).toHaveText("「项目」页发起");
          // t3 会话发起（createdBy=chat）
          await selectTask(page, "job-b90d");
          await expect(page.locator("[data-tk-source]")).toHaveText("会话发起");
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc1-1-layout-list", "CL-3");
    assertFidelityGreen(report);
  });
});

test.describe("TS1 TC1.2 过滤器与空态（R-3 + CL-1-T7）", () => {
  test("状态/项目 seg 普通过滤 + 无匹配清除过滤 + 空列表指路宿主 + 零创建 + 断言边界", async ({ mock, page }) => {
    await openTasks(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-3-seg",
        title: "过滤器：状态 seg（全部+六态）+ 项目 seg（数据驱动并集），普通过滤不分栏",
        run: async () => {
          const statusSeg = page.locator('[data-tk-filter-status] [data-tk-seg="status"]');
          await expect(statusSeg).toHaveCount(7);
          const projSeg = page.locator('[data-tk-filter-project] [data-tk-seg="project"]');
          await expect(projSeg).toHaveCount(5); // 全部项目 + helix/web-access/pi-src/sandpile
          // 状态过滤：已取消 → 1 行
          await page.locator('[data-tk-filter-status] button[data-v="cancelled"]').click();
          await expect(page.locator(".tk-row")).toHaveCount(1);
          await expect(page.locator('.tk-row[data-id="job-04f7"]')).toBeVisible();
          // 叠加项目过滤：pi-src → 无匹配
          await page.locator('[data-tk-filter-project] button[data-v="pi-src"]').click();
          await expect(page.locator(".tk-row")).toHaveCount(0);
        },
      },
      {
        id: "R-3-filter-empty",
        title: "无匹配空态：带「清除过滤」出口；清除后恢复全量",
        run: async () => {
          await expect(page.locator('[data-tk-empty="filter"]')).toBeVisible();
          await expect(page.locator('[data-tk-empty="filter"]')).toContainText("没有匹配的任务");
          await page.locator("[data-tk-clear-filters]").click();
          await expect(page.locator(".tk-row")).toHaveCount(6);
          await expect(page.locator('[data-tk-empty="filter"]')).toHaveCount(0);
        },
      },
      {
        id: "R-3-empty+CL-1-T7",
        title: "空列表态指路宿主（前往「项目」页 CTA → /project）；任务页零创建入口（任何状态）",
        run: async () => {
          // dev 演示控件（data-demo）可用性：切空列表
          await page.locator('[data-tk-demo] button[data-v="empty"]').click();
          await expect(page.locator('[data-tk-empty="list"]')).toBeVisible();
          await expect(page.locator('[data-tk-empty="list"]')).toContainText("暂无任务");
          await expect(page.locator('[data-tk-empty="list"]')).toContainText("任务从宿主上下文发起");
          await expect(page.locator('[data-tk-mode="empty"]')).toBeVisible();
          // 空态 CTA → /project
          await page.locator("[data-tk-goto-project]").click();
          await expect(page.locator('[data-p1-project="/project"]')).toBeVisible({ timeout: 10_000 });
          expect(new URL(page.url()).pathname).toBe("/project");
          // 回任务页恢复（演示控件切回全状态）
          await page.locator('.rail-btn[data-page="tasks"]').click();
          await expect(page.locator('[data-p2-task="/tasks"]')).toBeVisible();
          await page.locator('[data-tk-demo] button[data-v="full"]').click();
          await expect(page.locator(".tk-row")).toHaveCount(6);
          // 零创建：全页面按钮无「创建/新建」语义（空列表/过滤/详情各态均无）
          const labels = await page.locator(".tk-main button, .tk-side button").evaluateAll((bs) =>
            bs.map((b) => (b.textContent ?? "").trim()),
          );
          expect(labels.filter((x) => /新建|创建任务|发起任务/.test(x))).toHaveLength(0);
        },
      },
      {
        id: "断言边界",
        title: "原型标注 data-proto-annotation 不存在；dev 演示控件 data-demo 在场（只验可用性）",
        run: async () => {
          expect(await page.locator("[data-proto-annotation]").count()).toBe(0);
          await expect(page.locator("[data-tk-demo]")).toBeVisible();
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc1-2-filter-empty", "CL-3");
    assertFidelityGreen(report);
  });
});

test.describe("TS1 TC1.3 阶段条与批次 plan（R-4/R-5 + WS 推送驱动）", () => {
  test("stage 行驱动四态子行+连接线着色 + 批次六件 + plan 展开 + 开放阶段同构 + task.changed 驱动重拉", async ({ mock, page }) => {
    await openTasks(mock, page);
    await selectTask(page, "job-8f21");
    const checks: FidelityCheck[] = [
      {
        id: "D-2-sub-bookkeeping",
        title: "task.subscribe 连接级簿记生效（D-2）：进页自动订阅全部（mock 控制面读面 "*"），changed 帧按订阅过滤投递的订阅面就位",
        run: async () => {
          await expect.poll(() => mock.taskSubs(), { timeout: 5_000 }).toEqual(["*"]);
        },
      },
      {
        id: "R-4",
        title: "通用阶段条：序号/✓/●/✕ + 阶段名 + 四态子行；连接线随完成态着色",
        run: async () => {
          const bar = page.locator("[data-tk-stagebar]");
          await expect(bar.locator('[data-tk-stage]')).toHaveCount(3);
          await expect(bar.locator('[data-tk-stage="done"] .tk-stage-ic')).toHaveText("✓");
          await expect(bar.locator('[data-tk-stage="running"] .tk-stage-ic')).toHaveText("●");
          await expect(bar.locator('[data-tk-stage="pending"] .tk-stage-ic')).toHaveText("3");
          await expect(bar.locator('[data-stage-seq="1"] .tk-stage-name')).toHaveText("L0 核心层");
          await expect(bar.locator('[data-stage-seq="1"] .tk-stage-sub')).toHaveText("已完成 · 产出 3 节点");
          await expect(bar.locator('[data-stage-seq="2"] .tk-stage-sub')).toHaveText("进行中 · 批次 3/5");
          await expect(bar.locator('[data-stage-seq="3"] .tk-stage-sub')).toHaveText("待启动");
          // 连接线：仅 done 段着色（stage1 done → conn.done 恰 1 条）
          await expect(bar.locator(".tk-stage-conn.done")).toHaveCount(1);
          await expect(bar.locator(".tk-stage-conn:not(.done)")).toHaveCount(1);
        },
      },
      {
        id: "R-5",
        title: "批次列表：范围粗体+状态徽章+重试 warning 如实+原因 note+实例 plan（进度行/正在/可展开台账）+待启动队列文案",
        run: async () => {
          const batches = page.locator("[data-tk-batch]");
          await expect(batches).toHaveCount(5);
          // 范围粗体
          await expect(page.locator('[data-tk-batch][data-id="batch-1a"] .tk-b-scope')).toHaveText("daemon 任务引擎域");
          await expect(page.locator('[data-tk-batch][data-id="batch-1a"] .tk-b-scope')).toHaveCSS("font-weight", "600");
          // 重试如实：batch-1b retryCount=1 → warning 徽数 + 原因 note
          const b1b = page.locator('[data-tk-batch][data-id="batch-1b"]');
          await expect(b1b.locator("[data-tk-retry]")).toHaveText("自动重试 1 次");
          await expect(b1b.locator("[data-tk-retry-note]")).toContainText("自动重试 1 次后通过");
          // 实例 plan：batch-1c 4/6 项完成 + 正在：
          const b1c = page.locator('[data-tk-batch][data-id="batch-1c"]');
          await expect(b1c.locator(".tk-b-plan-t")).toHaveText("3/6 项完成");
          await expect(b1c.locator("[data-tk-doing]")).toContainText("正在：");
          await expect(b1c.locator("[data-tk-doing]")).toContainText("写 task.detail / task.artifacts 契约节点");
          // 台账展开（默认收起 → 展开 6 行四态图标）
          expect(await b1c.locator("[data-tk-plan-items]").count()).toBe(0);
          await b1c.locator("[data-tk-plan-toggle]").click();
          const items = b1c.locator("[data-tk-plan-items] .tk-pi");
          await expect(items).toHaveCount(6);
          await expect(b1c.locator('[data-tk-work="done"]')).toHaveCount(3);
          await expect(b1c.locator('[data-tk-work="in_progress"]')).toHaveCount(1);
          await expect(b1c.locator('[data-tk-work="pending"]')).toHaveCount(2);
          await expect(b1c.locator('[data-tk-work="done"] .tk-pi-ic').first()).toHaveText("✓");
          await expect(b1c.locator('[data-tk-work="in_progress"] .tk-pi-ic')).toHaveText("●");
          // 待启动批次：队列文案、无 plan 行
          const b1d = page.locator('[data-tk-batch][data-id="batch-1d"]');
          await expect(b1d.locator("[data-tk-batch-queued]")).toHaveText("待启动：批次范围已划定，队列中等待派发。");
        },
      },
      {
        id: "R-4/5-free（CL-3-T3）",
        title: "开放阶段类型（t6 依赖盘点→归类→汇总）同构渲染零特例；failed 批次 abandoned 台账带理由",
        run: async () => {
          await selectTask(page, "job-04f7");
          const bar = page.locator("[data-tk-stagebar]");
          await expect(bar.locator('[data-stage-seq="1"] .tk-stage-name')).toHaveText("依赖盘点");
          await expect(bar.locator('[data-stage-seq="2"] .tk-stage-name')).toHaveText("许可证归类");
          await expect(bar.locator('[data-stage-seq="3"] .tk-stage-name')).toHaveText("风险汇总");
          await expect(bar.locator('[data-stage-seq="1"] .tk-stage-sub')).toHaveText("已完成 · 产出 1 节点");
          // failed 任务（t5）：✕ 阶段 + failed 批次 + 重试 2 次 + abandoned 带理由
          await selectTask(page, "job-e55a");
          await expect(page.locator('[data-tk-stage="failed"] .tk-stage-ic')).toHaveText("✕");
          await expect(page.locator('[data-tk-stage="failed"] .tk-stage-sub')).toHaveText("失败");
          const b5b = page.locator('[data-tk-batch][data-id="batch-5b"]');
          await expect(b5b.locator("[data-tk-retry]")).toHaveText("自动重试 2 次");
          await expect(b5b.locator("[data-tk-retry-note]")).toContainText("已达自动重试上限");
          await b5b.locator("[data-tk-plan-toggle]").click();
          await expect(b5b.locator('[data-tk-work="abandoned"] .tk-pi-ic')).toHaveText("✕");
          await expect(b5b.locator('[data-tk-work="abandoned"]')).toContainText("放弃：上下文不足，执行实例终止");
        },
      },
      {
        id: "CL-3-T4",
        title: "WS 推送驱动：task.changed(batch) → 选中任务重拉 detail；task.changed(job) → 重拉 list+detail",
        run: async () => {
          await selectTask(page, "job-8f21");
          const countCmd = async (type: string) =>
            (await mock.clientFrames()).filter((f) => f.type === type).length;
          const detailBefore = await countCmd("task.detail");
          const listBefore = await countCmd("task.list");
          // batch 面变更：仅重拉 detail（选中任务）
          await mock.emit(taskChanged("job-8f21", "batch"));
          await expect
            .poll(async () => countCmd("task.detail"), { timeout: 5_000 })
            .toBe(detailBefore + 1);
          expect(await countCmd("task.list")).toBe(listBefore);
          // job 面变更：重拉 list + detail
          await mock.emit(taskChanged("job-8f21", "job", "running"));
          await expect
            .poll(async () => countCmd("task.list"), { timeout: 5_000 })
            .toBe(listBefore + 1);
          await expect
            .poll(async () => countCmd("task.detail"), { timeout: 5_000 })
            .toBe(detailBefore + 2);
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc1-3-stage-batch", "CL-3");
    assertFidelityGreen(report);
  });
});

test.describe("TS1 TC1.4 结果查询 tab（R-6 + CL-3-T6）", () => {
  test("阶段产物卡 + 节点条目人类可读 + 无产物空态 + confirmed 尾注 + tab 内零写动作", async ({ mock, page }) => {
    await openTasks(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-6-card",
        title: "阶段产物卡：阶段名+状态徽章+产出计数 chip+阶段摘要+节点清单（t1 仅 L0 有产物）",
        run: async () => {
          await selectTask(page, "job-8f21");
          await page.locator('[data-tk-tab="result"]').click();
          const art = page.locator('[data-tk-art][data-stage-seq="1"]');
          await expect(art).toBeVisible({ timeout: 10_000 });
          await expect(page.locator("[data-tk-art]")).toHaveCount(1); // 仅 L0 有产物
          await expect(art.locator(".tk-art-name")).toHaveText("L0 核心层");
          await expect(art.locator('[data-phase="stage"]')).toHaveText("已完成");
          await expect(art.locator("[data-tk-art-count]")).toHaveText("产出 3 节点");
          await expect(art.locator(".tk-art-sum")).toContainText("核心层完成");
          await expect(art.locator("[data-tk-node]")).toHaveCount(3);
        },
      },
      {
        id: "R-6-node",
        title: "节点条目：粗体 name+kind 徽章+digest 首行+「项目」页查看链接；裸 id 仅 data-id（AD-4）",
        run: async () => {
          const n1 = page.locator('[data-tk-node][data-id="kg-n-101"]');
          await expect(n1.locator(".tk-n-name")).toHaveText("daemon 四层架构基线");
          await expect(n1.locator(".tk-n-name")).toHaveCSS("font-weight", "600");
          await expect(n1.locator('[data-node-kind="rule"]')).toBeVisible();
          await expect(n1.locator(".tk-n-digest")).toContainText("daemon 按 adapters / application / domain / infrastructure 分层");
          await expect(n1.locator("[data-tk-node-link]")).toHaveText("在「项目」页查看 →");
          // 机械核对：可见文本零裸 id（kg-n-* / job-* / batch-*）
          const text = await visibleText(page);
          expect(text).not.toMatch(/kg-n-\d+/);
          expect(text).not.toMatch(/\bjob-[0-9a-f]{4}\b/);
          expect(text).not.toMatch(/\bbatch-[0-9a-z]+\b/);
          // 链接出口 → /project（AD-10：查看与修正转项目页）
          await n1.locator("[data-tk-node-link]").click();
          await expect(page.locator('[data-p1-project="/project"]')).toBeVisible({ timeout: 10_000 });
          await page.locator('.rail-btn[data-page="tasks"]').click();
          await selectTask(page, "job-8f21");
          await page.locator('[data-tk-tab="result"]').click();
          await expect(page.locator('[data-tk-art][data-stage-seq="1"]')).toBeVisible({ timeout: 10_000 });
        },
      },
      {
        id: "R-6-footnote",
        title: "尾注 confirmed 语义（V-1 无 draft）：落盘即正式知识、已参与附着/注入、修正转项目页；零 draft/审阅/转正措辞",
        run: async () => {
          const note = page.locator("[data-tk-art-footnote]");
          await expect(note).toContainText("confirmed（正式知识）");
          await expect(note).toContainText("附着 / 注入");
          await expect(note).toContainText("「项目」页");
          const text = await visibleText(page);
          expect(text).not.toMatch(/草稿|draft|审阅|转正|否决/i);
        },
      },
      {
        id: "R-6-superseded+zero-write",
        title: "superseded 节点降档呈现（t4）；tab 内零写动作",
        run: async () => {
          await selectTask(page, "job-3ad6");
          await page.locator('[data-tk-tab="result"]').click();
          const sup = page.locator('[data-tk-node][data-id="kg-n-205"]');
          await expect(sup).toBeVisible({ timeout: 10_000 });
          await expect(sup.locator(".tk-n-name")).toHaveClass(/dim/);
          // 结果 tab 内零写动作：无 删除/修改/supersede/暂停/取消 按钮
          const paneButtons = await page.locator('[data-tk-pane="result"] button').evaluateAll((bs) =>
            bs.map((b) => (b.textContent ?? "").trim()),
          );
          expect(paneButtons.filter((x) => /删除|修改|supersede|暂停|取消|转正/.test(x))).toHaveLength(0);
        },
      },
      {
        id: "R-6-empty",
        title: "无产物空态：尚无阶段产物（t3 全阶段 artifact null）",
        run: async () => {
          await selectTask(page, "job-b90d");
          await page.locator('[data-tk-tab="result"]').click();
          await expect(page.locator('[data-tk-empty="artifacts"]')).toBeVisible({ timeout: 10_000 });
          await expect(page.locator('[data-tk-empty="artifacts"]')).toContainText("尚无阶段产物");
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc1-4-result-tab", "CL-3");
    assertFidelityGreen(report);
  });
});

test.describe("TS1 TC1.5 生命周期门控与删除（R-7/R-19 + F3.5/F3.6）", () => {
  test("六态门控矩阵 + 取消两步确认", async ({ mock, page }) => {
    await openTasks(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-7-gate",
        title: "门控矩阵：pending=取消 / running=暂停+取消 / paused=继续+取消 / 三终态=删除（运行中无删除钮）",
        run: async () => {
          await selectTask(page, "job-b90d");
          expect(await headActions(page)).toEqual(["cancel"]);
          await selectTask(page, "job-8f21");
          expect(await headActions(page)).toEqual(["pause", "cancel"]);
          await selectTask(page, "job-71c4");
          expect(await headActions(page)).toEqual(["resume", "cancel"]);
          for (const jobId of ["job-3ad6", "job-e55a", "job-04f7"]) {
            await selectTask(page, jobId);
            expect(await headActions(page)).toEqual(["delete"]);
          }
        },
      },
      {
        id: "R-7-cancel",
        title: "取消两步内联确认（批次收口+产出保留 confirmed+不可撤销）；返回不操作；确认后徽章/toast/按钮联动",
        run: async () => {
          await selectTask(page, "job-b90d");
          await page.locator('[data-act="cancel"]').click();
          const box = page.locator('[data-tk-confirm="cancel"]');
          await expect(box).toBeVisible();
          await expect(box).toContainText("批次会收口");
          await expect(box).toContainText("confirmed 正式知识");
          await expect(box).toContainText("不可撤销");
          // 返回：不取消
          await page.locator("[data-tk-confirm-back]").click();
          await expect(box).toHaveCount(0);
          await expect(page.locator('[data-tk-detail] [data-task-status="pending"]')).toBeVisible();
          // 确认取消 → 徽章翻已取消 + 按钮集翻删除 + toast
          await page.locator('[data-act="cancel"]').click();
          await page.locator('[data-tk-confirm-yes="cancel"]').click();
          await expect(page.locator('[data-tk-detail] [data-task-status="cancelled"]')).toBeVisible({ timeout: 10_000 });
          expect(await headActions(page)).toEqual(["delete"]);
          await expect(page.locator(".toast-zone")).toContainText("任务已取消：已完成阶段产出保留（confirmed）");
          // 列表行同步翻（task.changed 广播驱动重拉收口）
          await expect(page.locator('.tk-row[data-id="job-b90d"] [data-task-status="cancelled"]')).toBeVisible({ timeout: 10_000 });
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc1-5a-gate-cancel", "CL-3");
    assertFidelityGreen(report);
  });

  test("暂停/继续 + 删除两步确认与列表联动", async ({ mock, page }) => {
    await openTasks(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-7-pause-resume",
        title: "暂停/继续免确认直发 + task.changed 广播驱动重拉（列表行就地刷新）",
        run: async () => {
          await selectTask(page, "job-8f21");
          const listCountBefore = (await mock.clientFrames()).filter((f) => f.type === "task.list").length;
          await page.locator('[data-act="pause"]').click();
          await expect(page.locator('[data-tk-detail] [data-task-status="paused"]')).toBeVisible({ timeout: 10_000 });
          expect(await headActions(page)).toEqual(["resume", "cancel"]);
          await expect(page.locator(".toast-zone")).toContainText("任务已暂停");
          // mock 生命周期成功伴发 task.changed 广播 → 页面重拉 list（推送驱动链）
          await expect
            .poll(
              async () => (await mock.clientFrames()).filter((f) => f.type === "task.list").length,
              { timeout: 5_000 },
            )
            .toBeGreaterThan(listCountBefore);
          await expect(page.locator('.tk-row[data-id="job-8f21"] [data-task-status="paused"]')).toBeVisible({ timeout: 10_000 });
          // 继续 → 运行中
          await page.locator('[data-act="resume"]').click();
          await expect(page.locator('[data-tk-detail] [data-task-status="running"]')).toBeVisible({ timeout: 10_000 });
          await expect(page.locator(".toast-zone")).toContainText("任务已继续");
          // 还原：重新暂停前无需——本 test 内 store 独立，继续留 running
        },
      },
      {
        id: "R-19-delete",
        title: "F3.6 删除：两步确认（任务域清理+kg 产出不动+不可撤销）；返回不删；确认后列表移除+选中回落首项+toast 交代",
        run: async () => {
          await selectTask(page, "job-04f7"); // cancelled 终态
          await page.locator('[data-act="delete"]').click();
          const box = page.locator('[data-tk-confirm="delete"]');
          await expect(box).toBeVisible();
          await expect(box).toContainText("任务 / 阶段 / 批次行与各批次实例工作台账");
          await expect(box).toContainText("不可撤销");
          await expect(box).toContainText("kg 产出（知识节点）不受影响");
          // 返回：不删
          await page.locator("[data-tk-confirm-back]").click();
          await expect(box).toHaveCount(0);
          await expect(page.locator(".tk-row")).toHaveCount(6);
          // 确认删除 → 列表 6→5 + 该行移除 + 选中回落首项（running 置顶 job-8f21）+ toast
          await page.locator('[data-act="delete"]').click();
          await page.locator('[data-tk-confirm-yes="delete"]').click();
          await expect(page.locator(".tk-row")).toHaveCount(5, { timeout: 10_000 });
          await expect(page.locator('.tk-row[data-id="job-04f7"]')).toHaveCount(0);
          await expect(page.locator('.tk-row[data-id="job-8f21"]')).toHaveClass(/selected/);
          await expect(page.locator('[data-tk-detail][data-id="job-8f21"]')).toBeVisible({ timeout: 10_000 });
          await expect(page.locator(".toast-zone")).toContainText(
            "任务已删除：依赖许可证合规扫描（任务域记录已清理，kg 产出保留）",
          );
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc1-5b-pause-delete", "CL-3");
    assertFidelityGreen(report);
  });
});

test.describe("TS1 TC1.6 事件导向进度与状态模型（R-8 + CL-3-T8/T10/T11 + 竞态复核）", () => {
  test("叙述句贯穿六态 + 终态行动出口 + 选任务重置三件套 + 快速切换竞态 + Cyber HUD 双主题", async ({ mock, page }) => {
    await openTasks(mock, page);
    const checks: FidelityCheck[] = [
      {
        id: "R-8",
        title: "「当前：…」叙述句贯穿六态（失败含原因+出口 / 取消含产出交代 / pending 装配说明）；终态行动出口 → /project",
        run: async () => {
          const narrative = page.locator("[data-tk-narrative]");
          await selectTask(page, "job-8f21");
          await expect(narrative).toContainText("当前：");
          await expect(narrative).toContainText("批次「protocol 命令族扩展」进行中");
          await selectTask(page, "job-b90d");
          await expect(narrative).toContainText("装配");
          await selectTask(page, "job-e55a");
          await expect(narrative).toContainText("两次自动重试均失败");
          await expect(narrative).toContainText("可在「项目」页确认索引状态后发起新任务");
          await selectTask(page, "job-04f7");
          await expect(narrative).toContainText("取消");
          await expect(narrative).toContainText("阶段产物保留");
          // 终态行动出口
          await selectTask(page, "job-3ad6");
          await expect(narrative).toContainText("落盘即 confirmed");
          await page.locator("[data-tk-go-project]").click();
          await expect(page.locator('[data-p1-project="/project"]')).toBeVisible({ timeout: 10_000 });
          await page.locator('.rail-btn[data-page="tasks"]').click();
          await expect(page.locator('[data-p2-task="/tasks"]')).toBeVisible();
          // 非终态无行动出口按钮
          await selectTask(page, "job-8f21");
          expect(await page.locator("[data-tk-go-project]").count()).toBe(0);
        },
      },
      {
        id: "CL-3-T10",
        title: "状态模型互斥与选任务重置：tab 回进度 + 确认条收起 + plan 收起；列表/详情各自状态机",
        run: async () => {
          await selectTask(page, "job-8f21");
          // 造旧态：切结果 tab + 展开 plan + 开取消确认条
          await page.locator('[data-tk-tab="progress"]').click();
          await page.locator('[data-tk-batch][data-id="batch-1c"] [data-tk-plan-toggle]').click();
          await expect(page.locator('[data-tk-batch][data-id="batch-1c"] [data-tk-plan-items]')).toBeVisible();
          await page.locator('[data-act="cancel"]').click();
          await expect(page.locator('[data-tk-confirm="cancel"]')).toBeVisible();
          await page.locator('[data-tk-tab="result"]').click();
          await expect(page.locator('[data-tk-pane="result"]')).toBeVisible();
          // 选新任务 → 三件套重置
          await selectTask(page, "job-71c4");
          await expect(page.locator('[data-tk-pane="progress"]')).toBeVisible(); // tab 回进度
          expect(await page.locator('[data-tk-confirm="cancel"]').count()).toBe(0); // 确认条收起
          expect(await page.locator("[data-tk-plan-items]").count()).toBe(0); // plan 收起
          // 视图态互斥承载：data-tk-mode 恰一值
          const mode = await page.locator(".tk-main").getAttribute("data-tk-mode");
          expect(["loading", "empty", "filter-empty", "success"]).toContain(mode);
          await expect(page.locator('[data-tk-mode="success"]')).toBeVisible();
          expect(await page.locator("[data-tk-skeleton]").count()).toBe(0); // 稳态零骨架（互斥）
        },
      },
      {
        id: "TC1.6-race",
        title: "快速切换任务竞态（ISSUE-T3.1-artifacts-race 复核）：artifacts 在途帧 FIFO 对号不错位",
        run: async () => {
          // t1 结果 tab 请求在途 → 立即切 t4 → 再进结果 tab：迟到回执不得错位落库
          await selectTask(page, "job-8f21");
          await page.locator('[data-tk-tab="result"]').click();
          await page.locator('.tk-row[data-id="job-3ad6"]').click(); // 竞态点：不回等直接切
          await page.locator('[data-tk-tab="result"]').click();
          // 终态：t4 产物呈现，t1 节点零混入
          await expect(page.locator('[data-tk-art][data-stage-seq="3"]')).toBeVisible({ timeout: 10_000 });
          await expect(page.locator('[data-tk-pane="result"]')).toContainText("实体层完成：15 个实体 / 契约节点");
          await expect(page.locator('[data-tk-node][data-id="kg-n-203"]')).toBeVisible();
          expect(await page.locator('[data-tk-node][data-id="kg-n-101"]').count()).toBe(0);
          const text = await page.locator('[data-tk-pane="result"]').textContent();
          expect(text).not.toContain("daemon 四层架构基线");
        },
      },
      {
        id: "CL-3-T11",
        title: "风格沿用：Cyber HUD 双主题（dark 默认/html.light 切换）+ accent token（暗 #22D3EE/亮 #2563EB）",
        run: async () => {
          const accent = () =>
            page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
          expect(await page.evaluate(() => document.documentElement.classList.contains("light"))).toBe(false);
          expect((await accent()).toUpperCase()).toBe("#22D3EE");
          await page.locator(".app-header [data-theme-toggle]").click();
          await expect(page.locator("html")).toHaveClass(/light/);
          expect((await accent()).toUpperCase()).toBe("#2563EB");
          expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("light");
          await page.locator(".app-header [data-theme-toggle]").click();
          expect(await page.evaluate(() => document.documentElement.classList.contains("light"))).toBe(false);
          expect((await accent()).toUpperCase()).toBe("#22D3EE");
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await shotEvidence(page, "fidelity-tc1-6-narrative-race-theme", "CL-3");
    assertFidelityGreen(report);
  });
});

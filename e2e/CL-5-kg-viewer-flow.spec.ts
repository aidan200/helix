/**
 * verification TS2 —— CL-5（P-1 图谱查看页）B 层用户流 E2E（mock mode on）。
 *
 * 与 F 层（CL-5-fidelity-kg-viewer.spec.ts，像素/清单还原）分工：本套件验
 * 「用户流走得通」——左栏选项目→折叠/展开→主区四态状态机→列表过滤→详情
 * 跳转→报告行动项→索引面板→B1 冷启动→转正写动作，一条真实操作链贯通；
 * 并抽查六命令 ws 帧的 project 作用域字段（A1/B1：五图谱命令必填 project）。
 *
 * F 层已覆盖的清单项此处映射引用不重复深断（见 spec 内注释）；
 * 本套件同时补 F 层三个核对缺口（TC1.2 产出）：
 * - FID-23 项目列表行骨架（首拉 .pj-plist 骨架）；
 * - FID-27 building 行徽章「构建中 · N%」；
 * - FID-28 building 次行「N / M 符号」。
 *
 * 断言来源：test-design §3.2 状态模型（互斥/清旧态）、review.md 行为规则、
 * contracts/kg-viewer-api.md mock 数据形状。证据落 evidence/e2e/（CL-5 前缀）。
 */
import { test, expect } from "./harness/fixtures";
import type { MockController } from "./harness/mock-session";
import type { Page } from "@playwright/test";
import { shotEvidence } from "./harness/evidence";
import { welcome } from "./harness/protocol";

const SID = "sess-kg-flow";

/** 标准进页面：建连 → welcome → IconRail 进 /project → 左栏 13 行收口。 */
async function openProject(mock: MockController, page: Page): Promise<void> {
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emit(welcome({ sessionId: SID }));
  await mock.waitForConn("connected");
  await page.locator('.rail-btn[data-page="project"]').click();
  await expect(page.locator('[data-p1-project="/project"]')).toBeVisible();
  await expect(page.locator(".pj-row")).toHaveCount(13, { timeout: 10_000 });
}

/** 末帧（type 过滤后）payload 读取——ws 命令 project 作用域抽查。 */
async function lastPayload(mock: MockController, type: string): Promise<Record<string, unknown>> {
  const frames = (await mock.clientFrames()).filter((f) => f.type === type);
  expect(frames.length, `${type} 帧应已发出`).toBeGreaterThan(0);
  return (frames[frames.length - 1]!.payload ?? {}) as Record<string, unknown>;
}

test.describe("CL-5 B 层：P-1 主用户流全链路（TC2.1）", () => {
  test("选项目→折叠/展开→四态状态机→过滤→详情跳转→报告行动项→索引面板", async ({ mock, page }) => {
    // ── 0. 未连接态先进 /project：项目列表首拉骨架（补 FID-23 缺口）──
    await page.locator('.rail-btn[data-page="project"]').click();
    await expect(page.locator('[data-p1-project="/project"]')).toBeVisible();
    await expect(page.locator(".pj-plist .kg-skel-row").first()).toBeVisible();
    await expect(page.locator('[data-pj-main="empty"]')).toBeVisible();

    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emit(welcome({ sessionId: SID }));
    await mock.waitForConn("connected");
    // kg.projects 自动首拉 → 骨架消退、13 行到位
    await mock.waitForCommand("kg.projects");
    await expect(page.locator(".pj-row")).toHaveCount(13, { timeout: 10_000 });
    await expect(page.locator(".pj-plist .kg-skel-row")).toHaveCount(0);

    // ── 1. 选 synced 项目（helix）→ 自动折叠 64px 窄轨 + 主区 graph ──
    await page.locator('.pj-row[data-name="helix"]').click();
    await expect(page.locator('[data-pj-rail="collapsed"]')).toBeVisible();
    await expect(page.locator(".pj-rail-name")).toHaveText("helix");
    await expect(page.locator('[data-pj-main="graph"]')).toBeVisible();
    await expect(page.locator('[data-kg-head] .kgv-title')).toHaveText("知识图谱 · helix");
    // 默认详情收口（mock 默认选首个实体 E-9）
    await expect(page.locator('[data-kg-detail] .kgv-dh-name')).toHaveText("Steer 消息队列", { timeout: 10_000 });
    // ws 抽查：kg.list / kg.node.detail / kg.change.report 均携带 project=helix
    await mock.waitForCommand("kg.list");
    expect((await lastPayload(mock, "kg.list")).project).toBe("helix");
    expect((await lastPayload(mock, "kg.node.detail")).project).toBe("helix");
    expect((await lastPayload(mock, "kg.change.report")).project).toBe("helix");

    // ── 2. ☰ 展开恢复两段列表：主区状态与选中不变（FID-30 流口径）──
    await page.locator(".pj-rail-btn").click();
    await expect(page.locator(".pj-domain")).toBeVisible();
    await expect(page.locator('[data-pj-main="graph"]')).toBeVisible();
    await expect(page.locator('[data-kg-head] .kgv-title')).toHaveText("知识图谱 · helix");
    await expect(page.locator('.pj-row[data-name="helix"]')).toHaveClass(/selected/);
    // 点当前已选中行 → 仅折叠不重置（详情仍停在 E-9，未重初始化）
    await page.locator('.pj-row[data-name="helix"]').click();
    await expect(page.locator('[data-pj-rail="collapsed"]')).toBeVisible();
    await expect(page.locator('[data-kg-detail] .kgv-dh-name')).toHaveText("Steer 消息队列");

    // ── 3. 主区四态状态机：graph → absent（先清旧态）→ 回 graph ──
    await page.locator(".pj-rail-btn").click();
    await page.locator('.pj-row[data-name="codegraph"]').click();
    await expect(page.locator('[data-pj-main="absent"]')).toBeVisible();
    await expect(page.locator('[data-kg-workspace]')).toBeHidden(); // 旧图谱残影清零
    await expect(page.locator(".pj-center-panel")).toContainText("codegraph");
    await expect(page.locator("[data-build-cta]")).toHaveText("构建索引");
    await shotEvidence(page, "kg-flow-absent-state", "CL-5");
    // 回 helix → graph（building 态在 TC2.2 冷启动链路覆盖）
    await page.locator(".pj-rail-btn").click();
    await page.locator('.pj-row[data-name="helix"]').click();
    await expect(page.locator('[data-kg-head] .kgv-title')).toHaveText("知识图谱 · helix");
    await expect(page.locator('[data-kg-detail] .kgv-dh-name')).toHaveText("Steer 消息队列", { timeout: 10_000 });

    // ── 4. 列表三路过滤叠加 + 计数行（FID-05 流口径：行为通即可）──
    await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 17");
    await page.locator('[data-kg-seg-kind] button', { hasText: "规则" }).click();
    await page.locator('[data-kg-seg-status] button', { hasText: "草稿" }).click();
    await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 1"); // 规则∩草稿=TR-47
    await page.locator('[data-kg-q]').fill("行动项");
    await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 1");
    // 空态支路：无匹配 → 「没有匹配的节点」+ 清除过滤恢复
    await page.locator('[data-kg-q]').fill("zzz-无命中");
    await expect(page.locator(".kgv-empty")).toContainText("没有匹配的节点");
    await page.locator('[data-kg-clear]').click();
    await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 17");

    // ── 5. 详情六段 + 关系/supersede 链跳转（FID-07/09/10 流口径）──
    const pane = page.locator("[data-kg-detail]");
    for (const sec of ["描述", "规则", "锚点", "关系", "supersede 链", "变更日志"]) {
      await expect(pane.locator(".kgv-sec-h", { hasText: sec })).toBeVisible();
    }
    // 关系跳转：E-9 → E-10
    await page.locator(".kg-rel-row .kg-nref").first().click();
    await expect(pane.locator(".kgv-dh-name")).toHaveText("会话服务 ChatService");
    // supersede 链跳转：E-13（历史）→ 链上现行项 nref → E-14（现行）
    await page.locator('.kgv-row[data-id="E-13"]').click();
    await expect(page.locator(".kg-chain")).toContainText("历史（留史可查）");
    await page.locator(".kg-chain-item.cur .kg-nref").click();
    await expect(pane.locator(".kgv-dh-name")).toHaveText("报告装配策略");

    // ── 6. 报告行动项：待决→已处理→撤销→tab 计数联动→清零横幅（FID-14 流口径）──
    await page.locator('[data-tab="report"]').click();
    await expect(page.locator('[data-kg-report-count]')).toHaveText("4 待决");
    await page.locator(".kg-entry").first().locator('input[type="radio"]').first().click();
    await expect(page.locator(".kg-entry").first()).toHaveClass(/done/);
    await expect(page.locator("[data-kg-done]").first()).toContainText("已处理：");
    await expect(page.locator('[data-kg-report-count]')).toHaveText("3 待决");
    await page.locator("[data-kg-undo]").first().click();
    await expect(page.locator('[data-kg-report-count]')).toHaveText("4 待决");
    for (const entry of await page.locator(".kg-entry").all()) {
      await entry.locator('input[type="radio"]').first().click();
    }
    await expect(page.locator("[data-kg-report-clear]")).toContainText("4 条已全部处理");
    await expect(page.locator('[data-kg-report-count]')).toHaveText("已清零");
    await shotEvidence(page, "kg-flow-report-cleared", "CL-5");

    // ── 7. 索引面板：helix synced → feifei degraded → 重建 building→synced ──
    const panel = page.locator("[data-kg-index-panel]");
    await expect(panel).toHaveAttribute("data-kg-index-panel", "synced");
    await page.locator(".pj-rail-btn").click();
    await page.locator('.pj-row[data-name="feifei"]').click();
    await expect(panel).toHaveAttribute("data-kg-index-panel", "degraded", { timeout: 10_000 });
    await expect(page.locator('[data-kg-head] .kgv-title')).toHaveText("知识图谱 · feifei");
    await expect(panel.locator(".kg-sev-badge.warn")).toHaveText("DEGRADED");
    await page.locator("[data-kg-rebuild]").click();
    expect((await lastPayload(mock, "kg.index.status")).project).toBe("feifei");
    await expect(panel).toHaveAttribute("data-kg-index-panel", "building");
    await expect(panel).toHaveAttribute("data-kg-index-panel", "synced", { timeout: 15_000 });
    await expect(page.locator(".toast-zone")).toContainText("索引构建完成");
    // 全程无路由跳转（反向断言流口径）
    expect(new URL(page.url()).pathname).toBe("/project");
    await shotEvidence(page, "kg-flow-rebuild-synced", "CL-5");
  });
});

test.describe("CL-5 B 层：B1 冷启动构建 + draft 转正写动作（TC2.2）", () => {
  test("absent CTA→rebuild 触发→轮询 building→synced→graph；转正两步确认（取消/确认分支）", async ({ mock, page }) => {
    await openProject(mock, page);

    // ── 1. 选 absent 项目 → 主区空态「构建索引」CTA ──
    await page.locator('.pj-row[data-name="codegraph"]').click();
    await expect(page.locator('[data-pj-main="absent"]')).toBeVisible();
    await expect(page.locator(".pj-center-panel .pb-absent")).toHaveText("未建索引");

    // ── 2. CTA → kg.index.status {project, rebuild:true}（B1 写入口）──
    await page.locator("[data-build-cta]").click();
    await mock.waitForCommand("kg.index.status");
    const trigger = (await mock.clientFrames()).find(
      (f) => f.type === "kg.index.status" && (f.payload as Record<string, unknown>).rebuild === true,
    );
    expect(trigger, "CTA 应触发 rebuild:true 帧").toBeDefined();
    expect((trigger!.payload as Record<string, unknown>).project).toBe("codegraph");
    await expect(page.locator('[data-pj-main="building"]')).toBeVisible();
    await expect(page.locator(".pj-build-panel")).toContainText("构建索引 · codegraph");

    // ── 3. 构建中途展开窄轨：行徽章翻「构建中 · N%」+ 次行「N / M 符号」──
    //    （补 FID-27/FID-28 building 态缺口；O-6 轮询驱动）
    await page.locator(".pj-rail-btn").click();
    await expect(page.locator(".pj-domain")).toBeVisible();
    const row = page.locator('.pj-row[data-name="codegraph"]');
    await expect(row.locator(".pb-building")).toContainText("构建中", { timeout: 10_000 });
    await expect(row.locator(".pj-row-data")).toContainText("/ 26 符号", { timeout: 10_000 });
    await shotEvidence(page, "kg-flow-coldstart-building-row", "CL-5");

    // ── 4. 轮询至 synced：主区自动进 graph + toast + 左栏徽章翻已同步 ──
    await expect(page.locator('[data-pj-main="graph"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".toast-zone")).toContainText("索引构建完成：codegraph · 26 符号");
    await expect(row.locator(".pb-synced")).toContainText("已同步", { timeout: 10_000 });
    await expect(page.locator('[data-kg-head] .kgv-title')).toHaveText("知识图谱 · codegraph");
    // 轮询帧 project 作用域抽查（O-6 同通道）
    expect((await lastPayload(mock, "kg.index.status")).project).toBe("codegraph");
    // 新图谱默认详情收口（graph 态按项目重初始化）
    await expect(page.locator('[data-kg-detail] .kgv-dh-name')).toHaveText("Steer 消息队列", { timeout: 10_000 });
    await shotEvidence(page, "kg-flow-coldstart-graph", "CL-5");

    // ── 5. 转正门控：仅 draft 渲染（confirmed 静默不渲染）──
    expect(await page.locator("[data-kg-promote]").count()).toBe(0); // E-9 confirmed
    await page.locator('.kgv-row[data-id="TR-47"]').click();
    await expect(page.locator("[data-kg-detail] .kgv-dh-name")).toHaveText("报告条目必须永远带行动项");
    await expect(page.locator("[data-kg-promote]")).toHaveText("转正");

    // ── 6. 两步确认 · 取消分支：确认条展开 → 取消退回（仍 draft、按钮在）──
    await page.locator("[data-kg-promote]").click();
    const box = page.locator("[data-kg-confirm-box]");
    await expect(box).toBeVisible();
    await page.locator("[data-kg-promote-no]").click();
    await expect(box).toBeHidden();
    await expect(page.locator("[data-kg-promote]")).toBeVisible();
    await expect(page.locator("[data-kg-detail] .st-draft").first()).toBeVisible();
    // 取消分支不发写命令
    expect((await mock.clientFrames()).filter((f) => f.type === "kg.node.confirm")).toHaveLength(0);

    // ── 7. 两步确认 · 确认分支：kg.node.confirm → 徽章翻转+日志追加+toast+按钮消失 ──
    await page.locator("[data-kg-promote]").click();
    await page.locator("[data-kg-promote-yes]").click();
    await mock.waitForCommand("kg.node.confirm");
    const confirmPayload = (await lastPayload(mock, "kg.node.confirm")) as { project?: string; id?: string };
    expect(confirmPayload.project).toBe("codegraph");
    expect(confirmPayload.id).toBe("TR-47");
    await expect(page.locator("[data-kg-detail] .st-confirmed").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".kg-log-row .kg-log-t").first()).toContainText("草稿转正（页面人工确认）");
    await expect(page.locator(".toast-zone")).toContainText("已转正：『报告条目必须永远带行动项』");
    await expect(page.locator("[data-kg-promote]")).toHaveCount(0);
    await expect(page.locator('.kgv-row[data-id="TR-47"]')).not.toHaveClass(/draft/);
    expect(new URL(page.url()).pathname).toBe("/project");
    await shotEvidence(page, "kg-flow-promote-confirmed", "CL-5");
  });
});

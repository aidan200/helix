/**
 * T5.4 —— P-1 项目域+知识图谱查看（单页 master-detail）还原度套件
 * （mock mode，无 daemon；?fakeTransport=1 标准入口，kg 六命令自动剧本由
 * fake-transport kg-mock 承载——mock daemon 读面镜像）。
 *
 * 断言源 = 本迭代 prototype/review.md「必须还原」全 32 项
 * （FID-01~24 见 testing/test-design.md §3.1；FID-25~32 为 F5.0 项目域层
 * 续排，FID-01 按 review.md 注修订为单页顶栏口径）：
 * - FID-01/02 单页顶栏与氛围层；FID-03~06 F5.1 列表/过滤/空态；
 * - FID-07~11 F5.2 六段详情；FID-12~15 F5.3 报告；FID-16~18 F5.4 转正；
 * - FID-19~21 F5.5 索引面板；FID-22~24 主题/骨架/toast；
 * - FID-25~32 F5.0 项目域与主区状态机（含 B1 冷启动全链；FID-29 工作树占位段已随 D8 W-R7 删除退役）。
 * - 机械核对五点：裸 id 不可见 / 符号等宽 / 因果叙述句式 / 状态互斥
 *   结构 / 转正入口唯一（test-design §3.4）。
 * - 反向断言：data-proto-annotation 不存在；全程无路由跳转（URL 恒 /project）。
 * - 主题键 = 既有 helix-theme（AF-5 裁决：原型 p1-theme 键不进实现，FID-22
 *   的 p1-theme 口径按裁决落 helix-theme）。
 * - 锚点失效措辞 = 「⚠ 失效 · 符号已不存在」（契约 AnchorRow 无 per-anchor
 *   note 字段，按 state 语义落词；FID-08 的「方法已删除」为原型 mock 注记）。
 */
import { test, expect } from "./harness/fixtures";
import type { MockController } from "./harness/mock-session";
import type { Page } from "@playwright/test";
import { computed } from "./harness/style-utils";
import { evidencePath } from "./harness/evidence";
import { welcome } from "./harness/protocol";
import { assertFidelityGreen, checkPrototypeFidelity, type FidelityCheck } from "./harness/prototype-fidelity";

const SID = "sess-kg-fidelity";

/** 暗主题通道值（tokens.css V1：cyan/violet/success/warning/search）。 */
const CYAN = "rgb(34, 211, 238)";
const VIOLET = "rgb(168, 85, 247)";
const SUCCESS = "rgb(52, 211, 153)";
const WARNING = "rgb(251, 191, 36)";

/** 全页可见文本（AD-16 机械核对载体：.app-layout 树）。 */
function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector(".app-layout")!.textContent ?? "");
}

/** 标准进页面：建连 → welcome → IconRail 进 /project → 左栏项目列表收口。 */
async function openProject(mock: MockController, page: Page): Promise<void> {
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emit(welcome({ sessionId: SID }));
  await mock.waitForConn("connected");
  await page.locator('.rail-btn[data-page="project"]').click();
  await expect(page.locator('[data-p1-project="/project"]')).toBeVisible();
  // kg.projects 自动应答（60ms 延迟）→ 14 行（056c38b 增 legacy 空产出项目）
  await expect(page.locator(".pj-row")).toHaveCount(14, { timeout: 10_000 });
}

/** 选中项目进 graph 态并等默认详情收口（默认选首个实体 = E-9 Steer 消息队列）。 */
async function enterGraph(page: Page, name: "helix" | "feifei"): Promise<void> {
  await page.locator(`.pj-row[data-name="${name}"]`).click();
  await expect(page.locator('[data-kg-workspace]')).toBeVisible();
  await expect(page.locator('[data-kg-detail] .kgv-dh-name')).toHaveText("Steer 消息队列", { timeout: 10_000 });
}

test.describe("T5.4 P-1 fidelity：F5.0 项目域 + F5.1~F5.5 图谱（FID-25~32 状态机主链）", () => {
  test("单页形态 / 项目行 / 折叠-展开 / 四态状态机 / B1 冷启动 / 排除清单", async ({ mock, page }) => {
    await openProject(mock, page);

    const checks: FidelityCheck[] = [
      {
        id: "FID-25",
        title: "单页 master-detail：页顶栏唯一（项目+workspace 徽章+主题切换+选中后上下文 chip）；左栏+主区；无「查看图谱」/返回入口",
        run: async () => {
          // 页顶栏唯一（可见口径：ChatPage 常驻 DOM display:none 属 F(4.4).2
          // 保状态架构，隐藏 header 不构成用户可见顶栏——:visible scope）
          await expect(page.locator(".app-header:visible")).toHaveCount(1);
          await expect(page.locator(".app-header:visible .p1-title")).toHaveText("项目");
          await expect(page.locator(".app-header:visible .hud-chip").first()).toContainText("workspace · ws");
          // S1：主题单钮全局唯一归 IconRail（页顶栏不再各挂 [data-theme-toggle]）
          await expect(page.locator("#btn-theme-toggle")).toBeVisible();
          await expect(page.locator(".pj-domain")).toBeVisible();
          await expect(page.locator('[data-pj-main="empty"]')).toBeVisible();
          // 无跳转入口：全页无「查看图谱」/返回 chip 文案
          const text = await visibleText(page);
          expect(text).not.toContain("查看图谱");
          expect(text).not.toContain("‹");
        },
      },
      {
        id: "FID-26",
        title: "项目行形态：粗体名+四态徽章 compact+次行；可选中高亮且无行尾按钮；语义边条三色、absent 无边条降档",
        run: async () => {
          const helix = page.locator('.pj-row[data-name="helix"]');
          await expect(helix.locator(".pj-row-name")).toHaveCSS("font-weight", "600");
          // 行内无任何按钮（选中即主区切换）
          expect(await page.locator(".pj-row button").count()).toBe(0);
          // 语义边条：synced=success / degraded=warning / building=accent / absent 无
          expect(await computed(page, '.pj-row[data-name="helix"]', "border-left-color")).toBe(SUCCESS);
          expect(await computed(page, '.pj-row[data-name="feifei"]', "border-left-color")).toBe(WARNING);
          expect(await computed(page, '.pj-row[data-name="codegraph"]', "border-left-color")).toBe("rgba(0, 0, 0, 0)"); // transparent
          // 选中高亮（选中即自动折叠——FID-30 口径；展开后验证行 selected）
          await page.locator('.pj-row[data-name="helix"]').click();
          await expect(page.locator('[data-pj-rail="collapsed"]')).toBeVisible();
          await page.locator(".pj-rail-name").click();
          await expect(page.locator('.pj-row[data-name="helix"]')).toHaveClass(/selected/);
        },
      },
      {
        id: "FID-27",
        title: "四态徽章：absent=muted 未建索引 / synced=success 脉冲点已同步 / degraded=DEGRADED 警示；零新增 token",
        run: async () => {
          await expect(page.locator('.pj-row[data-name="helix"] .pb-synced')).toContainText("已同步");
          await expect(page.locator('.pj-row[data-name="helix"] .kg-dot.ok')).toHaveCSS("background-color", SUCCESS);
          await expect(page.locator('.pj-row[data-name="feifei"] .kg-sev-badge.warn')).toHaveText("DEGRADED");
          expect(await computed(page, '.pj-row[data-name="codegraph"] .pb-absent', "color")).toBe("rgb(113, 129, 152)"); // --text-dim
        },
      },
      {
        id: "FID-28",
        title: "次行状态信息：synced=符号·节点·时间 / degraded=影响说明 / absent=未建索引",
        run: async () => {
          await expect(page.locator('.pj-row[data-name="helix"] .pj-row-data')).toContainText("56 符号 · 17 节点");
          await expect(page.locator('.pj-row[data-name="feifei"] .pj-row-data')).toContainText("重新构建以恢复");
          await expect(page.locator('.pj-row[data-name="codegraph"] .pj-row-data')).toHaveText("未建索引");
        },
      },
      {
        id: "FID-30",
        title: "折叠-展开：选中→36px 窄轨（点竖排名展开）；展开恢复；可反复；不改主区；点已选中行仅折叠",
        run: async () => {
          // 点当前已选中行 → 折叠（FID-26 已展开）→ 窄轨在场 + 主区 graph
          await page.locator('.pj-row[data-name="helix"]').click();
          await expect(page.locator('[data-pj-rail="collapsed"]')).toBeVisible();
          await expect(page.locator(".pj-rail-name")).toHaveText("helix");
          await expect(page.locator(".pj-rail-name")).toHaveAttribute("title", "展开项目域");
          expect(await computed(page, ".pj-rail", "width")).toBe("36px");
          expect(await computed(page, ".pj-rail-name", "writing-mode")).toContain("vertical");
          await expect(page.locator('[data-pj-main="graph"]')).toBeVisible();
          // 点竖排名展开：恢复列表，主区不动
          await page.locator(".pj-rail-name").click();
          await expect(page.locator(".pj-domain")).toBeVisible();
          await expect(page.locator('[data-pj-rail="collapsed"]')).toBeHidden();
          await expect(page.locator('[data-pj-main="graph"]')).toBeVisible();
          // 点当前已选中行 → 仅折叠不重置（kg-head 仍在）
          await page.locator('.pj-row[data-name="helix"]').click();
          await expect(page.locator('[data-pj-rail="collapsed"]')).toBeVisible();
          await expect(page.locator('[data-kg-head]')).toContainText("知识图谱 · helix");
        },
      },
      {
        id: "FID-31a",
        title: "主区四态互斥：empty→absent（CTA）；切项目先清旧态再进新态",
        run: async () => {
          // graph(helix) → 切 codegraph（absent）：旧图谱清场
          await page.locator(".pj-rail-name").click();
          await page.locator('.pj-row[data-name="codegraph"]').click();
          await expect(page.locator('[data-pj-main="absent"]')).toBeVisible();
          await expect(page.locator('[data-kg-workspace]')).toBeHidden(); // 旧图谱残影清零
          await expect(page.locator(".pj-center-panel")).toContainText("codegraph");
          // T3.2：absent 面板双徽标（未建索引 + bootstrap 引导态）——取首枚断文案
          await expect(page.locator(".pj-center-panel .pb-absent").first()).toHaveText("未建索引");
          await expect(page.locator("[data-build-cta]")).toHaveText("构建索引");
        },
      },
      {
        id: "FID-31b（B1 冷启动）",
        title: "absent CTA→building（进度 N/M+左栏行同步翻）→synced→graph 出现+toast+左栏徽章同步翻已同步",
        run: async () => {
          await page.locator("[data-build-cta]").click();
          await expect(page.locator('[data-pj-main="building"]')).toBeVisible();
          await expect(page.locator(".pj-build-panel")).toContainText("构建索引 · codegraph");
          await expect(page.locator(".pj-build-panel .kgv-ip-sub")).toContainText("/ 26 符号 · codegraph 机械抽取中");
          await expect(page.locator(".pj-build-panel .kg-progress-fill")).toBeVisible();
          // 完成翻转（mock 时基 3200ms + 轮询 750ms）
          await expect(page.locator('[data-pj-main="graph"]')).toBeVisible({ timeout: 15_000 });
          await expect(page.locator(".toast-zone")).toContainText("索引构建完成：codegraph · 26 符号");
          // 左栏徽章翻已同步（展开验证）+ 顶栏上下文 chip 在场
          await page.locator(".pj-rail-name").click();
          await expect(page.locator('.pj-row[data-name="codegraph"] .pb-synced')).toContainText("已同步");
          await expect(page.locator('[data-ctx-proj="codegraph"]')).toBeVisible();
        },
      },
      {
        id: "FID-32",
        title: "排除清单：docs/.helix/.worktrees 与文件项不出现在项目列表",
        run: async () => {
          const names = await page.locator(".pj-row").evaluateAll((rows) =>
            rows.map((r) => (r as HTMLElement).dataset.name),
          );
          expect(names).toHaveLength(14); // 056c38b 增 legacy
          for (const banned of ["docs", ".helix", ".worktrees", "aaa.txt", "ng-ai.zip"])
            expect(names, `排除清单 ${banned} 不应入列`).not.toContain(banned);
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await page.screenshot({ path: evidencePath("kg-f5-0-project-domain", "png", "CL-5"), fullPage: false });
    assertFidelityGreen(report);
  });
});

test.describe("T5.4 P-1 fidelity：F5.1~F5.5 graph 态（FID-01~24）", () => {
  test.beforeEach(async ({ mock, page }) => {
    await openProject(mock, page);
    await enterGraph(page, "helix");
  });

  test("F5.1 列表/过滤/空态 + F5.2 六段详情 + F5.3 报告 + F5.4 转正 + F5.5 面板（FID-03~21 机械五点）", async ({ mock, page }) => {
    const checks: FidelityCheck[] = [
      {
        id: "FID-01/31",
        title: "graph 态主区顶部：知识图谱 · 项目名（纯标识无返回；9798562 头部删只读/迭代 chip，右侧归索引面板）",
        run: async () => {
          await expect(page.locator('[data-kg-head] .kgv-title')).toHaveText("知识图谱 · helix");
          // 9798562 B2：头部「只读」/迭代 chip 删除（图谱是全局概念不挂迭代号）——
          // 右侧 = F5.5 索引面板紧凑形态 + C1 清空图谱入口
          await expect(page.locator('[data-kg-head] [data-kg-index-panel]')).toBeVisible();
          const headText = (await page.locator("[data-kg-head]").textContent()) ?? "";
          expect(headText).not.toContain("只读");
          expect(headText).not.toMatch(/iter-\d+-\w+/);
        },
      },
      {
        id: "FID-03",
        title: "行形态：粗体 name+kind 徽章（rule=cyan/entity=violet）+状态徽章+digest 截断；裸 id 永不可见",
        run: async () => {
          const row = page.locator('.kgv-row[data-id="TR-44"]');
          await expect(row.locator(".kgv-row-name")).toHaveCSS("font-weight", "600");
          expect(await computed(page, '.kgv-row[data-id="TR-44"] .kind-rule', "color")).toBe(CYAN);
          expect(await computed(page, '.kgv-row[data-id="E-9"] .kind-entity', "color")).toBe(VIOLET);
          // P2③ superseded 默认折叠：E-13 不在列，计数徽标行在场；展开后降档行入列
          await expect(page.locator('.kgv-row[data-id="E-13"]')).toHaveCount(0);
          await expect(page.locator('[data-kg-sup-toggle]')).toHaveText("已取代 1 条 · 展开 ▾");
          await page.locator('[data-kg-sup-toggle]').click();
          await expect(page.locator('.kgv-row[data-id="E-13"] .st-superseded')).toHaveText("已取代");
          expect(await visibleText(page)).not.toMatch(/\b(TR|E)-\d+\b/); // 机械核对①
        },
      },
      {
        id: "FID-04",
        title: "draft 高亮：warning 边条+微底色；superseded 行降档（透明度）",
        run: async () => {
          expect(await computed(page, '.kgv-row[data-id="TR-47"]', "border-left-color")).toBe(WARNING);
          expect(parseFloat(await computed(page, '.kgv-row[data-id="E-13"]', "opacity"))).toBeLessThan(1);
        },
      },
      {
        id: "FID-05",
        title: "过滤三路叠加：关键词（--search 橙 mark）×类型 seg×状态 seg；计数行 N 节点·匹配 M",
        run: async () => {
          await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 17");
          await page.locator('[data-kg-seg-kind] button', { hasText: "规则" }).click();
          await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 9");
          await page.locator('[data-kg-seg-status] button', { hasText: "草稿" }).click();
          await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 1"); // 叠加：规则∩草稿=TR-47
          await page.locator('[data-kg-seg-kind] button', { hasText: "全部" }).click();
          await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 2"); // 状态独立：草稿=TR-47+E-15
          await page.locator('[data-kg-q]').fill("行动项");
          await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 1");
          // 命中高亮（--search 橙 alpha 0.3）
          const markBg = await computed(page, ".kgv-row mark", "background-color");
          expect(markBg).toContain("249, 115, 22");
          await page.locator('[data-kg-seg-status] button', { hasText: "全部" }).click();
          await page.locator('[data-kg-q]').fill("");
        },
      },
      {
        id: "FID-06",
        title: "空态：无匹配「没有匹配的节点」+清除过滤按钮（不清空不恢复语义）",
        run: async () => {
          await page.locator('[data-kg-q]').fill("zzz-无命中");
          await expect(page.locator(".kgv-empty")).toContainText("没有匹配的节点");
          await page.locator('[data-kg-clear]').click();
          await expect(page.locator('[data-kg-count]')).toHaveText("17 节点 · 匹配 17");
        },
      },
      {
        id: "FID-07",
        title: "详情五段：头卡（名+徽章+域 chip+digest）+正文（描述/规则合并，9798562 B2）/锚点/关系/supersede 链/变更日志",
        run: async () => {
          const pane = page.locator("[data-kg-detail]");
          await expect(pane.locator(".kgv-dh-name")).toHaveText("Steer 消息队列");
          await expect(pane.locator(".kgv-dh-top .kind-entity")).toBeVisible();
          await expect(pane.locator(".st-confirmed")).toBeVisible();
          await expect(pane.locator(".hud-chip").first()).toHaveText("业务");
          // 9798562 B2：描述/规则合并为单「正文」段（react-markdown 渲染）
          for (const sec of ["正文", "锚点", "关系", "supersede 链", "变更日志"]) {
            await expect(pane.locator(".kgv-sec-h", { hasText: sec })).toBeVisible();
          }
        },
      },
      {
        id: "FID-08",
        title: "锚点行：等宽符号+路径:行号；dead「⚠ 失效」；stale「? 长期无附着命中」（机械核对②：等宽）",
        run: async () => {
          const dead = page.locator('.kg-anchor[data-anchor-state="dead"]');
          await expect(dead).toContainText("⚠ 失效 · 符号已不存在");
          await expect(dead).toContainText("apps/daemon/src/services/ChatService.ts:309");
          // 符号等宽（机械核对②）
          const font = await computed(page, ".kg-anchor code", "font-family");
          expect(font).toContain("JetBrains Mono");
          // stale 锚（切 TR-50）
          await page.locator('.kgv-row[data-id="TR-50"]').click();
          await expect(page.locator('.kg-anchor[data-anchor-state="stale"]')).toContainText("? 长期无附着命中");
        },
      },
      {
        id: "FID-09/10",
        title: "关系行（边词+引用可跳转）与 supersede 链（历史↓现行，可跳转）",
        run: async () => {
          // FID-08 后详情停在 TR-50——回点 E-9 断言其关系行
          await page.locator('.kgv-row[data-id="E-9"]').click();
          await expect(page.locator(".kg-rel-row", { hasText: "中转" })).toContainText("会话服务 ChatService");
          // 跳转：点关系引用 → 详情切换
          await page.locator(".kg-rel-row .kg-nref").first().click();
          await expect(page.locator("[data-kg-detail] .kgv-dh-name")).toHaveText("会话服务 ChatService");
          // supersede 链：E-13（历史）↓ E-14（现行）
          await page.locator('.kgv-row[data-id="E-13"]').click();
          const chain = page.locator(".kg-chain");
          await expect(chain).toContainText("历史（留史可查）");
          await expect(chain).toContainText("报告装配策略");
          await expect(chain.locator(".kg-chain-item.cur")).toContainText("现行");
          // 链引用可跳转
          await page.locator(".kg-chain .kg-nref").first().click();
          await expect(page.locator("[data-kg-detail] .kgv-dh-name")).toHaveText("变化报告生成器");
        },
      },
      {
        id: "FID-11",
        title: "变更日志：日期+迭代号+事件叙述，最新在上",
        run: async () => {
          await page.locator('.kgv-row[data-id="E-9"]').click();
          const first = page.locator(".kg-log-row .kg-log-t").first();
          await expect(first).toContainText("锚点 injectClosure 失效");
          await expect(page.locator(".kg-log-row").first()).toContainText("2026-08-25");
        },
      },
      {
        id: "FID-12/15",
        title: "报告条目形态：四类各一 glyph/色 + 因果叙述句式（主语你/本迭代）+ 疑似措辞限定（机械核对③）",
        run: async () => {
          await page.locator('[data-tab="report"]').click();
          await expect(page.locator(".kg-entry", { hasText: "失效锚点 ⚠" })).toBeVisible();
          await expect(page.locator(".kg-entry", { hasText: "规则冲突 ⚠" })).toBeVisible();
          await expect(page.locator(".kg-entry", { hasText: "疑似过时 ?" })).toBeVisible();
          await expect(page.locator(".kg-entry", { hasText: "知识变化 ✓" })).toBeVisible();
          // sev 色映射边框
          expect(await computed(page, '.kg-entry[data-entry-kind="dead_anchor"]', "border-color")).toContain("251, 191, 36");
          expect(await computed(page, '.kg-entry[data-entry-kind="suspect_stale"]', "border-color")).toContain("168, 85, 247");
          expect(await computed(page, '.kg-entry[data-entry-kind="knowledge_change"]', "border-color")).toContain("52, 211, 153");
          // 因果叙述句式 + 疑似限定（机械核对③）
          const deadBody = await page.locator('.kg-entry[data-entry-kind="dead_anchor"] .kgv-body').textContent();
          expect(deadBody!.startsWith("你")).toBe(true);
          const suspectBody = await page.locator('.kg-entry[data-entry-kind="suspect_stale"] .kgv-body').textContent();
          expect(suspectBody).toContain("疑似");
          expect(suspectBody).toContain("启发式排序，非结论");
        },
      },
      {
        id: "FID-13",
        title: "报告引用规范：符号=等宽+路径:行号；知识引用=粗体 name+徽章（9798562：refs 纯信息展示不跳转）",
        run: async () => {
          await expect(page.locator(".kg-entry code", { hasText: "injectClosure" }).first()).toBeVisible();
          await expect(page.locator(".kg-rel-row", { hasText: "apps/daemon/src/services/ChatService.ts:309" })).toBeVisible();
          const nref = page.locator('.kg-entry .kg-nref[data-goto="E-9"]');
          await expect(nref).toContainText("Steer 消息队列");
          // 报告面裁决（9798562 B2）：refs 纯信息展示不跳转——static 形态无点击 handler
          await expect(nref).toHaveClass(/static/);
        },
      },
      {
        id: "FID-14",
        title: "报告 = 纯通知面（9798562 B2）：计数 chip + 条目零交互装置（无 radio/已处理/撤销/清零横幅）",
        run: async () => {
          // 行动项交互整套随报告纯通知化删除——计数形态翻「N 条」（非「N 待决」）
          await expect(page.locator(".kgv-report-head .hud-chip").last()).toHaveText("4 条");
          const report = page.locator("[data-kg-report]");
          await expect(report).toBeVisible();
          // 零交互装置：无 radio / 无按钮 / 无已处理·撤销·清零文案
          expect(await report.locator('input[type="radio"]').count()).toBe(0);
          expect(await report.locator("button").count()).toBe(0);
          const text = (await report.textContent()) ?? "";
          expect(text).not.toContain("需要你决定");
          expect(text).not.toContain("已处理");
          expect(text).not.toContain("撤销");
          expect(text).not.toContain("已全部处理");
        },
      },
      {
        id: "FID-16/18",
        title: "转正门控：仅 draft 渲染；非草稿静默不渲染；全页唯一写入口（机械核对⑤）",
        run: async () => {
          // E-9（confirmed）无按钮
          await page.locator('.kgv-row[data-id="E-9"]').click();
          await expect(page.locator("[data-kg-detail] .kgv-dh-name")).toHaveText("Steer 消息队列");
          expect(await page.locator("[data-kg-promote]").count()).toBe(0);
          // 全页唯一写入口：本页全部按钮中仅确认链走 confirm（转正/构建 CTA 分域）
          const buttons = await page.locator(".app-layout button").evaluateAll((bs) =>
            bs.map((b) => (b.textContent ?? "").trim()),
          );
          expect(buttons.filter((t) => t === "转正")).toHaveLength(0); // confirmed 态零渲染
          // TR-47（draft）渲染
          await page.locator('.kgv-row[data-id="TR-47"]').click();
          await expect(page.locator("[data-kg-promote]")).toHaveText("转正");
          expect(await page.locator('[data-kg-promote-yes]').count()).toBe(0); // 确认条未开
        },
      },
      {
        id: "FID-17",
        title: "两步确认：内联确认条（warning 边框）→取消退回→确认后徽章翻转+日志追加+toast+按钮消失",
        run: async () => {
          await page.locator("[data-kg-promote]").click();
          const box = page.locator("[data-kg-confirm-box]");
          await expect(box).toBeVisible();
          expect(await computed(page, "[data-kg-confirm-box]", "border-color")).toContain("251, 191, 36");
          await expect(box).toContainText("确认将『报告条目必须永远带行动项』转正？");
          // 取消退回
          await page.locator("[data-kg-promote-no]").click();
          await expect(box).toBeHidden();
          // 确认 → kg.node.confirm → 徽章翻已确认 + 日志追加（daemon 落账回读）+ toast + 按钮消失
          await page.locator("[data-kg-promote]").click();
          await page.locator("[data-kg-promote-yes]").click();
          await expect(page.locator("[data-kg-detail] .st-confirmed").first()).toBeVisible({ timeout: 10_000 });
          await expect(page.locator(".kg-log-row .kg-log-t").first()).toContainText("草稿转正（页面人工确认）");
          await expect(page.locator(".toast-zone")).toContainText("已转正：『报告条目必须永远带行动项』");
          await expect(page.locator("[data-kg-promote]")).toHaveCount(0); // 按钮消失
          // 列表行状态翻转（draft 高亮消失）
          await expect(page.locator('.kgv-row[data-id="TR-47"]')).not.toHaveClass(/draft/);
        },
      },
      {
        id: "FID-19",
        title: "索引面板三态互斥：synced（绿点+已同步，符号数/时间入 title——9798562 头部紧凑形态）；结构互斥断言（机械核对④）",
        run: async () => {
          const panel = page.locator("[data-kg-index-panel]");
          await expect(panel).toHaveAttribute("data-kg-index-panel", "synced");
          await expect(panel.locator(".kg-dot.ok")).toBeVisible();
          await expect(panel.locator(".kgv-ip-synced")).toContainText("已同步");
          // 符号数/完成时间入 title 悬浮（紧凑形态：不再占正文行）
          const title = await panel.locator(".kgv-ip-synced").getAttribute("title");
          expect(title ?? "").toContain("56 符号");
        },
      },
      {
        id: "FID-20/21",
        title: "degraded（feifei）：DEGRADED 徽章+影响说明入 title+重新构建 → building → synced + toast；降级永不静默",
        run: async () => {
          await page.locator(".pj-rail-name").click();
          await page.locator('.pj-row[data-name="feifei"]').click();
          const panel = page.locator("[data-kg-index-panel]");
          await expect(panel).toHaveAttribute("data-kg-index-panel", "degraded", { timeout: 10_000 });
          await expect(page.locator('[data-kg-head] .kgv-title')).toHaveText("知识图谱 · feifei");
          const badge = panel.locator(".kg-sev-badge.warn");
          await expect(badge).toHaveText("DEGRADED"); // 徽章永不静默
          // 影响说明入 title（9798562 紧凑形态）
          expect((await badge.getAttribute("title")) ?? "").toContain("重新构建以恢复");
          await page.locator("[data-kg-rebuild]").click();
          await expect(panel).toHaveAttribute("data-kg-index-panel", "building");
          await expect(panel).toHaveAttribute("data-kg-index-panel", "synced", { timeout: 15_000 });
          await expect(page.locator(".toast-zone")).toContainText("索引构建完成");
        },
      },
      {
        id: "FID-23",
        title: "骨架与最终布局同构、无通用 spinner",
        run: async () => {
          // 切项目进 graph 即骨架（kg-skel-row 形状 = 行同构；无 spinner 类）。
          // gate 钉住：hold 后 kg 应答挂起，骨架停留到断言完（慢机 60ms 延迟窗 <
          // 采样往返时长会勈 no element——CI 收敛批次）；release 后数据到、详情落定。
          await mock.holdAutoReply();
          await page.locator(".pj-rail-name").click();
          await page.locator('.pj-row[data-name="helix"]').click();
          await expect(page.locator(".kgv-list .kg-skel-row").first()).toBeVisible();
          await expect(page.locator('[data-kg-detail] .kg-skel-card')).toBeVisible();
          expect(await page.locator(".spinner, [class*=loading-icon]").count()).toBe(0);
          // 骨架 pulse 动效（关键帧在场）
          const anim = await computed(page, ".kg-skel-line", "animation-name");
          expect(anim).toContain("kg-pulse");
          await mock.releaseAutoReplies();
          await expect(page.locator('[data-kg-detail] .kgv-dh-name')).toHaveText("Steer 消息队列", { timeout: 10_000 });
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    await page.screenshot({ path: evidencePath("kg-f5-1-5-graph-state", "png", "CL-5"), fullPage: false });
    assertFidelityGreen(report);
  });

  test("全局：主题切换 helix-theme / 氛围层 / toast / 反向断言（FID-01/02/22/24 + 断言边界）", async ({ mock, page }) => {
    const checks: FidelityCheck[] = [
      {
        id: "FID-02",
        title: "氛围层：蓝图网格底纹+扫描线（仅暗色）；暗默认",
        run: async () => {
          // 暗默认（无存储时 html 不带 light）
          expect(await page.evaluate(() => document.documentElement.classList.contains("light"))).toBe(false);
          const bodyBg = await computed(page, "body", "background-image");
          expect(bodyBg).toContain("linear-gradient");
          await expect(page.locator(".scanline-overlay")).toBeVisible();
          // 亮跟随：扫描线关闭（reload 后 W6o 门禁停留 boot 屏——重驱握手）
          await page.evaluate(() => localStorage.setItem("helix-theme", "light"));
          await page.reload();
          await mock.connect();
          await expect(page.locator(".scanline-overlay")).toBeHidden();
          expect(await computed(page, ".scanline-overlay", "display")).toBe("none");
          await page.evaluate(() => localStorage.setItem("helix-theme", "dark"));
          await page.reload();
          await mock.connect();
        },
      },
      {
        id: "FID-22",
        title: "主题切换：暗默认/亮 html.light；localStorage 键 = helix-theme（AF-5 裁决；S1 单钮归 IconRail）",
        run: async () => {
          // S1：主题单钮全局唯一归 IconRail（图标 = 切换目标：dark 态显 Sun）
          await expect(page.locator("#btn-theme-toggle svg.lucide-sun")).toBeAttached();
          await page.locator("#btn-theme-toggle").click();
          expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("light");
          await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
          await expect(page.locator("#btn-theme-toggle svg.lucide-moon")).toBeAttached();
          await page.locator("#btn-theme-toggle").click();
          expect(await page.evaluate(() => localStorage.getItem("helix-theme"))).toBe("dark");
        },
      },
      {
        id: "FID-24",
        title: "toast：右下角自动消退",
        run: async () => {
          // 触发一枚 toast（feifei 重建完成）后验证自动消退
          // （FID-02 reload 后 mock 控制面随页面重置——重建会话；项目列表回来后
          // 域展开、未选中，直接点 feifei 行进 graph）
          await mock.open();
          await mock.waitForCommand("hello");
          await mock.emit(welcome({ sessionId: SID }));
          await mock.waitForConn("connected");
          const feifei = page.locator('.pj-row[data-name="feifei"]');
          await expect(feifei).toBeVisible({ timeout: 10_000 });
          await feifei.click();
          await expect(page.locator("[data-kg-rebuild]")).toBeVisible({ timeout: 10_000 });
          await page.locator("[data-kg-rebuild]").click();
          const zone = page.locator(".toast-zone");
          await expect(zone).toContainText("索引构建完成", { timeout: 15_000 });
          expect(await computed(page, ".toast-zone", "position")).toBe("fixed");
          await expect(zone.locator(".toast")).toHaveCount(0, { timeout: 10_000 }); // 自动消退
        },
      },
      {
        id: "反向断言",
        title: "data-proto-annotation 不存在；全程无路由跳转（URL 恒 /project，无 /kg 导航）",
        run: async () => {
          expect(await page.locator("[data-proto-annotation]").count()).toBe(0);
          expect(await page.locator("[data-route-note]").count()).toBe(0);
          // 全程交互后 URL 仍 /project（无 /kg、无跳转）
          await page.locator(".pj-rail-name").click();
          await page.locator('.pj-row[data-name="helix"]').click();
          await page.locator('[data-tab="report"]').click();
          await expect(page.locator('[data-kg-pane="report"]')).toBeVisible();
          expect(new URL(page.url()).pathname).toBe("/project");
          expect(await page.locator('[data-p1-project="/project"]').count()).toBe(1);
        },
      },
      {
        id: "机械核对④",
        title: "状态互斥结构断言：主区四态属性互斥；graph 态内部 view 单态",
        run: async () => {
          // 主区 data-pj-main ∈ 四态且互斥（同一时刻一个值即互斥承载）
          const mode = await page.locator(".pj-main").getAttribute("data-pj-main");
          expect(["empty", "absent", "building", "graph"]).toContain(mode);
          // graph 态：列表骨架与行与空态互斥（恰一）——先等列表 settle 再断言
          // （切项目后 60ms 骨架瞬态由 FID-23 独立覆盖，此处断稳定态不变式）
          await expect(page.locator(".kgv-list .kgv-row").first()).toBeVisible({ timeout: 10_000 });
          const counts = {
            skel: await page.locator(".kgv-list .kg-skel-row").count(),
            rows: await page.locator(".kgv-list .kgv-row").count(),
            empty: await page.locator(".kgv-list .kgv-empty").count(),
          };
          expect(counts.skel === 0 && (counts.rows > 0) !== (counts.empty > 0)).toBe(true);
        },
      },
    ];
    const report = await checkPrototypeFidelity(checks);
    assertFidelityGreen(report);
  });
});

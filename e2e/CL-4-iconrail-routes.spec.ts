/**
 * T3.4 —— CL-4 多页面导航框架（IconRail 页签 + 占位页施工牌；S2 五位）。
 *
 * 测试点（testing/test-design.md §2.4 TP-CL4-1~7；纯前端零协议面，全落 F 层）：
 * - TP-CL4-1 五路由位深链直达 + 未知/旧路径（/settings/models、S2 退役
 *   /models）回落工作台；
 * - TP-CL4-2 chat 页常驻 DOM 保流式（display 切换；切页零 WS 影响）；
 * - TP-CL4-3 IconRail 形态与序（64px glass 竖条 + 五钮序 + lucide 同名图标）；
 * - TP-CL4-4 激活态三件套静态特征 + 恰一激活 + hover 提亮 + 点击迁移
 *   （reduced-motion 关停 BorderBeam；不做帧级动画断言）；
 * - TP-CL4-5/6 施工牌全退役核销（T5.4 project 换真页后零占位）+ 未建连
 *   门禁 boot 屏语义（W6o）；真页还原归 CL-5-fidelity-trace-page /
 *   CL-skills / CL-3 / CL-1-CL-4 套件背书；
 * - TP-CL4-7 双主题（DARK/LIGHT 渲染正常）。
 * TP-CL4-8 页面域/会话域分离守护落 arch-guard（apps/shell/src/tests/ag-scans.test.ts）。
 */
import { test, expect } from "./harness/fixtures";
import { streamDelta } from "./harness/protocol";

/** 六路由位（序 = IconRail 钮序；icon = lucide kebab 名，同名断言面；S2 去
 *  models 位；T3.1 任务位入列——project 与 settings 之间）。 */
const PAGES = [
  { id: "chat", path: "/", icon: "message-square" },
  { id: "skills", path: "/skills", icon: "layers" },
  { id: "trace", path: "/trace", icon: "activity" },
  { id: "project", path: "/project", icon: "folder-kanban" },
  { id: "tasks", path: "/tasks", icon: "list-todo" },
  { id: "settings", path: "/settings", icon: "settings" },
] as const;

/** 施工牌占位页：已全退役（T5.4 project 换真 ProjectPage 后 ConstructionBoard
 *  零消费面——六路由全真页）。保留空数组作演进锚（TP-CL4-5/6 注记）。 */
const PLACEHOLDERS: readonly (typeof PAGES)[number][] = [];

/** fake transport 标准入口（URL 形态默认剧本，spec 手动驱动）。 */
const FAKE = "?fakeTransport=1";

/** 路由位 → 页面可见锚（chat = 既有工作台（.route-layer 作用域——S2 起
 *  settings 真页亦用 .app-layout 壳）；trace = 真 TracePage（f413587）；
 *  skills = 真智能体页（M6 T4）；project = 真 ProjectPage（T5.4）；
 *  tasks = 真 TasksPage（T3.1）；settings = 真设置页（S2，含模型配置
 *  分区）——施工牌全退役后六路由皆真页锚）。 */
function pageAnchor(path: string): string {
  if (path === "/") return ".route-layer .app-layout";
  if (path === "/trace") return `[data-trace-page="${path}"]`;
  if (path === "/skills") return `[data-agents-page="${path}"]`;
  if (path === "/project") return `[data-p1-project="${path}"]`;
  if (path === "/tasks") return `[data-p2-task="${path}"]`;
  return `[data-settings-page="${path}"]`;
}

test.describe("T3.4 CL-4 IconRail 页签导航框架", () => {
  test("TP-CL4-1 六路由深链直达 + 未知/旧路径回落工作台（不出现模型独立页）", async ({ mock, page }) => {
    test.slow(); // 10 次 goto+connect 矩阵：本地 ~15s，CI 慢机 ~35s+ 超默认 30s（CI 收敛批次实证）
    await mock.awaitReady();

    // 深链矩阵：六独立路径各自渲染对应页。W6o 门禁语义：路由层不再独立于
    // 连接态——深链先落地 boot 屏（full 序列），重驱握手 + workspace.get
    // 预绑定进门禁 main 后目标页渲染（序列断言 = 深链可达性保持）
    for (const p of PAGES) {
      await page.goto(`${p.path}${FAKE}`);
      await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
      await mock.connect();
      await expect(page.locator("nav.icon-rail")).toBeVisible();
      await expect(page.locator(pageAnchor(p.path))).toBeVisible();
      // 页面域五态互斥：其余页不渲染（chat 常驻 DOM 但 display 切换隐藏）。
      // S3a：智能体页亦迁 AppLayout（.app-layout 不再唯一）——chat 壳锄定
      // .route-layer（TP-CL4-2 同锚），防 strict mode 多元素。
      for (const q of PAGES) {
        if (q.path === p.path) continue;
        if (q.path === "/") {
          if (p.path !== "/") {
            await expect(page.locator(".route-layer .app-layout")).toBeAttached(); // 常驻 DOM
            await expect(page.locator(".route-layer .app-layout")).toBeHidden();
          }
        } else {
          await expect(page.locator(pageAnchor(q.path))).toHaveCount(0);
        }
      }
    }

    // S2 退役路径 /models：回落工作台（不出现设置页/模型分区）
    await page.goto(`/models${FAKE}`);
    await mock.connect();
    await expect(page.locator(".route-layer .app-layout")).toBeVisible();
    await expect(page.locator("[data-settings-page]")).toHaveCount(0);
    await expect(page.locator("[data-trace-page]")).toHaveCount(0);
    await expect(page.locator("[data-construction]")).toHaveCount(0);

    // 旧路径 /settings/models 不保兼容 → 回落工作台（Q-4b：不出现模型独立页）
    await page.goto(`/settings/models${FAKE}`);
    await mock.connect();
    await expect(page.locator(".route-layer .app-layout")).toBeVisible();
    await expect(page.locator("[data-settings-page]")).toHaveCount(0);
    await expect(page.locator("[data-trace-page]")).toHaveCount(0);
    await expect(page.locator("[data-construction]")).toHaveCount(0);

    // 未知路径回落工作台（F-9 既有语义）
    await page.goto(`/nope${FAKE}`);
    await mock.connect();
    await expect(page.locator(".route-layer .app-layout")).toBeVisible();
    await expect(page.locator("[data-settings-page]")).toHaveCount(0);
    await expect(page.locator("[data-trace-page]")).toHaveCount(0);
    await expect(page.locator("[data-construction]")).toHaveCount(0);
  });

  test("TP-CL4-3 IconRail 形态与序：64px 常驻 + HelixLogo + 六钮序 + 主题单钮 + 底部头像块", async ({ mock, page }) => {
    await mock.connect();

    const rail = page.locator("nav.icon-rail");
    await expect(rail).toBeVisible();
    await expect(rail).toHaveCSS("width", "64px");
    // S1：logo = HelixLogo 渐变图标（HX 文字退役）
    await expect(rail.locator(".rail-logo [data-brand-logo]")).toBeAttached();
    await expect(rail.locator(".rail-avatar")).toBeAttached();

    // 六图标钮（rail-nav 内）：序 = chat/skills/trace/project/tasks/settings（S2 去 models；T3.1 任务位入列）
    const btns = rail.locator(".rail-nav .rail-btn");
    await expect(btns).toHaveCount(6);
    const order = await btns.evaluateAll((els) => els.map((el) => el.getAttribute("data-page")));
    expect(order).toEqual(PAGES.map((p) => p.id));

    // lucide 同名图标（MessageSquare/Layers/Activity/FolderKanban/Settings）
    for (const p of PAGES) {
      await expect(
        rail.locator(`.rail-btn[data-page="${p.id}"] svg.lucide-${p.icon}`),
      ).toBeAttached();
    }

    // S1：主题切换单钮（rail-nav 外、avatar 上；dark 态显示 Sun = 切换目标）
    const themeBtn = rail.locator("#btn-theme-toggle");
    await expect(themeBtn).toBeAttached();
    await expect(themeBtn.locator("svg.lucide-sun")).toBeAttached();

    // 常驻：切到占位页后 rail 仍挂载可见
    await rail.locator('.rail-btn[data-page="trace"]').click();
    await expect(rail).toBeVisible();
    await expect(rail).toHaveCSS("width", "64px");
  });

  test("TP-CL4-4 激活态三件套 + 恰一激活 + hover 提亮 + 点击迁移 + reduced-motion 关停", async ({ mock, page }) => {
    await mock.connect();

    // 恰一激活（初始 = chat）
    await expect(page.locator(".rail-btn.on")).toHaveCount(1);
    const chatBtn = page.locator('.rail-btn[data-page="chat"]');
    await expect(chatBtn).toHaveClass(/on/);

    // 三件套静态特征：① cyan 发光底（glow box-shadow + accent 边）
    await expect(chatBtn).toHaveCSS("box-shadow", /rgb/);
    const borderColor = await chatBtn.evaluate((el) => getComputedStyle(el).borderColor);
    expect(borderColor).not.toBe("rgba(0, 0, 0, 0)");
    // ② 左 2px 指示条（::before）
    const indicator = await chatBtn.evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return { width: s.width, content: s.content };
    });
    expect(indicator.width).toBe("2px");
    // ③ BorderBeam 巡游（::after conic 光带；@supports 兜底时缺席也算通过——
    //    断言「存在则为 conic + beam-rotate」）
    const beam = await chatBtn.evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return { content: s.content, bg: s.backgroundImage, anim: s.animationName, display: s.display };
    });
    if (beam.display !== "none" && beam.content !== "none") {
      expect(beam.bg).toContain("conic-gradient");
      expect(beam.anim).toBe("beam-rotate");
    }

    // reduced-motion：BorderBeam 关停
    await page.emulateMedia({ reducedMotion: "reduce" });
    const beamRm = await chatBtn.evaluate(
      (el) => getComputedStyle(el, "::after").animationName,
    );
    expect(beamRm).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // hover 提亮（非激活钮 color 变化；0.2s transition → poll 至过渡生效）
    const skillsBtn = page.locator('.rail-btn[data-page="skills"]');
    const colorBefore = await skillsBtn.evaluate((el) => getComputedStyle(el).color);
    await skillsBtn.hover();
    await expect
      .poll(() => skillsBtn.evaluate((el) => getComputedStyle(el).color))
      .not.toBe(colorBefore);

    // 点击切换：激活态随迁 + URL 更新
    await skillsBtn.click();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(page.locator(".rail-btn.on")).toHaveCount(1);
    await expect(skillsBtn).toHaveClass(/on/);
    await expect(chatBtn).not.toHaveClass(/on/);
  });

  test("TP-CL4-2 chat 常驻 DOM 保流式 + 切页零 WS 影响 + 其余页离开卸载", async ({ mock, page }) => {
    await mock.connect();
    const helloCount = async () =>
      (await mock.clientFrames()).filter((f) => f.type === "hello").length;
    const helloBefore = await helloCount();

    // 主流式进行中（主实例 delta → streaming 气泡）
    await mock.emit(streamDelta("m-nav-1", "流式上半段。"));
    await expect(page.locator(".msg.assistant")).toHaveCount(1);

    // 流式中切到 skills（真智能体页）：工作台隐藏但常驻 DOM，真页出现
    await page.locator('.rail-btn[data-page="skills"]').click();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(page.locator('[data-agents-page="/skills"]')).toBeVisible();
    await expect(page.locator('[data-route="off"] .app-layout')).toBeAttached();

    // 切走期间流式不中断（隐藏 DOM 持续更新）
    await mock.emit(streamDelta("m-nav-1", "切页期间追加的下半段。"));
    await expect(page.locator(".msg.assistant").first()).toContainText("切页期间追加的下半段");

    // SessionProvider 在路由层之上：切页零 WS 影响（无新 hello / 无重订阅抖动）
    expect(await helloCount()).toBe(helloBefore);

    // 切回 chat：状态保持（流式内容完整）
    await page.locator('.rail-btn[data-page="chat"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".app-layout")).toBeVisible();
    await expect(page.locator(".msg.assistant").first()).toContainText(
      "流式上半段。切页期间追加的下半段。",
    );
    // 真页条件渲染：离开卸载（智能体页同施工牌语义）
    await expect(page.locator('[data-agents-page="/skills"]')).toHaveCount(0);
    expect(await helloCount()).toBe(helloBefore);
  });

  test("TP-CL4-5/6 施工牌全退役（六路由真页锚）+ 未建连门禁 boot 屏语义", async ({ mock, page }) => {
    await mock.awaitReady();
    // 演进注记（2026-09）：施工牌随 project 换真 ProjectPage（T5.4）全退役，
    // ConstructionBoard 组件零消费面——原「施工牌同构 + 预告无时间承诺 +
    // 与断连态三重区分」覆盖意图由真页锚 + 门禁 boot 屏断言承接
    expect(PLACEHOLDERS).toHaveLength(0);

    // 六路由全真页锚 + 施工牌零残留
    for (const p of PAGES) {
      if (p.path === "/") continue; // chat 常驻 DOM（TP-CL4-2 覆盖）
      await page.goto(`${p.path}${FAKE}`);
      await mock.connect();
      await expect(page.locator(pageAnchor(p.path))).toBeVisible();
      await expect(page.locator("[data-construction]")).toHaveCount(0);
    }

    // 未建连门禁（三重区分演进）：无页面内容、无 conn-overlay——恒 boot 屏
    await page.goto(`/${FAKE}`);
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
    await expect(page.locator(".conn-overlay")).toHaveCount(0);
    await expect(page.locator(".route-layer .app-layout")).toHaveCount(0);
  });

  test("TP-CL4-7 双主题：IconRail / 施工牌 DARK·LIGHT 渲染正常", async ({ mock, page }) => {
    await mock.connect();

    for (const theme of ["light", "dark"] as const) {
      // S1：主题单钮（toggle；循环序 dark→light→dark 与单击节奏吻合）
      await page.locator("#btn-theme-toggle").click();
      if (theme === "light") {
        await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
      } else {
        await expect(page.locator("html")).not.toHaveClass(/light/);
      }
      await expect(page.locator("nav.icon-rail")).toBeVisible();
      await expect(page.locator(".rail-btn.on")).toHaveCount(1);

      await page.locator('.rail-btn[data-page="project"]').click();
      // T5.4：project 已换真 ProjectPage（施工牌全退役）
      await expect(page.locator('[data-p1-project="/project"]')).toBeVisible();

      await page.locator('.rail-btn[data-page="chat"]').click();
      await expect(page.locator(".app-layout")).toBeVisible();
    }
  });
});

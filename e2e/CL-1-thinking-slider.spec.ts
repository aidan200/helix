/**
 * T3.2 —— CL-1 P-1 chat 页 composer 推理强度滑块（F 层 mock mode E2E；
 * test-design §2.6/§2.7/§3/§5 口径；review.md §2 必须还原逐条核销的
 * 浏览器级证据面）。
 *
 * 剧本（fake transport 标准入口 ?fakeTransport=1；spec 手动驱动）：
 * - 主路径：建连（六档模型）→ 目录回放（CatalogModel 能力位防腐字段）→
 *   trigger 落位 .composer-foot 右侧 → popover 开合 → 拖动滑块（pointer
 *   三事件最近刻度吸附）→ thinking.set 命令帧断言（信封 sessionId）→
 *   thinking.changed 回推生效档显示 → 换模（model.changed）重解析 →
 *   「xhigh → high（模型能力所限）」轻提示 → PEAK（trigger+popover .peak +
 *   「▲ PEAK」徽章）→ 双主题 accent 同名变量（暗 #22D3EE / 亮 #2563EB）→
 *   刷新快照恢复（F1.5 E2E 边界 = 快照消费侧：快照读面携带 thinking 双位 →
 *   重连后 UI 与之一致；真实 daemon 重启回放链归 T3.1 integration，§5 口径）；
 * - 能力位变体（§4 mock 矩阵）：none（reasoning=false → 禁用态说明取代
 *   滑块位）/ 边界单档（n=1 防除零）/ 低于最低支持档（override minimal →
 *   effective low 回落 + 轻提示）；
 * - NFR-1 负断言：UI 无「关闭 reasoning/off」入口（档位集无 off 注入）；
 *   原型标注负断言：无 data-proto-annotation 锚。
 *
 * 证据：截图 + 断言输出落 docs/iterations/<iter>/evidence/e2e/（CL-1 前缀）。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import type { Page } from "@playwright/test";
import type { MockController } from "./harness/mock-session";
import type { CatalogModel } from "@helix/protocol";
import {
  authListResult,
  catalogModel,
  modelCatalogResult,
  modelChanged,
  modelGetDefaultResult,
  snapshot,
  thinkingChanged,
  welcome,
} from "./harness/protocol";

// ── 剧本常量（能力位三变体 + 边界变体；test-design §4 矩阵）──────────

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];
const TRI = ["low", "medium", "high"];
const M_SIX = "anthropic/claude-opus-4-1";
const M_TRI = "openai/gpt-5-mini";
const M_NONE = "local/qwen3-4b";
const M_SINGLE = "local/phi-4";
const SID = "sess-e2e";

const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function catalog(): CatalogModel[] {
  return [
    catalogModel(M_SIX, 200_000, COST, "builtin", { reasoning: true, thinkingLevels: SIX }),
    catalogModel(M_TRI, 200_000, COST, "builtin", { reasoning: true, thinkingLevels: TRI }),
    catalogModel(M_NONE, 32_000, COST, "builtin", { reasoning: false, thinkingLevels: [] }),
    catalogModel(M_SINGLE, 16_000, COST, "builtin", { reasoning: true, thinkingLevels: ["medium"] }),
  ];
}

/**
 * 建连 + 目录回放（picker 挂载即 requestModelConfig：catalog + get_default）。
 *
 * ⚠️ 目录拉取走「模型菜单开合」真实用户路径（T3.2 finding：picker 挂载效应
 * 在 fresh load 下早于 WS 握手，send 被 HelixWsClient 静默拒绝——已报
 * MainAgent 打回 T2.1；菜单路径是生产可用的幂等触发面，修复前后本 spec
 * 均有效）。
 */
async function connectWithCatalog(
  mock: MockController,
  page: Page,
  model: string,
  thinking?: { override: string | null; effective: string | null },
): Promise<void> {
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emitAll([
    welcome({ model }),
    snapshot([], { model, ...(thinking !== undefined ? { thinking } : {}) }),
  ]);
  await mock.waitForConn("connected");
  // 模型菜单开合触发目录拉取（见上 finding 注释）
  await page.locator("[data-model-badge]").click();
  await mock.waitForCommand("model.catalog");
  await mock.waitForCommand("model.get_default");
  await mock.emit(modelCatalogResult(catalog(), { source: "cache" }));
  await mock.emit(modelGetDefaultResult(M_SIX));
  await mock.emit(
    authListResult([
      { providerId: "anthropic", configured: true, keyMasked: "····e2e1" },
      { providerId: "openai", configured: true, keyMasked: "····e2e2" },
      { providerId: "local", configured: true, keyMasked: "····e2e3" },
    ]),
  );
  await page.locator(".msg-flow").click(); // 点外关闭菜单
  await expect(page.locator("[data-model-menu]")).toHaveCount(0);
}

const trigger = (page: Page) => page.locator(".tp-trigger");
const popover = (page: Page) => page.locator(".tp-popover");

/** 打开 popover 并断言 hud-popover 产品内容（review.md §2-2）。 */
async function openPopover(page: Page): Promise<void> {
  await trigger(page).click();
  await expect(popover(page)).toBeVisible();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(popover(page).locator(".tp-title")).toHaveText("Reasoning Effort");
  await expect(popover(page)).toContainText("会话覆盖 · 仅本会话生效");
}

/** 真实指针拖动（pointerdown/move/up，最近刻度吸附；fromPct → toPct）。 */
async function dragTrack(page: Page, fromPct: number, toPct: number): Promise<void> {
  const box = await page.locator(".tl-track").boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + box!.width * fromPct, y);
  await page.mouse.down();
  const steps = 5;
  for (let i = 1; i <= steps; i += 1) {
    const p = fromPct + ((toPct - fromPct) * i) / steps;
    await page.mouse.move(box!.x + box!.width * p, y);
  }
  await page.mouse.up();
}

test.describe("T3.2 CL-1 P-1 推理强度滑块（F 层 mock）", () => {
  test("主路径：落位 → 拖动 → thinking.set → 生效档 → 换模轻提示 → PEAK → 双主题 → 刷新快照恢复", async ({ mock, page }) => {
    await connectWithCatalog(mock, page, M_SIX);

    // ── 落位（review §2-1）：trigger 位于 .composer-foot 右侧（末位子元素）──
    const foot = page.locator(".composer-foot");
    await expect(foot.locator(".thinking-picker")).toHaveCount(1);
    await expect(trigger(page).locator(".tp-label")).toHaveText("THINKING");
    await expect(trigger(page).locator(".tp-chev")).toBeVisible();
    // 无覆盖 → AUTO（provider 默认语义）
    await expect(trigger(page).locator(".tp-level")).toHaveText("AUTO");
    const lastIsPicker = await foot.evaluate((el) =>
      el.lastElementChild?.classList.contains("thinking-picker") ?? false,
    );
    expect(lastIsPicker).toBe(true);

    // ── popover 开合 + 六档刻度（F1.2 能力位驱动：刻度数 = thinkingLevels.length）──
    await openPopover(page);
    await expect(popover(page).locator(".tl-tick")).toHaveCount(6);
    await expect(popover(page).locator(".tl-tick").first()).toHaveAttribute("data-level", "minimal");

    // ── 拖动选档（F1.1）：pointerdown 吸附 medium → 拖至 xhigh ──
    await dragTrack(page, 0.42, 0.8);
    const sets = (await mock.clientFrames()).filter((f) => f.type === "thinking.set");
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(sets[0]!.payload).toEqual({ level: "medium" }); // 落点吸附
    expect(sets[sets.length - 1]!.payload).toEqual({ level: "xhigh" }); // 拖至 80% = idx4
    expect(sets[sets.length - 1]!.sessionId).toBe(SID); // 信封 sessionId 必填（AD-4①）

    // ── 生效档显示（thinking.changed 回推权威；UI 零解析）──
    await mock.emit(thinkingChanged(SID, { override: "xhigh", effective: "xhigh" }));
    await expect(trigger(page).locator(".tp-level")).toHaveText("XHIGH");
    await expect(popover(page).locator(".tl-tick.cur")).toHaveText("xhigh");
    // 无钳制 → 无轻提示（重渲染清旧态）
    await expect(popover(page).locator(".tp-hint")).toHaveCount(0);

    // ── 换模重解析（F1.3）：model.changed + thinking.changed 钳制回推 ──
    await mock.emitAll([
      modelChanged(SID, M_TRI, M_SIX),
      thinkingChanged(SID, { override: "xhigh", effective: "high" }),
    ]);
    await expect(popover(page).locator(".tp-hint")).toHaveText("xhigh → high（模型能力所限）");
    await expect(popover(page).locator(".tl-tick")).toHaveCount(3); // 三档重渲染
    await expect(popover(page).locator(".tl-tick.cur")).toHaveText("high"); // 滑块显示生效档
    await expect(trigger(page).locator(".tp-level")).toHaveText("HIGH");

    // ── PEAK（F1.4）：三档模型最高档 high = 能力上限 → 同入 .peak + 徽章 ──
    await expect(trigger(page)).toHaveClass(/peak/);
    await expect(popover(page)).toHaveClass(/peak/);
    await expect(popover(page).locator(".tp-peak-badge")).toBeVisible();
    await expect(popover(page).locator(".tp-peak-badge")).toHaveText("▲ PEAK");
    const darkShot = await shotEvidence(page, "thinking-p1-peak-dark", "CL-1");

    // ── 双主题（§3 双主题与设计系统）：accent 同名变量暗 #22D3EE / 亮 #2563EB ──
    const levelColor = async () =>
      trigger(page).locator(".tp-level").evaluate((el) => getComputedStyle(el).color);
    expect(await levelColor()).toBe("rgb(34, 211, 238)"); // 暗色 accent #22D3EE
    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/light/);
    expect(await levelColor()).toBe("rgb(37, 99, 235)"); // 亮色 accent #2563EB
    const lightShot = await shotEvidence(page, "thinking-p1-peak-light", "CL-1");
    // PEAK 态跨主题保持（同名变量渲染，形态契约不变）
    await expect(trigger(page)).toHaveClass(/peak/);

    // ── NFR-1 + 原型标注负断言 ──
    const bodyText = (await page.locator("body").textContent()) ?? "";
    expect(bodyText).not.toContain("关闭 reasoning");
    expect(bodyText).not.toContain("关闭推理");
    await expect(page.locator('.tl-tick[data-level="off"]')).toHaveCount(0);
    await expect(page.locator("[data-proto-annotation]")).toHaveCount(0);

    // ── F1.5 刷新快照恢复（§5 E2E 边界 = 快照消费侧）──
    await page.reload();
    await mock.awaitReady();
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ model: M_TRI }),
      snapshot([], { model: M_TRI, thinking: { override: "xhigh", effective: "high" } }),
    ]);
    await mock.waitForConn("connected");
    // 目录拉取（菜单路径；finding 见 connectWithCatalog 注释）
    await page.locator("[data-model-badge]").click();
    await mock.waitForCommand("model.catalog");
    await mock.waitForCommand("model.get_default");
    await mock.emit(modelCatalogResult(catalog(), { source: "cache" }));
    await mock.emit(modelGetDefaultResult(M_SIX));
    await page.locator(".msg-flow").click();
    await expect(page.locator("[data-model-menu]")).toHaveCount(0);
    // 快照读面 thinking 双位 → UI 与引擎一致（覆盖保留 + 生效档显示 + 轻提示 + PEAK）
    await expect(trigger(page).locator(".tp-level")).toHaveText("HIGH");
    await openPopover(page);
    await expect(popover(page).locator(".tp-hint")).toHaveText("xhigh → high（模型能力所限）");
    await expect(popover(page).locator(".tl-tick.cur")).toHaveText("high");
    await expect(trigger(page)).toHaveClass(/peak/);
    const restoreShot = await shotEvidence(page, "thinking-p1-snapshot-restored", "CL-1");

    writeEvidence(
      "thinking-p1-assertions",
      "md",
      [
        "# CL-1 P-1 E2E 断言输出（主路径）",
        "",
        `- thinking.set 帧序：${sets.map((f) => JSON.stringify(f.payload)).join(" → ")}（sessionId=${SID}）`,
        "- 换模重解析：model.changed → thinking.changed{override:xhigh,effective:high} → 轻提示「xhigh → high（模型能力所限）」+ 3 刻度重渲染",
        "- PEAK：trigger/popover 同挂 .peak + 「▲ PEAK」徽章可见",
        "- 双主题 accent：dark rgb(34, 211, 238) / light rgb(37, 99, 235)（同名变量）",
        "- F1.5 快照恢复：reload 后 snapshot.thinking{override:xhigh,effective:high} → trigger HIGH + 轻提示 + PEAK 一致",
        "- NFR-1 负断言：无「关闭 reasoning」入口、无 [data-level=off] 档位、无 data-proto-annotation 锚",
        "",
        "## 证据截图",
        `- ${darkShot}`,
        `- ${lightShot}`,
        `- ${restoreShot}`,
      ].join("\n"),
      "CL-1",
    );
  });

  test("能力位变体 none：reasoning=false → trigger 禁用 + 说明取代滑块位（滑块不渲染）", async ({ mock, page }) => {
    await connectWithCatalog(mock, page, M_NONE);
    await expect(trigger(page)).toHaveAttribute("aria-disabled", "true");
    await expect(trigger(page)).toHaveClass(/disabled/);
    await expect(trigger(page).locator(".tp-level")).toHaveText("OFF");
    await trigger(page).click({ force: true }); // aria-disabled 仍可点开读说明（产品必要交代；force 跳过 actionability 的 aria-disabled 判停）
    await expect(popover(page)).toBeVisible();
    await expect(popover(page).locator(".tp-disabled-note")).toContainText("当前模型不支持 reasoning");
    await expect(popover(page).locator(".tl-track")).toHaveCount(0); // 滑块不渲染（两态不叠加）
    const shot = await shotEvidence(page, "thinking-p1-disabled-none", "CL-1");
    writeEvidence("thinking-p1-variant-none", "md", `# CL-1 P-1 none 变体\n\n- reasoning=false → trigger aria-disabled + OFF + 说明取代滑块位\n- ${shot}\n`, "CL-1");
  });

  test("边界变体：单档防除零 + 覆盖低于最低支持档回落（levels[0]）+ 轻提示", async ({ mock, page }) => {
    // 单档变体（n=1，pct 防除零）
    await connectWithCatalog(mock, page, M_SINGLE);
    await openPopover(page);
    await expect(popover(page).locator(".tl-tick")).toHaveCount(1);
    await mock.emit(thinkingChanged(SID, { override: "medium", effective: "medium" }));
    const thumbLeft = await popover(page).locator(".tl-thumb").evaluate((el) => (el as HTMLElement).style.left);
    expect(thumbLeft).toBe("0%");
    expect(thumbLeft).not.toContain("NaN");
    // 单档即最高档 → PEAK
    await expect(trigger(page)).toHaveClass(/peak/);

    // 覆盖低于最低支持档：切三档模型 + daemon 回落回推（resolveEffective levels[0] 分支镜像）
    await mock.emitAll([
      modelChanged(SID, M_TRI, M_SINGLE),
      thinkingChanged(SID, { override: "minimal", effective: "low" }),
    ]);
    await expect(popover(page).locator(".tl-tick")).toHaveCount(3);
    await expect(popover(page).locator(".tl-tick.cur")).toHaveText("low");
    await expect(popover(page).locator(".tp-hint")).toHaveText("minimal → low（模型能力所限）");
    const shot = await shotEvidence(page, "thinking-p1-boundary-variants", "CL-1");
    writeEvidence(
      "thinking-p1-boundary-variants",
      "md",
      `# CL-1 P-1 边界变体\n\n- 单档：1 刻度 + thumb 0%（无 NaN）+ 单档即 PEAK\n- 低于最低支持档：minimal → low 回落 + 轻提示 + 滑块强调 low\n- ${shot}\n`,
      "CL-1",
    );
  });
});

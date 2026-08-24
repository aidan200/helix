/**
 * T3.2 —— CL-1 P-2 agents 页 profile 推理级别字段（F 层 mock mode E2E；
 * test-design §2.6/§3 口径；review.md §3 必须还原逐条核销的浏览器级证据面）。
 *
 * 剧本（fake transport 标准入口；agent.config 族契约 v0.6 + thinking 槽位
 * v0.11 AD-6 扩维）：
 * - ghost（F2.1 留空）：dashed 框 + 空心 thumb 停兜底 medium 位 + 刻度去
 *   强调 +「未配置」中性徽标 + 回落说明 + × 隐藏；
 * - 配置：点刻度 high → agent.config.set_enabled{resourceType:"thinking",
 *   name:"high",enabled:true} → applied + changed + 重拉 → configured
 *   （accent 档位徽标 + × 清除钮 + spawn 快照说明 + 实 thumb）；
 * - 清除：× → set_enabled{name:"-",enabled:false} → 重拉回 ghost（两态
 *   视觉与徽标同步切换不叠加）；
 * - 换模轻提示（F2.2）：已配 xhigh → 槽位切三档模型 → 「xhigh → high
 *   （模型能力所限；spawn 解析时按能力过滤，配置值不丢）」+ 徽标仍示 xhigh
 *   （配置值本体不改写）+ PEAK（high = 三档能力上限）；
 * - 禁用：槽位切 reasoning=false 模型 → 字段禁用 + 滑块不渲染 + 已有配置
 *   保留不可改（徽标保留、× 隐藏）；
 * - NFR-1 / 原型标注负断言。
 *
 * 证据：截图 + 断言输出落 docs/iterations/<iter>/evidence/e2e/（CL-1 前缀）。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import type { Page } from "@playwright/test";
import type { MockController } from "./harness/mock-session";
import type { AgentConfigProfileBlock, CatalogModel } from "@helix/protocol";
import type { ClientFrame } from "./harness/protocol";
import {
  agentConfigChanged,
  agentConfigListResult,
  agentConfigSetResult,
  authListResult,
  catalogModel,
  modelCatalogResult,
  snapshot,
  welcome,
} from "./harness/protocol";

// ── 剧本常量（能力位三变体；与 P-1 spec 同目录数据面）────────────────

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];
const TRI = ["low", "medium", "high"];
const M_SIX = "anthropic/claude-opus-4-1";
const M_TRI = "openai/gpt-5-mini";
const M_NONE = "local/qwen3-4b";
const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function catalog(): CatalogModel[] {
  return [
    catalogModel(M_SIX, 200_000, COST, "builtin", { reasoning: true, thinkingLevels: SIX }),
    catalogModel(M_TRI, 200_000, COST, "builtin", { reasoning: true, thinkingLevels: TRI }),
    catalogModel(M_NONE, 32_000, COST, "builtin", { reasoning: false, thinkingLevels: [] }),
  ];
}

/** profile 块（thinking 槽位 v0.11 扩维；工具/技能面最简——本 spec 断言面在 thinking 字段）。 */
function block(
  profileKind: "main-session" | "subagent-worker",
  model: string | null,
  thinkingLevel: string | null,
): AgentConfigProfileBlock {
  return {
    profileKind,
    tools: [{ name: "read", enabled: true, snippet: "读取文件内容（文本或图片）" }],
    skills: [],
    diagnostics: [],
    model,
    thinkingLevel,
  };
}

const field = (page: Page, kind: string) => page.locator(`[data-thinking-field="${kind}"]`);

/** 命令帧计数（多写序列的增量等待基准——waitForCommand 首帧匹配不适用）。 */
async function cmdCount(mock: MockController, type: string): Promise<number> {
  return (await mock.clientFrames()).filter((f) => f.type === type).length;
}

/** 等待某命令帧数超过基准并返回最新帧。 */
async function waitNextCommand(mock: MockController, type: string, before: number): Promise<ClientFrame> {
  let found: ClientFrame | undefined;
  await expect
    .poll(
      async () => {
        const frames = (await mock.clientFrames()).filter((f) => f.type === type);
        found = frames.length > before ? frames[frames.length - 1] : undefined;
        return Boolean(found);
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  return found!;
}

/** 进 agents 页 + 回放 list 双块（sub 槽位 = 六档模型）+ 能力位目录 + auth。 */
async function openAgents(
  mock: MockController,
  page: Page,
  subModel: string | null = M_SIX,
  subThinking: string | null = null,
): Promise<void> {
  await page.goto("/skills?fakeTransport=1");
  await mock.awaitReady();
  await mock.open();
  await mock.waitForCommand("hello");
  await mock.emitAll([welcome({}), snapshot([], {})]);
  await mock.waitForConn("connected");
  await mock.waitForCommand("agent.config.list");
  await mock.waitForCommand("model.catalog");
  await mock.waitForCommand("auth.list");
  await mock.emit(modelCatalogResult(catalog(), { source: "cache" }));
  await mock.emit(
    authListResult([
      { providerId: "anthropic", configured: true, keyMasked: "····e2e1" },
      { providerId: "openai", configured: true, keyMasked: "····e2e2" },
      { providerId: "local", configured: true, keyMasked: "····e2e3" },
    ]),
  );
  await mock.emit(
    agentConfigListResult([
      block("main-session", M_SIX, null),
      block("subagent-worker", subModel, subThinking),
    ]),
  );
  await expect(page.locator('[data-agents-page="/skills"]')).toBeVisible();
}

/** 写面收口链：applied 回执 → changed 广播 → 重拉 list 回放新块。 */
async function settleWrite(
  mock: MockController,
  changed: { profileKind: "main-session" | "subagent-worker"; resourceType: "model" | "thinking"; name: string | null; enabled: boolean },
  subModel: string | null,
  subThinking: string | null,
): Promise<void> {
  const listBefore = await cmdCount(mock, "agent.config.list");
  await mock.emit(agentConfigSetResult({ status: "applied" }));
  await mock.emit(agentConfigChanged(changed));
  await waitNextCommand(mock, "agent.config.list", listBefore); // changed → 重拉（事件驱动）
  await mock.emit(
    agentConfigListResult([
      block("main-session", M_SIX, null),
      block("subagent-worker", subModel, subThinking),
    ]),
  );
}

test.describe("T3.2 CL-1 P-2 profile 推理级别字段（F 层 mock）", () => {
  test("主路径：ghost → 配置 → 清除 → 换模轻提示 → 禁用（F2.1/F2.2 全链）", async ({ mock, page }) => {
    await openAgents(mock, page);
    const f = field(page, "subagent-worker");

    // ── ghost 未配置态（F2.1；review §3-3）──
    await expect(f).toHaveClass(/unset/);
    await expect(f.locator(".tl-state")).toHaveText("未配置");
    await expect(f.locator(".tl-state")).not.toHaveClass(/set/);
    await expect(f.locator(".tl-box")).toHaveCSS("border-style", "dashed");
    await expect(f.locator(".tl-thumb")).toHaveClass(/ghost/);
    expect(await f.locator(".tl-thumb").evaluate((el) => (el as HTMLElement).style.left)).toBe("40%"); // 兜底 medium = 六档 idx2
    await expect(f.locator(".tl-tick.on")).toHaveCount(0); // 刻度去强调
    await expect(f.locator(".tl-tick.cur")).toHaveCount(0);
    await expect(f.locator(".ag-note")).toContainText("spawn 解析时回落兜底 medium");
    await expect(f.locator(".tl-clear")).toHaveCount(0); // × 隐藏
    // label 与模型槽位并列（review §3-1）
    await expect(f.locator(".hud-label")).toHaveText("推理级别 · THINKING LEVEL");
    const ghostShot = await shotEvidence(page, "thinking-p2-ghost", "CL-1");

    // ── 配置：点刻度 high → thinking 槽位写入 → 重拉收口 configured ──
    await f.locator('.tl-tick[data-level="high"]').click();
    let cmd = await waitNextCommand(mock, "agent.config.set_enabled", 0);
    expect(cmd.payload).toEqual({
      profileKind: "subagent-worker",
      resourceType: "thinking",
      name: "high",
      enabled: true,
    });
    expect(cmd.sessionId).toBeUndefined(); // 全局命令
    await settleWrite(
      mock,
      { profileKind: "subagent-worker", resourceType: "thinking", name: "high", enabled: true },
      M_SIX,
      "high",
    );
    // configured 态：accent 徽标 + × + spawn 快照说明 + 实 thumb（两态不叠加）
    await expect(f).not.toHaveClass(/unset/);
    await expect(f.locator(".tl-state")).toHaveText("high");
    await expect(f.locator(".tl-state")).toHaveClass(/set/);
    await expect(f.locator(".tl-clear")).toBeVisible();
    await expect(f.locator(".ag-note")).toContainText("spawn 时按此档解析快照");
    await expect(f.locator(".tl-thumb")).not.toHaveClass(/ghost/);
    await expect(f.locator(".tl-tick.cur")).toHaveText("high");
    const configuredShot = await shotEvidence(page, "thinking-p2-configured", "CL-1");

    // ── 清除：× → clear 槽位 → 回 ghost ──
    let before = await cmdCount(mock, "agent.config.set_enabled");
    await f.locator(".tl-clear").click();
    cmd = await waitNextCommand(mock, "agent.config.set_enabled", before);
    expect(cmd.payload).toEqual({
      profileKind: "subagent-worker",
      resourceType: "thinking",
      name: "-",
      enabled: false,
    });
    await settleWrite(
      mock,
      { profileKind: "subagent-worker", resourceType: "thinking", name: null, enabled: false },
      M_SIX,
      null,
    );
    await expect(f).toHaveClass(/unset/);
    await expect(f.locator(".tl-state")).toHaveText("未配置");
    await expect(f.locator(".tl-thumb")).toHaveClass(/ghost/);

    // ── 换模轻提示（F2.2）：先配 xhigh，再切三档模型 ──
    before = await cmdCount(mock, "agent.config.set_enabled");
    await f.locator('.tl-tick[data-level="xhigh"]').click();
    await waitNextCommand(mock, "agent.config.set_enabled", before);
    await settleWrite(
      mock,
      { profileKind: "subagent-worker", resourceType: "thinking", name: "xhigh", enabled: true },
      M_SIX,
      "xhigh",
    );
    await expect(f.locator(".tl-state")).toHaveText("xhigh");
    // 槽位切三档模型（select 真实交互）
    before = await cmdCount(mock, "agent.config.set_enabled");
    await page.locator("#sel-model-subagent-worker").selectOption(M_TRI);
    cmd = await waitNextCommand(mock, "agent.config.set_enabled", before);
    expect(cmd.payload).toEqual({
      profileKind: "subagent-worker",
      resourceType: "model",
      name: M_TRI,
      enabled: true,
    });
    await settleWrite(
      mock,
      { profileKind: "subagent-worker", resourceType: "model", name: M_TRI, enabled: true },
      M_TRI,
      "xhigh",
    );
    // 轻提示 + 配置值本体不改写 + 滑块显示生效位 high（三档 idx2 → 100%）+ PEAK
    await expect(f.locator(".tl-hint")).toHaveText(
      "xhigh → high（模型能力所限；spawn 解析时按能力过滤，配置值不丢）",
    );
    await expect(f.locator(".tl-state")).toHaveText("xhigh");
    await expect(f.locator(".tl-tick")).toHaveCount(3);
    expect(await f.locator(".tl-thumb").evaluate((el) => (el as HTMLElement).style.left)).toBe("100%");
    await expect(f.locator(".tl-box")).toHaveClass(/peak/); // high = 三档能力上限 → PEAK
    const clampedShot = await shotEvidence(page, "thinking-p2-clamped-peak", "CL-1");

    // ── 禁用：槽位切 reasoning=false 模型 → 字段禁用 + 配置保留不可改 ──
    before = await cmdCount(mock, "agent.config.set_enabled");
    await page.locator("#sel-model-subagent-worker").selectOption(M_NONE);
    await waitNextCommand(mock, "agent.config.set_enabled", before);
    await settleWrite(
      mock,
      { profileKind: "subagent-worker", resourceType: "model", name: M_NONE, enabled: true },
      M_NONE,
      "xhigh",
    );
    await expect(f).toHaveClass(/disabled/);
    await expect(f.locator(".tl-track")).toHaveCount(0); // 滑块不渲染（两态不叠加）
    await expect(f.locator(".tl-state")).toHaveText("xhigh"); // 已有配置保留
    await expect(f.locator(".tl-clear")).toHaveCount(0); // 不可改（× 隐藏）
    await expect(f.locator(".ag-note")).toContainText("不支持 reasoning");
    const disabledShot = await shotEvidence(page, "thinking-p2-disabled", "CL-1");

    // ── NFR-1 / 原型标注负断言 ──
    const bodyText = (await page.locator("body").textContent()) ?? "";
    expect(bodyText).not.toContain("关闭 reasoning");
    expect(bodyText).not.toContain("关闭推理");
    await expect(page.locator('.tl-tick[data-level="off"]')).toHaveCount(0);
    await expect(page.locator("[data-proto-annotation]")).toHaveCount(0);

    writeEvidence(
      "thinking-p2-assertions",
      "md",
      [
        "# CL-1 P-2 E2E 断言输出（主路径）",
        "",
        "- ghost：dashed 框 + 空心 thumb 40%（兜底 medium）+ 未配置徽标 + 回落说明 + × 隐藏",
        "- 配置：点刻度 high → set_enabled{thinking,high,true} → 重拉 → accent 徽标 + × + spawn 快照说明",
        "- 清除：× → set_enabled{thinking,-,false} → 重拉回 ghost（两态不叠加）",
        "- 换模轻提示：xhigh + 切三档 → 「xhigh → high（模型能力所限；spawn 解析时按能力过滤，配置值不丢）」+ 徽标仍 xhigh + PEAK",
        "- 禁用：切 reasoning=false → 字段禁用 + 滑块不渲染 + 配置保留 + × 隐藏",
        "- NFR-1 负断言：无「关闭 reasoning」入口、无 [data-level=off] 档位、无 data-proto-annotation 锚",
        "",
        "## 证据截图",
        `- ${ghostShot}`,
        `- ${configuredShot}`,
        `- ${clampedShot}`,
        `- ${disabledShot}`,
      ].join("\n"),
      "CL-1",
    );
  });

  test("能力位变体：三档 ghost 刻度数=3 + 六档/三档切换跟随槽位模型（TR-AD-42 不硬编码）", async ({ mock, page }) => {
    await openAgents(mock, page, M_TRI, null);
    const f = field(page, "subagent-worker");
    // 三档能力位 → 3 刻度（能力位驱动渲染）
    await expect(f.locator(".tl-tick")).toHaveCount(3);
    expect(await f.locator(".tl-tick").allTextContents()).toEqual(TRI.map((s) => s));
    // ghost 兜底 medium = 三档 idx1 → 50%
    expect(await f.locator(".tl-thumb").evaluate((el) => (el as HTMLElement).style.left)).toBe("50%");
    const shot = await shotEvidence(page, "thinking-p2-tri-ghost", "CL-1");
    writeEvidence("thinking-p2-tri-variant", "md", `# CL-1 P-2 三档变体\n\n- 刻度数=3 跟随槽位模型能力位；ghost 兜底 medium 停 50%\n- ${shot}\n`, "CL-1");
  });
});

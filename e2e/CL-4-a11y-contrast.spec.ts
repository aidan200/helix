/**
 * CL-4 F4.2 —— a11y 对比度断言（--text-faint 双主题 ≥4.5:1，F-6①/F-9 延后裁决兑现）。
 *
 * SoT 联动：断言解析 docs/design-system/tokens.md 主题注册表（两列值 +
 * 对应底色 token），不硬编码色值——token 再调时断言自动跟随注册表。
 *
 * 口径（brief 决策消解）：
 * - WCAG 2.x 相对亮度：sRGB 分量 c ≤ 0.03928 时线性 = c/12.92，否则
 *   ((c+0.055)/1.055)^2.4；L = 0.2126R + 0.7152G + 0.0722B；
 *   对比度 = (L1+0.05)/(L2+0.05)（L1 较亮）。
 * - 底色映射：暗列对 --void（最深底），亮列对 --bg（白底）——faint 文字
 *   实际所处底以 tokens.md 注册的 bg token 为准。
 * - 双主题各自断言（F-9：不只暗色列）。
 *
 * 一致性附加断言（防人工同步漂移）：tokens.css 实际变量值 == tokens.md
 * 注册表值——文本级（fs 解析 :root / html.light 块）+ 页面级
 * （getComputedStyle 实际生效值）双层；另含注册表内部自洽断言
 * （--text-faint-rgb 通道 == hex 换算，通道同步铁律）。
 *
 * 截图：双主题对照（who/ts/t-dur 痕迹文字消费面）落 evidence 目录
 * （T51_EVIDENCE_DIR 环境变量覆盖，缺省 test-results/t51-evidence）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test as nodeTest, expect } from "@playwright/test";
import { test as pageTest } from "./harness/fixtures";
import { cssVar } from "./harness/style-utils";
import { messageCompleted, msgEntry, toolResult } from "./harness/protocol";

const WORKTREE_ROOT = path.resolve(__dirname, "..");
const TOKENS_MD = path.join(WORKTREE_ROOT, "docs/design-system/tokens.md");
const TOKENS_CSS = path.join(WORKTREE_ROOT, "apps/shell/src/shared/ui/styles/tokens.css");
const EVIDENCE_DIR =
  process.env.T51_EVIDENCE_DIR ?? path.join(WORKTREE_ROOT, "test-results", "t51-evidence");

/** 底色映射（brief 决策消解）：暗列对 --void（最深底），亮列对 --bg（白底）。 */
const BG_TOKEN = { dark: "void", light: "bg" } as const;
type Theme = keyof typeof BG_TOKEN;

// ── tokens.md 注册表解析 ───────────────────────────────────

const md = fs.readFileSync(TOKENS_MD, "utf8");

/** 注册表行 → { dark, light }（行内前三个反引号 cell：变量名/暗列/亮列）。 */
function registryRow(name: string): { dark: string; light: string } {
  const line = md
    .split("\n")
    .find((l) => l.trimStart().startsWith("|") && l.includes("`--" + name + "`"));
  if (!line) throw new Error(`tokens.md 注册表未找到 --${name} 行`);
  const cells = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (cells.length < 3) throw new Error(`--${name} 行格式异常：${line}`);
  return { dark: cells[1], light: cells[2] };
}

/** cell 值中提取 6 位 hex（如 `#475569`（slate-600）→ #475569）。 */
function hexOf(cell: string): string {
  const m = /#([0-9a-fA-F]{6})/.exec(cell);
  if (!m) throw new Error(`cell 中无 6 位 hex：${cell}`);
  return `#${m[1]}`;
}

/** 通道 cell → [r, g, b]（如 `71 85 105`）。 */
function channelOf(cell: string): [number, number, number] {
  const m = /^(\d+) (\d+) (\d+)$/.exec(cell.trim());
  if (!m) throw new Error(`cell 中无 r g b 通道值：${cell}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// ── WCAG 2.x 对比度 ───────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function srgbToLinear(c: number): number {
  const cs = c / 255;
  // WCAG 2.0/2.1 阈值 0.03928（2.2 为 0.04045，对本色域各分量结果无差异）
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ── tokens.css 文本解析（一致性断言用）────────────────────

const css = fs.readFileSync(TOKENS_CSS, "utf8");

function cssBlock(selector: string): string {
  const m = new RegExp(`^${selector}\\s*\\{([\\s\\S]*?)\\}`, "m").exec(css);
  if (!m) throw new Error(`tokens.css 未找到 ${selector} 块`);
  return m[1];
}

function cssVarIn(block: string, name: string): string {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`块内未找到 --${name} 声明`);
  return m[1].trim();
}

// ── 断言主体 ──────────────────────────────────────────────

nodeTest.describe("CL-4 F4.2 对比度 ≥4.5:1（tokens.md SoT 联动，双主题各自）", () => {
  for (const theme of ["dark", "light"] as const) {
    nodeTest(`${theme === "dark" ? "暗列" : "亮列"} --text-faint 对 ${BG_TOKEN[theme]} 底 ≥4.5:1`, () => {
      const fg = hexOf(registryRow("text-faint")[theme]);
      const bgHex = hexOf(registryRow(BG_TOKEN[theme])[theme]);
      const ratio = contrastRatio(fg, bgHex);
      expect(
        ratio,
        `tokens.md ${theme} 列 --text-faint ${fg} 对底色 --${BG_TOKEN[theme]} ${bgHex} ` +
          `对比度 ${ratio.toFixed(3)}:1，需 ≥4.5:1（WCAG AA 正文）`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  nodeTest("注册表内部自洽：--text-faint-rgb 通道 == hex 换算（通道同步铁律）", () => {
    const faint = registryRow("text-faint");
    const channel = registryRow("text-faint-rgb");
    for (const theme of ["dark", "light"] as const) {
      expect(
        channelOf(channel[theme]),
        `tokens.md ${theme} 列通道 ${channel[theme]} 应等于 --text-faint ${faint[theme]} 的 r g b`,
      ).toEqual(hexToRgb(hexOf(faint[theme])));
    }
  });
});

nodeTest.describe("tokens.css ↔ tokens.md 一致性（防人工同步漂移）", () => {
  nodeTest(":root（暗）/ html.light（亮）的 --text-faint 与 -rgb 通道 == 注册表两列", () => {
    const root = cssBlock(":root");
    const light = cssBlock("html\\.light");
    const faint = registryRow("text-faint");
    const channel = registryRow("text-faint-rgb");

    expect(cssVarIn(root, "text-faint").toLowerCase()).toBe(faint.dark.toLowerCase());
    expect(cssVarIn(light, "text-faint").toLowerCase()).toBe(faint.light.toLowerCase());
    expect(channelOf(cssVarIn(root, "text-faint-rgb"))).toEqual(channelOf(channel.dark));
    expect(channelOf(cssVarIn(light, "text-faint-rgb"))).toEqual(channelOf(channel.light));
  });
});

pageTest.describe("页面实际生效值 == tokens.md 注册表（getComputedStyle）", () => {
  pageTest("暗色默认：--text-faint computed == 注册表暗列", async ({ mock, page }) => {
    await mock.connect();
    expect((await cssVar(page, "--text-faint")).toLowerCase()).toBe(
      hexOf(registryRow("text-faint").dark).toLowerCase(),
    );
  });

  pageTest("切亮色：--text-faint computed == 注册表亮列", async ({ mock, page }) => {
    await mock.connect();
    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass("light");
    expect((await cssVar(page, "--text-faint")).toLowerCase()).toBe(
      hexOf(registryRow("text-faint").light).toLowerCase(),
    );
  });
});

pageTest.describe("CL-4 F4.2 双主题截图对照（痕迹文字消费面）", () => {
  pageTest("who/ts/t-dur 痕迹文字在暗/亮两主题下对照截图", async ({ mock, page }) => {
    await mock.connect();

    // 痕迹文字消费面：user/assistant 消息（.who/.ts）+ done 工具卡（.t-dur）
    await mock.sendUserMessage("体检一轮设计 token");
    await mock.emit(messageCompleted(msgEntry("u-1", "user", "体检一轮设计 token")));
    await mock.emit(
      toolResult({
        kind: "tool-call",
        id: "t-1",
        name: "read",
        args: '{"path":"docs/design-system/tokens.md"}',
        state: "done",
        result: "# helix Design Token Registry（节选）…",
        durationMs: 240,
        ts: Date.now(),
      }),
    );
    await mock.emit(messageCompleted(msgEntry("a-1", "assistant", "token 体检完成，--text-faint 双主题达标。")));
    await expect(page.locator(".msg.user .meta .who")).toHaveText("用户");
    await expect(page.locator(".tool-card.done .t-dur")).toBeVisible();

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "CL-4-text-faint-dark.png") });

    await page.locator("#btn-theme-toggle").click();
    await expect(page.locator("html")).toHaveClass("light");
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "CL-4-text-faint-light.png") });
  });
});

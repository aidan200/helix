#!/usr/bin/env node
/**
 * perf + a11y 审计脚本（CL-6 验收锚；T4.2 入仓判据化）。
 *
 * 源：iter-20260816-6q6f final-verification/perf-a11y-audit.mjs（123 行硬编码
 * 色表 × WCAG 公式 + 12 步 Tab 遍历）——本仓化校准：
 * - 色表随 tokens.md/tokens.css 现状：--text-dim 暗列 T4.2 调值 #718198
 *   （三组合 4.87/4.61/4.75 全 ≥4.5）；亮列保留 #64748B（4.76 不回退）；
 *   --text-faint 双达标档（#728299 / #5B6B81）不回退。
 * - 遍历步骤随现状扩展：M4 新面纳入——IconRail 六图标钮（T3.4）/ 抽屉
 *   steer 输入栏（T3.3）/ 施工牌（Q-4c）的焦点链各自成段断言。
 * - 判据化：任一 FAIL 项 → 进程 exit 1（可重复执行 = `bun run audit:a11y`）。
 *
 * 运行：bun run audit:a11y（自包含：VITE_HELIX_FAKE_TRANSPORT=1 构建 mock
 * 产物 → vite preview → 审计 → 杀进程；无需外部服务）。
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
// 协议版本位单点化（F(2).1）：直读 envelope.ts 源文件（node ≥22.18 原生
// type-stripping，envelope.ts 自包含零依赖可独立加载；加载失败即抛错退出）。
import { PROTOCOL_VERSION } from "../packages/protocol/src/envelope.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = path.join(ROOT, "apps", "shell");
const HOST = "127.0.0.1";
const PORT = Number(process.env.AUDIT_PORT || 4178);
const BASE = `http://${HOST}:${PORT}`;
const V = PROTOCOL_VERSION; // 帧 v 位唯一事实源：packages/protocol/src/envelope.ts

const failures = [];
function gate(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} —— ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failures.push(`${name}${detail ? `（${detail}）` : ""}`);
}

/* ─────────── 0. 自包含服务：构建 mock 产物 + vite preview ─────────── */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: SHELL, stdio: "inherit", ...opts });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exit ${c}`))));
  });
}
async function waitReady(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`服务就绪超时：${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

console.log("═══ 0. 构建 mock 产物（VITE_HELIX_FAKE_TRANSPORT=1）+ vite preview ═══");
await run("bunx", ["vite", "build"], {
  env: { ...process.env, VITE_HELIX_FAKE_TRANSPORT: "1" },
});
const server = spawn("bunx", ["vite", "preview", "--host", HOST, "--port", String(PORT), "--strictPort"], {
  cwd: SHELL,
  stdio: "ignore",
});
process.on("exit", () => server.kill());
await waitReady(BASE);
console.log(`preview 就绪：${BASE}`);

/* ─────────── 1. WCAG 对比度（tokens.css 实值，T4.2 校准） ─────────── */
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return ((l1 + 0.05) / (l2 + 0.05)).toFixed(2);
}
const combos = {
  dark: {
    bg: "#0a0e16", elevated: "#0f1521", panel: "#0B1120",
    text: "#E2E8F0", muted: "#94A3B8", dim: "#718198", faint: "#728299", accent: "#22D3EE", violet: "#A855F7", error: "#F87171", success: "#34D399",
  },
  light: {
    bg: "#FFFFFF", elevated: "#FFFFFF", panel: "#FFFFFF",
    text: "#0F172A", muted: "#475569", dim: "#64748B", faint: "#5B6B81", accent: "#2563EB", violet: "#9333EA", error: "#B91C1C", success: "#15803D",
  },
};
console.log("═══ A. WCAG 对比度（正文标准 4.5:1 / 大文本与 UI 组件 3:1）═══");
for (const [theme, t] of Object.entries(combos)) {
  const rows = [];
  for (const fg of ["text", "muted", "dim", "faint", "accent", "violet", "error", "success"]) {
    for (const bg of ["bg", "elevated", "panel"]) {
      const r = ratio(t[fg], t[bg]);
      rows.push({ theme, fg: `${fg}(${t[fg]})`, bg: `${bg}(${t[bg]})`, ratio: Number(r), pass45: Number(r) >= 4.5, pass30: Number(r) >= 3 });
    }
  }
  const fail45 = rows.filter((x) => !x.pass45);
  const fail30 = rows.filter((x) => !x.pass30);
  console.log(`[${theme}] 组合 ${rows.length}：≥4.5:1 ${rows.length - fail45.length} 项；<4.5:1 → ${fail45.map((x) => `${x.fg.split("(")[0]}/${x.bg.split("(")[0]}=${x.ratio}`).join(", ") || "无"}；<3:1 → ${fail30.map((x) => `${x.fg.split("(")[0]}=${x.ratio}`).join(", ") || "无"}`);
  // 判据：文字四档（text/muted/dim/faint）全组合 ≥4.5；品牌/状态色 ≥3（UI 组件档）
  const textFail = rows.filter((x) => ["text", "muted", "dim", "faint"].some((k) => x.fg.startsWith(k + "(")) && !x.pass45);
  const brandFail = rows.filter((x) => ["accent", "violet", "error", "success"].some((k) => x.fg.startsWith(k + "(")) && !x.pass30);
  gate(`[${theme}] 文字四档全组合 ≥4.5:1`, textFail.length === 0, textFail.map((x) => `${x.fg.split("(")[0]}/${x.bg.split("(")[0]}=${x.ratio}`).join(", "));
  gate(`[${theme}] 品牌/状态色全组合 ≥3:1`, brandFail.length === 0, brandFail.map((x) => `${x.fg.split("(")[0]}=${x.ratio}`).join(", "));
}

/* ─────────── 2. 浏览器性能 + 可访问性 ─────────── */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 离线兜底路由（与 e2e/harness/fixtures.ts 同规）：dev-token HTTP 端点拦截
// （fake transport 懒装配在握手 token 获取之后，不拦截则 fetch 失败模块不载）
// + 外部字体离线化（无网环境不阻塞渲染）。
await page.route("**://127.0.0.1:*/helix-dev-token", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "text/plain",
    body: "e2e-dev-token",
    headers: { "access-control-allow-origin": "*" },
  });
});
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
  await route.fulfill({ status: 200, contentType: "text/css", body: "/* audit offline */" });
});

await page.goto(BASE, { waitUntil: "networkidle" });
// mock 剧本：建连 → 欢迎 + 快照（用户/助手/工具卡 + running 实例卡片）
await page.waitForFunction(() => Boolean(window.__helixMock), null, { timeout: 10_000 });
const mock = {
  open: () => page.evaluate(() => window.__helixMock.open()),
  emitAll: (frames) => page.evaluate((fs) => window.__helixMock.emitAll(fs), frames),
  clientFrames: () => page.evaluate(() => window.__helixMock.clientFrames()),
};
await mock.open();
await page.waitForFunction(
  () => window.__helixMock.clientFrames().some((f) => f && f.type === "hello"),
  null,
  { timeout: 5_000 },
);
await mock.emitAll([
  { v: V, type: "connection.welcome", payload: { sessionId: "sess-a11y", model: "claude-sonnet-4-5", agentState: "idle" } },
  {
    v: V, sessionId: "sess-a11y", channel: "session", type: "session.snapshot",
    payload: {
      snapshot: {
        sessionId: "sess-a11y", model: "claude-sonnet-4-5", agentState: "idle", revision: 3,
        entries: [
          { kind: "message", id: "e1", role: "user", content: "审计样例用户消息", ts: 1 },
          { kind: "message", id: "e2", role: "assistant", content: "审计样例助手回复", ts: 2 },
          { kind: "tool-call", id: "e3", name: "read", args: '{"path":"src/main.ts"}', state: "done", result: "ok", durationMs: 240, ts: 3 },
        ],
        tail: [
          { kind: "message", id: "e1", role: "user", content: "审计样例用户消息", ts: 1 },
          { kind: "message", id: "e2", role: "assistant", content: "审计样例助手回复", ts: 2 },
          { kind: "tool-call", id: "e3", name: "read", args: '{"path":"src/main.ts"}', state: "done", result: "ok", durationMs: 240, ts: 3 },
        ],
        totalEntries: 3, tailStartCursor: null,
        instances: [{ instanceId: "a1", kind: "subagent", profileKind: "subagent-worker", state: "running", task: "审计焦点链实例", model: "claude-sonnet-4-5", anchorEntryId: "e2", createdAt: new Date().toISOString() }],
      },
    },
  },
]);
await page.waitForSelector('.app[data-conn="connected"]', { timeout: 10_000 });
await page.waitForSelector(".msg.assistant", { timeout: 5_000 });

const perf = await page.evaluate(() => new Promise((resolve) => {
  const out = { lcp: 0, cls: 0, fcp: 0, ttfb: 0, interactions: [] };
  new PerformanceObserver((l) => {
    const es = l.getEntries();
    if (es.length) out.lcp = es[es.length - 1].startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) out.cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.interactionId > 0) out.interactions.push(Math.round(e.duration));
  }).observe({ type: "event", buffered: true });
  const nav = performance.getEntriesByType("navigation")[0];
  out.ttfb = Math.round(nav.responseStart);
  const paint = performance.getEntriesByType("paint");
  out.fcp = Math.round(paint.find((p) => p.name === "first-contentful-paint")?.startTime || 0);
  setTimeout(() => { out.cls = Number(out.cls.toFixed(4)); resolve(out); }, 300);
}));

console.log("═══ B. 性能指标（vite preview 生产构建，mock 模式，本地 WebView 等效环境）═══");
console.log(JSON.stringify(perf, null, 2));
console.log(`判定：LCP=${(perf.lcp / 1000).toFixed(2)}s（<2.5s ${perf.lcp < 2500 ? "PASS" : "FAIL"}）CLS=${perf.cls}（<0.1 ${perf.cls < 0.1 ? "PASS" : "FAIL"}）FCP=${(perf.fcp / 1000).toFixed(2)}s TTFB=${perf.ttfb}ms`);
gate("LCP <2.5s", perf.lcp < 2500, `LCP=${(perf.lcp / 1000).toFixed(2)}s`);
gate("CLS <0.1", perf.cls < 0.1, `CLS=${perf.cls}`);

/* 交互采样（近似 INP）：Tab 进入输入框 + 打字 + 点击会话卡 */
const input = page.locator('textarea, input[type="text"]').last();
await input.click().catch(() => {});
await page.keyboard.type("hello helix", { delay: 40 });
const sessionCard = page.locator('[data-testid*="session"], [class*="session-card"]').first();
await sessionCard.click().catch(() => {});
await page.waitForTimeout(800);
const interactions = await page.evaluate(() => {
  const out = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId > 0) out.push(Math.round(e.duration)); }).observe({ type: "event" });
  return new Promise((r) => setTimeout(() => r(out), 400));
});
const worst = Math.max(0, ...interactions, ...perf.interactions);
console.log(`交互 event duration 采样 ${interactions.length + perf.interactions.length} 次，最差 ${worst}ms（INP<200ms ${worst < 200 ? "PASS" : "FAIL"}，近似口径）`);
gate("INP 近似 <200ms", worst < 200, `worst=${worst}ms`);

/* 可访问性：alt / 键盘导航 / focus 可见性 */
const a11y = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll("img")];
  const noAlt = imgs.filter((i) => i.getAttribute("alt") === null);
  const buttons = [...document.querySelectorAll("button")];
  const noLabel = buttons.filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label") && !b.getAttribute("title"));
  const links = [...document.querySelectorAll("a")];
  const noLinkText = links.filter((a) => !a.textContent.trim() && !a.getAttribute("aria-label"));
  return { imgTotal: imgs.length, imgNoAlt: noAlt.length, btnTotal: buttons.length, btnNoLabel: noLabel.length, linkTotal: links.length, linkNoText: noLinkText.length, hasMainLandmark: !!document.querySelector('main,[role="main"]'), langAttr: document.documentElement.lang || "(none)" };
});
console.log("═══ C. 可访问性基础面 ═══");
console.log(JSON.stringify(a11y, null, 2));
gate("img 全带 alt", a11y.imgNoAlt === 0, `${a11y.imgNoAlt}/${a11y.imgTotal} 缺`);
gate("button 全带可读名（文本/aria-label/title）", a11y.btnNoLabel === 0, `${a11y.btnNoLabel}/${a11y.btnTotal} 缺`);

/* ─────────── 3. 键盘 Tab 焦点链（分段；T4.2 新面纳入） ─────────── */
/* 空跳根因（T4.2 排查结论）：历史报告「第 8 步 body/lost」非 tabindex 缺失/
 * 顺序断裂，而是 Tab 回卷边界的浏览器标准行为——最后一个可聚焦元素再 Tab，
 * 焦点移交浏览器 UI（headless 下 activeElement 读作 body），次步回首元素；
 * 极简 2 按钮页面同现。判据校准为：一轮遍历（n 可见可聚焦元素 + 1 步）中
 * body/lost ≤1（回卷步）且其余步恰好覆盖全部 n 元素各一次（中段零空跳）。 */
async function visibleTabbableCount() {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll("button, input, textarea, select, a[href], summary, [tabindex]")];
    return els.filter((e) => {
      if (e.disabled) return false;
      const ti = e.getAttribute("tabindex");
      if (ti !== null && Number(ti) < 0) return false;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return Boolean(e.offsetWidth || e.offsetHeight);
    }).length;
  });
}
async function gateFocusCycle(name) {
  const n = await visibleTabbableCount();
  await page.evaluate(() => document.activeElement?.blur?.());
  const trail = [];
  for (let i = 0; i < n + 1; i++) {
    await page.keyboard.press("Tab");
    trail.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body/lost";
        // 元素身份 = 可聚焦候选集 DOM 序索引（同类名元素唯一化，如 rail-btn 组）
        const els = [...document.querySelectorAll("button, input, textarea, select, a[href], summary, [tabindex]")];
        const idx = els.indexOf(el);
        const cs = getComputedStyle(el);
        const styled = cs.outlineStyle !== "none" || cs.boxShadow !== "none" || cs.borderColor !== cs.backgroundColor;
        return `@${idx} ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}${el.id ? "#" + el.id : ""}|focus样式:${styled ? "有" : "无"}`;
      }),
    );
  }
  console.log(`键盘 Tab 焦点链（${name}，${n}+1 步）：`, JSON.stringify(trail));
  const lost = trail.filter((t) => t.includes("lost")).length;
  const uniq = new Set(trail.filter((t) => !t.includes("lost")).map((t) => t.split("|")[0])).size;  gate(`${name}焦点链中段零空跳（回卷步 ≤1 且一轮覆盖全部可见元素）`, lost <= 1 && uniq === n, `lost=${lost}，一轮覆盖 ${uniq}/${n}`);
}

console.log("═══ D. 键盘焦点链（工作台主面 → 抽屉 steer 输入栏 → 智能体页）═══");
// 段 1：工作台主面（IconRail → 顶栏 → 侧栏 → 输入区 → DrawerRail 全链）
await gateFocusCycle("工作台主面");

// 段 2：抽屉 steer 输入栏（T3.3 新面）——点开 running 实例卡 → 抽屉内遍历
await page.locator('.sa-card[data-instance="a1"]').click();
await page.waitForSelector('.drawer[data-instance="a1"]', { timeout: 5_000 });
await gateFocusCycle("抽屉 steer 输入栏");
await page.keyboard.press("Escape");
await page.waitForSelector(".drawer", { state: "detached", timeout: 5_000 }).catch(() => {});

// 段 3：智能体页（M6 T4 真页，原施工牌面转正）——页面有交互面，焦点链遍历页面域
await page.goto(`${BASE}/skills`, { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__helixMock), null, { timeout: 10_000 });
await page.evaluate(() => window.__helixMock.open());
await page.waitForFunction(
  () => window.__helixMock.clientFrames().some((f) => f && f.type === "hello"),
  null,
  { timeout: 5_000 },
);
await page.evaluate((frames) => window.__helixMock.emitAll(frames), [
  { v: V, type: "connection.welcome", payload: { sessionId: "sess-a11y-ag", model: "claude-sonnet-4-5", agentState: "idle" } },
]);
await page.waitForFunction(
  () => window.__helixMock.clientFrames().some((f) => f && f.type === "agent.config.list"),
  null,
  { timeout: 5_000 },
);
// list 回执（自包含字面量，与 harness.agentConfigListResult 同构）：双 kind 最小块
await page.evaluate((frame) => window.__helixMock.emitAll([frame]), {
  v: V,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.list.result",
  payload: {
    profiles: [
      {
        profileKind: "main-session",
        tools: [
          { name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" },
          { name: "read", enabled: true, snippet: "读取文件内容（文本或图片）" },
          { name: "grep", enabled: false, snippet: "跨文件正则检索并列出匹配行" },
        ],
        skills: [],
        diagnostics: [],
        model: null,
      },
      {
        profileKind: "subagent-worker",
        tools: [
          { name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" },
          { name: "read", enabled: true, snippet: "读取文件内容（文本或图片）" },
        ],
        skills: [],
        diagnostics: [],
        model: null,
      },
    ],
  },
});
await page.waitForSelector('[data-agents-page="/skills"]', { timeout: 5_000 });
await page.waitForSelector('[data-switch="bash"]', { timeout: 5_000 });
await gateFocusCycle("智能体页");

await browser.close();
server.kill();

console.log("═══ 取证完成 ═══");
if (failures.length > 0) {
  console.error(`审计未通过（${failures.length} 项 FAIL）：\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("审计全过（对比度 / 性能 / 可访问性基础面 / 三段焦点链中段零空跳）——CL-6 验收锚达成");

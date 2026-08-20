/**
 * T4.1 —— G11 checkPrototypeFidelity 工具落地 + 本迭代四页（P-1~P-4）
 * review.md 必须还原清单「G ✓」项接入（TP-CL5-5 / F(5.5).5；CL-5 裁决）。
 *
 * 接入面（test-design §3 映射表 13 项 G✓ 全登记）：
 * - 实跑 10 项（实现已落地）：R-P1-1/R-P1-3/R-P1-4/R-P1-6、R-P2-1/R-P2-3/
 *   R-P2-4、R-P3-1、R-P4-1/R-P4-4；
 * - T4.2 翻 run 4 项（T3.3 定向 steer 投影面已交付，pending → 实跑）：
 *   R-P1-5（主区定向细条）、R-P3-2（输入栏显隐/目标绑定）、R-P3-4（抽屉侧
 *   同构）、R-P3-5（三态互斥含输入面规则）。
 * 行为/状态类断言仍留各 CL spec（test-design §5 注记 8：避免双重维护）；
 * 本 spec 承载形态/结构/同构类还原断言。断言纪律沿既有：语义类选择器 +
 * token 派生值（不做像素 diff）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect } from "./harness/fixtures";
import { computed } from "./harness/style-utils";
import {
  agentCompleted,
  agentInstance,
  agentQueued,
  agentSpawned,
  agentStarted,
  agentStateChanged,
  backgroundMessageCompleted,
  closure,
  msgEntry,
  sessionListResult,
  sessionMeta,
  streamDelta,
  toolEntry,
  v02Snapshot,
  welcome,
} from "./harness/protocol";
import { MULTI_SESSION_A, MULTI_SESSION_B } from "./harness/scenarios";
import {
  assertFidelityGreen,
  checkPrototypeFidelity,
  formatFidelityReport,
  type FidelityCheck,
} from "./harness/prototype-fidelity";

const SID = "sess-fidelity";
const SHELL_SRC = path.resolve(__dirname, "..", "apps", "shell", "src");

// ── 工具自测（红/绿两路径；不依赖浏览器） ──────────────────

test.describe("T4.1 G11 工具自测（TP-CL5-5）", () => {
  test("红路径：已知差异样例报 FAIL + 绿门抛出（红输出映射清单编号）", async () => {
    const report = await checkPrototypeFidelity([
      { id: "R-P9-1", title: "一致样例", run: () => {} },
      {
        id: "R-P9-2",
        title: "已知差异样例",
        run: () => {
          throw new Error("期望 860px 实得 600px");
        },
      },
    ]);
    expect(report.passed.map((r) => r.id)).toEqual(["R-P9-1"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.id).toBe("R-P9-2");
    expect(report.failed[0]!.error).toContain("期望 860px");
    expect(formatFidelityReport(report)).toContain("[FAIL] R-P9-2");
    expect(() => assertFidelityGreen(report)).toThrow(/R-P9-2/);
  });

  test("绿路径：一致全 PASS + pending 登记不计失败不执行", async () => {
    const report = await checkPrototypeFidelity([
      { id: "R-P9-1", title: "一致样例甲", run: () => {} },
      { id: "R-P9-2", title: "一致样例乙", run: async () => {} },
      {
        id: "R-P9-3",
        title: "登记待落地样例",
        status: "pending",
        run: () => {
          throw new Error("pending 不应执行");
        },
      },
    ]);
    expect(report.failed).toHaveLength(0);
    expect(report.passed).toHaveLength(2);
    expect(report.pending.map((r) => r.id)).toEqual(["R-P9-3"]);
    expect(() => assertFidelityGreen(report)).not.toThrow();
  });
});

// ── P-1 工作台主区时间轴（review.md §3） ──────────────────

test.describe("G11 P-1 主区时间轴还原清单", () => {
  test("R-P1-1/3/4/5/6 实跑（R-P1-5 由 T4.2 翻 run）", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: SID }),
      v02Snapshot(SID, {
        tail: [
          msgEntry("e1", "user", "用户消息样例"),
          msgEntry("e2", "assistant", "助手回复样例"),
          toolEntry("e3", "read", "src/main.ts", "done", { result: "ok", durationMs: 240 }),
          // R-P1-5 素材：定向 steer entry（user + steerState + instanceId≠main）
          msgEntry("e4", "user", "定向干预样例", { steerState: "drained", instanceId: "a1" }),
        ],
        totalEntries: 4,
        tailStartCursor: null,
        instances: [agentInstance("a1", { state: "running", task: "还原度验证实例", anchorEntryId: "e2" })],
      }),
    ]);
    await mock.waitForConn("connected");
    // 流式光标素材（R-P1-6）
    await mock.emit(streamDelta("m-1", "流式中的回复"));
    await expect(page.locator(".msg.assistant.streaming")).toHaveCount(1);

    const checks: FidelityCheck[] = [
      {
        id: "R-P1-1",
        title: "布局：三区骨架（侧栏 + 顶栏 48px + 主区版心 860px）+ 底部主输入区",
        run: async () => {
          await expect(page.locator(".sidebar")).toBeVisible();
          expect(await computed(page, ".app-header", "height")).toBe("48px");
          expect(await computed(page, ".flow-inner", "max-width")).toBe("860px");
          await expect(page.locator(".composer")).toBeVisible();
        },
      },
      {
        id: "R-P1-3",
        title: "撤 best-effort 推导：锚点投影零推导残留（grep 机械化）",
        run: () => {
          const snapshot = fs.readFileSync(
            path.join(SHELL_SRC, "entities", "session", "model", "consumers", "snapshot.ts"),
            "utf8",
          );
          expect(snapshot).not.toMatch(/anchorFromSnapshot|liveAnchor/);
          const flow = fs.readFileSync(
            path.join(SHELL_SRC, "widgets", "chat-stream", "ui", "MessageFlow.tsx"),
            "utf8",
          );
          expect(flow).not.toMatch(/tailCards/);
        },
      },
      {
        id: "R-P1-4",
        title: "SubAgent 卡片形态：边框卡 + 名称 + 状态徽标 + 任务行 + profile + 点击开抽屉",
        run: async () => {
          const card = page.locator('.sa-card[data-instance="a1"]');
          await expect(card).toBeVisible();
          expect(await computed(page, ".sa-card", "border-style")).toBe("solid");
          await expect(card.locator(".sa-id")).toContainText("a1");
          await expect(card.locator(".sa-id .prof")).toContainText("subagent-worker");
          await expect(card.locator(".sa-state")).not.toBeEmpty();
          await expect(card.locator(".sa-task")).toHaveText("还原度验证实例");
          await card.click();
          await expect(page.locator('.drawer[data-instance="a1"]')).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.locator(".drawer")).toHaveCount(0);
        },
      },
      {
        id: "R-P1-5",
        title: "定向消息投影（主区侧）：violet 2px 左边线细条 + steer chip + 正文，非气泡",
        run: async () => {
          const strip = page.locator('.msg-flow .steer-directed[data-target="a1"]');
          await expect(strip).toHaveCount(1);
          // violet 左边线（token 派生值：2px solid rgb(var(--violet-rgb) / 0.55)）
          expect(await computed(page, ".msg-flow .steer-directed", "border-left-width")).toBe("2px");
          expect(
            await strip.evaluate((el) => getComputedStyle(el).borderLeftColor),
          ).toBe("rgba(168, 85, 247, 0.55)");
          await expect(strip.locator(".sd-chip")).toHaveText("steer → a1");
          await expect(strip.locator(".sd-text")).toHaveText("定向干预样例");
          // 非气泡形态（行内细条不渲染为 user 气泡）
          await expect(page.locator(".msg-flow .msg.user", { hasText: "定向干预样例" })).toHaveCount(0);
        },
      },
      {
        id: "R-P1-6",
        title: "聊天流既有形态：用户/助手气泡 + 工具卡 done 态 + 流式光标 + usage 徽标",
        run: async () => {
          await expect(page.locator(".msg.user .bubble").first()).toBeVisible();
          await expect(page.locator(".msg.assistant .bubble").first()).toBeVisible();
          const done = page.locator(".tool-card.done");
          await expect(done).toHaveCount(1);
          await expect(done.locator(".t-state .lab")).toHaveText("完成");
          await expect(page.locator(".msg.assistant.streaming .stream-cursor")).toBeVisible();
          await expect(page.locator(".stats-btn")).toBeVisible();
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));
  });
});

// ── P-2 会话列表侧边栏（review.md §4） ────────────────────

test.describe("G11 P-2 侧边栏未读还原清单", () => {
  test("R-P2-1/3/4 实跑", async ({ mock, page }) => {
    const SESSION_C = "sess-fidelity-c";
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([welcome({ sessionId: MULTI_SESSION_A }), v02Snapshot(MULTI_SESSION_A, { tail: [] })]);
    await mock.waitForConn("connected");
    await mock.waitForCommand("session.list");
    await mock.emit(
      sessionListResult([
        sessionMeta(MULTI_SESSION_A, { title: "活跃会话 A", lastActivityAt: 3_000, runState: "idle" }),
        sessionMeta(MULTI_SESSION_B, { title: "后台会话 B", lastActivityAt: 2_000, runState: "streaming", loaded: false }),
        sessionMeta(SESSION_C, { title: "后台空闲会话 C", lastActivityAt: 1_000, runState: "idle", loaded: false }),
      ]),
    );
    const cardA = page.locator(`[data-session-card="${MULTI_SESSION_A}"]`);
    const cardB = page.locator(`[data-session-card="${MULTI_SESSION_B}"]`);
    // 未读 pill 素材（R-P2-1）+ A 运行态素材（R-P2-3 切走后保持）
    await mock.emit(backgroundMessageCompleted(MULTI_SESSION_B, msgEntry("b-m1", "assistant", "B 后台消息", { ts: 2 })));
    await mock.emit(agentStateChanged("running"));
    await expect(cardB).toHaveAttribute("data-unread", "1");
    await expect(cardA).toHaveAttribute("data-run-state", "streaming");

    const checks: FidelityCheck[] = [
      {
        id: "R-P2-1",
        title: "布局：侧栏（NEW 按钮 + 卡片流）；卡片 = 状态点 + 标题 + 未读 pill + 相对时间 + 运行态标签",
        run: async () => {
          await expect(page.locator("#btn-new-session")).toBeVisible();
          await expect(cardB.locator(".ses-title")).toHaveText("后台会话 B");
          await expect(cardB.locator(".ses-time")).not.toBeEmpty();
          await expect(cardB.locator(".ses-unread")).toHaveText("1");
          await expect(cardB.locator(".hud-badge .hud-dot")).toBeAttached();
          await expect(cardB.locator(".hud-badge")).not.toBeEmpty();
        },
      },
      {
        id: "R-P2-4",
        title: "活跃/后台区分：活跃 = 选中底（恰一 active）；后台 = 常规卡 + 运行态点三态",
        run: async () => {
          await expect(page.locator(".ses.active")).toHaveCount(1);
          await expect(cardA).toHaveAttribute("data-active", "1");
          // 选中底 vs 常规卡底（bg-selected ≠ 透明底）
          const bgActive = await cardA.evaluate((el) => getComputedStyle(el).backgroundColor);
          const bgBackground = await cardB.evaluate((el) => getComputedStyle(el).backgroundColor);
          expect(bgActive).not.toBe(bgBackground);
          // 运行态点三态：streaming = cyan 脉冲 / idle = 静点
          await expect(cardB.locator(".hud-dot-cyan.hud-dot-pulse")).toBeAttached();
          await expect(
            page.locator(`[data-session-card="${SESSION_C}"] .hud-dot-idle`),
          ).toBeAttached();
        },
      },
      {
        id: "R-P2-3",
        title: "生命周期表现面：切换活跃未读清零 + 活跃/后台视觉迁移；后台运行态切走后保持",
        run: async () => {
          await cardB.click();
          // B 即转活跃：未读清零 pill 摘除（先升后降命令序断言留 CL-2-monitor-tier spec）
          await expect(cardB).toHaveAttribute("data-active", "1");
          await expect(cardB).toHaveAttribute("data-unread", "0");
          await expect(cardB.locator(".ses-unread")).toHaveCount(0);
          // 快照 ack 收口 → A 转后台保留运行态
          await mock.emit(
            v02Snapshot(MULTI_SESSION_B, {
              tail: [msgEntry("b-t1", "user", "B 尾窗首条", { ts: 3 })],
              totalEntries: 1,
              tailStartCursor: null,
            }),
          );
          await expect(page.locator(".app")).toHaveAttribute("data-view", "ready");
          await expect(cardA).not.toHaveAttribute("data-active", "1");
          await expect(cardA).toHaveAttribute("data-run-state", "streaming");
          await expect(page.locator(".ses.active")).toHaveCount(1);
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));
  });
});

// ── P-3 SubAgent 抽屉（review.md §5） ─────────────────────

test.describe("G11 P-3 抽屉还原清单", () => {
  test("R-P3-1/2/4/5 实跑（T3.3 面已交付，T4.2 翻 run）", async ({ mock, page }) => {
    await mock.connect();
    await mock.emit(agentSpawned("a1", "还原度抽屉验证", { model: "anthropic/claude-sonnet-4-5" }));
    await expect(page.locator('.sa-card[data-instance="a1"]')).toHaveCount(1);
    await page.locator('.sa-card[data-instance="a1"]').click();
    const drawer = page.locator('.drawer[data-instance="a1"]');
    await expect(drawer).toBeVisible();

    const checks: FidelityCheck[] = [
      {
        id: "R-P3-1",
        title: "布局：右侧 overlay min(540px,100vw) + 头部（id/状态徽标/profile/模型 chips + 关闭）+ 实例 feed",
        run: async () => {
          expect(await computed(page, ".drawer", "width")).toBe("540px");
          await expect(drawer.locator(".d-id")).toContainText("a1 · subagent-worker");
          await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "running");
          await expect(drawer.locator('.d-chip[data-chip="model"]')).toHaveText("anthropic/claude-sonnet-4-5");
          await expect(drawer.locator(".d-close")).toBeVisible();
          await expect(drawer.locator(".d-channel")).toBeVisible();
          // 底部 steer 输入栏段 = R-P3-2 实跑项承载（T4.2 翻 run）
        },
      },
      {
        id: "R-P3-2",
        title: "抽屉底部输入栏：仅 running 渲染 + 目标 chip 绑定当前展开实例（无选择器）",
        run: async () => {
          const composer = drawer.locator('.steer-composer[data-kind="steer-composer"]');
          await expect(composer).toHaveCount(1);
          await expect(composer.locator(".sc-target .tgt")).toHaveText("→ a1");
          await expect(composer.locator("select")).toHaveCount(0);
          await expect(composer.locator('[role="combobox"]')).toHaveCount(0);
          await expect(composer.locator(".sc-bar input")).toBeEnabled(); // 无阻塞发送态
        },
      },
      {
        id: "R-P3-4",
        title: "定向消息投影（抽屉侧）：实例 feed 与时间轴同构（同物种 violet 细条 + chip + 正文）",
        run: async () => {
          const input = drawer.locator(".steer-composer .sc-bar input");
          await input.fill("抽屉侧定向干预");
          await input.press("Enter");
          const feedStrip = drawer.locator('.steer-directed[data-target="a1"]');
          const axisStrip = page.locator('.msg-flow .steer-directed[data-target="a1"]');
          await expect(feedStrip).toHaveCount(1);
          await expect(axisStrip).toHaveCount(1);
          for (const strip of [feedStrip, axisStrip]) {
            await expect(strip.locator(".sd-chip")).toHaveText("steer → a1");
            await expect(strip.locator(".sd-text")).toHaveText("抽屉侧定向干预");
          }
          // 同构机械化：两侧同组件同类名
          expect(await feedStrip.evaluate((el) => el.className)).toBe(
            await axisStrip.evaluate((el) => el.className),
          );
        },
      },
      {
        id: "R-P3-5",
        title: "三态呈现：running（输入栏）/ queued（排队说明卡）/ completed（closure 卡）互斥，无输入面静默不渲染",
        run: async () => {
          const composer = drawer.locator(".steer-composer");
          const queuedHint = drawer.locator('.ch-hint[data-kind="queued-hint"]');
          const closureCard = drawer.locator('.closure-card[data-kind="closure"]');
          // running：仅输入栏
          await expect(composer).toHaveCount(1);
          await expect(queuedHint).toHaveCount(0);
          await expect(closureCard).toHaveCount(0);
          // queued：输入栏静默摘除（DOM 不存在）+ 排队说明卡
          await mock.emit(agentQueued("a1", 2));
          await expect(composer).toHaveCount(0);
          await expect(queuedHint).toBeVisible();
          await expect(closureCard).toHaveCount(0);
          // 回 running → completed：closure 末尾卡，无输入面
          await mock.emit(agentStarted("a1"));
          await expect(composer).toHaveCount(1);
          await mock.emit(
            agentCompleted("a1", closure("done", "三态互斥验证收口。", { reportPath: "reports/sess-e2e/a1.md" })),
          );
          await expect(composer).toHaveCount(0);
          await expect(queuedHint).toHaveCount(0);
          await expect(closureCard).toHaveCount(1);
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));
  });
});

// ── P-4 全局导航壳（review.md §6） ────────────────────────

test.describe("G11 P-4 导航壳还原清单", () => {
  const PAGES = [
    { id: "chat", path: "/" },
    { id: "models", path: "/models" },
    { id: "skills", path: "/skills" },
    { id: "trace", path: "/trace" },
    { id: "project", path: "/project" },
    { id: "settings", path: "/settings" },
  ] as const;
  // 施工牌 ×3（trace 已换真 TracePage——契约依据 f413587；真页还原清单
  // 归 CL-5-fidelity-trace-page 套件背书，此处只断真页锚在场 + 施工牌遇位）
  const PLACEHOLDERS = PAGES.slice(2).filter((p) => p.id !== "trace");

  test("R-P4-1/4 实跑", async ({ mock, page }) => {
    await mock.connect();

    const checks: FidelityCheck[] = [
      {
        id: "R-P4-1",
        title: "布局：IconRail 64px 常驻 + HX logo + 六图标钮（序）+ 底部头像块",
        run: async () => {
          const rail = page.locator("nav.icon-rail");
          await expect(rail).toBeVisible();
          expect(await computed(page, "nav.icon-rail", "width")).toBe("64px");
          await expect(rail.locator(".rail-logo")).toContainText("HX");
          await expect(rail.locator(".rail-avatar")).toBeAttached();
          const order = await rail.locator(".rail-btn").evaluateAll((els) => els.map((el) => el.getAttribute("data-page")));
          expect(order).toEqual(PAGES.map((p) => p.id));
        },
      },
      {
        id: "R-P4-4",
        title: "施工牌 ×3 同构：虚线围挡 + 图标格 + 页名 + 路由行 + 预告 + 「规划中」徽标 + 无操作入口（trace 已换真页）",
        run: async () => {
          const signatures: string[] = [];
          for (const p of PLACEHOLDERS) {
            await page.goto(`${p.path}?fakeTransport=1`);
            const board = page.locator(`[data-construction="${p.path}"]`);
            await expect(board).toBeVisible();
            const frame = board.locator(".construction-frame");
            expect(await frame.evaluate((el) => getComputedStyle(el).borderStyle)).toBe("dashed");
            await expect(frame.locator(".cs-icon")).toHaveCSS("width", "64px");
            await expect(frame.locator(".cs-name")).not.toBeEmpty();
            await expect(frame.locator(".cs-route")).toHaveText(p.path);
            const preview = (await frame.locator(".cs-preview").textContent()) ?? "";
            expect(preview.length).toBeGreaterThan(0);
            expect(preview.length).toBeLessThanOrEqual(32);
            await expect(frame.locator(".hud-badge.hud-badge-cyan")).toBeVisible();
            await expect(frame.locator("button")).toHaveCount(0);
            signatures.push(
              await frame.evaluate(
                (el) => `${el.className}>${Array.from(el.children).map((c) => c.className).join(",")}`,
              ),
            );
          }
          expect(new Set(signatures).size).toBe(1);
          // trace = 真 TracePage（契约依据 f413587）：真页锚在场 + 施工牌遇位
          await page.goto("/trace?fakeTransport=1");
          await expect(page.locator('[data-trace-page="/trace"]')).toBeVisible();
          await expect(page.locator('[data-construction="/trace"]')).toHaveCount(0);
        },
      },
    ];
    assertFidelityGreen(await checkPrototypeFidelity(checks));
  });
});

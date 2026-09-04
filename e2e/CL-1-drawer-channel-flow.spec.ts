/**
 * T4.4 S2 —— CL-1 抽屉全流（F1.2 channel 五物种 / kill 两步 / F1.8 stalled /
 * steer 注入回放 / 卡片↔抽屉联动）。
 *
 * 剧本（契约 §5.1/§5.2，test-design §4.2 S2）：
 * 点击卡（键盘路径）→ agent.subscribe → 五物种回放（lc spawned/模型解析、
 * SA msg、think 折叠、tool 三态、steer 注入=channel 内 user 消息回放——
 * T4.3 投影规则、closure 五字段）→ agent.stalled → agent.kill 两步确认 →
 * agent.killed → 状态回流 P-1 卡片（同一状态源双视图同帧）。
 *
 * 断言纪律：语义类 + data-lc/data-status/data-kind 锚点 + zh-CN 词条。
 * steer 注入走 daemon 帧回放（harness 直注 chat.message.completed）；真 steer
 * 行为由 E 层 CL-7-e2e-steer 覆盖。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  agentFailed,
  agentKilled,
  agentSpawned,
  agentStalled,
  messageCompleted,
  msgEntry,
  thinkingCompleted,
  thinkingDelta,
  toolResult,
  toolStarted,
} from "./harness/protocol";
import {
  DRAWER_AGENT,
  DRAWER_KILL_CLOSURE,
  DRAWER_MSG,
  DRAWER_STALLED_MS,
  DRAWER_STEER_TEXT,
  DRAWER_TASK,
  DRAWER_THINK_ENTRY,
  DRAWER_THINK_FRAMES,
  DRAWER_THINK_TEXT,
  DRAWER_TOOL_BASH_ERR,
  DRAWER_TOOL_READ,
  DRAWER_TOOL_READ_DONE,
} from "./harness/scenarios";

test.describe("T4.4 S2 CL-1 抽屉全流（五物种 + kill + stalled + steer）", () => {
  test.beforeEach(async ({ mock, page }) => {
    await mock.connect();
    await mock.emit(agentSpawned(DRAWER_AGENT, DRAWER_TASK, { model: "anthropic/claude-sonnet-4-5" }));
    await expect(page.locator(`.sa-card.running[data-instance="${DRAWER_AGENT}"]`)).toHaveCount(1);
  });

  test("键盘开抽屉：Enter 路径 + agent.subscribe 命令 + 结构四段", async ({ mock, page }) => {
    // F1.1 键盘可达：整卡 a 语义（Tab 聚焦 + Enter 开抽屉）
    await page.locator(".sa-card").focus();
    await page.keyboard.press("Enter");

    const drawer = page.locator(`.drawer[data-instance="${DRAWER_AGENT}"]`);
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-label", `${DRAWER_AGENT} · ${DRAWER_TASK}`);

    // 契约 §4：打开即订阅（v0.1 通路语义）
    const sub = await mock.waitForCommand("agent.subscribe");
    expect(sub.payload).toEqual({ agentId: DRAWER_AGENT });

    // 结构：头（id/profile/model chip/状态）/任务段/channel 段
    await expect(drawer.locator(".d-id")).toContainText(`${DRAWER_AGENT} · subagent-worker`);
    await expect(drawer.locator('.d-chip[data-chip="model"]')).toHaveText("anthropic/claude-sonnet-4-5");
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "running");
    await expect(drawer.locator(".task-text")).toHaveText(DRAWER_TASK);
    await expect(drawer.locator(".d-channel")).toBeVisible();

    // channel 开行：spawned + 模型解析（声明槽位，AD-6）
    await expect(drawer.locator('.lc-row[data-lc="spawned"]')).toContainText(
      "spawned · subagent-worker · 单任务收敛 SOP",
    );
    await expect(drawer.locator('.lc-row[data-lc="modelResolved"]')).toContainText(
      "模型解析 · anthropic/claude-sonnet-4-5（profile.model 声明值）",
    );

    // Esc 关闭 → 退订（契约 §4）
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    const unsub = await mock.waitForCommand("agent.unsubscribe");
    expect(unsub.payload).toEqual({ agentId: DRAWER_AGENT });
  });

  test("五物种回放：msg/think 流式→折叠/tool 三态/steer 注入标记 + toast", async ({ mock, page }) => {
    await page.locator(".sa-card").click();
    const drawer = page.locator(`.drawer[data-instance="${DRAWER_AGENT}"]`);
    await expect(drawer).toBeVisible();

    // ① SA 消息（violet 气泡 + who + bubble）
    await mock.emit(messageCompleted(msgEntry("sa-m1", "assistant", DRAWER_MSG), { instanceId: DRAWER_AGENT }));
    const msg = drawer.locator('.ch-msg[data-kind="ch-message"]');
    await expect(msg).toHaveCount(1);
    await expect(msg.locator(".who")).toHaveText(DRAWER_AGENT);
    await expect(msg.locator(".bubble")).toHaveText(DRAWER_MSG);

    // ② thinking：delta 流式（伴随块 + 光标逐帧）→ completed 折叠（不可逆）
    await mock.emit(thinkingDelta(DRAWER_AGENT, DRAWER_THINK_FRAMES[0]!));
    const live = drawer.locator(".think-live");
    await expect(live).toBeVisible();
    await expect(live).toContainText("思考中");
    await expect(live.locator(".tl-text")).toHaveText(DRAWER_THINK_FRAMES[0]!);
    await expect(live.locator(".stream-cursor")).toBeVisible();
    await mock.emit(thinkingDelta(DRAWER_AGENT, DRAWER_THINK_FRAMES[1]!));
    await expect(live.locator(".tl-text")).toHaveText(DRAWER_THINK_FRAMES.join(""));

    await mock.emit(thinkingCompleted(DRAWER_THINK_ENTRY));
    const folded = drawer.locator('.fb-wrap[data-kind="thinking"]');
    await expect(folded).toHaveCount(1);
    await expect(folded.locator(".fb-text")).toHaveText("已思考 4s"); // CAND-35：reasoningTokens 退役，折叠条不再带 token 档
    await expect(folded.locator(".who-chip")).toHaveText(DRAWER_AGENT);
    await expect(drawer.locator(".think-live")).toHaveCount(0); // 完成即折叠，不可逆
    // 展开回看（F2.4）
    await folded.locator(".flow-bar").click();
    await expect(folded.locator(".flow-bar")).toHaveAttribute("aria-expanded", "true");
    await expect(folded.locator(".flow-body")).toBeVisible();
    await expect(folded.locator(".flow-body")).toContainText(DRAWER_THINK_TEXT);

    // ③ tool 三态：running → done（原位定稿）+ error 卡
    await mock.emit(toolStarted(DRAWER_TOOL_READ));
    const toolRunning = drawer.locator(".tool-card.running");
    await expect(toolRunning).toHaveCount(1);
    await expect(toolRunning.locator(".t-name")).toHaveText("read");
    await expect(toolRunning.locator(".t-state")).toContainText("执行中");
    await mock.emit(toolResult(DRAWER_TOOL_READ_DONE));
    const toolDone = drawer.locator(".tool-card.done");
    await expect(toolDone).toHaveCount(1);
    await expect(toolDone.locator(".t-state")).toContainText("完成");
    await mock.emit(toolResult(DRAWER_TOOL_BASH_ERR));
    const toolErr = drawer.locator(".tool-card.error");
    await expect(toolErr).toHaveCount(1);
    await expect(toolErr.locator(".t-name")).toHaveText("bash");
    await expect(toolErr.locator(".t-state")).toContainText("失败");

    // ④ steer 注入标记 = channel 内 user 消息回放（T4.3 投影规则）+ violet toast
    await mock.emit(
      messageCompleted(msgEntry("sa-steer-1", "user", DRAWER_STEER_TEXT, { instanceId: DRAWER_AGENT }), {
        instanceId: DRAWER_AGENT,
      }),
    );
    const steerMark = drawer.locator('.steer-mark[data-kind="steer-mark"]');
    await expect(steerMark).toHaveCount(1);
    await expect(steerMark.locator(".sm-label")).toContainText("⇦ 主线 steer 注入");
    await expect(steerMark.locator(".sm-text")).toHaveText(DRAWER_STEER_TEXT);
    const steerToast = page.locator(".toast.violet", { hasText: "steer 已注入实例" });
    await expect(steerToast).toBeVisible();
    await expect(steerToast).toContainText("steer 已注入实例");
    await expect(steerToast).toContainText(`${DRAWER_AGENT} · 经 Agent.steer() 转投`);
  });

  test("F1.8 stalled：警示徽标 + channel warn 行（仅 running，非状态迁移）", async ({ mock, page }) => {
    await page.locator(".sa-card").click();
    const drawer = page.locator(`.drawer[data-instance="${DRAWER_AGENT}"]`);
    await expect(drawer).toBeVisible();

    await mock.emit(agentStalled(DRAWER_AGENT, DRAWER_STALLED_MS));
    // 头部警示徽标（warning + 脉冲点 + 时长）
    const badge = drawer.locator(".d-stalled");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("stalled · idle 45.0s");
    // channel 对应 warn 行（无倒计时无自动终止的语义文案）
    const row = drawer.locator('.lc-row[data-lc="stalled"]');
    await expect(row).toHaveClass(/warn/);
    await expect(row).toContainText("stalled · idle 45.0s 无事件增量（警示不自动杀）");
    // 实例仍 running（非状态迁移）
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "running");
  });

  test("kill 两步：确认 3s 复原 → 确认击发命令 → killed 回流双视图 + closure 卡五字段", async ({ mock, page }) => {
    await page.locator(".sa-card").click();
    const drawer = page.locator(`.drawer[data-instance="${DRAWER_AGENT}"]`);
    await expect(drawer).toBeVisible();
    const killBtn = drawer.locator(".d-kill");

    // 第一步：armed → 「确认终止？」；3s 未确认自动复原
    await killBtn.click();
    await expect(killBtn).toHaveText("确认终止？");
    await expect(killBtn).toHaveClass(/confirm/);
    await expect
      .poll(async () => killBtn.textContent(), { timeout: 5_000 })
      .toBe("终止实例");
    await expect(killBtn).not.toHaveClass(/confirm/);

    // 两步确认击发：agent.kill{agentId}
    await killBtn.click();
    await expect(killBtn).toHaveText("确认终止？");
    await killBtn.click();
    const kill = await mock.waitForCommand("agent.kill");
    expect(kill.payload).toEqual({ agentId: DRAWER_AGENT });

    // daemon 回执 agent.killed（closure failed 五字段：reportPath/findings/taskId 全发）
    await mock.emit(agentKilled(DRAWER_AGENT, DRAWER_KILL_CLOSURE));

    // 抽屉视图：状态 chip failed + terminated 行 + closure 卡 + toast + kill 禁用
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "failed");
    await expect(drawer.locator('.lc-row[data-lc="terminated"]')).toHaveClass(/err/);
    await expect(drawer.locator('.lc-row[data-lc="terminated"]')).toContainText(
      "terminated · 用户手动终止（终止权在用户，AD-7）",
    );
    const closureCard = drawer.locator('.closure-card[data-kind="closure"]');
    await expect(closureCard).toHaveAttribute("data-status", "failed");
    await expect(closureCard.locator(".cl-badge")).toHaveText("failed");
    await expect(closureCard.locator(".cl-summary")).toHaveText("用户终止：任务未完成收口。");
    await expect(closureCard.locator(".cl-meta")).toContainText("reportPath reports/sess-e2e/agent-1.md");
    await expect(closureCard.locator(".cl-meta")).toContainText("findings 2");
    await expect(closureCard.locator(".cl-meta")).toContainText("taskId T-44");
    const killToast = page.locator(".toast.err");
    await expect(killToast).toBeVisible();
    await expect(killToast).toContainText("实例已终止");
    await expect(killToast).toContainText(`${DRAWER_AGENT} · closure 将以 failed 注入主线下轮`);
    await expect(killBtn).toBeDisabled();

    // reportPath 脚注（四段结构末端）
    const foot = drawer.locator('.d-foot[data-foot="report"]');
    await expect(foot).toBeVisible();
    await expect(foot).toContainText("reports/sess-e2e/agent-1.md");
    await expect(foot).toContainText("任务报告经 daemon 单写队列落盘");

    // 状态回流 P-1 卡片（同一状态源双视图同帧）：failed + terminated 交代经脚注
    const card = page.locator(`.sa-card.failed[data-instance="${DRAWER_AGENT}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.locator(".cl-badge")).toHaveText("failed");

    await shotEvidence(page, "drawer-kill-two-step", "CL-1");
    writeEvidence(
      "drawer-channel-flow",
      "txt",
      [
        "T4.4 S2 CL-1 抽屉全流（五物种 + kill 两步 + stalled + steer 回放）",
        "断言: 键盘开抽屉/agent.subscribe 退订/五物种回放/stalled warn 行/",
        "  kill 两步确认→agent.killed 回流双视图+closure 五字段",
        "结果: PASS",
      ].join("\n"),
      "CL-1",
    );
  });

  test("OI-7 lc.crashed 文案：agent.failed → channel err 行（crashed · 错误原文透传）+ closure 卡", async ({
    mock,
    page,
  }) => {
    const CRASH_ERROR = "子进程非零退出（exit 137）";
    const CRASH_CLOSURE = {
      status: "failed" as const,
      summary: "引擎崩溃，任务未完成。",
      reportPath: null,
      findings: null,
      taskId: null,
    };

    await page.locator(".sa-card").click();
    const drawer = page.locator(`.drawer[data-instance="${DRAWER_AGENT}"]`);
    await expect(drawer).toBeVisible();

    await mock.emit(agentFailed(DRAWER_AGENT, CRASH_ERROR, CRASH_CLOSURE));

    // lc.crashed 文案（zh-CN 词条 + error 原文透传——领域数据不 i18n）
    const row = drawer.locator('.lc-row[data-lc="crashed"]');
    await expect(row).toHaveClass(/err/);
    await expect(row).toContainText(`crashed · ${CRASH_ERROR}`);
    // failed 终态：状态 chip + closure 卡同帧
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "failed");
    const closureCard = drawer.locator('.closure-card[data-kind="closure"]');
    await expect(closureCard.locator(".cl-summary")).toHaveText(CRASH_CLOSURE.summary);

    await shotEvidence(page, "drawer-lc-crashed", "CL-1");
  });
});

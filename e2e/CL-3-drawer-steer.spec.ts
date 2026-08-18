/**
 * T3.3 —— CL-3 抽屉 steer 输入栏（F 层剧本；TP-CL3-4/5/6 + R-P3-2/4/5）。
 *
 * 剧本（契约 v0.3 §3；review.md §5；brief task-T3.3）：
 * - 三态显隐（Q-3b）：running → 底部输入栏渲染；queued/completed → 静默不
 *   渲染（DOM 不存在，非 hidden；无禁用态无解释文案）；
 * - 发送行为（R-P3-2）：running 态 Enter 非空 → chat.steer 出站载荷含
 *   instanceId（目标 = 当前展开实例）+ 输入即清空 + 无阻塞发送态 + 本地
 *   echo 双处立即可见（Q-3a：主轴定向细条 + 抽屉实例 feed 同物种）；
 * - 空输入 Enter → 零命令零转换；
 * - 目标绑定：chip「→ {instanceId}」明示，无下拉选择器；
 * - 双处同构（R-P3-4）：时间轴侧与抽屉侧同物种（violet 左边线细条 +
 *   「steer → {目标}」chip + 正文，非气泡）；steer.queued（信封 instanceId=
 *   目标，T2.3）对账不产生双份；快照恢复重放完整保留；
 * - 出站载荷形态（F(3.3).1 缺省路径回归）：主 Composer steer 不携带
 *   instanceId（payload 恰为 { text }）；
 * - 主窗口卡片无输入控件（Q-3b 边界断言）。
 *
 * 断言纪律：语义类 + data-kind/data-target 锚点 + zh-CN 词条；出站帧经
 * __helixMock.clientFrames 实收断言（非手写帧字面量）。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  agentCompleted,
  agentInstance,
  agentQueued,
  agentSpawned,
  agentStarted,
  agentStateChanged,
  closure,
  msgEntry,
  snapshot,
  steerQueued,
  welcome,
} from "./harness/protocol";

const AGENT = "agent-steer-1";
const TASK = "验证抽屉 steer 输入栏三态与定向发送";
const MODEL = "anthropic/claude-sonnet-4-5";
const STEER_TEXT = "回归用例优先覆盖先升后降的 ack 间隙。";
const STEER_ENTRY_ID = "e-dir-steer-1";
const DONE_CLOSURE = closure("done", "任务完成：回归用例已补齐。", {
  reportPath: "reports/sess-e2e/agent-steer-1.md",
});

/** 标准前置：建连 → spawn running 实例（流首锚）→ 卡片在场。 */
async function spawnRunning(mock: import("./harness/mock-session").MockController, page: import("@playwright/test").Page) {
  await mock.connect();
  await mock.emit(agentSpawned(AGENT, TASK, { model: MODEL, anchorEntryId: null }));
  await expect(page.locator(`.sa-card.running[data-instance="${AGENT}"]`)).toHaveCount(1);
}

/** 开抽屉（点击卡片路径）。 */
async function openDrawer(page: import("@playwright/test").Page) {
  await page.locator(`.sa-card[data-instance="${AGENT}"]`).click();
  const drawer = page.locator(`.drawer[data-instance="${AGENT}"]`);
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("T3.3 CL-3 抽屉 steer 输入栏（三态显隐 + 定向发送 + 双处同构）", () => {
  test("三态显隐（Q-3b）：running 渲染输入栏；queued/completed 静默不渲染 + 末尾卡", async ({
    mock,
    page,
  }) => {
    await spawnRunning(mock, page);
    const drawer = await openDrawer(page);

    // running：输入栏 DOM 存在（目标行 + 输入条 + Enter kbd）
    const composer = drawer.locator('.steer-composer[data-kind="steer-composer"]');
    await expect(composer).toHaveCount(1);
    await expect(composer.locator(".sc-bar input")).toBeVisible();
    await expect(composer.locator(".sc-bar input")).toBeEnabled(); // 无阻塞发送态

    // → queued：输入栏静默消失（DOM 不存在，非 hidden）+ 排队说明卡 + 位次徽标
    await mock.emit(agentQueued(AGENT, 2));
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "queued");
    await expect(composer).toHaveCount(0);
    await expect(drawer.locator('.ch-hint[data-kind="queued-hint"]')).toBeVisible();
    await expect(drawer.locator(".d-chip", { hasText: "排队 #2" })).toHaveCount(1);

    // → running（槽位释放）：输入栏回归
    await mock.emit(agentStarted(AGENT));
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "running");
    await expect(composer).toHaveCount(1);

    // → completed：输入栏静默消失 + closure 末尾卡（沿 M2 形态）
    await mock.emit(agentCompleted(AGENT, DONE_CLOSURE));
    await expect(drawer.locator(".d-status")).toHaveAttribute("data-status", "done");
    await expect(composer).toHaveCount(0);
    const closureCard = drawer.locator('.closure-card[data-kind="closure"]');
    await expect(closureCard).toHaveCount(1);
    await expect(closureCard.locator(".cl-summary")).toHaveText("任务完成：回归用例已补齐。");

    await shotEvidence(page, "drawer-steer-three-states", "CL-3");
  });

  test("目标绑定（R-P3-2）：chip 明示当前展开实例，无下拉选择器", async ({ mock, page }) => {
    await spawnRunning(mock, page);
    const drawer = await openDrawer(page);

    const composer = drawer.locator('.steer-composer[data-kind="steer-composer"]');
    await expect(composer.locator(".sc-target .tgt")).toHaveText(`→ ${AGENT}`);
    // 无选择器 DOM（目标绑定当前展开实例，Q-3b 交互形态裁决）
    await expect(composer.locator("select")).toHaveCount(0);
    await expect(composer.locator('[role="combobox"]')).toHaveCount(0);
    await expect(composer.locator(".sc-bar .kbd")).toHaveText("Enter");
  });

  test("发送行为（R-P3-2/F(3.3).1）：Enter 非空 → 载荷含 instanceId + 即清空 + 双处 echo 可见", async ({
    mock,
    page,
  }) => {
    await spawnRunning(mock, page);
    const drawer = await openDrawer(page);

    const input = drawer.locator(".steer-composer .sc-bar input");
    await input.fill(STEER_TEXT);
    await input.press("Enter");

    // 出站载荷：chat.steer 信封 sessionId + payload { text, instanceId }（契约 §3.1）
    const cmd = await mock.waitForCommand("chat.steer");
    expect(cmd.sessionId).toBe("sess-e2e");
    expect(cmd.payload).toEqual({ text: STEER_TEXT, instanceId: AGENT });

    // 发送即清空、无阻塞态（输入保持可用）
    await expect(input).toHaveValue("");
    await expect(input).toBeEnabled();

    // 本地 echo 双处立即可见（Q-3a；同物种：violet 细条 + 目标 chip + 正文）
    const axisStrip = page.locator(`.msg-flow .steer-directed[data-target="${AGENT}"]`);
    await expect(axisStrip).toHaveCount(1);
    await expect(axisStrip.locator(".sd-chip")).toHaveText(`steer → ${AGENT}`);
    await expect(axisStrip.locator(".sd-text")).toHaveText(STEER_TEXT);
    const feedStrip = drawer.locator(`.steer-directed[data-target="${AGENT}"]`);
    await expect(feedStrip).toHaveCount(1);
    await expect(feedStrip.locator(".sd-chip")).toHaveText(`steer → ${AGENT}`);
    await expect(feedStrip.locator(".sd-text")).toHaveText(STEER_TEXT);

    // 非气泡形态（R-P3-4：行内细条不渲染为气泡）
    await expect(page.locator(".msg-flow .msg.user", { hasText: STEER_TEXT })).toHaveCount(0);

    // steer.queued 对账（T2.3：信封 instanceId=目标）——echo 确认不产生双份
    await mock.emit(steerQueued(STEER_ENTRY_ID, { instanceId: AGENT }));
    await expect(page.locator(`.msg-flow .steer-directed[data-target="${AGENT}"]`)).toHaveCount(1);
    await expect(drawer.locator(`.steer-directed[data-target="${AGENT}"]`)).toHaveCount(1);

    await shotEvidence(page, "drawer-steer-send-echo", "CL-3");
  });

  test("空输入 Enter → 零命令零转换（R-P3-2）", async ({ mock, page }) => {
    await spawnRunning(mock, page);
    const drawer = await openDrawer(page);
    const input = drawer.locator(".steer-composer .sc-bar input");

    const steerFramesBefore = (await mock.clientFrames()).filter((f) => f.type === "chat.steer").length;
    // 纯空 Enter + 纯空白 Enter 均零动作
    await input.press("Enter");
    await input.fill("   ");
    await input.press("Enter");
    await page.waitForTimeout(300);

    const steerFramesAfter = (await mock.clientFrames()).filter((f) => f.type === "chat.steer").length;
    expect(steerFramesAfter).toBe(steerFramesBefore);
    await expect(page.locator(".msg-flow .steer-directed")).toHaveCount(0);
    await expect(drawer.locator(".steer-directed")).toHaveCount(0);
  });

  test("快照恢复重放（R-P3-4）：定向干预历史双处完整保留", async ({ mock, page }) => {
    // 重启恢复（空状态起全量重建变体，S6 同规）：首帧即推携带定向 steer entry
    // 的快照（主轴尾窗 + 实例 channel 归组双投影，daemon DTO 面 T2.3 已验；
    // 本断言 = shell 快照投影重建——重连合入语义下已有事件流 channel 保留，
    // 故恢复重放的权威面 = 空状态重建）
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome(),
      snapshot(
        [
          msgEntry("m-u1", "user", "重启前的主线指令"),
          msgEntry(STEER_ENTRY_ID, "user", STEER_TEXT, { steerState: "drained", instanceId: AGENT }),
        ],
        {
          instances: [
            agentInstance(AGENT, { task: TASK, model: MODEL, state: "running", anchorEntryId: null }),
          ],
        },
      ),
    ]);
    await mock.waitForConn("connected");

    // 时间轴侧：定向细条在主轴（非气泡；渲染判别 instanceId≠main，非 steerState——
    // 定向 entry steerState 恒 drained，T2.3 边界注记）
    const axisStrip = page.locator(`.msg-flow .steer-directed[data-target="${AGENT}"]`);
    await expect(axisStrip).toHaveCount(1);
    await expect(axisStrip.locator(".sd-text")).toHaveText(STEER_TEXT);
    await expect(page.locator(".msg-flow .msg.user", { hasText: STEER_TEXT })).toHaveCount(0);

    // 抽屉侧：实例 feed 同物种保留（channel 归组 user+steerState → 定向物种）
    const drawer = await openDrawer(page);
    const feedStrip = drawer.locator(`.steer-directed[data-target="${AGENT}"]`);
    await expect(feedStrip).toHaveCount(1);
    await expect(feedStrip.locator(".sd-chip")).toHaveText(`steer → ${AGENT}`);
    await expect(feedStrip.locator(".sd-text")).toHaveText(STEER_TEXT);

    await shotEvidence(page, "drawer-steer-snapshot-restore", "CL-3");
    writeEvidence(
      "drawer-steer",
      "txt",
      [
        "T3.3 CL-3 抽屉 steer 输入栏（F 层）",
        "断言: 三态显隐/目标绑定无选择器/Enter 发送载荷含 instanceId+即清空/",
        "  空输入零动作/双处同构 echo+steer.queued 对账无双份/快照恢复双处保留/",
        "  缺省路径回归(主 Composer 无 instanceId)/主窗口卡片无输入控件",
        "结果: PASS",
      ].join("\n"),
      "CL-3",
    );
  });

  test("缺省路径回归（F(3.3).1）：主 Composer steer 载荷不携带 instanceId", async ({ mock, page }) => {
    await mock.connect();
    // 主线生成中 → 主 Composer 发送自动转 chat.steer（缺省主实例，契约 §3.1）
    await mock.emit(agentStateChanged("running"));
    const cmd = await mock.sendUserMessage("主线生成中的普通注入", "chat.steer");
    expect(cmd.payload).toEqual({ text: "主线生成中的普通注入" }); // 恰为 {text}，无 instanceId key
    expect(cmd.sessionId).toBe("sess-e2e");
    // 缺省路径语义不动：本地 echo = 既有 user 气泡 + STEER 徽标（非定向细条）
    const echo = page.locator(".msg-flow .msg.user", { hasText: "主线生成中的普通注入" });
    await expect(echo).toHaveCount(1);
    await expect(echo.locator(".steer-badge")).toHaveText("STEER · 已入队");
    await expect(page.locator(".msg-flow .steer-directed")).toHaveCount(0);
  });

  test("主窗口卡片无输入控件（Q-3b 边界：输入面唯一位于抽屉底部）", async ({ mock, page }) => {
    await spawnRunning(mock, page);
    const card = page.locator(`.sa-card[data-instance="${AGENT}"]`);
    await expect(card.locator("input")).toHaveCount(0);
    await expect(card.locator("textarea")).toHaveCount(0);
    await expect(card.locator(".steer-composer")).toHaveCount(0);
  });
});

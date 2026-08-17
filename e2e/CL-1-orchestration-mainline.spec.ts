/**
 * T4.4 S1 —— CL-1 编排主线（F1.1 四态卡 / F1.3 排队位次 / F1.5 spawn 秒回 /
 * F1.6 done·failed 卡 + closure 双通道）。
 *
 * 剧本（契约 §5.1 事件序列，test-design §4.2 S1）：
 * handshake → snapshot（含既有 done 实例）→ 用户消息 → agent.spawned（秒回
 * 出卡 + toast）→ agent.spawned + agent.queued{2} → 位次递减{1} →
 * agent.started → 实例 delta（卡片 streaming 摘要）→ agent.completed{closure}
 * → 另一实例 agent.failed。
 *
 * 断言纪律：语义类（.sa-card.<state>）+ zh-CN 词条文案；closure 注入通道
 * 不占 UI 位（F1.6：closure 摘要不出现在主线消息气泡）；帧构造全部经
 * harness/protocol.ts 直引 @helix/protocol 类型。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import {
  agentCompleted,
  agentFailed,
  agentQueued,
  agentSpawned,
  agentStarted,
  messageCompleted,
  msgEntry,
  snapshot,
  streamDelta,
  welcome,
} from "./harness/protocol";
import {
  ORCH_AGENT1,
  ORCH_AGENT1_CLOSURE,
  ORCH_AGENT1_DELTAS,
  ORCH_AGENT1_MODEL,
  ORCH_AGENT1_TASK,
  ORCH_AGENT2,
  ORCH_AGENT2_CLOSURE,
  ORCH_AGENT2_ERROR,
  ORCH_AGENT2_TASK,
  ORCH_EXISTING_INSTANCE,
  ORCH_EXISTING_USAGE,
} from "./harness/scenarios";

test.describe("T4.4 S1 CL-1 编排主线（四态卡/排队/秒回/done·failed）", () => {
  test.beforeEach(async ({ mock }) => {
    // handshake → snapshot（含既有 done 实例 agent-0）→ connected
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome(),
      snapshot([], { instances: [ORCH_EXISTING_INSTANCE], usage: ORCH_EXISTING_USAGE }),
    ]);
    await mock.waitForConn("connected");
  });

  test("快照既有实例：done 终态卡恢复（closure 徽标 + 摘要 + 注入脚注）", async ({ page }) => {
    const card = page.locator(".sa-card.done");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-instance", "agent-0");
    await expect(card.locator(".sa-task")).toContainText("既有实例（快照恢复的 done 终态）");
    await expect(card.locator(".cl-badge")).toHaveText("closure · done");
    await expect(card.locator(".sa-sub")).toContainText("既有实例已收口：报告已落盘。");
    await expect(card.locator(".sa-foot")).toContainText("closure 已注入主线下轮");
  });

  test("F1.5 spawn 秒回：事件即出卡 running + toast，不等 closure", async ({ mock, page }) => {
    await mock.sendUserMessage("派一个 SubAgent 梳理编排事件族");

    await mock.emit(agentSpawned(ORCH_AGENT1, ORCH_AGENT1_TASK, { model: ORCH_AGENT1_MODEL }));

    // 秒回出卡：spawn 事件即 running 卡（预算内直跑主路径），closure 尚未发生
    const card = page.locator(".sa-card.running");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-instance", ORCH_AGENT1);
    await expect(card.locator(".sa-id")).toContainText(`${ORCH_AGENT1} · subagent-worker`);
    await expect(card.locator(".sa-task")).toHaveText(ORCH_AGENT1_TASK);
    await expect(card.locator(".sa-state")).toContainText("执行中 ·");
    await expect(card.locator(".sa-foot")).toContainText("per-instance channel 订阅中");

    // F1.5 toast：violet「spawn 秒回」+ {id} · {profile} · 预算内立即执行
    const toast = page.locator(".toast.violet");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("spawn 秒回");
    await expect(toast).toContainText(`${ORCH_AGENT1} · subagent-worker · 预算内立即执行`);
  });

  test("F1.3 排队位次：queued 卡 + 位次随出队递减（事件驱动）→ started 转 running", async ({ mock, page }) => {
    await mock.emit(agentSpawned(ORCH_AGENT2, ORCH_AGENT2_TASK));
    // 超限入队：queued{2}
    await mock.emit(agentQueued(ORCH_AGENT2, 2));

    const card = page.locator(".sa-card.queued");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".sa-state")).toHaveText("排队 #2");
    await expect(card.locator(".sa-sub")).toContainText("等待空位 · 前方实例释放后自动出队");
    await expect(card.locator(".sa-foot")).toContainText("FIFO 队列 · 位次随出队递减");

    // 位次递减（daemon 重发驱动，前端不自行计算）
    await mock.emit(agentQueued(ORCH_AGENT2, 1));
    await expect(card.locator(".sa-state")).toHaveText("排队 #1");

    // 出队直跑：started → running（queued 态互斥清除）
    await mock.emit(agentStarted(ORCH_AGENT2));
    await expect(page.locator(".sa-card.queued")).toHaveCount(0);
    const running = page.locator(".sa-card.running");
    await expect(running).toHaveCount(1);
    await expect(running).toHaveAttribute("data-instance", ORCH_AGENT2);
    await expect(running.locator(".sa-state")).toContainText("执行中 ·");
  });

  test("实例 delta → running 卡 streaming 摘要尾窗 + 光标；不进主消息流", async ({ mock, page }) => {
    await mock.emit(agentSpawned(ORCH_AGENT1, ORCH_AGENT1_TASK, { model: ORCH_AGENT1_MODEL }));
    await expect(page.locator(".sa-card.running")).toHaveCount(1);

    // SubAgent delta（instanceId 分流）：只更新卡片摘要，不进主消息流
    await mock.emit(streamDelta("sa-msg-1", ORCH_AGENT1_DELTAS[0]!, { instanceId: ORCH_AGENT1 }));
    const card = page.locator(`.sa-card.running[data-instance="${ORCH_AGENT1}"]`);
    await expect(card.locator(".sa-sub")).toContainText(ORCH_AGENT1_DELTAS[0]!);
    await expect(card.locator(".sa-sub")).toHaveClass(/sa-stream/);
    await expect(card.locator(".stream-cursor")).toBeVisible();
    // 主消息流零 delta 气泡（F1.6 分流）
    await expect(page.locator(".msg.assistant")).toHaveCount(0);

    await mock.emit(streamDelta("sa-msg-1", ORCH_AGENT1_DELTAS[1]!, { instanceId: ORCH_AGENT1 }));
    await expect(card.locator(".sa-sub")).toContainText(ORCH_AGENT1_DELTAS.join(""));
  });

  test("F1.6 done·failed 双终态卡：closure 徽标/摘要/脚注互斥；注入通道不占 UI 位", async ({ mock, page }) => {
    await mock.emit(agentSpawned(ORCH_AGENT1, ORCH_AGENT1_TASK, { model: ORCH_AGENT1_MODEL }));
    await mock.emit(agentSpawned(ORCH_AGENT2, ORCH_AGENT2_TASK));
    await expect(page.locator(".sa-card.running")).toHaveCount(2);

    // done 收口（closure 五字段：reportPath 有值 / findings·taskId 显式 null）
    await mock.emit(agentCompleted(ORCH_AGENT1, ORCH_AGENT1_CLOSURE));
    const done = page.locator(`.sa-card.done[data-instance="${ORCH_AGENT1}"]`);
    await expect(done).toHaveCount(1);
    await expect(done.locator(".cl-badge")).toHaveText("closure · done");
    await expect(done.locator(".sa-sub")).toContainText("编排事件族梳理完成：四态投影规则已核对。");
    await expect(done.locator(".sa-foot")).toContainText("closure 已注入主线下轮");
    // 状态互斥：done 卡不在 running/queued 态
    await expect(page.locator(`.sa-card.running[data-instance="${ORCH_AGENT1}"]`)).toHaveCount(0);

    // F1.6 注入通道不占 UI 位：closure 摘要不出现在主线消息气泡（同一事实单一呈现面）
    await expect(page.locator(".msg", { hasText: "四态投影规则已核对" })).toHaveCount(0);

    // failed 收口（error 行 = agent.failed 错误原文）
    await mock.emit(agentFailed(ORCH_AGENT2, ORCH_AGENT2_ERROR, ORCH_AGENT2_CLOSURE));
    const failed = page.locator(`.sa-card.failed[data-instance="${ORCH_AGENT2}"]`);
    await expect(failed).toHaveCount(1);
    await expect(failed.locator(".cl-badge")).toHaveText("failed");
    await expect(failed.locator(".sa-sub")).toContainText(ORCH_AGENT2_ERROR);
    await expect(failed.locator(".sa-foot")).toContainText("closure failed 已注入主线下轮");
    // 四态互斥清点：agent-0 done + agent-1 done + agent-2 failed，无 running/queued
    await expect(page.locator(".sa-card.done")).toHaveCount(2);
    await expect(page.locator(".sa-card.running")).toHaveCount(0);
    await expect(page.locator(".sa-card.queued")).toHaveCount(0);
  });

  test("主线消息流与编排事件共存：user 气泡投影 + 主线 assistant 回复不被实例分流吞掉", async ({ mock, page }) => {
    const userText = "主线继续：讲讲事件族与通道族的分工";
    const cmd = await mock.sendUserMessage(userText);
    expect(cmd.type).toBe("chat.send");
    await mock.emit(messageCompleted(msgEntry("m-user-1", "user", userText)));
    await mock.emit(streamDelta("m-main-1", "编排事件族驱动卡片，通道族驱动账目。"));
    await mock.emit(agentSpawned(ORCH_AGENT1, ORCH_AGENT1_TASK, { model: ORCH_AGENT1_MODEL }));
    await expect(page.locator(".msg.user", { hasText: userText })).toBeVisible();

    // 主线 delta（无 instanceId → main）进消息流；实例卡片同屏共存
    await expect(page.locator(".msg.assistant.streaming")).toBeVisible();
    await expect(page.locator(".sa-card.running")).toHaveCount(1);
    await mock.emit(messageCompleted(msgEntry("m-main-1", "assistant", "编排事件族驱动卡片，通道族驱动账目。（完）")));
    await expect(page.locator(".msg.assistant", { hasText: "通道族驱动账目" })).toBeVisible();

    await shotEvidence(page, "orchestration-mainline-coexist", "CL-1");
    writeEvidence(
      "orchestration-mainline",
      "txt",
      [
        "T4.4 S1 CL-1 编排主线（四态卡/排队/秒回/done·failed）",
        "断言: 四态互斥清点/closure 双通道（注入文本不占 UI 位）/位次递减重发/",
        "  spawn 秒回 toast/主线与实例流共存",
        "结果: PASS",
      ].join("\n"),
      "CL-1",
    );
  });
});

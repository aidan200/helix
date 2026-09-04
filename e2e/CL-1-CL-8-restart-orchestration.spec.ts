/**
 * T2.4 —— CL-1 × CL-8：SubAgent 编排重启恢复浏览器端到端（AD-10 语义）。
 *
 * R1（closure 抗重启 / done 终态恢复）：spawn → 剧本收口 done（closure 卡 +
 * O-5 报告落盘 + closure 注入主线已消费）→ SIGTERM → 重启：卡片 done 终态
 * 恢复（task 一致）；报告文件可读；账目快照在场；主线注入消息可续（活会话）。
 *
 * R2（running → failed 收口）：spawn 挂起（running）→ SIGTERM → 重启：卡片
 * failed（收口态）；channel 历史可回放；closure failed 注入主线（TR-64
 * 队列坞语义：queued 不上时间轴——快照 pendingSteer 权威重建进左下角
 * 浮动坞，CLOSURE 来源 chip + 已入队——**未消费**）；零新事件流（机械
 * 判据：恢复后 N 秒无新 assistant 消息/无新引擎事件——重启剧本设为陷阱
 * 条目，被自动消费即失败）。
 *
 * R3（queued → cancelled）：3 running + 1 queued → SIGTERM → 重启：queued
 * 实例标 cancelled（渲染态区别于 failed）；不自动重派（零新事件流）；其余
 * 3 个按 R2 收口 failed + 3 条 closure 注入。
 *
 * daemon 侧进程内级恢复一致性（注册表/账目/closure 双源核对）由
 * apps/daemon/test/integration/restore-orchestration.test.ts 覆盖；本 spec
 * 验浏览器投影（快照 instances/entries → 卡片/消息流重建）与恢复语义的外显。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { slowReply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const RESTART_SUMMARY = "daemon 重启，任务未完成";

/** 通用前置：建 home+沙箱。 */
function prepHome(tag: string): string {
  const home = mkdtempSync(path.join(tmpdir(), `helix-e2e-cl1-${tag}-`));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

/** 等 N ms（零新事件流的观察窗口）。 */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe("T2.4 CL-1×CL-8 SubAgent 编排重启恢复（R1~R3）", () => {
  test("R1 done 终态恢复：closure 卡/报告/账目抗重启 + 主线注入消息可续", async ({ e2e, page }) => {
    test.setTimeout(150_000);
    const home = prepHome("r1");
    const TASK = "R1 调研调度恢复语义";
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: TASK }),
        slowReply("主线确认 spawn 已回。（完R1a）", 30, 6),
        slowReply("主线收到 closure 结论：调研完成。（完R1b）", 30, 6),
      ],
    };
    const subagentScript = [{ delayMs: 600, result: "done" as const, summary: "R1 调研完成：结论 X" }];

    const d1 = await e2e.startDaemon({ script, home, subagentScript });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // 前置：spawn → turn1 收口（完R1a）→ 600ms 剧本收口 done → closure 注入
    // 主线（idle 立即新 turn）→ turn2 收口（完R1b）
    await e2e.send(page, "派一个 SubAgent 去调研");
    await e2e.waitForTurnDone(page, "（完R1a）");
    await e2e.waitForTurnDone(page, "（完R1b）");
    const card = page.locator(".sa-card.done");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".sa-task")).toContainText(TASK);
    // T10：spawn id = agent-<hex> 唯一串，从 DOM 捕获后用（报告文件名同源）
    const agentId = (await card.getAttribute("data-instance"))!;
    expect(agentId).toMatch(/^agent-[0-9a-f]+$/);
    await shotEvidence(page, "cl1-r1-before", "CL-1");

    // O-5 报告产物在盘（重启前已落）
    const reportsDir = path.join(home, "reports");
    const sessionDir = readdirSync(reportsDir)[0]!;
    const reportPath = path.join(reportsDir, sessionDir, `${agentId}.md`);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toContain("R1 调研完成：结论 X");

    // 停机 → 重启（同 home；重启剧本从头消费——新消息拿 entry[0]）
    await d1.stop();
    const d2 = await e2e.startDaemon({
      script: { entries: [slowReply("重启后主线可续。（完R1R）", 30, 6)] },
      home,
      subagentScript: [],
      retries: 8,
    });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".toast.ok")).toBeVisible({ timeout: 10_000 });

    // 卡片 done 终态恢复（task 与重启前一致）+ 账目徽标在场（usage 快照装配）
    const restored = page.locator(".sa-card.done");
    await expect(restored).toBeVisible({ timeout: 10_000 });
    await expect(restored.locator(".sa-task")).toContainText(TASK);
    await expect(page.locator(".sa-card")).toHaveCount(1);
    await expect(page.locator(".stats-btn")).toBeVisible();

    // channel 历史可回放：closure 注入 turn 的 assistant 消息在场
    await expect(page.locator(".msg.assistant", { hasText: "（完R1b）" })).toBeVisible();
    await shotEvidence(page, "cl1-r1-after", "CL-1");

    // 主线注入消息可续（活会话）：新消息流式往返
    await e2e.send(page, "重启后继续");
    await e2e.waitForTurnDone(page, "（完R1R）", 30_000);
    await expect(page.locator(".msg.assistant", { hasText: "（完R1R）" })).toBeVisible();

    writeEvidence(
      "cl1-r1",
      "txt",
      [
        "R1 done 终态恢复：PASS",
        "重启前: .sa-card.done（task 一致）+ 报告文件含 summary + closure 注入 turn 完成",
        "重启后: .sa-card.done 恢复 + .stats-btn 在场（usage 快照）+ 历史回放 + 新消息可续",
      ].join("\n"),
      "CL-1",
    );
  });

  test("R2 running → failed 收口：注入主线（不消费）+ 零新事件流", async ({ e2e, page }) => {
    test.setTimeout(150_000);
    const home = prepHome("r2");
    const TASK = "R2 挂起运行中的任务";
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: TASK }),
        slowReply("主线继续别的活。（完R2）", 30, 6),
      ],
    };

    const d1 = await e2e.startDaemon({ script, home, subagentScript: [null] });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    await e2e.send(page, "派一个会挂起的 SubAgent");
    // 主线 turn 收口（消息级等待——running 卡自带 stream-cursor，不用全局 cursor=0）
    await e2e.waitForAssistantText(page, "（完R2）");
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    await expect(page.locator(".sa-card.running")).toBeVisible({ timeout: 10_000 });
    await shotEvidence(page, "cl1-r2-before", "CL-1");

    // 停机 → 重启。重启剧本首条为陷阱条目：若恢复错误地自动续跑（注入即
    // sendMessage），该条会被消费产生新 assistant 消息——断言「零新事件流」
    // 即机械判据（恢复后 N 秒无新引擎事件）。
    await d1.stop();
    const d2 = await e2e.startDaemon({
      script: { entries: [slowReply("陷阱：不应被自动消费。（TRAP-R2）", 30, 6)] },
      home,
      subagentScript: [],
      retries: 8,
    });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".toast.ok")).toBeVisible({ timeout: 10_000 });

    // 卡片 failed（重启收口态）+ task 恢复
    const card = page.locator(".sa-card.failed");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".sa-task")).toContainText(TASK);

    // channel 历史可回放（重启前 turn 的 user/assistant 在场）
    await expect(page.locator(".msg.assistant", { hasText: "（完R2）" })).toBeVisible();

    // closure failed 注入主线：**queued 未消费**——TR-64 队列坞语义
    //（queued 不上时间轴；快照重建归左下角浮动坞，CLOSURE 来源 chip +
    // 已入队对账态；若被消费则坞内出账 + drained 条目上轴 + 陷阱剧本产出
    // 新 assistant 消息）。T10：注入前缀 id 从 DOM 卡片捕获
    const failedCard = page.locator(".sa-card.failed");
    const failedId = (await failedCard.getAttribute("data-instance"))!;
    expect(failedId).toMatch(/^agent-[0-9a-f]+$/);
    await expect(page.locator(".msg.user", { hasText: `${failedId} closure: failed` })).toHaveCount(0);
    const dock = page.locator('[data-kind="steer-dock"]');
    await expect(dock).toBeVisible({ timeout: 10_000 });
    await expect(dock.locator(".sdq-toggle")).toContainText("1 条注入排队中");
    await dock.locator(".sdq-toggle").click();
    const item = dock.locator('.sdq-item[data-source="closure"]');
    await expect(item).toHaveCount(1);
    await expect(item.locator(".sdq-src.closure")).toHaveText("CLOSURE");
    await expect(item.locator(".sdq-text")).toContainText(`${failedId} closure: failed — ${RESTART_SUMMARY}`);
    await expect(item.locator(".sdq-state")).toHaveText("STEER · 已入队"); // 未消费（无 drained）
    await shotEvidence(page, "cl1-r2-after", "CL-1");

    // 零新事件流（机械判据）：观察窗口内无新 assistant 消息 / 无流式光标 /
    // 卡片不复活 running
    const assistantCount = await page.locator(".msg.assistant").count();
    await settle(2500);
    await expect(page.locator(".msg.assistant")).toHaveCount(assistantCount);
    await expect(page.locator(".stream-cursor")).toHaveCount(0);
    await expect(page.locator(".sa-card.running")).toHaveCount(0);
    await expect(page.locator(".sa-card")).toHaveCount(1); // 仅该实例，无复活 spawn

    writeEvidence(
      "cl1-r2",
      "txt",
      [
        "R2 running→failed 收口：PASS",
        "重启后: .sa-card.failed（task 恢复）+ 历史回放 + closure 注入（TR-64 队列坞 queued 未消费）",
        "零新事件流: 2.5s 观察窗无新 assistant / 无 stream-cursor / 无 running 卡（陷阱剧本未被消费）",
      ].join("\n"),
      "CL-1",
    );
  });

  test("R3 queued → cancelled：渲染区别 failed + 不自动重派", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = prepHome("r3");
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: "R3 任务甲" }),
        toolCall("agent_spawn", { task: "R3 任务乙" }),
        toolCall("agent_spawn", { task: "R3 任务丙" }),
        toolCall("agent_spawn", { task: "R3 排队任务丁" }),
        slowReply("主线确认四个都派出。（完R3）", 30, 6),
      ],
    };

    const d1 = await e2e.startDaemon({ script, home, subagentScript: [null, null, null] });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    await e2e.send(page, "派出三跑一排");
    // 主线 turn 收口（消息级等待——running 卡自带 stream-cursor，不可用全局
    // waitForTurnDone 的 cursor=0 断言）
    await e2e.waitForAssistantText(page, "（完R3）");
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    // maxConcurrent=3：前 3 个直跑、第 4 个入队（卡片四态渲染）
    await expect(page.locator(".sa-card.running")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator(".sa-card.queued")).toHaveCount(1);
    await shotEvidence(page, "cl1-r3-before", "CL-1");

    await d1.stop();
    const d2 = await e2e.startDaemon({
      script: { entries: [slowReply("陷阱：不应被自动消费。（TRAP-R3）", 30, 6)] },
      home,
      subagentScript: [],
      retries: 8,
    });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".toast.ok")).toBeVisible({ timeout: 10_000 });

    // 3 running → failed 收口；1 queued → cancelled（渲染态区别）
    await expect(page.locator(".sa-card.failed")).toHaveCount(3, { timeout: 10_000 });
    const cancelled = page.locator(".sa-card.cancelled");
    await expect(cancelled).toHaveCount(1);
    await expect(page.locator(".sa-card.running")).toHaveCount(0); // 不自动重派（无人复活）
    await expect(page.locator(".sa-card.queued")).toHaveCount(0); // 队列清空
    await shotEvidence(page, "cl1-r3-after", "CL-1");

    // 3 条 closure failed 注入主线（queued 实例无 closure 注入——只有 3 条）：
    // TR-64 队列坞语义——queued 不上时间轴，坞内 3 条 CLOSURE 来源条目全部
    // 已入队未消费（无 drained）
    await expect(page.locator(".msg.user", { hasText: `closure: failed — ${RESTART_SUMMARY}` })).toHaveCount(0);
    const dock3 = page.locator('[data-kind="steer-dock"]');
    await expect(dock3).toBeVisible({ timeout: 10_000 });
    await expect(dock3.locator(".sdq-toggle")).toContainText("3 条注入排队中");
    await dock3.locator(".sdq-toggle").click();
    const items3 = dock3.locator('.sdq-item[data-source="closure"]');
    await expect(items3).toHaveCount(3, { timeout: 10_000 });
    await expect(items3.locator(".sdq-text").first()).toContainText(`closure: failed — ${RESTART_SUMMARY}`);
    await expect(dock3.locator(".sdq-item .sdq-state")).toHaveCount(3);
    for (const state of await dock3.locator(".sdq-item .sdq-state").allTextContents()) {
      expect(state).toBe("STEER · 已入队"); // 全部未消费
    }

    // 零新事件流（机械判据）
    const assistantCount = await page.locator(".msg.assistant").count();
    await settle(2500);
    await expect(page.locator(".msg.assistant")).toHaveCount(assistantCount);
    await expect(page.locator(".sa-card.failed")).toHaveCount(3);
    await expect(page.locator(".sa-card.cancelled")).toHaveCount(1);

    writeEvidence(
      "cl1-r3",
      "txt",
      [
        "R3 queued→cancelled：PASS",
        "重启后: .sa-card.failed ×3（running 收口）+ .sa-card.cancelled ×1（渲染区别）",
        "不自动重派: 无 running/queued 卡复活；closure 注入 ×3（queued 实例无 closure）坞内全部已入队未消费",
        "零新事件流: 2.5s 观察窗 DOM 稳定（陷阱剧本未被消费）",
      ].join("\n"),
      "CL-1",
    );
  });
});

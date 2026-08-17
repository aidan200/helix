/**
 * T5.5 —— CL-1×CL-2 活跃事件条重设计 + 消息流 SubAgent 卡片时间轴内联
 *（task brief §4.1/§4.2 用户裁决落地；证据规格 §6）。
 *
 * 剧本（F 层 mock transport）：
 * ① 折叠态多活跃事件：m1 → spawn a1(running) → spawn a2+queued#1 → spawn a3
 *   → rail 折叠 26px、data-rail-count=3（活跃数）、三 violet 标识纵列；
 * ② 展开态简介列表：展开把手 → 每事件一行（类型徽标 + task + 状态：running
 *   计时 / queued 排位）；localStorage 记忆（helix-activity-rail-collapsed=0）；
 * ③ 内联卡 running→done 原位：m1 → spawn a1 → m2，卡锚定 m1/m2 之间；
 *   agent.completed 后 done 卡留原位（几何 y 区间断言 + 截图证据）。
 *
 * 断言纪律：语义类（.rail-marker/.rail-row/.sa-card.<state>）+ 几何区间；
 * 截图落 evidence/e2e/（prefix CL-1，门控可识别）。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence } from "./harness/evidence";
import {
  agentCompleted,
  agentQueued,
  agentSpawned,
  closure,
  messageCompleted,
  msgEntry,
  snapshot,
  welcome,
} from "./harness/protocol";

test.describe("T5.5 活跃事件条 + 消息流卡片时间轴内联", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([welcome(), snapshot([])]);
    await mock.waitForConn("connected");
  });

  test("折叠态多活跃事件（类型着色纵列）→ 展开态简介列表 → 内联卡 running→done 原位", async ({
    mock,
    page,
  }) => {
    // ── ① 折叠态：三个活跃事件（running ×2 + queued #1）──
    await mock.emitAll([
      messageCompleted(msgEntry("m1", "assistant", "第一条主线回复")),
      agentSpawned("a1", "盘点 session reducer 测试面"),
      agentSpawned("a2", "补齐 daemon 单测"),
      agentQueued("a2", 1),
      agentSpawned("a3", "巡检 e2e 证据面"),
    ]);
    const rail = page.locator("[data-drawer-rail]");
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute("data-rail-state", "collapsed");
    await expect(rail).toHaveAttribute("data-rail-count", "3"); // 活跃数（非累计）
    const markers = rail.locator(".rail-marker");
    await expect(markers).toHaveCount(3);
    await expect(markers.first()).toHaveAttribute("data-activity-type", "subagent");
    await expect(markers.first()).toHaveAttribute("data-color", "violet");
    await expect(markers.nth(1)).toHaveAttribute("data-state", "queued");
    await page.waitForTimeout(400); // 等 log-rise 入场动效落定再取证
    await shotEvidence(page, "activity-rail-collapsed-multi", "CL-1");

    // ── ② 展开态：简介列表 + localStorage 记忆 ──
    await page.locator(".rail-toggle").click();
    await expect(rail).toHaveAttribute("data-rail-state", "expanded");
    const rows = rail.locator(".rail-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("盘点 session reducer 测试面");
    await expect(rows.nth(0)).toContainText("执行中");
    await expect(rows.nth(1)).toContainText("补齐 daemon 单测");
    await expect(rows.nth(1)).toContainText("排队 #1");
    expect(await page.evaluate(() => localStorage.getItem("helix-activity-rail-collapsed"))).toBe(
      "0",
    );
    await page.waitForTimeout(400);
    await shotEvidence(page, "activity-rail-expanded-rows", "CL-1");
    // 收起回折叠（把手双向）
    await page.locator(".rail-toggle").click();
    await expect(rail).toHaveAttribute("data-rail-state", "collapsed");

    // ── ③ 内联卡 running→done 原位：卡锚定 m1 之后、m2 之前 ──
    await mock.emit(messageCompleted(msgEntry("m2", "assistant", "第二条主线回复")));
    const m1Box = await page.locator(".msg", { hasText: "第一条主线回复" }).boundingBox();
    const m2Box = await page.locator(".msg", { hasText: "第二条主线回复" }).boundingBox();
    const cardA1 = page.locator('.sa-card[data-instance="a1"]');
    await expect(cardA1).toHaveClass(/running/);
    const runBox = (await cardA1.boundingBox())!;
    expect(runBox.y).toBeGreaterThan(m1Box!.y); // m1 之后
    expect(runBox.y).toBeLessThan(m2Box!.y); // m2 之前
    await page.waitForTimeout(400);
    await shotEvidence(page, "sa-card-inline-running", "CL-1");

    await mock.emit(agentCompleted("a1", closure("done", "测试面盘点收口")));
    await expect(cardA1).toHaveClass(/done/); // 原位转终态
    const doneBox = (await cardA1.boundingBox())!;
    expect(Math.abs(doneBox.y - runBox.y)).toBeLessThan(2); // 原位（y 不漂移）
    await expect(cardA1).toContainText("测试面盘点收口");
    // 终态立即离开事件条：a1 离开后余 2 活跃
    await expect(rail).toHaveAttribute("data-rail-count", "2");
    await page.waitForTimeout(400);
    await shotEvidence(page, "sa-card-inline-done-insitu", "CL-1");
  });
});

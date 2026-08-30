/**
 * T4.1 剧本二 —— bootstrap 重启恢复 E2E（testing/test-design.md §1.4-2；
 * CL-1 发起 + CL-3 断点恢复：任务 running 中 SIGTERM daemon → 重启 →
 * running 任务扫出续跑、done stage 不重跑、in-flight 批次按失败重试路径）。
 *
 * 现场构造：daemon A 编排剧本跑完 stage1（批次收口 + 阶段聚合）→ stage2
 * 批次派发后挂起（ScriptedSubagentRunner null 条目 = 在跑不收口）→ SIGTERM。
 * Scripted runner 无子进程、无 shutdown 钩子 → 停机竞态零介入，batch2 行
 * 保持 running（in-flight 现场确定性留存，TR-TEST-3：机制不进剧本）。
 *
 * 恢复断言（真库）：daemon B 同 home 重启 → recoverOnStartup 扫出 running
 * 任务 → in-flight batch2 failed 收口（retry_note=daemon 重启）→ 编排重开
 * sweepRetries 自动重派（同 batch 行新实例）→ 续跑至 done；stage1 done 不
 * 重跑（无新批次行、artifact 原样、instanceId 不变、retry_count=0）。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  makeBootstrapWorkspace,
  restartRecoveryScriptA,
  restartRecoveryScriptB,
  idleDaemonScript,
  launchBootstrapViaUi,
  taskRows,
} from "./harness/bootstrap-env";

test.describe("T4.1 剧本二：bootstrap 重启恢复（SIGTERM → 扫出续跑 → in-flight 重试路径）", () => {
  test("running 中 SIGTERM → 重启续跑：done stage 不重跑 + in-flight 批次失败重试", async ({ e2e, page }) => {
    test.setTimeout(240_000);
    const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-t41-boot2-"));
    const ws = makeBootstrapWorkspace(home);

    // ── daemon A：stage1 完成 + stage2 批次在跑挂起 ──
    const dA = await e2e.startDaemon({
      script: idleDaemonScript(),
      home,
      orchestratorScript: { entries: restartRecoveryScriptA() },
      subagentScript: [
        { delayMs: 300, result: "done", summary: "批次 1 完成：L0 节点已落账" },
        null, // batch2 挂起（在跑不收口——SIGTERM 现场）
      ],
      kgWorkspaceRoot: ws,
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await launchBootstrapViaUi(page);

    // P-2 观察到 running；真库等到现场就绪：stage1 done + batch2 running
    const jobRow = page.locator(".tk-row");
    await expect(jobRow).toHaveCount(1, { timeout: 15_000 });
    await expect(jobRow).toHaveAttribute("data-task", "running", { timeout: 20_000 });
    await expect
      .poll(
        () => {
          const rows = taskRows(home);
          const s1 = rows.stages.find((s) => s.seq === 1);
          const b2 = rows.batches.find((b) => b.stage_seq === 2);
          return { stage1: s1?.status, batch2: b2?.status, batches: rows.batches.length };
        },
        { timeout: 60_000, intervals: [200, 500, 1000] },
      )
      .toEqual({ stage1: "done", batch2: "running", batches: 2 });
    const preRows = taskRows(home); // 停机前现场快照（恢复比对基线）
    await shotEvidence(page, "boot2-before-sigterm", "CL-1-CL-3");

    // ── SIGTERM（优雅停机；scripted 实例无 shutdown 钩子 → batch2 保持 running） ──
    await dA.stop();
    const downRows = taskRows(home);
    expect(downRows.jobs[0]).toMatchObject({ status: "running" });
    expect(downRows.batches.find((b) => b.stage_seq === 2)).toMatchObject({ status: "running", retry_count: 0 });

    // ── daemon B：同 home 重启 → 恢复扫描续跑 ──
    const dB = await e2e.startDaemon({
      script: idleDaemonScript(),
      home,
      retries: 5,
      orchestratorScript: { entries: restartRecoveryScriptB() },
      subagentScript: [
        { delayMs: 15000, result: "done", summary: "批次 2 重跑完成（接力 brief）" }, // batch2 重派实例（慢速——恢复中间态观察窗口）
        { delayMs: 300, result: "done", summary: "批次 3 完成：L2 节点已落账" },
      ],
      kgWorkspaceRoot: ws,
    });
    // 恢复扫描中间态（真库）：in-flight batch2 已走失败重试路径（retry_count=1 +
    // 重启收口注记 + 同 batch 行换新实例回 running）——「扫出续跑」机械证据。
    await expect
      .poll(
        () => {
          const b = taskRows(home).batches.find((x) => x.stage_seq === 2);
          return { status: b?.status, retry: b?.retry_count, note: b?.retry_note ?? "" };
        },
        { timeout: 30_000, intervals: [200, 500] },
      )
      .toEqual({ status: "running", retry: 1, note: "daemon 重启：in-flight 批次收口走自动重试" });

    // 页面联动：重启后任务仍在列表且推进至终态 done（running 中间态由上方真库
    // 轮询钉定——UI 观察时点受页面加载耗时影响，不作硬断言避免竞态）。
    await page.reload();
    await e2e.waitForConnected(page);
    await page.locator('.rail-btn[data-page="tasks"]').click();
    await expect(page.locator('[data-p2-task="/tasks"]')).toBeVisible();
    await expect(jobRow).toHaveCount(1, { timeout: 15_000 });
    await shotEvidence(page, "boot2-after-restart", "CL-1-CL-3");
    await expect(jobRow).toHaveAttribute("data-task", "done", { timeout: 120_000 });
    await shotEvidence(page, "boot2-tasks-done", "CL-1-CL-3");

    // ── 真库断言：恢复形态 + done stage 不重跑 + in-flight 重试路径 ──
    const postRows = taskRows(home);
    expect(postRows.jobs).toHaveLength(1);
    expect(postRows.jobs[0]).toMatchObject({ type: "kg-bootstrap", status: "done" });
    // 全阶段 done；stage1 artifact 与停机前逐字一致（done stage 不重跑）
    expect(postRows.stages.map((s) => s.status)).toEqual(["done", "done", "done"]);
    const preS1 = preRows.stages.find((s) => s.seq === 1)!;
    const postS1 = postRows.stages.find((s) => s.seq === 1)!;
    expect(postS1.artifact).toBe(preS1.artifact);
    // 批次行：三阶段各一行（无重插）；stage1 批次原样（实例不变、零重试）
    expect(postRows.batches).toHaveLength(3);
    const preB1 = preRows.batches.find((b) => b.stage_seq === 1)!;
    const postB1 = postRows.batches.find((b) => b.stage_seq === 1)!;
    expect(postB1).toMatchObject({ id: preB1.id, status: "done", retry_count: 0, instance_id: preB1.instance_id });
    // in-flight batch2：失败重试路径（retry_count=1 + 重启收口注记 + 同 batch 行换新实例续跑至 done）
    const preB2 = preRows.batches.find((b) => b.stage_seq === 2)!;
    const postB2 = postRows.batches.find((b) => b.stage_seq === 2)!;
    expect(postB2.id).toBe(preB2.id);
    expect(postB2.status).toBe("done");
    expect(postB2.retry_count).toBe(1);
    expect(postB2.retry_note).toContain("daemon 重启：in-flight 批次收口走自动重试");
    expect(postB2.instance_id).not.toBe(preB2.instance_id);
    expect(postB2.instance_id).not.toBeNull();
    // stage3 批次：恢复后续跑新派（重试零）
    const postB3 = postRows.batches.find((b) => b.stage_seq === 3)!;
    expect(postB3).toMatchObject({ status: "done", retry_count: 0 });

    writeEvidence(
      "boot2-db-assert",
      "json",
      JSON.stringify({ preSigterm: preRows, afterSigterm: downRows, recovered: postRows }, null, 2),
      "CL-1-CL-3",
    );

    // ── teardown：fixture 三件套（SIGTERM + 子进程树回收 + tmp 清理 + 端口验证）──
    await dB.stop();
  });
});

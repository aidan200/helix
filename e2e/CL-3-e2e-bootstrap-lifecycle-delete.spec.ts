/**
 * T4.1 剧本三 —— bootstrap 生命周期 + 终态删除 E2E（testing/test-design.md
 * §1.4-3；CL-3 生命周期总口径 + F3.6 删除总口径）：pause→resume→cancel 经
 * 真引擎 API 生效 + 页面状态联动；cancel 后 delete → helix.db 任务四表行
 * 清零 + work_item 零孤儿 + kg 产出不动（真库断言）。
 *
 * 现场构造：批次子进程为真子进程（realSubagent），工具轮全真（plan_create/
 * kg-update 真落账），尾部 closure 回复慢速流（~10s+ 在跑窗口）——
 * - pause 窗口：batch1 在跑中暂停 → 停派（批次行不增）+ 在跑自然收口
 *   （batch1 done 照常落库，job 保持 paused，stage 不推进）；
 * - resume：续派（stage1 聚合 + batch2 派发）；
 * - cancel 窗口：batch2 在跑中取消 → 在跑批次 SIGTERM（真子进程 kill 通路）
 *   + 批次行 failed（retry_note=cancelled，不触发自动重试）+ job cancelled。
 *
 * 真库断言：delete 前 work_item 非空（ orphan 检查非真空）→ delete 后
 * job/stage/batch/work_item 四表清零；kg nodes/change_log 快照逐字不动
 * （删任务 ≠ 删知识，AD-10）。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  makeBootstrapWorkspace,
  lifecycleScript,
  slowBatchChildEngineScript,
  idleDaemonScript,
  launchBootstrapViaUi,
  openFirstTaskDetail,
  kgNodes,
  kgChangeLog,
  taskRows,
  taskTableCounts,
} from "./harness/bootstrap-env";

test.describe("T4.1 剧本三：bootstrap 生命周期 + 终态删除（pause/resume/cancel/delete 真引擎 + 页面联动）", () => {
  test("pause 停派+在跑收口 → resume 续派 → cancel SIGTERM → delete 清四表不动 kg", async ({ e2e, page }) => {
    test.setTimeout(300_000);
    const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-t41-boot3-"));
    const ws = makeBootstrapWorkspace(home);

    const d = await e2e.startDaemon({
      script: idleDaemonScript(),
      home,
      orchestratorScript: { entries: lifecycleScript() },
      realSubagent: { engineScript: slowBatchChildEngineScript() },
      kgWorkspaceRoot: ws,
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await launchBootstrapViaUi(page);
    const jobRow = await openFirstTaskDetail(page);
    await expect(jobRow).toHaveAttribute("data-task", "running", { timeout: 20_000 });

    // ── 1. pause：batch1 在跑中暂停（慢速流窗口内） ──
    await expect
      .poll(() => taskRows(home).batches.find((b) => b.stage_seq === 1)?.status, {
        timeout: 60_000,
        intervals: [100, 200, 500],
      })
      .toBe("running");
    await page.locator('[data-tk-actions] [data-act="pause"]').click();
    // 页面状态联动：列表行 + 详情徽标 → paused
    await expect(jobRow).toHaveAttribute("data-task", "paused", { timeout: 15_000 });
    await shotEvidence(page, "boot3-paused-inflight", "CL-3");
    // 停派（O-2）：paused 期间批次行不增；在跑批次未被打断（仍 running）
    const pausedRows = taskRows(home);
    expect(pausedRows.jobs[0]).toMatchObject({ status: "paused" });
    expect(pausedRows.batches).toHaveLength(1);
    expect(pausedRows.batches[0]).toMatchObject({ stage_seq: 1, status: "running" });

    // ── 2. 在跑自然收口：batch1 done 照常落库，job 保持 paused，阶段不推进 ──
    await expect
      .poll(() => taskRows(home).batches[0]?.status, { timeout: 60_000, intervals: [500, 1000] })
      .toBe("done");
    const settledRows = taskRows(home);
    expect(settledRows.jobs[0]).toMatchObject({ status: "paused" });
    expect(settledRows.batches).toHaveLength(1); // 停派持守：收口不触发新批次
    expect(settledRows.stages.find((s) => s.seq === 1)?.status).not.toBe("done");
    await shotEvidence(page, "boot3-paused-settled", "CL-3");

    // ── 3. resume：续派（stage1 聚合 + batch2 派发） ──
    await page.locator('[data-tk-actions] [data-act="resume"]').click();
    await expect(jobRow).toHaveAttribute("data-task", "running", { timeout: 15_000 });
    await expect
      .poll(
        () => {
          const rows = taskRows(home);
          return {
            stage1: rows.stages.find((s) => s.seq === 1)?.status,
            batch2: rows.batches.find((b) => b.stage_seq === 2)?.status,
          };
        },
        { timeout: 60_000, intervals: [200, 500, 1000] },
      )
      .toEqual({ stage1: "done", batch2: "running" });
    await shotEvidence(page, "boot3-resumed-redispatch", "CL-3");

    // ── 4. cancel：batch2 在跑中取消（两步确认）→ 在跑批次 SIGTERM + failed 收口 ──
    await page.locator('[data-tk-actions] [data-act="cancel"]').click();
    await page.locator('[data-tk-confirm-yes="cancel"]').click();
    await expect(jobRow).toHaveAttribute("data-task", "cancelled", { timeout: 15_000 });
    const cancelledRows = taskRows(home);
    expect(cancelledRows.jobs[0]).toMatchObject({ status: "cancelled" });
    const b2 = cancelledRows.batches.find((b) => b.stage_seq === 2)!;
    expect(b2.status).toBe("failed");
    expect(b2.retry_note).toContain("cancelled"); // 取消收口，不触发自动重试
    await shotEvidence(page, "boot3-cancelled", "CL-3");

    // ── 5. delete 前快照：kg 产出基线 + work_item 非空（orphan 检查非真空） ──
    const kgBefore = kgNodes(ws);
    const logBefore = kgChangeLog(ws);
    const countsBefore = taskTableCounts(home);
    expect(kgBefore.length).toBeGreaterThanOrEqual(2); // batch1 真落账（kg-update 工具轮全真）
    expect(countsBefore.work_items).toBeGreaterThanOrEqual(2); // batch1 plan 两项真落台账
    expect(countsBefore.jobs).toBe(1);

    // ── 6. delete（两步确认）→ 四表清零 + 页面联动（列表清空） ──
    await page.locator('[data-tk-actions] [data-act="delete"]').click();
    await page.locator('[data-tk-confirm-yes="delete"]').click();
    await expect(page.locator(".tk-row")).toHaveCount(0, { timeout: 15_000 });
    await shotEvidence(page, "boot3-deleted", "CL-3");
    expect(taskTableCounts(home)).toEqual({ jobs: 0, stages: 0, batches: 0, work_items: 0 });

    // ── 7. kg 产出不动（AD-10：删任务 ≠ 删知识）——快照逐字比对 ──
    expect(kgNodes(ws)).toEqual(kgBefore);
    expect(kgChangeLog(ws)).toEqual(logBefore);

    writeEvidence(
      "boot3-db-assert",
      "json",
      JSON.stringify(
        {
          paused: pausedRows,
          settled: settledRows,
          cancelled: cancelledRows,
          countsBeforeDelete: countsBefore,
          countsAfterDelete: taskTableCounts(home),
          kgNodesBeforeDelete: kgBefore,
          kgChangeLogBeforeDelete: logBefore,
        },
        null,
        2,
      ),
      "CL-3",
    );

    // ── teardown：fixture 三件套（SIGTERM + 子进程树回收 + tmp 清理 + 端口验证）──
    await d.stop();
  });
});

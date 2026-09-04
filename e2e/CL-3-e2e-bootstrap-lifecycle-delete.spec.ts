/**
 * T4.1 剧本三 —— bootstrap 生命周期 + 终态删除 E2E（testing/test-design.md
 * §1.4-3；CL-3 生命周期总口径 + F3.6 删除总口径）：pause→resume→cancel 经
 * 真引擎 API 生效 + 页面状态联动；cancel 后 delete → helix.db 任务四表行
 * 清零 + work_item 零孤儿 + kg 产出不动（真库断言）。
 *
 * 现场构造：批次子进程为真子进程（realSubagent），工具轮全真（plan_create/
 * kg-update 真落账），park-aware 三轮回复（慢速收口首演 ~19s 窗口 → PARK
 * 挂起轮 → RESUME 续跑 closure 终演）——链 A（⑤ park/resume 批）语义：
 * - pause 窗口：batch1 落账完成（kg 节点在库 = 工具轮收口，慢速收口轮在跑）
 *   中暂停 → 停派（批次行不增）+ 在跑实例协作式挂起（PARK 轮 → parked
 *   等待；批次行保持 running，实例级 parked——不再暂停期自然收口）；
 * - resume：复活 parked 实例（RESUME 续跑 closure 收口 → batch1 done）+
 *   编排 kick（待命轮）→ batch1 收口轮聚合 stage1 + 派发 batch2；
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

/** 等 N ms（挂起持守观察窗）。 */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

    // ── 1. pause：batch1 落账完成（kg 节点在库 = 工具轮已收口，子进程必在
    //    慢速收口轮——park 打入确定性窗口）中暂停 ──
    await expect
      .poll(() => taskRows(home).batches.find((b) => b.stage_seq === 1)?.status, {
        timeout: 60_000,
        intervals: [100, 200, 500],
      })
      .toBe("running");
    // kg-update 是工具轮第 4 调用（plan 三调用在其前）——节点在库 ⇒ 子进程
    // 已进入慢速收口首演轮（~19s 窗口），PARK 指令必在 turn 边界 drain
    await expect
      .poll(() => kgNodes(ws).length, { timeout: 60_000, intervals: [200, 500] })
      .toBe(2);
    await page.locator('[data-tk-actions] [data-act="pause"]').click();
    // 页面状态联动：列表行 + 详情徽标 → paused
    await expect(jobRow).toHaveAttribute("data-task", "paused", { timeout: 15_000 });
    await shotEvidence(page, "boot3-paused-inflight", "CL-3");
    // 停派（O-2）：paused 期间批次行不增；在跑批次行保持 running（链 A⑤：
    // 实例级协作式挂起 parked——批次行状态不变，可见性面展示实例态）
    const pausedRows = taskRows(home);
    expect(pausedRows.jobs[0]).toMatchObject({ status: "paused" });
    expect(pausedRows.batches).toHaveLength(1);
    expect(pausedRows.batches[0]).toMatchObject({ stage_seq: 1, status: "running" });

    // ── 2. 挂起持守：观察窗内批次不收口、阶段不推进（parked 等待 RESUME——
    //    旧「在跑自然收口 done」语义已随 park/resume 批退役）──
    await settle(3000);
    const parkedRows = taskRows(home);
    expect(parkedRows.jobs[0]).toMatchObject({ status: "paused" });
    expect(parkedRows.batches).toHaveLength(1);
    expect(parkedRows.batches[0]).toMatchObject({ stage_seq: 1, status: "running" });
    expect(parkedRows.stages.find((s) => s.seq === 1)?.status).not.toBe("done");
    await shotEvidence(page, "boot3-paused-parked", "CL-3");

    // ── 3. resume：复活 parked 实例（RESUME 续跑 closure 收口）→ batch1 done
    //    → 收口轮聚合 stage1 + 派发 batch2 ──
    await page.locator('[data-tk-actions] [data-act="resume"]').click();
    await expect(jobRow).toHaveAttribute("data-task", "running", { timeout: 15_000 });
    await expect
      .poll(
        () => {
          const rows = taskRows(home);
          return {
            stage1: rows.stages.find((s) => s.seq === 1)?.status,
            batch1: rows.batches.find((b) => b.stage_seq === 1)?.status,
            batch2: rows.batches.find((b) => b.stage_seq === 2)?.status,
          };
        },
        { timeout: 90_000, intervals: [200, 500, 1000] },
      )
      .toEqual({ stage1: "done", batch1: "done", batch2: "running" });
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
          parked: parkedRows,
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

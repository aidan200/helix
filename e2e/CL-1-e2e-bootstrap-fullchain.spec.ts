/**
 * T4.1 剧本一 —— bootstrap 任务全链路 E2E（testing/test-design.md §1.4-1；
 * CL-1 发起 + CL-2 编排产出真库断言 + CL-4 呈现与事后修正）。
 *
 * 链路全真（TR-TEST-5 E 层 + TR-TEST-4 --home tmp）：真 daemon（tmp home
 * 预绑 tmp workspace）→ 浏览器真 WS → /project 页发起（kg.bootstrap.create，
 * 准入机械复核走真 sync——codegraph 不可用 → degraded 如实放行）→ 编排主
 * agent（FakeLLM 剧本驱动批次循环 LLM 判断面）→ 批次 SubAgent 真子进程
 * （FakeEngineScript toolCalls：plan_create/plan_update/kg-update 批量落账
 * → closure）→ 产出经 KgWriteService 真落 .helix-kg → P-2 观察进度 →
 * P-1 图谱呈现核对（产出呈现 tab/UI supersede 已退役——E-118 留碑，见步骤 6）。
 *
 * 真库断言（bun -e 只读直查）：nodes（status=confirmed + layer ∈ L0/L1/L2 +
 * origin_batch_id 非空）+ change_log（task_id = jobId）。
 * 剧本只钉 LLM 输出（TR-TEST-3）——引擎状态机/closure 硬约束/落库全真。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  makeBootstrapWorkspace,
  happyPathOrchestratorScript,
  batchChildEngineScript,
  idleDaemonScript,
  kgNodes,
  kgChangeLog,
  taskRows,
} from "./harness/bootstrap-env";

test.describe("T4.1 剧本一：bootstrap 任务全链路（发起→编排→产出→呈现→修正）", () => {
  test("全链路真库贯通：confirmed+layer+origin_batchId 落库 + P-2 进度 + P-1 图谱呈现", async ({ e2e, page }) => {
    test.setTimeout(240_000);
    const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-t41-boot1-"));
    const ws = makeBootstrapWorkspace(home);

    const d = await e2e.startDaemon({
      script: idleDaemonScript(),
      home,
      orchestratorScript: { entries: happyPathOrchestratorScript() },
      realSubagent: { engineScript: batchChildEngineScript() },
      kgWorkspaceRoot: ws,
      // degraded 确定性（da705ea 二级化后）：宿主 HELIX_CODEGRAPH_PATH 会经
      // process.env 泄漏进 E 层 daemon 使 sync 成功（synced 无 warn）——置空
      // 强制 EngineUnavailable → degraded 基准（本 spec 验 degraded 准入放行面）
      env: { HELIX_CODEGRAPH_PATH: "" },
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 1. /project：absent 项目 → 构建索引（真 sync：codegraph 不可用 → degraded） ──
    await page.locator('.rail-btn[data-page="project"]').click();
    await expect(page.locator('[data-p1-project="/project"]')).toBeVisible();
    const row = page.locator('.pj-row[data-name="demo-proj"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator('[data-pj-main="absent"]')).toBeVisible({ timeout: 10_000 });
    await shotEvidence(page, "boot1-absent-guide", "CL-1-CL-2-CL-4");
    await page.locator("[data-build-cta]").click();
    // degraded 基准建立（无 codegraph 二进制 → EngineUnavailable → degraded 标记 + baseline）
    await expect(page.locator('[data-pj-main="graph"]')).toBeVisible({ timeout: 30_000 });

    // ── 2. bootstrap 入口（degraded + 知识层空 → 准入放行；degraded warning 条如实） ──
    const entry = page.locator('[data-boot-entry="ready"]');
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await expect(entry.locator('[data-boot-degraded-warn]')).toBeVisible();
    await shotEvidence(page, "boot1-entry-ready", "CL-1-CL-2-CL-4");
    await entry.locator("[data-launch-btn]").click();
    await expect(page.locator("[data-boot-launched]")).toBeVisible({ timeout: 10_000 });

    // ── 3. P-2 任务页：观察到 running 进度 → done ──
    await page.locator("[data-goto-tasks]").click();
    await expect(page.locator('[data-p2-task="/tasks"]')).toBeVisible();
    const jobRow = page.locator(".tk-row");
    await expect(jobRow).toHaveCount(1, { timeout: 15_000 });
    // running 态先行观察到（阶段条 stage 行驱动；随后终态 done）
    await expect(jobRow).toHaveAttribute("data-task", "running", { timeout: 20_000 });
    await shotEvidence(page, "boot1-tasks-running", "CL-1-CL-2-CL-4");
    await jobRow.click();
    await expect(page.locator('[data-tk-detail][data-id^="task-"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-tk-stagebar] [data-tk-stage]")).toHaveCount(3, { timeout: 15_000 });
    await expect(jobRow).toHaveAttribute("data-task", "done", { timeout: 120_000 });
    await shotEvidence(page, "boot1-tasks-done", "CL-1-CL-2-CL-4");

    // ── 4. P-2 结果查询 tab：阶段产物卡（B1 改造后纯文字卡——阶段名 + 摘要；
    //    kg 零耦合：无节点清单/计数 chip，9798562）──
    await page.locator('[data-tk-tab="result"]').click();
    await expect(page.locator("[data-tk-art]")).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator("[data-tk-art][data-stage-seq='1'] .tk-art-sum")).toContainText("L0 层建成：架构 2 节点");
    await expect(page.locator("[data-tk-art][data-stage-seq='3'] .tk-art-sum")).toContainText("L2 层建成：购物车实体 2 节点");
    await expect(page.locator("[data-tk-node]")).toHaveCount(0); // 节点清单退役钉住

    // ── 5. P-1 图谱呈现（KgViewer 节点列表）：6 节点全部已确认 ──
    await page.locator('.rail-btn[data-page="project"]').click();
    await expect(page.locator('[data-p1-project="/project"]')).toBeVisible();
    // 选中态跨页保持（折叠轨形态：已选项目不再以 .pj-row 列表形态渲染）——
    // 无需重点行，直等项目详情主区
    await expect(page.locator('[data-pj-main="graph"]')).toBeVisible({ timeout: 15_000 });
    const nodeRows = page.locator("[data-kg-list] .kgv-row");
    await expect(nodeRows).toHaveCount(6, { timeout: 15_000 });
    await expect(page.locator("[data-kg-count]")).toContainText("6 节点");
    await expect(nodeRows.locator("text=已确认")).toHaveCount(6);
    await shotEvidence(page, "boot1-kg-nodes", "CL-1-CL-2-CL-4");

    // ── 6. 退役留碑（E-118 / 2026-09 裁决）：产出呈现 tab（KgProducePane）与
    //    UI 版 supersede 已移除——kg.bootstrap.produce / kg.node.supersede 等
    //    命令 daemon 侧保留但无 UI 消费者；supersede 命令面由集成层
    //    kg-supersede.test.ts 承载，本 spec 不再经 UI 演练事后修正。 ──

    // ── 7. 真库断言（daemon 运行中 WAL 只读直查） ──
    const nodes = kgNodes(ws, "demo-proj");
    expect(nodes.length).toBe(6);
    const layers = new Map(nodes.map((n) => [n.id, n.layer]));
    for (const n of nodes) {
      expect(["L0", "L1", "L2"]).toContain(n.layer);
      expect(n.origin_batch_id).not.toBeNull();
      expect(n.origin_batch_id).toMatch(/^batch-/);
    }
    const confirmedCount = nodes.filter((n) => n.status === "confirmed").length;
    expect(confirmedCount).toBe(6);
    expect([...layers.values()].filter((l) => l === "L0").length).toBe(2);
    expect([...layers.values()].filter((l) => l === "L1").length).toBe(2);
    expect([...layers.values()].filter((l) => l === "L2").length).toBe(2);

    const rows = taskRows(d.home);
    expect(rows.jobs.length).toBe(1);
    const jobId = rows.jobs[0]!.id;
    expect(rows.jobs[0]).toMatchObject({ type: "kg-bootstrap", status: "done" });
    // 产出批次可溯源：每批次的 origin_batch_id 恰是该批次行 id
    const batchIds = new Set(rows.batches.map((b) => b.id));
    for (const n of nodes) expect(batchIds.has(n.origin_batch_id!)).toBe(true);
    // change_log：createNode 记 taskId（supersede 修正面退役留碑，见步骤 6）
    const log = kgChangeLog(ws);
    const creates = log.filter((l) => l.op === "createNode");
    expect(creates.length).toBe(6);
    for (const c of creates) expect(c.task_id).toBe(jobId);

    // 证据：真库断言快照（供验收复核）
    writeEvidence(
      "boot1-db-assert",
      "json",
      JSON.stringify({ nodes, changeLog: log, taskRows: rows }, null, 2),
      "CL-1-CL-2-CL-4",
    );

    // ── teardown：fixture 三件套（SIGTERM + 子进程树回收 + tmp 清理 + 端口验证）──
    await d.stop();
  });
});

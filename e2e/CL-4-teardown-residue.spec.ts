/**
 * T5.2 —— CL-4：teardown 零残留纪律断言（TR-TEST-6 机械判据）。
 *
 * 「零残留」三面（决策消解）：①tmp 基目录（fixture 根，helix-e2e-* 前缀）
 * 无残留子目录/文件；②ps 无 daemon（launcher.ts）/SubAgent（--child-main）
 * 子进程（命令行特征匹配，本 worktree 范围）；③daemon 端口可 bind。
 * 任一命中即红（非软警告）——本 spec 与 daemon-fixture teardown 断言双层
 * 守护：spec 覆盖「连跑两轮后」的套件级判据（第二轮的全量断言面），
 * fixture teardown 覆盖单 test 粒度的即时红。
 *
 * 故意残留自证（验收标准①红面证据的机械化形态）：
 * - 进程面/端口面：真子进程 SubAgent 模式 spawn 探针 → 存活时 ps 断言
 *   命中 + 端口 bind 失败（探测器抓得到残留）；daemon SIGTERM 后子进程
 *   孤儿化（注入 runner 不在 daemon dispose 范围）→ 兜底回收 → ps 清空。
 * - tmp 面：mkdtemp 探针目录 → 残留清单命中 → 即删（探测器自证，非旁路
 *   清理——daemon 残留的清理责任仍在 fixture）。
 */
import { test, expect } from "./harness/daemon-fixture";
import {
  E2E_DAEMON_PORT,
  canBindPort,
  filterResidueByGroup,
  findResidueProcesses,
  listE2eTmpResidue,
  recoverResidueProcesses,
  waitForPortFree,
  type PsEntry,
} from "./harness/daemon-fixture";
import { writeEvidence } from "./harness/evidence";
import { listHelixTmpResidue } from "./harness/tmp-hygiene";
import { slowReply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe("T5.2 CL-4 teardown 零残留纪律（TR-TEST-6）", () => {
  test("组归属豁免判据（TR-302 活跃豁免）：纯函数四场景", () => {
    // 表：本 run（pgid=90）| 外部活组长 daemon（pid=500，pgid=500）带着 worker（pid=501，pgid=500）
    // | detached daemon 组长（pid=600，pgid=600）| 死组遗孤 worker（pid=701，pgid=700，组长不在表）
    const ps: PsEntry[] = [
      { pid: 90, ppid: 1, pgid: 90, command: "playwright test" },
      { pid: 500, ppid: 1, pgid: 500, command: "bun /repo/apps/daemon/main.ts" }, // 外部活跃 daemon（无特征）
      { pid: 501, ppid: 500, pgid: 500, command: "bun /repo/apps/daemon/main.ts --child-main" }, // SubAgent worker（有特征）
      { pid: 600, ppid: 90, pgid: 600, command: "bun /repo/apps/daemon/test/e2e/launcher.ts --role main" }, // 本 run detached daemon（组长+特征，父=spec 进程）
      { pid: 601, ppid: 600, pgid: 600, command: "bun /repo/apps/daemon/main.ts --child-main" }, // 其孙 worker
      { pid: 701, ppid: 1, pgid: 700, command: "bun /repo/apps/daemon/main.ts --child-main" }, // 死组遗孤（组长 700 已退）
    ];
    const hits = ps.filter((e) => /--child-main|launcher\.ts/.test(e.command));
    const recovered = filterResidueByGroup(hits, ps, 90, 90);
    const recoveredPids = recovered.map((e) => e.pid).sort();
    // 回收：本 run detached 树（600+601）与死组遗孤（701）；豁免：外部活跃 worker（501）
    expect(recoveredPids).toEqual([600, 601, 701]);
    expect(recoveredPids).not.toContain(501);
  });

  test("组归属豁免判据：detached 组长形态盲区（SubAgent worker 自身即组长）", () => {
    // SubAgent worker 被 SubagentLauncher detached spawn（自身即组长 pgid==pid），父 = 活跃用户 daemon
    // —— d971303a 首版盲区：被当「本 run detached 树根」误回收（第四任 137 实证）
    const ps: PsEntry[] = [
      { pid: 90, ppid: 1, pgid: 90, command: "playwright test" },
      { pid: 888, ppid: 1, pgid: 888, command: "bun /repo/apps/daemon/main.ts" }, // 用户 daemon（活，无特征）
      { pid: 889, ppid: 888, pgid: 889, command: "bun /repo/apps/daemon/main.ts --child-main" }, // SubAgent worker（detached 组长+特征）
      { pid: 999, ppid: 1, pgid: 999, command: "bun /repo/apps/daemon/test/e2e/launcher.ts --role main" }, // 上一 run 遗孤 daemon（组长+ppid=1）
    ];
    const hits = ps.filter((e) => /--child-main|launcher\.ts/.test(e.command));
    const recoveredPids = filterResidueByGroup(hits, ps, 90, 90).map((e) => e.pid).sort();
    // 豁免：活跃 SubAgent worker（889，父不在本 run 树）；回收：上一 run 遗孤（999，ppid=1）
    expect(recoveredPids).toEqual([999]);
    expect(recoveredPids).not.toContain(889);
  });

  test("SubAgent 子进程树兜底回收 + 故意残留红自证（ps/端口面）", async ({ e2e, page }) => {
    test.setTimeout(90_000);
    // 探针剧本：子进程长流式（4s/片 × 25 片 ≈ 100s 存活窗）+ ignoreAbort——
    // SIGTERM 不收敛，逼迫兜底回收走满 SIGTERM→3s→SIGKILL 升级序列（O-6 同参数）
    const PROBE_TEXT = "残留探针" + "占".repeat(96);
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: "T5.2 残留探针任务" }),
        slowReply("主线已派出探针。（完t52）", 20, 4),
      ],
    };

    const d = await e2e.startDaemon({
      script,
      realSubagent: { engineScript: { replies: [PROBE_TEXT], chunkDelayMs: 4000, ignoreAbort: true } },
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    await e2e.send(page, "派探针");
    // 注：探针 SubAgent 存活期间其卡片自带 stream-cursor（running 态合法 UI），
    // 故不用 waitForTurnDone（它要求全页零 cursor）——只等主线文本 + 主线
    // composer 离开 streaming，即证 agent_spawn 工具已执行。子进程在场的断言
    // 由下方 ps 扫描承担。
    await e2e.waitForAssistantText(page, "（完t52）");
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/);

    // 进程面正控：真子进程在场（ps 特征命中——残留探测器抓得到活进程）
    let child = { pid: -1, command: "" };
    for (let i = 0; i < 100 && child.pid < 0; i++) {
      const hit = findResidueProcesses().find((p) => p.command.includes("--child-main"));
      if (hit) child = { pid: hit.pid, command: hit.command };
      else await sleep(100);
    }
    expect(child.pid, `SubAgent 子进程应存活（ps 命中）：${child.pid < 0 ? "未命中" : child.command}`).toBeGreaterThan(0);

    // 端口面正控：daemon 在场时 5333 bind 必失败（探测器抓得到端口占用）
    expect(await canBindPort(E2E_DAEMON_PORT)).toBe(false);

    // tmp 面正控：故意残留探针目录 → 残留清单必命中（断言红自证）
    const probe = mkdtempSync(path.join(tmpdir(), "helix-e2e-probe-"));
    try {
      expect(listE2eTmpResidue()).toContain(path.basename(probe));
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }

    // daemon SIGTERM 优雅停机 → 注入 runner 的子进程不在 daemon dispose 范围
    // （subagentLauncher undefined）→ ChildMain 孤儿化 → 兜底回收独立于 O-6
    await d.stop();
    expect(d.exited).toBe(true);
    const orphan = findResidueProcesses().filter((p) => p.command.includes("--child-main"));
    expect(orphan.length, `daemon 退出后 SubAgent 子进程应孤儿存活（ps）：${JSON.stringify(orphan)}`).toBeGreaterThan(0);

    // 兜底回收：SIGTERM（组）→ 3s 超时 SIGKILL（探针 ignoreAbort——走满升级路径）
    const unrecovered = await recoverResidueProcesses();
    writeEvidence(
      "teardown-recovery-ps",
      "txt",
      `SIGTERM 后孤儿：${JSON.stringify(orphan, null, 2)}\n兜底回收后残留：${JSON.stringify(unrecovered, null, 2)}\n回收后 ps 全量扫描：${JSON.stringify(findResidueProcesses(), null, 2)}\n`,
      "CL-4",
    );
    expect(unrecovered, `兜底回收后不应有残留进程：${JSON.stringify(unrecovered)}`).toEqual([]);
    expect(findResidueProcesses()).toEqual([]);
  });

  test("三面零残留（连跑两轮判据：tmp 基目录/进程/端口）", async () => {
    // 套件级断言：本轮（或上一轮连跑）任何 test 的 teardown 泄漏在此变红
    // T4.3：tmp 面从 helix-e2e-* 扩展为 helix-* 全前缀面（TR-TEST-6 外补判据）
    const tmpResidue = listHelixTmpResidue();
    const procResidue = findResidueProcesses();
    const portFree = await canBindPort(E2E_DAEMON_PORT);
    writeEvidence(
      "teardown-three-faces",
      "txt",
      [
        `① tmp 基目录残留（${tmpdir()} 下 helix-* 全前缀）：${JSON.stringify(tmpResidue)}`,
        `② 残留进程（launcher/--child-main 特征）：${JSON.stringify(procResidue, null, 2)}`,
        `③ 端口 ${E2E_DAEMON_PORT} 可 bind：${portFree}`,
      ].join("\n"),
      "CL-4",
    );
    expect(tmpResidue, "① tmp 基目录应为空（helix-* 全前缀零残留）").toEqual([]);
    expect(procResidue, "② 不应有 daemon/SubAgent 残留进程（teardown 三件套之二）").toEqual([]);
    expect(portFree, "③ 端口应可 bind（teardown 三件套之三）").toBe(true);
    await expect(waitForPortFree(E2E_DAEMON_PORT, 5000)).resolves.toBeUndefined();
  });
});

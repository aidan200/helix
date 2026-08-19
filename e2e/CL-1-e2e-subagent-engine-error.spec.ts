/**
 * T1.4 / F1.4 —— CL-1 SubAgent provider 错误剧本（真 daemon + 真子进程，E 层）。
 *
 * 补 SubAgent 链路 provider 错误流的 E 层覆盖（TR-TEST-3 mock 盲区）：
 * FakeEngineScript error 形态（逐字段 mirror 主线 launcher 错误剧本）驱动
 * 真子进程 → agentLoop 收口 stopReason=error → engine_error 连发 →
 * SchedulerService engine.error 领域事件（F1.1）→ ChildMain 兜底 closure
 * 摘要并入「（engine: <原因>）」（F1.2）→ agent.failed 透出。
 *
 * 两段断言缺一不闭环（test-design §七，F-6 boundary finding）：
 * ① 错误透出：agent.failed error 字段含 provider 原文（抽屉 crashed 行可见
 *    = T1.1 通道 + T1.2 摘要的联合可见面）；
 * ② failed 兜底收口：closure 摘要含「（engine: <原因>）」（抽屉 closure 尾卡
 *    + closure_records 持久化面可查）。
 * 附带 trace 数据面：domain_events 含该实例 engine.error 行（直查 SQLite，
 * T2.1 查询面未就绪——daemon 优雅停机 drain 后只读查询）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { reply, toolCall, type DaemonScript } from "./harness/daemon-script";

const BUN = process.env.HELIX_E2E_BUN ?? "bun";

const TASK = "provider 错误剧本验证任务";
/** provider 原文（与 CL-7 主线错误剧本同形态：429 限额）。 */
const ERROR_TEXT = "429: {\"code\":\"1308\",\"message\":\"已达到 5 小时的使用上限。\"}";
const ERROR_FRAGMENT = "已达到 5 小时的使用上限";

/** 通用前置：建 home+沙箱（fixture teardown 统一清理，本 spec 无旁路清理）。 */
function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl1-sa-err-"));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

interface TraceRow {
  readonly type: string;
  readonly agent_instance_id: string;
  readonly payload: string;
}
interface ClosureRow {
  readonly agent_id: string;
  readonly result: string;
  readonly summary: string;
}

/** daemon 停机 drain 后直查 SQLite 持久化面（bun:sqlite 只读；T2.1 查询面未就绪）。 */
function queryPersistence(dbPath: string): { events: TraceRow[]; closures: ClosureRow[] } {
  const script = `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
const events = db.query("SELECT type, agent_instance_id, payload FROM domain_events WHERE type IN ('engine.error','agent.failed') ORDER BY id").all();
const closures = db.query("SELECT agent_id, result, summary FROM closure_records ORDER BY id").all();
console.log(JSON.stringify({ events, closures }));
`;
  const out = execFileSync(BUN, ["-e", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out.trim().split("\n").at(-1)!) as { events: TraceRow[]; closures: ClosureRow[] };
}

test.describe("T1.4 CL-1 SubAgent provider 错误剧本（真子进程 + error 形态 FakeEngineScript）", () => {
  test("错误透出 + failed 兜底收口两段都发生 + trace 数据面 engine.error 落库", async ({ e2e, page }) => {
    test.setTimeout(150_000);
    const home = prepHome();
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: TASK }), // turn1：spawn 真子进程（error 剧本引擎）
        reply("主线已派出错误验证实例。（完S1）"), // turn1 续写
        reply("closure 注入自动轮收口。（完C）"), // closure 注入自动轮
      ],
    };

    const d = await e2e.startDaemon({
      script,
      home,
      realSubagent: { engineScript: { replies: [], error: { message: ERROR_TEXT } } },
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 派发：spawn → 主线续写收口（running 卡在场）───────────
    await e2e.send(page, "派出错误剧本 SubAgent");
    await e2e.waitForAssistantText(page, "（完S1）", 30_000);
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });

    // ── 段① 错误透出：agent.failed error 含 provider 原文 ──────
    // 终态卡 failed + 抽屉 crashed 生命周期行透出原文（error=兜底 summary，
    // 经 T1.2 摘要通道携带 engine 原因）
    await expect(page.locator(".sa-card.failed")).toHaveCount(1, { timeout: 30_000 });
    await page.locator(".sa-card.failed").click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    const crashedRow = drawer.locator('.ch-item[data-lc="crashed"]');
    await expect(crashedRow).toBeVisible({ timeout: 15_000 });
    await expect(crashedRow).toContainText(ERROR_FRAGMENT);
    await shotEvidence(page, "cl1-sa-engine-error-crashed", "CL-1");

    // ── 段② failed 兜底收口：closure 摘要含「（engine: <原因>）」──
    const closureCard = drawer.locator('.closure-card[data-kind="closure"]');
    await expect(closureCard).toHaveAttribute("data-status", "failed");
    await expect(closureCard.locator(".cl-summary")).toContainText("（engine:");
    await expect(closureCard.locator(".cl-summary")).toContainText(ERROR_FRAGMENT);

    // 主线注入（closure → SteerQueue → 自动轮消耗 e3）
    await expect(page.locator(".msg.assistant", { hasText: "（完C）" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".composer")).not.toHaveClass(/streaming/, { timeout: 15_000 });
    await shotEvidence(page, "cl1-sa-engine-error-closure", "CL-1");

    // ── 持久化面断言：优雅停机 drain 后直查 SQLite ────────────
    await d.stop(); // SIGTERM → drain 写队列（domain_events/closure_records 落盘完成）
    const { events, closures } = queryPersistence(path.join(home, "helix.db"));

    // 段② 持久化锚：closure_records 该实例 failed 行 summary 含 engine 原因 + 原文
    const closureRow = closures.find((c) => c.result === "failed" && c.agent_id.startsWith("agent-"));
    expect(closureRow, "closure_records 应含该实例 failed 收口行").toBeDefined();
    expect(closureRow!.summary).toContain("（engine:");
    expect(closureRow!.summary).toContain(ERROR_FRAGMENT);

    // trace 数据面（F1.1 锚 4）：domain_events 含该实例 engine.error 行，payload 仅原文
    const engineError = events.find((e) => e.type === "engine.error" && e.agent_instance_id.startsWith("agent-"));
    expect(engineError, "domain_events 应含该实例 engine.error 行").toBeDefined();
    expect(engineError!.payload).toContain(ERROR_FRAGMENT);

    // 段① 持久化锚（同一事件的领域面）：agent.failed payload error 含 provider 原文
    const agentFailed = events.find((e) => e.type === "agent.failed" && e.agent_instance_id.startsWith("agent-"));
    expect(agentFailed, "domain_events 应含该实例 agent.failed 行").toBeDefined();
    expect(agentFailed!.payload).toContain(ERROR_FRAGMENT);

    writeEvidence(
      "cl1-sa-engine-error",
      "txt",
      [
        "T1.4 CL-1 SubAgent provider 错误剧本（真子进程 + error 形态 FakeEngineScript）：PASS",
        `段① 错误透出: sa-card.failed + 抽屉 crashed 行含 provider 原文（${ERROR_FRAGMENT}）`,
        `段② 兜底收口: closure failed 尾卡 summary 含（engine: <原因>）+ closure_records 持久化行一致`,
        `trace 数据面: domain_events 该实例 engine.error 行 payload=${engineError!.payload}`,
        "链路: scriptedEngine error 单帧 → agentLoop stopReason=error → message_end + engine_error",
        "  → SchedulerService engine.error 领域事件（F1.1）→ 兜底 closure（engine: 原因）（F1.2）→ agent.failed",
      ].join("\n"),
      "CL-1",
    );
  });
});

/**
 * TC3.2 —— TP-CL7-2 / S2：CL-7 E 层五工具卡端到端（真 daemon + FakeLLM 工具剧本）。
 *
 * FakeLLM 只「发起」工具调用（脚本），「执行」是真的：CoreToolExecutor 在 tmp
 * 沙箱 cwd 真实执行 read/bash/write/edit/grep，结果回注 loop、续写基于真实
 * 结果（replyFromResult {last}）。工具卡主数据源 = tool.call.started /
 * tool.call.result 事件投影（T1.5 反馈 #6：不解析 Entry 文本）。
 *
 * 断言源：requirements §3.7 F(7).2 + review.md R-06/R-16 + SM-4（三态与折叠
 * 契约）+ test-design TP-CL7-2；bash error 卡断言真实 exit code。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { replyFromResult, toolCall, type DaemonScript } from "./harness/daemon-script";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const READ_MARKER = "HELIX-E2E-READ-42";
const BASH_MARKER = "HELIX-E2E-BASH-55";
const SLOW_MARKER = "HELIX-E2E-BASH-77";
const WRITE_MARKER = "HELIX-E2E-WRITE-88";
const EDIT_OLD = "EDIT-OLD-99";
const EDIT_NEW = "EDIT-NEW-100";
const GREP_MARKER = "HELIX-E2E-GREP-66";
const FAIL_CODE = 7;

const script: DaemonScript = {
  entries: [
    toolCall("read", { path: "note.txt" }),
    replyFromResult("read 的真实结果：{last}"),
    toolCall("bash", { command: `echo ${BASH_MARKER}` }),
    replyFromResult("bash 的真实输出：{last}"),
    toolCall("write", { path: "written-e2e.txt", content: WRITE_MARKER }),
    replyFromResult("write 完成：{last}"),
    toolCall("edit", { path: "edit-target.txt", oldText: EDIT_OLD, newText: EDIT_NEW }),
    replyFromResult("edit 完成：{last}"),
    toolCall("grep", { pattern: GREP_MARKER, path: "." }),
    replyFromResult("grep 命中：{last}"),
    // 慢命令：制造可观测的 running 窗口（三态断言之 running）
    toolCall("bash", { command: `sleep 1.2 && echo ${SLOW_MARKER}` }),
    replyFromResult("慢命令输出：{last}"),
    // 错误命令：bash exit≠0 → error 卡 + exit code
    toolCall("bash", { command: `exit ${FAIL_CODE}` }),
    replyFromResult("错误命令的真实结果：{last}"),
  ],
};

/** 预置沙箱：note.txt / edit-target.txt / grep 源文件（daemon 启动前就位）。 */
function prepSandbox(): { home: string; sandbox: string } {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-tools-"));
  const sandbox = path.join(home, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(path.join(sandbox, "note.txt"), `E 层工具夹具文件\n${READ_MARKER} 演示内容\n`, "utf8");
  writeFileSync(path.join(sandbox, "edit-target.txt"), `第一行 ${EDIT_OLD}\n第二行 保持不变\n`, "utf8");
  writeFileSync(path.join(sandbox, "grep-source.ts"), `export const a = "${GREP_MARKER}";\nexport const b = 2;\n`, "utf8");
  return { home, sandbox };
}

/** 等待并展开目标卡（按标志性文本锁定本轮新卡，避免点到已展开的旧卡）。 */
async function expandCard(page: import("@playwright/test").Page, marker: string, state = "done") {
  const card = page.locator(`.tool-card.${state}`, { hasText: marker }).last();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator(".t-head").click();
  await expect(card).toHaveClass(/open/);
  return card;
}

test.describe("TC3.2 CL-7 E 层五工具卡端到端（真 daemon + FakeLLM 工具剧本，S2）", () => {
  test("五工具真实执行：各一张卡 + 三态 + 展开 + bash error exit code + 磁盘副作用", async ({ e2e, page }) => {
    test.setTimeout(120_000);
    const { home, sandbox } = prepSandbox();
    await e2e.startDaemon({ script, home });

    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── read：卡出现 → done → 展开含真实文件内容 ───────────────
    await e2e.send(page, "读取 note.txt 告诉我内容");
    const readCard = await expandCard(page, "note.txt");
    await expect(readCard.locator(".t-name")).toHaveText("read");
    const readSections = readCard.locator(".t-section");
    await expect(readSections.nth(0).locator(".t-sec-label")).toHaveText("参数");
    await expect(readSections.nth(0).locator(".t-pre")).toContainText("note.txt");
    await expect(readSections.nth(1).locator(".t-sec-label")).toHaveText("结果");
    await expect(readSections.nth(1).locator(".t-pre")).toContainText(READ_MARKER); // 真实执行结果
    // 续写依赖真实结果（工具结果回注 loop）
    await e2e.waitForAssistantText(page, READ_MARKER);
    await shotEvidence(page, "e2e-tools-read-done");

    // ── bash：echo 输出回注 ────────────────────────────────────
    await e2e.send(page, "运行 echo 命令并复述输出");
    const bashCard = await expandCard(page, BASH_MARKER);
    await expect(bashCard.locator(".t-name")).toHaveText("bash");
    await expect(bashCard.locator(".t-section").nth(1).locator(".t-pre")).toContainText(BASH_MARKER);
    await e2e.waitForAssistantText(page, BASH_MARKER);

    // ── write：磁盘副作用（Node 侧核验） ───────────────────────
    await e2e.send(page, `把 ${WRITE_MARKER} 写入 written-e2e.txt`);
    await expect(page.locator(".tool-card.done", { hasText: "write" })).toBeVisible();
    expect(readFileSync(path.join(sandbox, "written-e2e.txt"), "utf8")).toBe(WRITE_MARKER); // 真实落盘
    await e2e.waitForAssistantText(page, "written-e2e.txt");

    // ── edit：磁盘替换生效（旧串消失/新串出现） ────────────────
    await e2e.send(page, "把 edit-target.txt 里的旧串替换成新串");
    await expect(page.locator(".tool-card.done", { hasText: "edit" })).toBeVisible();
    const edited = readFileSync(path.join(sandbox, "edit-target.txt"), "utf8");
    expect(edited).toContain(EDIT_NEW);
    expect(edited).not.toContain(EDIT_OLD);
    await e2e.waitForAssistantText(page, "edit 完成");

    // ── grep：真实命中行（path:行号: 内容，相对沙箱 cwd） ───────
    await e2e.send(page, "搜一下 GREP 标记在哪");
    const grepCard = await expandCard(page, GREP_MARKER);
    await expect(grepCard.locator(".t-name")).toHaveText("grep");
    await expect(grepCard.locator(".t-section").nth(1).locator(".t-pre")).toContainText(
      `grep-source.ts:1: export const a = "${GREP_MARKER}";`,
    );
    await e2e.waitForAssistantText(page, GREP_MARKER);

    // ── bash 慢命令：running 态可观测（accent 边框语义已在 F 层验证，
    //    此处断言 running 结构契约：执行中徽标 + spinner + 不可展开）───
    await e2e.send(page, "跑一个慢命令");
    const running = page.locator(".tool-card.running");
    await expect(running).toBeVisible({ timeout: 10_000 });
    await expect(running.locator(".t-name")).toHaveText("bash");
    await expect(running.locator(".t-state .lab")).toHaveText("执行中");
    await expect(running.locator(".t-spinner")).toBeVisible();
    await expect(running.locator(".t-body")).toHaveCount(0); // SM-4：running 不可展开
    await running.locator(".t-head").click();
    await expect(running.locator(".t-body")).toHaveCount(0);
    await shotEvidence(page, "e2e-tools-bash-running");

    // 收口为 done + 耗时徽标 + 真实输出
    const slowDone = page.locator(".tool-card.done", { hasText: "sleep" }).first();
    await expect(slowDone).toBeVisible({ timeout: 15_000 });
    await expect(slowDone.locator(".t-dur")).toContainText("s"); // durationMs ≥ 1.2s
    await slowDone.locator(".t-head").click();
    await expect(slowDone.locator(".t-section").nth(1).locator(".t-pre")).toContainText(SLOW_MARKER);
    await e2e.waitForAssistantText(page, SLOW_MARKER);

    // ── bash error：exit 7 → error 卡 + 「结果 · exit 7」 ───────
    await e2e.send(page, "跑一个必失败的命令");
    const errCard = page.locator(".tool-card.error");
    await expect(errCard).toBeVisible();
    await expect(errCard.locator(".t-state .lab")).toHaveText("失败");
    await errCard.locator(".t-head").click();
    const errSections = errCard.locator(".t-section");
    // 真实错误文案（pi bash）：Command exited with code 7 —— pre 为真实结果全文。
    // 徽标 exit code 由 extractExitCode 双文案兼容提取（回退修复 TS3-b：
    // /exited with code N/ 优先、/exit N/ 回退），与真实退出码一致。
    await expect(errSections.nth(1).locator(".t-sec-label")).toContainText("结果 · exit");
    expect(await errSections.nth(1).locator(".t-sec-label").textContent()).toBe(`结果 · exit ${FAIL_CODE}`);
    await expect(errSections.nth(1).locator(".t-pre")).toContainText(`Command exited with code ${FAIL_CODE}`);
    // 模型看到真实错误并续写（错误结果也回注）
    await e2e.waitForAssistantText(page, `Command exited with code ${FAIL_CODE}`);
    await shotEvidence(page, "e2e-tools-bash-error-exit7");

    // ── 收口：七张卡齐全（read/bash×3/write/edit/grep）+ 事件数据源 ──
    await expect(page.locator(".tool-card")).toHaveCount(7);
    const names = await page.locator(".tool-card .t-name").allTextContents();
    expect(new Set(names)).toEqual(new Set(["read", "bash", "write", "edit", "grep"]));
    await expect(page.locator(".tool-card.done")).toHaveCount(6);
    await expect(page.locator(".tool-card.error")).toHaveCount(1);
    await expect(page.locator(".tool-card.running")).toHaveCount(0);

    writeEvidence(
      "e2e-tools",
      "txt",
      [
        "TC3.2 CL-7 E 层五工具卡端到端（真 daemon + FakeLLM 工具剧本）",
        "read: done 卡展开含真实文件内容（" + READ_MARKER + "）+ 续写含真实结果",
        "bash(echo): done 卡结果含 " + BASH_MARKER,
        "write: 磁盘落盘核验 written-e2e.txt === " + WRITE_MARKER,
        "edit: 磁盘替换核验（旧串消失/新串出现）",
        "grep: 命中行 grep-source.ts:1（真实执行）",
        "bash(sleep 1.2): running 态结构契约（执行中徽标+spinner+不可展开）→ done + t-dur",
        `bash(exit ${FAIL_CODE}): error 卡；pre 真实结果「Command exited with code ${FAIL_CODE}」`,
        `  徽标「结果 · exit ${FAIL_CODE}」与真实退出码一致（extractExitCode 双文案兼容）`,
        "七卡齐全（read/bash×3/write/edit/grep）；done=6 error=1 running=0",
        "结果: PASS",
      ].join("\n"),
    );
  });
});

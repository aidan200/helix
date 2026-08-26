import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createGrepTool } from "../../src/adapters/driven/tools/grep/GrepTool";
import { probeRgVersion } from "../../src/adapters/driven/tools/grep/freeze-backend";

/**
 * T1.3 integration：运行期首败永久降级（AF-1 语义③）+ 可用性探针行为。
 *
 * 失败注入用契约等价的假 rg 脚本，走真实 spawn 链路（TR-TEST-3 末款）；
 * fixture 落 tmp（TR-TEST-4）；afterEach 清理（TR-TEST-6）。
 * 假 rg 超时脚本必须 `exec sleep`（被 spawn 进程即 sleeper，kill 即生效，
 * 无孙进程持有管道——T1.2 复用约束②）。
 *
 * 降级三要素（AF-1 v2 / brief 决策消解）：
 * ① 当轮结果正确返回（ts 重跑同一查询，不向 agent 抛错）；
 * ② warning 日志一次（只进日志面，结果形状/文案不变）；
 * ③ 翻转内存标识为 ts——后续调用零判断直走 ts（spawn 计数断言）。
 */

interface FacadeRun {
  readonly text: string;
  readonly isError: boolean;
}

describe("grep 门面首败永久降级（假 rg 注入，真 spawn 链路）", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** fixture + 门面执行环境（cwd 指向 tmp 仓库）。 */
  function setup(): { root: string; context: ExecutionToolContext } {
    dir = mkdtempSync(path.join(tmpdir(), "helix-degrade-"));
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "const marker = 'HELIX';\n");
    writeFileSync(path.join(dir, "b.md"), "# HELIX 手册\n");
    return { root: dir, context: { env: new NodeExecutionEnv({ cwd: dir }) } };
  }

  /** 假 rg：每次被 spawn 先向计数文件追加一行，再按 script 行为失败/挂起。 */
  function makeFakeRg(script: string): { rgPath: string; spawnCount: () => number } {
    const root = dir as string;
    const countFile = path.join(root, "spawn-count");
    const rgPath = path.join(root, "fake-rg");
    writeFileSync(rgPath, `#!/bin/sh\necho x >> "${countFile}"\n${script}\n`);
    chmodSync(rgPath, 0o755);
    return {
      rgPath,
      spawnCount: () => {
        try {
          return readFileSync(countFile, "utf8").split("\n").filter((l) => l === "x").length;
        } catch {
          return 0;
        }
      },
    };
  }

  async function runGrep(
    tool: ReturnType<typeof createGrepTool>,
    context: ExecutionToolContext,
    pattern = "HELIX",
  ): Promise<FacadeRun> {
    try {
      const result = await tool.execute(
        "tc-1",
        { pattern, path: "." },
        new AbortController().signal,
        undefined,
        context,
      );
      const text = result.content
        .map((b) => (b as { type: string; text?: string }).text ?? "")
        .join("\n");
      return { text, isError: false };
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  test("非零退出首败 → 降级三要素（当轮 ts 结果 + warning 一次 + 后续不再 spawn rg）", async () => {
    const { context } = setup();
    const { rgPath, spawnCount } = makeFakeRg("echo boom >&2\nexit 2");
    const warnings: string[] = [];
    const tool = createGrepTool({ rgPath, warn: (m) => warnings.push(m) });

    // 当轮：rg 首败，门面用 ts 重跑同一查询返回正确结果（不抛错）
    const first = await runGrep(tool, context);
    expect(first.isError).toBe(false);
    // ts 后端 readdir 发现序不契约化——排序后断言（parity 同口径）
    expect(first.text.split("\n").sort()).toEqual([
      "b.md:1: # HELIX 手册",
      "src/a.ts:1: const marker = 'HELIX';",
    ]);
    expect(spawnCount()).toBe(1); // rg 被 spawn 一次
    // warning 一次，含错误分类名
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("RgExecError");

    // 后续：内存标识已翻转 ts，零判断直走 ts（spawn 计数不再增长）
    const second = await runGrep(tool, context);
    expect(second.isError).toBe(false);
    expect(second.text).toBe(first.text); // 形状/文案完全一致（对 agent 无感）
    expect(spawnCount()).toBe(1); // 不再 spawn rg
    expect(warnings.length).toBe(1); // warning 只记一次

    // 第三次同样直走 ts
    await runGrep(tool, context);
    expect(spawnCount()).toBe(1);
  });

  test("超时首败（exec sleep 假 rg）→ 同样三要素（RgTimeoutError 分类）", async () => {
    const { context } = setup();
    const { rgPath, spawnCount } = makeFakeRg("exec sleep 30"); // exec：无孙进程持管道
    const warnings: string[] = [];
    // timeout 3000ms：高系统负载下 Bun.spawn 预热+脚本起跳可逼近 1.5s，
    // 过紧会在子进程脚本起跑前 kill（计数行未写入、超时分类失败）——3000ms
    // 仍远小于 sleep 30，超时分支语义不变（负载 flaky 修复，OI-grep-degrade-flaky）。
    const tool = createGrepTool({ rgPath, rgTimeoutMs: 3000, warn: (m) => warnings.push(m) });

    const first = await runGrep(tool, context);
    expect(first.isError).toBe(false);
    expect(first.text).toContain("src/a.ts:1: const marker = 'HELIX';");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("RgTimeoutError");

    const second = await runGrep(tool, context);
    expect(second.text).toBe(first.text);
    expect(spawnCount()).toBe(1);
  });

  test("非降级类错误不吞咽：空 pattern 的语义错误原样抛出（不翻转标识、不记 warning）", async () => {
    const { context } = setup();
    const { rgPath, spawnCount } = makeFakeRg("echo boom >&2\nexit 2");
    const warnings: string[] = [];
    const tool = createGrepTool({ rgPath, warn: (m) => warnings.push(m) });

    const bad = await runGrep(tool, context, ""); // 空 pattern：rg 后端 spawn 前抛语义错
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("pattern");
    expect(warnings.length).toBe(0);
    expect(spawnCount()).toBe(0); // spawn 前判定，零进程开销
  });

  test("定格 ts（无 rgPath）→ 每次调用零 spawn（直走内置后端）", async () => {
    const { context } = setup();
    const tool = createGrepTool({ warn: () => expect.unreachable("ts 定格不应有 warning") });
    const r = await runGrep(tool, context);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("src/a.ts:1: const marker = 'HELIX';");
  });
});

describe("probeRgVersion：可用性探针三要素（rg --version / 2s 超时 / 退出码 0）", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeScript(name: string, script: string): string {
    dir = dir ?? mkdtempSync(path.join(tmpdir(), "helix-probe-"));
    const p = path.join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${script}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test("退出码 0 → ok（真 --version 语义的最小模拟）", async () => {
    const good = makeScript("rg-good", "echo 'ripgrep 15.1.0'\nexit 0");
    expect(await probeRgVersion(good, 2000)).toEqual({ ok: true, reason: "" });
  });

  test("非零退出 → 不 ok（原因含退出码）", async () => {
    const bad = makeScript("rg-bad", "echo broken >&2\nexit 1");
    const r = await probeRgVersion(bad, 2000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("退出码 1");
  });

  test("超时 → kill 并判不 ok（exec sleep 无孙进程持管道）", async () => {
    const slow = makeScript("rg-slow", "exec sleep 30");
    const r = await probeRgVersion(slow, 300);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("超时");
  });

  test("路径不可执行/不存在 → 不 ok（不抛裸错，与 resolve-rg 保守语义同调）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-probe-missing-"));
    const r = await probeRgVersion(path.join(dir, "no-such-rg"), 2000);
    expect(r.ok).toBe(false);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

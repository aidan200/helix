import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { GrepMatch } from "../../src/adapters/driven/tools/grep/contract";
import { createTsBackend } from "../../src/adapters/driven/tools/grep/backends/ts-backend";
import {
  createRgBackend,
  RG_TIMEOUT_MS,
  RgExecError,
  RgTimeoutError,
} from "../../src/adapters/driven/tools/grep/backends/rg-backend";
import { resolveRgPath } from "../../src/adapters/driven/tools/grep/resolve-rg";

/**
 * T1.2 integration：真 rg 二进制对 tmp fixture 仓库的基础冒烟 + 错误分类。
 * - rg 路径经 T1.1 resolver 注入面获取（TR-TEST-3 末款：真实注入面，
 *   禁止白盒构造；TR-TEST-4：fixture 落 tmp，零触碰真实 home）。
 * - 五维 parity 契约全集属 T1.3；本文件只钉「基础检索排序后与 TS 后端
 *   逐项相等」+ RgExecError/RgTimeoutError 分类（test-design F3.2 口径：
 *   失败注入用契约等价的假 rg 脚本，走真实 spawn 链路）。
 * - TR-TEST-6：afterEach 清理 tmp fixture（连跑两轮零残留由目录唯一性保证）。
 */

/** (path, lineNumber) 字典序排序（TS 后端 readdir 发现序不契约化，对齐后断言）。 */
function sortMatches(matches: readonly GrepMatch[]): GrepMatch[] {
  return [...matches].sort((a, b) =>
    a.path === b.path ? a.lineNumber - b.lineNumber : a.path < b.path ? -1 : 1,
  );
}

describe("rg 后端 integration（真 rg + tmp fixture）", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** fixture：含 .gitignore 忽略文件 / 隐藏文件 / node_modules / .git 的最小语料。 */
  function makeFixture(): string {
    dir = mkdtempSync(path.join(tmpdir(), "helix-rg-it-"));
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    mkdirSync(path.join(dir, ".hidden"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "src", "alpha.ts"), "const marker = 'HELIX';\nconst other = 1;\n// HELIX 注释\n");
    writeFileSync(path.join(dir, "src", "beta.ts"), "import { HELIX } from './alpha';\n");
    writeFileSync(path.join(dir, "docs", "note.md"), "# HELIX 手册\n正文无关键词\n");
    writeFileSync(path.join(dir, ".hidden", "secret.txt"), "隐藏 HELIX 也命中\n");
    writeFileSync(path.join(dir, "ignored.txt"), "被 gitignore 的 HELIX\n");
    writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(dir, "node_modules", "dep", "x.js"), "// node_modules HELIX 不应命中\n");
    writeFileSync(path.join(dir, ".git", "config"), "# .git HELIX 不应命中\n");
    return dir;
  }

  /** 经 resolver PATH 级注入取真 rg（缺 rg 直接失败，不静默跳过）。 */
  function hostRgPath(): string {
    const resolution = resolveRgPath({ pathEnv: process.env.PATH, probe: existsSync });
    if (resolution.kind !== "resolved") {
      throw new Error(`测试前置失败：宿主机 PATH 无 rg（brew install ripgrep）；reasons=${resolution.reasons.join("；")}`);
    }
    return resolution.path;
  }

  test("基础冒烟：rg 后端与 TS 后端结果排序后逐项相等（含 gitignore 抵消/隐藏文件/具名目录跳过）", async () => {
    const root = makeFixture();
    const env = new NodeExecutionEnv({ cwd: root });
    const query = { pattern: "HELIX" };
    const tsMatches = await createTsBackend(env, ".").search(query);
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    expect(rg.name).toBe("rg");
    const rgMatches = await rg.search(query);
    // 归一判据生效的副作用断言：隐藏文件与被 gitignore 的文件都必须命中
    expect(rgMatches.some((m) => m.path === path.join(".hidden", "secret.txt"))).toBe(true);
    expect(rgMatches.some((m) => m.path === "ignored.txt")).toBe(true);
    expect(rgMatches.some((m) => m.path.includes("node_modules"))).toBe(false);
    expect(rgMatches.some((m) => m.path.startsWith(".git/"))).toBe(false);
    // rg 后端自身已排序；TS 后端排序后逐项相等
    expect(rgMatches).toEqual(sortMatches(tsMatches));
    expect(rgMatches.length).toBeGreaterThan(0);
  });

  test("glob 与 ignoreCase 经适配层归一后与 TS 后端一致", async () => {
    const root = makeFixture();
    const env = new NodeExecutionEnv({ cwd: root });
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    const ts = createTsBackend(env, ".");
    for (const query of [
      { pattern: "HELIX", glob: "*.ts" },
      { pattern: "helix", ignoreCase: true },
      { pattern: "helix", glob: "*.md", ignoreCase: true },
    ]) {
      expect(await rg.search(query)).toEqual(sortMatches(await ts.search(query)));
    }
  });

  test("零命中：rg exit 1 归一为空数组（与 TS 后端同形状，不抛错）", async () => {
    const root = makeFixture();
    const env = new NodeExecutionEnv({ cwd: root });
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    expect(await rg.search({ pattern: "NO_SUCH_TOKEN_42" })).toEqual([]);
    expect(await createTsBackend(env, ".").search({ pattern: "NO_SUCH_TOKEN_42" })).toEqual([]);
  });

  test("空 pattern：spawn 前抛错（与 TS 同语义）", async () => {
    const root = makeFixture();
    const env = new NodeExecutionEnv({ cwd: root });
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    await expect(rg.search({ pattern: "" })).rejects.toThrow(/pattern/);
  });

  test("非零退出（≥2）→ RgExecError（假 rg 脚本固定 exit 2，走真实 spawn）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-rg-bad-"));
    const fake = path.join(dir, "fake-rg");
    writeFileSync(fake, "#!/bin/sh\necho boom >&2\nexit 2\n");
    chmodSync(fake, 0o755);
    const env = new NodeExecutionEnv({ cwd: dir });
    const rg = createRgBackend(fake, env, ".", { timeoutMs: RG_TIMEOUT_MS });
    try {
      await rg.search({ pattern: "x" });
      expect.unreachable("应抛 RgExecError");
    } catch (e) {
      expect(e).toBeInstanceOf(RgExecError);
      expect((e as RgExecError).exitCode).toBe(2);
      expect((e as RgExecError).stderr).toContain("boom");
    }
  });

  test("rg 路径不可执行（不存在）→ RgExecError（非裸错）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-rg-missing-"));
    const env = new NodeExecutionEnv({ cwd: dir });
    const rg = createRgBackend(path.join(dir, "no-such-rg"), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    await expect(rg.search({ pattern: "x" })).rejects.toBeInstanceOf(RgExecError);
  });

  test("超时 → kill 子进程并抛 RgTimeoutError（假 rg sleep 兜底）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-rg-slow-"));
    const fake = path.join(dir, "slow-rg");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n"); // exec：被 spawn 进程即 sleeper，kill 即生效（无孙进程持有管道）
    chmodSync(fake, 0o755);
    const env = new NodeExecutionEnv({ cwd: dir });
    const rg = createRgBackend(fake, env, ".", { timeoutMs: 300 });
    await expect(rg.search({ pattern: "x" })).rejects.toBeInstanceOf(RgTimeoutError);
  });
});

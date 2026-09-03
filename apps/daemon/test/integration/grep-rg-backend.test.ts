import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createRgBackend,
  RG_TIMEOUT_MS,
  RgExecError,
  RgTimeoutError,
} from "../../src/adapters/driven/tools/grep/backends/rg-backend";

/**
 * T1.2 integration：真 rg 二进制对 tmp fixture 仓库的 golden 行为锚 +
 * 错误分类。rg 唯一化后本文件即后端行为的权威断言面（原 TS parity
 * 对比已随 TS 后端删除，契约面见 grep-contract.test.ts）。
 * - rg 路径经 Bun.which 取宿主机 rg（缺 rg 直接失败，不静默跳过）。
 * - TR-TEST-4：fixture 落 tmp，零触碰真实 home；TR-TEST-6：afterEach 清理。
 * - 失败注入用契约等价的假 rg 脚本，走真实 spawn 链路（TR-TEST-3 末款）。
 */

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

  /** 宿主机 rg 定位（缺 rg 直接失败，不静默跳过）。 */
  function hostRgPath(): string {
    const rg = Bun.which("rg");
    if (rg === null) {
      throw new Error("测试前置失败：宿主机无 rg（brew install ripgrep）");
    }
    return rg;
  }

  test("基础冒烟：归一五维全生效（hidden/gitignore 抵消/具名目录跳过/排序/./ 前缀剥除）", async () => {
    const root = makeFixture();
    const env = new NodeExecutionEnv({ cwd: root });
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    expect(rg.name).toBe("rg");
    expect(await rg.search({ pattern: "HELIX" })).toEqual([
      { path: path.join(".hidden", "secret.txt"), lineNumber: 1, line: "隐藏 HELIX 也命中" },
      { path: "docs/note.md", lineNumber: 1, line: "# HELIX 手册" },
      { path: "ignored.txt", lineNumber: 1, line: "被 gitignore 的 HELIX" },
      { path: "src/alpha.ts", lineNumber: 1, line: "const marker = 'HELIX';" },
      { path: "src/alpha.ts", lineNumber: 3, line: "// HELIX 注释" },
      { path: "src/beta.ts", lineNumber: 1, line: "import { HELIX } from './alpha';" },
    ]);
  });

  test("glob 过滤（* 跨目录单源语义）与 ignoreCase 归一", async () => {
    const root = makeFixture();
    const env = new NodeExecutionEnv({ cwd: root });
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    expect((await rg.search({ pattern: "HELIX", glob: "*.ts" })).map((m) => m.path)).toEqual([
      "src/alpha.ts",
      "src/alpha.ts",
      "src/beta.ts",
    ]);
    expect(await rg.search({ pattern: "helix" })).toEqual([]); // 默认区分大小写
    const ci = await rg.search({ pattern: "helix", ignoreCase: true });
    expect(ci.length).toBe(6); // 同冒烟六命中
    const ciMd = await rg.search({ pattern: "helix", glob: "*.md", ignoreCase: true });
    expect(ciMd).toEqual([{ path: "docs/note.md", lineNumber: 1, line: "# HELIX 手册" }]);
  });

  test("fixed-strings 语义：正则元字符按字面子串处理", async () => {
    const root = makeFixture();
    writeFileSync(path.join(dir as string, "src", "regex.ts"), "a.b 字面量\naxb 正则会误中\n");
    const env = new NodeExecutionEnv({ cwd: root });
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    expect(await rg.search({ pattern: "a.b" })).toEqual([
      { path: "src/regex.ts", lineNumber: 1, line: "a.b 字面量" },
    ]);
  });

  test("零命中：rg exit 1 归一为空数组（不抛错）", async () => {
    const root = makeFixture();
    const env = new NodeExecutionEnv({ cwd: root });
    const rg = createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS });
    expect(await rg.search({ pattern: "NO_SUCH_TOKEN_42" })).toEqual([]);
  });

  test("空 pattern：spawn 前抛错", async () => {
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

  test("超时 → kill 子进程并抛 RgTimeoutError（假 rg sleep 兜底；文案含收窄引导）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-rg-slow-"));
    const fake = path.join(dir, "slow-rg");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n"); // exec：被 spawn 进程即 sleeper，kill 即生效（无孙进程持有管道）
    chmodSync(fake, 0o755);
    const env = new NodeExecutionEnv({ cwd: dir });
    const rg = createRgBackend(fake, env, ".", { timeoutMs: 300 });
    try {
      await rg.search({ pattern: "x" });
      expect.unreachable("应抛 RgTimeoutError");
    } catch (e) {
      expect(e).toBeInstanceOf(RgTimeoutError);
      expect((e as Error).message).toContain("收窄 path 或加 glob");
    }
  });
});

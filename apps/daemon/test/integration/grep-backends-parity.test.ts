import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { GrepMatch, GrepQuery } from "../../src/adapters/driven/tools/grep/contract";
import { createTsBackend } from "../../src/adapters/driven/tools/grep/backends/ts-backend";
import {
  buildRgArgv,
  createRgBackend,
  RG_TIMEOUT_MS,
} from "../../src/adapters/driven/tools/grep/backends/rg-backend";
import { resolveRgPath } from "../../src/adapters/driven/tools/grep/resolve-rg";

/**
 * T1.3 parity 契约（F3.3，TR-TEST-4）：真两后端（内置 TS + 真 rg 二进制）
 * 对同一 tmp fixture 仓库跑同一查询，**排序后逐项相等**。五维断言：
 * ① gitignore 不生效（两后端都命中被 ignore 的文件）
 * ② 隐藏文件均可见
 * ③ glob 过滤一致
 * ④ ignoreCase 一致
 * ⑤ 上下文行——GrepQuery 无此参数面，断言 rg argv 不含 -C/-A/-B（参数构造守护）
 *
 * rg 来源经 resolver 注入面获取（TR-TEST-3 末款）；缺 rg 时前置用例失败并
 * 输出安装提示（brew install ripgrep），不静默跳过。afterEach 清理 tmp（TR-TEST-6）。
 */

/** (path, lineNumber) 字典序排序（TS 后端 readdir 发现序不契约化，对齐后断言）。 */
function sortMatches(matches: readonly GrepMatch[]): GrepMatch[] {
  return [...matches].sort((a, b) =>
    a.path === b.path ? a.lineNumber - b.lineNumber : a.path < b.path ? -1 : 1,
  );
}

describe("grep 双后端 parity 契约（真两后端 × tmp fixture，五维）", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * fixture：gitignore 忽略文件 / 隐藏目录与隐藏文件 / 多 glob 形态（ts/md/txt）/
   * 大小写混合语料（HELIX / helix / Helix）/ 具名跳过目录（node_modules/.git）。
   */
  function makeFixture(): string {
    dir = mkdtempSync(path.join(tmpdir(), "helix-parity-"));
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    mkdirSync(path.join(dir, ".hidden"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "src", "alpha.ts"), "const marker = 'HELIX';\nconst other = 1;\n// helix 注释\n");
    writeFileSync(path.join(dir, "src", "beta.ts"), "import { Helix } from './alpha';\n");
    writeFileSync(path.join(dir, "docs", "note.md"), "# HELIX 手册\n正文 helix 出现\n");
    writeFileSync(path.join(dir, ".hidden", "secret.txt"), "隐藏 helix 也命中\n");
    writeFileSync(path.join(dir, ".dotfile.txt"), "点文件 Helix 顶层\n");
    writeFileSync(path.join(dir, "ignored.ts"), "被 gitignore 的 HELIX\n");
    writeFileSync(path.join(dir, ".gitignore"), "ignored.ts\n");
    writeFileSync(path.join(dir, "node_modules", "dep", "x.js"), "// node_modules HELIX 不应命中\n");
    writeFileSync(path.join(dir, ".git", "config"), "# .git HELIX 不应命中\n");
    return dir;
  }

  /** 经 resolver PATH 级注入取真 rg（缺 rg 前置用例失败，不静默跳过）。 */
  function hostRgPath(): string {
    const resolution = resolveRgPath({ pathEnv: process.env.PATH, probe: existsSync });
    if (resolution.kind !== "resolved") {
      throw new Error(
        `前置失败：宿主机 PATH 无 rg，请先安装（brew install ripgrep）；reasons=${resolution.reasons.join("；")}`,
      );
    }
    return resolution.path;
  }

  /** 同一查询双后端各跑一次，排序后逐项相等（parity 核心断言）。 */
  async function expectParity(root: string, query: GrepQuery): Promise<{ ts: GrepMatch[]; rg: GrepMatch[] }> {
    const env = new NodeExecutionEnv({ cwd: root });
    const ts = sortMatches(await createTsBackend(env, ".").search(query));
    const rg = await createRgBackend(hostRgPath(), env, ".", { timeoutMs: RG_TIMEOUT_MS }).search(query);
    expect(rg).toEqual(ts);
    return { ts, rg };
  }

  test("前置：宿主机 rg 可用（缺 rg 在此失败并给安装提示，后续用例才有意义）", () => {
    expect(hostRgPath()).toContain("rg");
  });

  test("① gitignore 不生效：两后端都命中被 .gitignore 忽略的文件", async () => {
    const root = makeFixture();
    const { ts, rg } = await expectParity(root, { pattern: "HELIX" });
    for (const matches of [ts, rg]) {
      expect(matches.some((m) => m.path === "ignored.ts")).toBe(true);
    }
  });

  test("② 隐藏文件均可见：隐藏目录与顶层点文件两后端同命中", async () => {
    const root = makeFixture();
    const { ts, rg } = await expectParity(root, { pattern: "helix", ignoreCase: true });
    for (const matches of [ts, rg]) {
      expect(matches.some((m) => m.path === path.join(".hidden", "secret.txt"))).toBe(true);
      expect(matches.some((m) => m.path === ".dotfile.txt")).toBe(true);
      // 负断言：具名跳过目录两后端同不命中
      expect(matches.some((m) => m.path.includes("node_modules"))).toBe(false);
      expect(matches.some((m) => m.path.startsWith(".git/"))).toBe(false);
    }
  });

  test("③ glob 过滤一致：多 glob 形态（*.ts / *.md / 无 glob）逐项相等", async () => {
    const root = makeFixture();
    for (const query of [
      { pattern: "HELIX", glob: "*.ts" },
      { pattern: "helix", glob: "*.md", ignoreCase: true },
      { pattern: "HELIX" },
    ]) {
      const { ts, rg } = await expectParity(root, query);
      expect(rg.length).toBeGreaterThan(0);
      if (query.glob === "*.ts") {
        expect(rg.every((m) => m.path.endsWith(".ts"))).toBe(true);
      }
      expect(rg).toEqual(ts);
    }
  });

  test("④ ignoreCase 一致：大小写混合语料下开关两态逐项相等", async () => {
    const root = makeFixture();
    const sensitive = await expectParity(root, { pattern: "helix" });
    expect(sensitive.rg.length).toBeGreaterThan(0);
    const insensitive = await expectParity(root, { pattern: "helix", ignoreCase: true });
    // 语料设计保证两态命中数不同（HELIX/Helix/helix 三种形态都在）
    expect(insensitive.rg.length).toBeGreaterThan(sensitive.rg.length);
  });

  test("⑤ 上下文行参数守护：GrepQuery 无此参数面，rg argv 恒不含 -C/-A/-B", () => {
    const queries: GrepQuery[] = [
      { pattern: "x" },
      { pattern: "x", glob: "*.ts", ignoreCase: true },
      { pattern: "-C" }, // pattern 本身似 flag：经 -e 传入，不被吞成上下文开关
    ];
    for (const query of queries) {
      const argv = buildRgArgv(query, ".");
      // 排除 -e 的 pattern 值位（pattern 本身似 flag 时也只作 -e 的值出现）
      const flags = argv.filter((_t, i) => argv[i - 1] !== "-e");
      expect(flags).not.toContain("-C");
      expect(flags).not.toContain("-A");
      expect(flags).not.toContain("-B");
      // pattern "-C" 必须作为 -e 的值出现，而非独立 flag
      if (query.pattern === "-C") {
        expect(argv[argv.indexOf("-e") + 1]).toBe("-C");
      }
    }
  });
});

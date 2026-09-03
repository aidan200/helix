import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createGrepTool } from "../../src/adapters/driven/tools/grep/GrepTool";
import { RgExecError } from "../../src/adapters/driven/tools/grep/backends/rg-backend";

/**
 * grep 工具 golden fixture 契约测试（rg 唯一化后的语义基准锚）：
 * 固定目录树 × 契约六维，经**门面 execute 全链路**（真 rg 真 spawn）
 * 断言 agent 可见的最终输出形状与语义——历史该角色由「TS parity 对比」
 * 担任，TS 后端删除后契约不再有对照实现，改为 golden 文字锚定。
 *
 * 六维：①子串（fixed-strings，非正则）②gitignore 抵消 ③hidden 命中
 * ④node_modules/.git 跳过 ⑤glob 单源（* 跨目录）⑥零命中/空 pattern。
 * 输出契约：`path:行号: 行内容` 逐行 / `(no matches for "...")`。
 *
 * TR-TEST-4：fixture 落 tmp；TR-TEST-6：afterEach 清理。
 */

interface FacadeRun {
  readonly text: string;
  readonly isError: boolean;
}

describe("grep 工具 golden 契约（门面全链路，真 rg + tmp fixture）", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function setup(): { context: ExecutionToolContext } {
    dir = mkdtempSync(path.join(tmpdir(), "helix-contract-"));
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    mkdirSync(path.join(dir, ".hidden"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "const marker = 'HELIX';\n// HELIX 注释\n");
    writeFileSync(path.join(dir, "docs", "b.md"), "# HELIX 手册\n");
    writeFileSync(path.join(dir, ".hidden", "s.txt"), "隐藏 HELIX\n");
    writeFileSync(path.join(dir, "ignored.txt"), "gitignore HELIX\n");
    writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(dir, "node_modules", "dep", "x.js"), "// HELIX 不命中\n");
    writeFileSync(path.join(dir, ".git", "config"), "# HELIX 不命中\n");
    return { context: { env: new NodeExecutionEnv({ cwd: dir }) } };
  }

  function hostRgPath(): string {
    const rg = Bun.which("rg");
    if (rg === null) throw new Error("测试前置失败：宿主机无 rg（brew install ripgrep）");
    return rg;
  }

  async function runGrep(
    tool: ReturnType<typeof createGrepTool>,
    context: ExecutionToolContext,
    params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean },
  ): Promise<FacadeRun> {
    try {
      const result = await tool.execute(
        "tc-1",
        { path: ".", ...params },
        new AbortController().signal,
        undefined,
        context,
      );
      const text = result.content.map((b) => (b as { type: string; text?: string }).text ?? "").join("\n");
      return { text, isError: false };
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  test("①~④ 子串命中全集：输出 `path:行号: 行内容`，hidden/gitignore 命中，具名目录跳过", async () => {
    const { context } = setup();
    const tool = createGrepTool({ rgPath: hostRgPath() });
    const run = await runGrep(tool, context, { pattern: "HELIX" });
    expect(run.isError).toBe(false);
    expect(run.text).toBe(
      [
        `${path.join(".hidden", "s.txt")}:1: 隐藏 HELIX`,
        "docs/b.md:1: # HELIX 手册",
        "ignored.txt:1: gitignore HELIX",
        "src/a.ts:1: const marker = 'HELIX';",
        "src/a.ts:2: // HELIX 注释",
      ].join("\n"),
    );
  });

  test("① fixed-strings：正则元字符 pattern 按字面子串（不误中、不报错）", async () => {
    const { context } = setup();
    writeFileSync(path.join(dir as string, "src", "re.ts"), "a.b 字面\naxb 误中\n");
    const tool = createGrepTool({ rgPath: hostRgPath() });
    const run = await runGrep(tool, context, { pattern: "a.b" });
    expect(run.text).toBe("src/re.ts:1: a.b 字面");
  });

  test("⑤ glob 单源过滤（* 跨目录）；ignoreCase 开关", async () => {
    const { context } = setup();
    const tool = createGrepTool({ rgPath: hostRgPath() });
    const tsOnly = await runGrep(tool, context, { pattern: "HELIX", glob: "*.ts" });
    expect(tsOnly.text).toBe("src/a.ts:1: const marker = 'HELIX';\nsrc/a.ts:2: // HELIX 注释");
    const ci = await runGrep(tool, context, { pattern: "helix", ignoreCase: true });
    expect(ci.text.split("\n").length).toBe(5);
  });

  test("⑥ 零命中：`(no matches for \"...\")` 文案；空 pattern 抛语义错", async () => {
    const { context } = setup();
    const tool = createGrepTool({ rgPath: hostRgPath() });
    const none = await runGrep(tool, context, { pattern: "NO_SUCH_TOKEN_42" });
    expect(none.isError).toBe(false);
    expect(none.text).toBe('(no matches for "NO_SUCH_TOKEN_42")');
    const empty = await runGrep(tool, context, { pattern: "" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("pattern 不能为空");
  });

  test("运行期失败透传：rg 非零退出 → 错误原样上抛（无 TS 兜底可降级）", async () => {
    const { context } = setup();
    const fake = path.join(dir as string, "fake-rg");
    writeFileSync(fake, "#!/bin/sh\necho boom >&2\nexit 2\n");
    chmodSync(fake, 0o755);
    const tool = createGrepTool({ rgPath: fake });
    await expect(
      tool.execute("tc-2", { pattern: "x", path: "." }, undefined, undefined, context),
    ).rejects.toBeInstanceOf(RgExecError);
  });
});

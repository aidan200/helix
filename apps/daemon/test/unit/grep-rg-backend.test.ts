import { describe, expect, test } from "bun:test";
import {
  buildRgArgv,
  parseRgStdout,
} from "../../src/adapters/driven/tools/grep/backends/rg-backend";

/**
 * TP-CL-3/F3.1（U，T1.2）：rg 后端的两个纯函数面——argv 构造与 stdout 解析。
 * 本文件只 import 纯函数符号（不 spawn、不触 fs），同 grep-tool.test.ts 的
 * framework-free 口径。argv 断言是 AD-2 归一判据的机械守护：--fixed-strings /
 * --no-ignore / --hidden 恒在，glob 不进 argv（适配层单源过滤）。
 */

describe("buildRgArgv：归一判据的 argv 投影", () => {
  test("恒带 --fixed-strings/--no-ignore/--hidden/--line-number/--with-filename/--no-heading + SKIP_DIRS 排除", () => {
    const argv = buildRgArgv({ pattern: "HELIX" }, "src");
    expect(argv).toEqual([
      "--fixed-strings",
      "--no-ignore",
      "--hidden",
      "--line-number",
      "--with-filename",
      "--no-heading",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
      "-e",
      "HELIX",
      "--",
      "src",
    ]);
  });

  test("ignoreCase=true 时带 -i；缺省/false 不带", () => {
    expect(buildRgArgv({ pattern: "x", ignoreCase: true }, ".")).toContain("-i");
    expect(buildRgArgv({ pattern: "x" }, ".")).not.toContain("-i");
    expect(buildRgArgv({ pattern: "x", ignoreCase: false }, ".")).not.toContain("-i");
  });

  test("glob 不传给 rg（适配层用同一 globToRegExp 过滤，单源语义）", () => {
    const argv = buildRgArgv({ pattern: "x", glob: "*.ts" }, ".");
    expect(argv).not.toContain("*.ts");
    expect(argv.join(" ")).not.toContain("*.ts");
  });

  test("pattern 经 -e 传入（pattern 以 - 开头不被吞成 flag）；rootPath 经 -- 隔离", () => {
    const argv = buildRgArgv({ pattern: "-weird" }, "docs");
    expect(argv.at(-4)).toBe("-e");
    expect(argv.at(-3)).toBe("-weird");
    expect(argv.at(-2)).toBe("--");
    expect(argv.at(-1)).toBe("docs");
  });
});

describe("parseRgStdout：rg 输出 → GrepMatch[] 归一", () => {
  test("基本解析：path:行号:内容 逐行 → GrepMatch（1-based 行号为 number）", () => {
    const stdout = "src/a.ts:3:HELIX one\nsrc/a.ts:7:x HELIX y\ndocs/n.md:1:# HELIX\n";
    expect(parseRgStdout(stdout)).toEqual([
      { path: "docs/n.md", lineNumber: 1, line: "# HELIX" },
      { path: "src/a.ts", lineNumber: 3, line: "HELIX one" },
      { path: "src/a.ts", lineNumber: 7, line: "x HELIX y" },
    ]);
  });

  test("结果按 (path, lineNumber) 字典序排序（乱序输入归一为稳定序）", () => {
    const stdout = "b.ts:10:L\nb.ts:2:L\na.ts:9:L\n";
    expect(parseRgStdout(stdout).map((m) => `${m.path}:${m.lineNumber}`)).toEqual([
      "a.ts:9",
      "b.ts:2",
      "b.ts:10",
    ]);
  });

  test("边界：路径含冒号（非数字段）不误切；行内容含冒号原样保留", () => {
    const stdout = "dir:sub/f.ts:2:hel:ix 内容\n";
    expect(parseRgStdout(stdout)).toEqual([
      { path: "dir:sub/f.ts", lineNumber: 2, line: "hel:ix 内容" },
    ]);
  });

  test("边界：空内容行（行即命中整行为空串场景外）与空 pattern 行尾的尾换行不产幽灵行", () => {
    expect(parseRgStdout("a.ts:5:\n")).toEqual([{ path: "a.ts", lineNumber: 5, line: "" }]);
    expect(parseRgStdout("")).toEqual([]);
    expect(parseRgStdout("\n")).toEqual([]);
  });

  test("路径投影归一：rg 相对 rootPath 输出的 ./ 前缀剥除（与 TS relativeToCwd 同口径）", () => {
    const stdout = "./src/a.ts:1:X\n./b.ts:2:X\n";
    expect(parseRgStdout(stdout).map((m) => m.path)).toEqual(["b.ts", "src/a.ts"]);
  });

  test("glob 过滤在适配层生效（与 TS 同一 globToRegExp，* 跨目录）", () => {
    const stdout = "src/a.ts:1:X\ndocs/n.md:2:X\n";
    const matches = parseRgStdout(stdout, "*.md");
    expect(matches).toEqual([{ path: "docs/n.md", lineNumber: 2, line: "X" }]);
  });
});

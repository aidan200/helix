import { describe, expect, test } from "bun:test";
import {
  buildRgArgv,
  parseRgJson,
} from "../../src/adapters/driven/tools/grep/backends/rg-backend";

/**
 * TP-CL-3/F3.1（U，T1.2）：rg 后端的两个纯函数面——argv 构造与 --json 解析。
 * 本文件只 import 纯函数符号（不 spawn、不触 fs），同 grep-tool.test.ts 的
 * framework-free 口径。argv 断言是 AD-2 归一判据的机械守护：--fixed-strings /
 * --no-ignore / --hidden / --json 恒在，glob 不进 argv（适配层单源过滤）。
 */

describe("buildRgArgv：归一判据的 argv 投影", () => {
  test("恒带 --fixed-strings/--no-ignore/--hidden/--json + SKIP_DIRS 排除", () => {
    const argv = buildRgArgv({ pattern: "HELIX" }, "src");
    expect(argv).toEqual([
      "--fixed-strings",
      "--no-ignore",
      "--hidden",
      "--json",
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

/** 构造一行 rg --json 事件（测试夹具）。 */
function jsonLine(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

function matchEvent(path: string, line: string, lineNumber: number): unknown {
  return {
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${line}\n` },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [],
    },
  };
}

describe("parseRgJson：rg --json 事件流 → GrepMatch[] 归一", () => {
  test("基本解析：match 事件 → GrepMatch（1-based 行号为 number，行尾换行剥除）", () => {
    const stdout =
      jsonLine(matchEvent("src/a.ts", "HELIX one", 3)) +
      jsonLine(matchEvent("src/a.ts", "x HELIX y", 7)) +
      jsonLine(matchEvent("docs/n.md", "# HELIX", 1));
    expect(parseRgJson(stdout)).toEqual([
      { path: "docs/n.md", lineNumber: 1, line: "# HELIX" },
      { path: "src/a.ts", lineNumber: 3, line: "HELIX one" },
      { path: "src/a.ts", lineNumber: 7, line: "x HELIX y" },
    ]);
  });

  test("结果按 (path, lineNumber) 字典序排序（乱序输入归一为稳定序）", () => {
    const stdout =
      jsonLine(matchEvent("b.ts", "L", 10)) +
      jsonLine(matchEvent("b.ts", "L", 2)) +
      jsonLine(matchEvent("a.ts", "L", 9));
    expect(parseRgJson(stdout).map((m) => `${m.path}:${m.lineNumber}`)).toEqual([
      "a.ts:9",
      "b.ts:2",
      "b.ts:10",
    ]);
  });

  test("非 match 事件（begin/end/summary）全部忽略", () => {
    const stdout =
      jsonLine({ type: "begin", data: { path: { text: "a.ts" } } }) +
      jsonLine(matchEvent("a.ts", "X", 5)) +
      jsonLine({ type: "end", data: { path: { text: "a.ts" }, binary_offset: null, stats: {} } }) +
      jsonLine({ type: "summary", data: { elapsed_total: {}, stats: {} } });
    expect(parseRgJson(stdout)).toEqual([{ path: "a.ts", lineNumber: 5, line: "X" }]);
  });

  test("路径/行内容含冒号、Windows 盘符路径：结构化字段免切分，原样保留", () => {
    const stdout =
      jsonLine(matchEvent("dir:sub/f.ts", "hel:ix 内容", 2)) +
      jsonLine(matchEvent("C:\\src\\a.ts", "win HELIX", 42));
    expect(parseRgJson(stdout)).toEqual([
      { path: "C:\\src\\a.ts", lineNumber: 42, line: "win HELIX" },
      { path: "dir:sub/f.ts", lineNumber: 2, line: "hel:ix 内容" },
    ]);
  });

  test("CRLF 行终止符剥除；空行内容原样为空串", () => {
    const stdout = jsonLine({
      type: "match",
      data: { path: { text: "a.ts" }, lines: { text: "crlf X\r\n" }, line_number: 3 },
    });
    expect(parseRgJson(stdout)).toEqual([{ path: "a.ts", lineNumber: 3, line: "crlf X" }]);
  });

  test("边界：空输入与解析失败行不产幽灵命中", () => {
    expect(parseRgJson("")).toEqual([]);
    expect(parseRgJson("\n")).toEqual([]);
    expect(parseRgJson("not json at all\n")).toEqual([]);
  });

  test("非 UTF-8（bytes 形态）path/lines 跳过——对齐 TS 解码失败跳过语义", () => {
    const stdout =
      jsonLine({
        type: "match",
        data: { path: { bytes: "AAE=" }, lines: { text: "X\n" }, line_number: 1 },
      }) +
      jsonLine({
        type: "match",
        data: { path: { text: "a.ts" }, lines: { bytes: "AAE=" }, line_number: 2 },
      }) +
      jsonLine(matchEvent("b.ts", "Y", 3));
    expect(parseRgJson(stdout)).toEqual([{ path: "b.ts", lineNumber: 3, line: "Y" }]);
  });

  test("路径投影归一：rg 相对 rootPath 输出的 ./ 前缀剥除（与 TS relativeToCwd 同口径）", () => {
    const stdout = jsonLine(matchEvent("./src/a.ts", "X", 1)) + jsonLine(matchEvent("./b.ts", "X", 2));
    expect(parseRgJson(stdout).map((m) => m.path)).toEqual(["b.ts", "src/a.ts"]);
  });

  test("glob 过滤在适配层生效（与 TS 同一 globToRegExp，* 跨目录）", () => {
    const stdout = jsonLine(matchEvent("src/a.ts", "X", 1)) + jsonLine(matchEvent("docs/n.md", "X", 2));
    const matches = parseRgJson(stdout, "*.md");
    expect(matches).toEqual([{ path: "docs/n.md", lineNumber: 2, line: "X" }]);
  });
});

import { describe, expect, test } from "bun:test";
import { globToRegExp, matchFiles } from "../../src/adapters/driven/tools/GrepTool";

/**
 * TP-CL5-2（U）：grep 匹配核心纯函数——输入内存数据（文件清单 + 查询），
 * 输出命中行列表。本文件**只 import 纯函数符号**（不触 fs/node API、
 * 不实例化工具），即 test-design「framework-free 可单测」的机械证明。
 * 四情形：多命中 / 零命中 / 路径过滤（glob）/ 大小写开关。
 */

/** 内存 fixture：三个文件、若干行（行号即数组序 +1）。 */
const FIXTURE = [
  { path: "src/alpha.ts", lines: ["const marker = 'HELIX';", "const other = 1;", "// HELIX 注释"] },
  { path: "src/beta.ts", lines: ["import { HELIX } from './alpha';", "export const x = 2;"] },
  { path: "docs/note.md", lines: ["# HELIX 手册", "正文无关键词"] },
  { path: "root.txt", lines: ["顶层一行 HELIX"] },
];

describe("TP-CL5-2：grep 纯函数四情形", () => {
  test("① 多命中：跨文件跨行收集所有命中（path + 1-based 行号 + 行文本）", () => {
    const matches = matchFiles(FIXTURE, { pattern: "HELIX" });
    expect(matches).toEqual([
      { path: "src/alpha.ts", lineNumber: 1, line: "const marker = 'HELIX';" },
      { path: "src/alpha.ts", lineNumber: 3, line: "// HELIX 注释" },
      { path: "src/beta.ts", lineNumber: 1, line: "import { HELIX } from './alpha';" },
      { path: "docs/note.md", lineNumber: 1, line: "# HELIX 手册" },
      { path: "root.txt", lineNumber: 1, line: "顶层一行 HELIX" },
    ]);
  });

  test("② 零命中：返回空数组（不抛错）", () => {
    expect(matchFiles(FIXTURE, { pattern: "NO_SUCH_TOKEN_42" })).toEqual([]);
  });

  test("③ 路径过滤：glob 只保留匹配文件（* 可跨目录）", () => {
    const matches = matchFiles(FIXTURE, { pattern: "HELIX", glob: "*.md" });
    expect(matches.map((m) => m.path)).toEqual(["docs/note.md"]);
    const tsOnly = matchFiles(FIXTURE, { pattern: "HELIX", glob: "*.ts" });
    expect(tsOnly.map((m) => m.path)).toEqual(["src/alpha.ts", "src/alpha.ts", "src/beta.ts"]); // alpha 两处命中都保留
    expect([...new Set(tsOnly.map((m) => m.path))]).toEqual(["src/alpha.ts", "src/beta.ts"]);
  });

  test("④ 大小写：默认区分；ignoreCase 打开后大小写不敏感", () => {
    expect(matchFiles(FIXTURE, { pattern: "helix" })).toEqual([]); // 区分：全小写不命中
    const ci = matchFiles(FIXTURE, { pattern: "helix", ignoreCase: true });
    expect(ci.length).toBe(5);
    expect(ci[0]).toEqual({ path: "src/alpha.ts", lineNumber: 1, line: "const marker = 'HELIX';" });
  });

  test("边界：空 pattern 拒绝（fail-fast，避免「全命中」误用）", () => {
    expect(() => matchFiles(FIXTURE, { pattern: "" })).toThrow(/pattern/);
  });
});

describe("globToRegExp（路径过滤的实现核）", () => {
  test("* 跨目录（grep --include 语义）、? 单字符、其余字面量转义", () => {
    expect(globToRegExp("*.ts").test("src/alpha.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("root.txt")).toBe(false);
    expect(globToRegExp("a?c.ts").test("abc.ts")).toBe(true);
    expect(globToRegExp("a?c.ts").test("ac.ts")).toBe(false);
    expect(globToRegExp("v1.0.txt").test("v1x0.txt")).toBe(false); // . 被转义为字面量
    expect(globToRegExp("v1.0.txt").test("v1.0.txt")).toBe(true);
  });
});

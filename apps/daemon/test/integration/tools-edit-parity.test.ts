import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEditTool as createPiEditTool,
  createWriteTool as createPiWriteTool,
  NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { createEditTool } from "../../src/adapters/driven/tools/edit/EditTool";
import { createReadTool } from "../../src/adapters/driven/tools/read/ReadTool";
import { createEditLinesTool } from "../../src/adapters/driven/tools/edit-lines/EditLinesTool";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * T3.1 自写 edit / read / edit-lines 三工具（F1.4，AD-12 方案 C + AF-1 复制收口）。
 *
 * oracle：pi createEditTool（/node 子入口 import，仅限测试文件——AF-1 平权
 * 护栏口径）。同 (content, oldText, newText) 输入集跑双工具，断言成功判定、
 * 错误类别、输出形态等价（test-design §2.1 F1.4 + §六 R-2）。
 *
 * 覆盖：①平权对照（成功/引号风格失配/重复/未匹配/多项单项失配/重叠边角）；
 * ②失败现场（最近似区段实际内容+行号——失败即 read，CL-1.A7）；
 * ③三级推荐管线逐级命中（CL-1.A8）；④read 行号输出 ↔ edit ③级前缀剥离互防御；
 * ⑤edit-lines expectedText 校验（CL-1.A9）；⑥F-16 口径失败样本集回放统计（R-2）；
 * ⑦同名覆盖注册（CL-1.A12，write/bash 保留 pi）；⑧VENDORED 纪律（hash+零 pi import）；
 * ⑨notifyWrite（T2.2 契约签名）与 onEditApplied（T3.2 挂点）注入面。
 */

let dir: string | undefined;
let env: NodeExecutionEnv | undefined;

function makeEnv(): { dir: string; env: NodeExecutionEnv } {
  dir = mkdtempSync(path.join(tmpdir(), "helix-edit-parity-"));
  env = new NodeExecutionEnv({ cwd: dir });
  return { dir, env };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  env = undefined;
});

type RunResult =
  | { ok: true; text: string; details: any }
  | { ok: false; error: string };

async function run(
  tool: AgentHarnessTool<ExecutionToolContext, any, any>,
  args: unknown,
  e: NodeExecutionEnv,
): Promise<RunResult> {
  try {
    const result = await tool.execute("tc-1", args as never, undefined, undefined, { env: e });
    return {
      ok: true,
      text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n"),
      details: (result as any).details,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 平权用例：同一输入集，双工具各写一份同名同内容文件后执行。 */
interface ParityCase {
  name: string;
  content: string;
  edits: Array<{ oldText: string; newText: string }>;
  expectOk: boolean;
  /** 失败类别标记（双工具错误消息都应包含）。 */
  category?: string;
  /** 该类别下自写错误 = pi 错误原样透传（byte 级相等）。 */
  exactErrorMessage?: boolean;
}

const PARITY_CASES: ParityCase[] = [
  { name: "success-single", content: "alpha\nbeta\ngamma\n", edits: [{ oldText: "beta", newText: "BETA" }], expectOk: true },
  {
    name: "success-multi",
    content: "one\ntwo\nthree\nfour\n",
    edits: [
      { oldText: "one", newText: "1" },
      { oldText: "three\nfour", newText: "3\n4" },
    ],
    expectOk: true,
  },
  {
    // pi 内核 fuzzy：智能引号（U+2019）↔ ASCII——内核层已吃下，双工具都成功
    name: "success-smart-quote-fuzzy",
    content: "const s = \u201Chello\u201D;\n",
    edits: [{ oldText: 'const s = "hello";', newText: "const s = 'hi';" }],
    expectOk: true,
  },
  { name: "success-crlf", content: "a\r\nb\r\nc\r\n", edits: [{ oldText: "b", newText: "B" }], expectOk: true },
  { name: "success-bom", content: "\uFEFFa\nb\n", edits: [{ oldText: "b", newText: "c" }], expectOk: true },
  {
    // ASCII 引号风格互换——内核不做该归一（①级管线的目标场景）
    name: "fail-quote-style",
    content: "const greeting = 'hello';\n",
    edits: [{ oldText: 'const greeting = "hello";', newText: "const greeting = 'hi';" }],
    expectOk: false,
    category: "Could not find",
  },
  {
    name: "fail-not-found",
    content: "alpha\nbeta\n",
    edits: [{ oldText: "nonexistent", newText: "x" }],
    expectOk: false,
    category: "Could not find",
  },
  {
    name: "fail-duplicate",
    content: "dup\nmiddle\ndup\n",
    edits: [{ oldText: "dup", newText: "x" }],
    expectOk: false,
    category: "occurrences of the text",
    exactErrorMessage: true,
  },
  {
    name: "fail-multi-edit-item",
    content: "keep\nother\n",
    edits: [
      { oldText: "keep", newText: "k" },
      { oldText: "missing", newText: "m" },
    ],
    expectOk: false,
    category: "Could not find edits[1]",
  },
  {
    name: "fail-overlap",
    content: "hello world foo\n",
    edits: [
      { oldText: "hello world", newText: "A" },
      { oldText: "world foo", newText: "B" },
    ],
    expectOk: false,
    category: "overlap",
    exactErrorMessage: true,
  },
  {
    name: "fail-empty-oldtext",
    content: "alpha\n",
    edits: [{ oldText: "", newText: "x" }],
    expectOk: false,
    category: "must not be empty",
    exactErrorMessage: true,
  },
  {
    name: "fail-no-change",
    content: "alpha\n",
    edits: [{ oldText: "alpha", newText: "alpha" }],
    expectOk: false,
    category: "No changes made",
    exactErrorMessage: true,
  },
];

describe("① 自写 edit 与 pi createEditTool 平权对照（AF-1 行为 oracle）", () => {
  test.each(PARITY_CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const { dir: d, env: e } = makeEnv();
    const piFile = `${c.name}-pi.txt`;
    const selfFile = `${c.name}-self.txt`;
    writeFileSync(path.join(d, piFile), c.content);
    writeFileSync(path.join(d, selfFile), c.content);

    const pi = await run(createPiEditTool(), { path: piFile, edits: c.edits }, e);
    const self = await run(createEditTool(), { path: selfFile, edits: c.edits }, e);

    // 成功判定等价
    expect(self.ok, `self.ok（self error: ${self.ok ? "" : self.error}）`).toBe(pi.ok);
    expect(self.ok).toBe(c.expectOk);

    if (pi.ok && self.ok) {
      // 输出形态等价：正文 + diff + patch
      expect(self.text.replaceAll(selfFile, "<file>")).toBe(pi.text.replaceAll(piFile, "<file>"));
      expect(self.details?.diff).toBe(pi.details?.diff);
      expect(self.details?.patch?.replaceAll(selfFile, "<file>")).toBe(pi.details?.patch?.replaceAll(piFile, "<file>"));
      expect(self.details?.firstChangedLine).toBe(pi.details?.firstChangedLine);
      // 落盘内容等价
      expect(readFileSync(path.join(d, selfFile), "utf8")).toBe(readFileSync(path.join(d, piFile), "utf8"));
    } else if (!pi.ok && !self.ok) {
      // 错误类别等价
      expect(self.error).toContain(c.category!);
      expect(pi.error).toContain(c.category!);
      if (c.exactErrorMessage) {
        expect(self.error.replaceAll(selfFile, "<file>")).toBe(pi.error.replaceAll(piFile, "<file>"));
      } else {
        // not-found 类：自写错误 = pi 错误原文 + 现场与建议附录（前缀保持）
        expect(self.error.startsWith(pi.error.replace(piFile, selfFile))).toBe(true);
      }
    }
  });
});

describe("② 失败现场：最近似区段实际内容+行号（CL-1.A7，失败即 read）", () => {
  test("文本漂移失配 → 错误含最近似区段实际内容与行号", async () => {
    const { dir: d, env: e } = makeEnv();
    const file = "scene.ts";
    writeFileSync(
      path.join(d, file),
      ["import x from 'x';", "", "export function calc(input: number) {", "  const answer = 41;", "  return answer + 1;", "}", ""].join("\n"),
    );
    const r = await run(
      createEditTool(),
      { path: file, edits: [{ oldText: "  const answer = 42;\n  return answer + 1;", newText: "  const answer = 43;\n  return answer + 2;" }] },
      e,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Could not find the exact text");
      expect(r.error).toContain("最近似现场");
      // 实际内容（41 不是 42）+ 行号（第 4 行）
      expect(r.error).toContain("const answer = 41;");
      expect(r.error).toMatch(/4\t.*const answer = 41;/);
      // 失败即 read：现场行带 cat -n 风格行号前缀
      expect(r.error).toMatch(/^\s+\d+\t/m);
    }
  });
});

describe("③ 失败三级推荐管线逐级命中（CL-1.A8，按序三建议）", () => {
  test("①级：引号风格失配 → 引号归一化重匹配命中并按序输出三建议", async () => {
    const { dir: d, env: e } = makeEnv();
    writeFileSync(path.join(d, "q.ts"), "const a = 'one';\nconst b = \"two\";\nconst c = `three`;\n");
    const r = await run(
      createEditTool(),
      { path: "q.ts", edits: [{ oldText: 'const b = \'two\';', newText: "const b = 2;" }] },
      e,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 按序三建议（① < ② < ③）
      const i1 = r.error.indexOf("① 引号归一化重匹配：");
      const i2 = r.error.indexOf("② 行锚重匹配：");
      const i3 = r.error.indexOf("③ 滑窗相似度+行号前缀剥离：");
      expect(i1).toBeGreaterThanOrEqual(0);
      expect(i2).toBeGreaterThan(i1);
      expect(i3).toBeGreaterThan(i2);
      // ①级命中：定位到 L2（现场是 "two"，oldText 写了 'two'）
      expect(r.error).toMatch(/① 引号归一化重匹配：命中 L2/);
      expect(r.error).toContain('const b = "two";');
    }
  });

  test("②级：首行精确锚 + 行段漂移 → 行锚重匹配命中", async () => {
    const { dir: d, env: e } = makeEnv();
    writeFileSync(
      path.join(d, "anchor.ts"),
      ["function compute(input: number) {", "  const doubled = input * 2;", "  return doubled + 1;", "}", ""].join("\n"),
    );
    const r = await run(
      createEditTool(),
      {
        path: "anchor.ts",
        edits: [
          { oldText: "function compute(input: number) {\n  const doubled = input * 3;\n  return doubled + 1;\n}", newText: "…" },
        ],
      },
      e,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/② 行锚重匹配：锚行命中 L1/);
      expect(r.error).toContain("const doubled = input * 2;");
      // 现场行号可直接转 edit-lines
      expect(r.error).toContain("startLine=1");
    }
  });

  test("③级：oldText 带 read 行号前缀 → 前缀剥离滑窗命中（①②不命中）", async () => {
    const { dir: d, env: e } = makeEnv();
    writeFileSync(path.join(d, "p.txt"), "alpha line\nbeta line\ngamma line\n");
    // read 输出形态（%6d\t）整段复制为 oldText——③级的目标场景
    const prefixed = "     1\talpha line\n     2\tbeta line";
    const r = await run(
      createEditTool(),
      { path: "p.txt", edits: [{ oldText: prefixed, newText: "replaced" }] },
      e,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/① 引号归一化重匹配：未命中/);
      expect(r.error).toMatch(/② 行锚重匹配：未命中/);
      expect(r.error).toMatch(/③ 滑窗相似度\+行号前缀剥离：最近似 L1-L2/);
    }
  });
});

describe("④ read 行号输出 ↔ edit ③级前缀剥离互防御", () => {
  test("read 输出 %6d\\t 行号；其内容作 oldText 被 ③级吃下；剥离后重试成功", async () => {
    const { dir: d, env: e } = makeEnv();
    writeFileSync(path.join(d, "defense.txt"), ["first", "second", "third", "fourth"].join("\n") + "\n");

    const read = await run(createReadTool(), { path: "defense.txt" }, e);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // 行号输出形态：每行 `%6d\t`
    const lines = read.text.split("\n");
    expect(lines.length).toBe(4);
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i]).toBe(`${String(i + 1).padStart(6, " ")}\t${["first", "second", "third", "fourth"][i]}`);
    }

    // 整段 read 输出直接作 oldText → 失败，但 ③级剥离后命中现场
    const fail = await run(
      createEditTool(),
      { path: "defense.txt", edits: [{ oldText: lines.slice(1, 3).join("\n"), newText: "SECOND\nTHIRD" }] },
      e,
    );
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.error).toMatch(/③ 滑窗相似度\+行号前缀剥离：最近似 L2-L3/);
      // 现场内容可直接复制重写 oldText（被动链闭环）
      expect(fail.error).toContain("second");
    }

    // 剥离前缀（③级建议的出路）→ 成功
    const stripped = lines.slice(1, 3).map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
    const retry = await run(
      createEditTool(),
      { path: "defense.txt", edits: [{ oldText: stripped, newText: "SECOND\nTHIRD" }] },
      e,
    );
    expect(retry.ok).toBe(true);
    expect(readFileSync(path.join(d, "defense.txt"), "utf8")).toBe("first\nSECOND\nTHIRD\nfourth\n");
  });

  test("read offset/limit 与续读提示；offset 越界报错", async () => {
    const { dir: d, env: e } = makeEnv();
    writeFileSync(path.join(d, "long.txt"), Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
    const part = await run(createReadTool(), { path: "long.txt", offset: 3, limit: 4 }, e);
    expect(part.ok).toBe(true);
    if (part.ok) {
      expect(part.text).toContain(`     3\tline-3`);
      expect(part.text).toContain(`     6\tline-6`);
      expect(part.text).not.toContain(`line-7\n`);
      expect(part.text).toContain("Use offset=7");
    }
    const over = await run(createReadTool(), { path: "long.txt", offset: 99 }, e);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("beyond end of file");
  });

  test("read 截断上限：2000 行预算 + 续读指针", async () => {
    const { dir: d, env: e } = makeEnv();
    writeFileSync(path.join(d, "big.txt"), Array.from({ length: 3000 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const r = await run(createReadTool(), { path: "big.txt" }, e);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("  2000\tl2000");
      expect(r.text).not.toContain("l2001\n");
      expect(r.text).toContain("Use offset=2001");
    }
  });
});

describe("⑤ edit-lines：expectedText 全等校验（CL-1.A9）", () => {
  test("失配 → 拒绝落盘 + 失败含现场（行段实际内容+行号）", async () => {
    const { dir: d, env: e } = makeEnv();
    const file = "lines.ts";
    const content = ["aaa", "bbb", "ccc", "ddd"].join("\n") + "\n";
    writeFileSync(path.join(d, file), content);
    const r = await run(
      createEditLinesTool(),
      { file, startLine: 2, endLine: 3, expectedText: "bbb\nXXX", newText: "replaced" },
      e,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("expectedText");
      // 现场：L2-L3 实际内容（ccc 而非 XXX）
      expect(r.error).toMatch(/2\tbbb/);
      expect(r.error).toMatch(/3\tccc/);
    }
    // 文件零变化
    expect(readFileSync(path.join(d, file), "utf8")).toBe(content);
  });

  test("匹配 → 替换成功（多行 newText、行数可变、尾换行保持）", async () => {
    const { dir: d, env: e } = makeEnv();
    const file = "lines2.txt";
    writeFileSync(path.join(d, file), ["aaa", "bbb", "ccc", "ddd"].join("\n") + "\n");
    const r = await run(
      createEditLinesTool(),
      { file, startLine: 2, endLine: 3, expectedText: "bbb\nccc", newText: "B1\nB2\nB3" },
      e,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("Successfully replaced lines 2-3");
      expect(r.text).toContain(file);
      expect(r.details?.diff).toContain("+3 B2");
    }
    expect(readFileSync(path.join(d, file), "utf8")).toBe(["aaa", "B1", "B2", "B3", "ddd"].join("\n") + "\n");
  });

  test("行界与参数校验：startLine<1 / endLine 越界 / start>end → 拒绝且文件不变", async () => {
    const { dir: d, env: e } = makeEnv();
    const file = "lines3.txt";
    const content = "x\ny\n";
    writeFileSync(path.join(d, file), content);
    for (const args of [
      { file, startLine: 0, endLine: 1, expectedText: "x", newText: "z" },
      { file, startLine: 1, endLine: 9, expectedText: "x", newText: "z" },
      { file, startLine: 2, endLine: 1, expectedText: "x", newText: "z" },
    ]) {
      const r = await run(createEditLinesTool(), args, e);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(readFileSync(path.join(d, file), "utf8")).toBe(content);
    }
  });

  test("CRLF 文件：校验与替换按 LF 归一比对，落盘保持 CRLF", async () => {
    const { dir: d, env: e } = makeEnv();
    const file = "crlf.txt";
    writeFileSync(path.join(d, file), "aaa\r\nbbb\r\nccc\r\n");
    const r = await run(
      createEditLinesTool(),
      { file, startLine: 2, endLine: 2, expectedText: "bbb", newText: "B" },
      e,
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(d, file), "utf8")).toBe("aaa\r\nB\r\nccc\r\n");
  });
});

describe("⑥ F-16 口径失败样本集回放（R-2 命中率统计）", () => {
  interface Sample {
    content: string;
    oldText: string;
  }
  // 引号风格失配类（最高频）：ASCII ' " ` 互换，语义内容零漂移
  const quoteSamples: Sample[] = [
    { content: "const a = 'x';\n", oldText: 'const a = "x";' },
    { content: "it(\"works\", () => {})\n", oldText: "it('works', () => {})" },
    { content: "const t = `tpl`;\n", oldText: "const t = 'tpl';" },
    { content: "msg = \"hi\" + name\n", oldText: "msg = `hi` + name" },
    { content: "from mod import thing as t\nx = t('arg')\n", oldText: "from mod import thing as t\nx = t(\"arg\")\n" },
    { content: "const cfg = { name: \"value\" };\n", oldText: "const cfg = { name: 'value' };" },
  ];
  // 文本漂移类：行内小改（数字/词/缩进），无引号问题
  const driftSamples: Sample[] = [
    { content: "  const answer = 41;\n", oldText: "  const answer = 42;" },
    { content: "function foo(a, b) {\n  return a + b;\n}\n", oldText: "function foo(a, b) {\n  return a - b;\n}\n" },
    { content: "  indented.deeply()\n", oldText: "    indented.deeply()" },
    { content: "# title\n\nsome paragraph text here\n", oldText: "# title\n\nsome paragraph text\n" },
  ];

  const level1Hit = (error: string) => /① 引号归一化重匹配：命中/.test(error);
  const level2Hit = (error: string) => /② 行锚重匹配：锚行命中/.test(error);
  const level3Hit = (error: string) => /③ 滑窗相似度\+行号前缀剥离：最近似/.test(error);

  test("引号归一化层吃下大部分（≥5/6）；每例失败信息含现场", async () => {
    const { dir: d, env: e } = makeEnv();
    let hits = 0;
    for (let i = 0; i < quoteSamples.length; i++) {
      const file = `quote-${i}.txt`;
      writeFileSync(path.join(d, file), quoteSamples[i]!.content);
      const r = await run(createEditTool(), { path: file, edits: [{ oldText: quoteSamples[i]!.oldText, newText: "ok" }] }, e);
      expect(r.ok, `sample ${i} 应失败`).toBe(false);
      if (!r.ok) {
        if (level1Hit(r.error)) hits++;
        expect(r.error, `sample ${i} 应含现场`).toContain("最近似现场");
      }
    }
    expect(hits).toBeGreaterThanOrEqual(5);
  });

  test("文本漂移类：行锚/滑窗层兜住大部分（≥3/4）", async () => {
    const { dir: d, env: e } = makeEnv();
    let hits = 0;
    for (let i = 0; i < driftSamples.length; i++) {
      const file = `drift-${i}.txt`;
      writeFileSync(path.join(d, file), driftSamples[i]!.content);
      const r = await run(createEditTool(), { path: file, edits: [{ oldText: driftSamples[i]!.oldText, newText: "ok" }] }, e);
      expect(r.ok, `sample ${i} 应失败`).toBe(false);
      if (!r.ok) {
        if (level2Hit(r.error) || level3Hit(r.error)) hits++;
        expect(r.error).toContain("最近似现场");
      }
    }
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  test("多编辑项单项失配：错误定位 edits[i] 且附现场；重叠编辑：类别错误与 pi 平权", async () => {
    const { dir: d, env: e } = makeEnv();
    // 多编辑项单项失配：错误定位 edits[1] 且附现场
    writeFileSync(path.join(d, "multi.txt"), "keep\n  const answer = 41;\n");
    const multi = await run(
      createEditTool(),
      { path: "multi.txt", edits: [{ oldText: "keep", newText: "k" }, { oldText: "  const answer = 42;", newText: "x" }] },
      e,
    );
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.error).toContain("Could not find edits[1]");
      expect(multi.error).toContain("最近似现场");
      expect(multi.error).toContain("const answer = 41;");
    }
    // 重叠编辑 ×2：类别错误（无现场要求），与 pi 类别等价
    for (const [i, content] of ["hello world foo\n", "aaaa bbbb cccc dddd\n"].entries()) {
      const file = `ov-${i}.txt`;
      writeFileSync(path.join(d, file), content);
      const pi = await run(
        createPiEditTool(),
        { path: file, edits: [{ oldText: content.trim().split(" ").slice(0, 2).join(" "), newText: "A" }, { oldText: content.trim().split(" ").slice(1, 3).join(" "), newText: "B" }] },
        e,
      );
      const self = await run(createEditTool(), { path: file, edits: [{ oldText: content.trim().split(" ").slice(0, 2).join(" "), newText: "A" }, { oldText: content.trim().split(" ").slice(1, 3).join(" "), newText: "B" }] }, e);
      expect(self.ok).toBe(false);
      expect(pi.ok).toBe(false);
      if (!self.ok && !pi.ok) expect(self.error).toContain("overlap");
    }
  });
});

describe("⑦ 同名覆盖注册（CL-1.A12）：edit/read 自写生效，write/bash 保留 pi", () => {
  test("registry 按 name 覆盖可验证（行为级）", async () => {
    const { dir: d } = makeEnv();
    const executor = new CoreToolExecutor({ cwd: d });
    // read：自写 → 行号输出（pi read 无行号）
    writeFileSync(path.join(d, "r.txt"), "hello\nworld\n");
    const read = await executor.execute({ toolCallId: "tc", toolName: "read", args: { path: "r.txt" } });
    expect(read.isError).toBe(false);
    expect(read.content).toContain(`     1\thello`);
    // edit：自写 → 失败信息带三级建议（pi 无）
    const edit = await executor.execute({
      toolCallId: "tc",
      toolName: "edit",
      args: { path: "r.txt", edits: [{ oldText: "hello world", newText: "x" }] },
    });
    expect(edit.isError).toBe(true);
    expect(edit.content).toContain("① 引号归一化重匹配");
    // edit-lines：新注册可解析
    const el = await executor.execute({
      toolCallId: "tc",
      toolName: "edit-lines",
      args: { file: "r.txt", startLine: 1, endLine: 1, expectedText: "hello", newText: "hi" },
    });
    expect(el.isError).toBe(false);
    expect(readFileSync(path.join(d, "r.txt"), "utf8")).toBe("hi\nworld\n");
    // write：pi 保留（输出文案 = pi write）
    const write = await executor.execute({
      toolCallId: "tc",
      toolName: "write",
      args: { path: "w.txt", content: "data" },
    });
    expect(write.isError).toBe(false);
    expect(write.content).toBe("Successfully wrote 4 bytes to w.txt");
    // bash：pi 保留（真 shell 执行）
    const bash = await executor.execute({ toolCallId: "tc", toolName: "bash", args: { command: "echo parity-ok" } });
    expect(bash.isError).toBe(false);
    expect(bash.content).toContain("parity-ok");
    // resolveTools：profile 装配面可解析五件（edit/read/edit-lines/write/bash）
    const tools = executor.resolveTools(["bash", "read", "write", "edit", "edit-lines", "grep"]);
    expect(tools.map((t) => t.name)).toEqual(["bash", "read", "write", "edit", "edit-lines", "grep"]);
  });
});

describe("⑧ VENDORED 纪律（AF-1）：逐字复制 + 零 pi import", () => {
  const kernelDir = path.join(import.meta.dir, "..", "..", "src", "adapters", "driven", "tools", "edit", "kernel");
  const upstreamDir = path.join(
    import.meta.dir, "..", "..", "node_modules",
    "@earendil-works", "pi-agent-core", "dist", "harness", "tools",
  );
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  /** 剥离 VENDORED 三行头注释后的正文。 */
  const body = (s: string) => s.split("\n").slice(3).join("\n");

  test.each(["edit-diff.js", "edit-diff.d.ts", "file-mutation-queue.d.ts"])(
    "%s 正文与上游逐字节一致（sha256）",
    (name) => {
      const ours = readFileSync(path.join(kernelDir, name), "utf8");
      const upstream = readFileSync(path.join(upstreamDir, name), "utf8");
      expect(ours.startsWith("// VENDORED from @earendil-works/pi-agent-core@0.84.2")).toBe(true);
      expect(sha(body(ours))).toBe(sha(upstream));
    },
  );

  test("file-mutation-queue.js：唯一手改 = getOrThrow 内联（其余逐字）", () => {
    const ours = readFileSync(path.join(kernelDir, "file-mutation-queue.js"), "utf8");
    const upstream = readFileSync(path.join(upstreamDir, "file-mutation-queue.js"), "utf8");
    expect(ours).not.toContain('from "../types.js"');
    // 差异面收口：上游删掉 import 行；我方删掉内联块（2 行注释 + 6 行函数）后逐行相等
    const upstreamLines = upstream.split("\n").filter((l) => l !== 'import { getOrThrow } from "../types.js";');
    const deviationBlock = [
      "// [AF-1 sole allowed deviation] getOrThrow inlined from upstream ../types.js",
      "// (relative import not vendored; 6-line helper, semantics identical).",
      "function getOrThrow(result) {",
      "    if (!result.ok)",
      "        throw result.error;",
      "    return result.value;",
      "}",
    ];
    // 正文开头恰为内联块（8 行），其后与上游（去掉 import 行）逐行相等
    const bodyLines = body(ours).split("\n");
    expect(bodyLines.slice(0, deviationBlock.length)).toEqual(deviationBlock);
    expect(bodyLines.slice(deviationBlock.length)).toEqual(upstreamLines);
  });

  test("kernel/ 零 pi import；edit-diff 运行体依赖 diff 包（AG-05 五键依据）", () => {
    for (const name of ["edit-diff.js", "edit-diff.d.ts", "file-mutation-queue.js", "file-mutation-queue.d.ts"]) {
      const src = readFileSync(path.join(kernelDir, name), "utf8");
      // 头注释的 VENDORED 溯源标注含包名（非 import）——剥头后断言零 pi 符号
      expect(body(src).includes("@earendil-works"), `${name} 不得出现 pi import`).toBe(false);
    }
    expect(readFileSync(path.join(kernelDir, "edit-diff.js"), "utf8")).toContain('from "diff"');
  });
});

describe("⑨ 注入面：notifyWrite（T2.2 契约）与 onEditApplied（T3.2 挂点预留）", () => {
  test("edit 成功 → notifyWrite(projectRoot, path, sha256) + onEditApplied 事实；失败不投递", async () => {
    const { dir: d, env: e } = makeEnv();
    const notified: Array<{ projectRoot: string; path: string; hash: string }> = [];
    const applied: unknown[] = [];
    const tool = createEditTool({
      projectRoot: "/proj",
      notifyWrite: (projectRoot, p, hash) => notified.push({ projectRoot, path: p, hash }),
      onEditApplied: (event) => {
        applied.push(event);
        return ""; // T3.2：挂点返回 📎 块（''=沉默）
      },
    });
    writeFileSync(path.join(d, "n.txt"), "old\n");
    const ok = await run(tool, { path: "n.txt", edits: [{ oldText: "old", newText: "new" }] }, e);
    expect(ok.ok).toBe(true);
    // 投递一次，签名按 T2.2 契约
    expect(notified.length).toBe(1);
    expect(notified[0]!.projectRoot).toBe("/proj");
    expect(notified[0]!.path).toBe(path.join(d, "n.txt"));
    expect(notified[0]!.hash).toBe(createHash("sha256").update("new\n").digest("hex"));
    // T3.2 挂点：文件路径 + 编辑对 + 修改行号（base 坐标）+ 落盘后行内容
    expect(applied.length).toBe(1);
    const event = applied[0] as any;
    expect(event.filePath).toBe(path.join(d, "n.txt"));
    expect(event.edits[0].oldText).toBe("old");
    expect(event.edits[0].newText).toBe("new");
    expect(event.edits[0].editLineStart).toBe(1);
    expect(event.edits[0].editLineEnd).toBe(1);
    expect(event.fileLines).toEqual(["new", ""]);
    // 失败路径不投递
    const fail = await run(tool, { path: "n.txt", edits: [{ oldText: "ghost", newText: "x" }] }, e);
    expect(fail.ok).toBe(false);
    expect(notified.length).toBe(1);
    expect(applied.length).toBe(1);
  });

  test("M23：写完成后 abort 不跳过 hooks——notifyWrite/onEditApplied 照常投递（对齐 edit-lines 写前查一次）", async () => {
    const { dir: d, env: e } = makeEnv();
    const notified: string[] = [];
    const applied: unknown[] = [];
    const tool = createEditTool({
      projectRoot: "/proj",
      notifyWrite: (root, p) => notified.push(`${root}:${p}`),
      onEditApplied: (ev) => {
        applied.push(ev);
        return "";
      },
    });
    writeFileSync(path.join(d, "m23.txt"), "old\n");
    const controller = new AbortController();
    // 写落盘后才 abort 的 env 包装（写后 abort 场景：文件已写，hooks 不许被跳过）
    const wrapped = new Proxy(e, {
      get(t, p, r) {
        if (p === "writeFile") {
          return async (...args: unknown[]) => {
            const res = await (t as unknown as { writeFile: (...a: unknown[]) => Promise<unknown> }).writeFile(...args);
            controller.abort();
            return res;
          };
        }
        const v = Reflect.get(t, p, r) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const result = await tool.execute(
      "tc-1",
      { path: "m23.txt", edits: [{ oldText: "old", newText: "new" }] } as never,
      controller.signal as never,
      undefined,
      { env: wrapped as unknown as NodeExecutionEnv },
    );
    expect((result.content as any[])[0].text).toContain("Successfully replaced");
    expect(notified).toEqual([`/proj:${path.join(d, "m23.txt")}`]);
    expect(applied.length).toBe(1);
    // 文件已落盘（写后 abort 不回滚、不吞成功结果）
    expect(readFileSync(path.join(d, "m23.txt"), "utf8")).toBe("new\n");
  });

  test("依赖容缺：不注入 deps 时 edit/edit-lines 正常工作", async () => {
    const { dir: d, env: e } = makeEnv();
    writeFileSync(path.join(d, "bare.txt"), "a\n");
    const edit = await run(createEditTool(), { path: "bare.txt", edits: [{ oldText: "a", newText: "b" }] }, e);
    expect(edit.ok).toBe(true);
    writeFileSync(path.join(d, "bare2.txt"), "a\nb\n");
    const el = await run(
      createEditLinesTool(),
      { file: "bare2.txt", startLine: 1, endLine: 1, expectedText: "a", newText: "A" },
      e,
    );
    expect(el.ok).toBe(true);
  });

  test("edit-lines 成功 → notifyWrite 投递；失配不投递", async () => {
    const { dir: d, env: e } = makeEnv();
    const notified: string[] = [];
    const tool = createEditLinesTool({
      projectRoot: "/proj",
      notifyWrite: (root, p) => notified.push(`${root}:${p}`),
    });
    writeFileSync(path.join(d, "el.txt"), "x\ny\n");
    const ok = await run(tool, { file: "el.txt", startLine: 1, endLine: 1, expectedText: "x", newText: "X" }, e);
    expect(ok.ok).toBe(true);
    expect(notified).toEqual([`/proj:${path.join(d, "el.txt")}`]);
    const bad = await run(tool, { file: "el.txt", startLine: 2, endLine: 2, expectedText: "WRONG", newText: "Y" }, e);
    expect(bad.ok).toBe(false);
    expect(notified.length).toBe(1);
  });
});

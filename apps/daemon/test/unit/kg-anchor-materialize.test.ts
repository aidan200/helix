import { describe, expect, test } from "bun:test";
import { materializeAnchors } from "../../src/domain/kg/anchor-materialize";
import type { AnchorDeclRow } from "../../src/domain/kg/types";

/**
 * 锚物化 join 纯函数单测（CL-2.A3，AD-13 三级作用域确定性 join）。
 *
 * global 不物化 / path glob → 文件锚 / symbol → path#symbol 锚；
 * 确定性：同输入同输出（排序稳定），供 sync 管道全量重算。
 */

const FILES = ["src/app.ts", "src/lib/util.ts", "src/lib/deep/helper.ts", "README.md"];

const SYMBOLS = [
  { name: "main", file: "src/app.ts" },
  { name: "Handler", file: "src/app.ts" },
  { name: "formatDate", file: "src/lib/util.ts" },
  { name: "Handler", file: "src/lib/deep/helper.ts" },
];

function decl(nodeId: string, scopeKind: AnchorDeclRow["scopeKind"], pattern: string): AnchorDeclRow {
  return { nodeId, scopeKind, pattern };
}

describe("anchor-materialize：三级作用域确定性 join（CL-2.A3）", () => {
  test("① global 声明永不物化（零锚）", () => {
    const out = materializeAnchors({
      declarations: [decl("TR-1", "global", ""), decl("TR-2", "global", "")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    expect(out).toEqual([]);
  });

  test("② path 声明：glob 匹配文件面 → 每命中文件一枚文件锚（anchorSymbol=null）", () => {
    const out = materializeAnchors({
      declarations: [decl("TR-1", "path", "src/lib/**/*.ts")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    expect(out).toEqual([
      { nodeId: "TR-1", anchorPath: "src/lib/deep/helper.ts", anchorSymbol: null, anchorKind: "path" },
      { nodeId: "TR-1", anchorPath: "src/lib/util.ts", anchorSymbol: null, anchorKind: "path" },
    ]);
  });

  test("③ path 精确 pattern 命中单文件；* 不跨段、** 跨段", () => {
    const exact = materializeAnchors({
      declarations: [decl("TR-1", "path", "src/app.ts")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    expect(exact).toEqual([
      { nodeId: "TR-1", anchorPath: "src/app.ts", anchorSymbol: null, anchorKind: "path" },
    ]);

    const star = materializeAnchors({
      declarations: [decl("TR-1", "path", "src/*/*.ts")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    // src/*/*.ts 只命中一层（src/lib/util.ts）；deep/helper.ts 是两层不命中
    expect(star.map((a) => a.anchorPath)).toEqual(["src/lib/util.ts"]);

    const doubleStar = materializeAnchors({
      declarations: [decl("TR-1", "path", "src/**/*.ts")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    expect(doubleStar.map((a) => a.anchorPath)).toEqual(["src/app.ts", "src/lib/deep/helper.ts", "src/lib/util.ts"]);
  });

  test("④ symbol 声明：path#symbol → 符号锚（精名匹配，同名符号多文件各自成锚）", () => {
    const out = materializeAnchors({
      declarations: [decl("E-1", "symbol", "src/app.ts#Handler"), decl("E-2", "symbol", "src/**/util.ts#formatDate")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    expect(out).toEqual([
      { nodeId: "E-1", anchorPath: "src/app.ts", anchorSymbol: "Handler", anchorKind: "symbol" },
      { nodeId: "E-2", anchorPath: "src/lib/util.ts", anchorSymbol: "formatDate", anchorKind: "symbol" },
    ]);
  });

  test("⑤ symbol 同名多文件命中（glob path 段）：每处符号一枚锚", () => {
    const out = materializeAnchors({
      declarations: [decl("E-1", "symbol", "src/**/*#Handler")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    expect(out).toEqual([
      { nodeId: "E-1", anchorPath: "src/app.ts", anchorSymbol: "Handler", anchorKind: "symbol" },
      { nodeId: "E-1", anchorPath: "src/lib/deep/helper.ts", anchorSymbol: "Handler", anchorKind: "symbol" },
    ]);
  });

  test("⑥ 符号面为空（degraded docs-only 路径输入）：symbol 声明零锚，path 声明照常", () => {
    const out = materializeAnchors({
      declarations: [decl("TR-1", "path", "src/**"), decl("E-1", "symbol", "src/app.ts#Handler")],
      filePaths: FILES,
      symbols: [],
    });
    expect(out).toEqual([
      { nodeId: "TR-1", anchorPath: "src/app.ts", anchorSymbol: null, anchorKind: "path" },
      { nodeId: "TR-1", anchorPath: "src/lib/deep/helper.ts", anchorSymbol: null, anchorKind: "path" },
      { nodeId: "TR-1", anchorPath: "src/lib/util.ts", anchorSymbol: null, anchorKind: "path" },
    ]);
  });

  test("⑦ 无匹配 pattern → 空结果；确定性排序（nodeId→path→symbol）", () => {
    const out = materializeAnchors({
      declarations: [decl("TR-9", "path", "nope/**/*.ts"), decl("E-9", "symbol", "src/app.ts#Missing")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    expect(out).toEqual([]);

    const multi = materializeAnchors({
      declarations: [decl("TR-2", "path", "src/**"), decl("TR-1", "path", "src/**")],
      filePaths: FILES,
      symbols: SYMBOLS,
    });
    // TR-1 在前（按 nodeId 排序）
    expect(multi.slice(0, 3).every((a) => a.nodeId === "TR-1")).toBe(true);
  });
});

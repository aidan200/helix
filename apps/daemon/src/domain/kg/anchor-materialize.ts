/**
 * 锚物化确定性 join（domain 纯逻辑，AD-13 三级作用域，CL-2.A3）。
 *
 * 架构锚：iter-20260825-11fo architecture.md §3.2「锚物化」——
 * - global 声明永不物化（常驻层系统提示到达，附着=重复运输）；
 * - path 声明：pattern（glob）匹配文件面 → 每命中文件一枚文件锚；
 * - symbol 声明：pattern 形如 `pathGlob#symbolName` → 命中处一枚符号锚。
 *
 * 确定性：纯函数、同输入同输出（输出按 nodeId→path→symbol 码点序稳定
 * 排序），供 sync 管道每次全量重算（重算差集 = orphan 检测输入）。
 * degraded（docs-only）路径：文件面传上一基准、符号面传空——symbol
 * 声明自然零锚（CL-2.A2「符号域锚跳过」）。
 */

import type { AnchorDeclRow, MaterializedAnchor } from "./types";

/** 物化 join 输入：锚声明全集 + 当前文件面 + 当前符号面（均相对 projectRoot）。 */
export interface MaterializeInput {
  readonly declarations: readonly AnchorDeclRow[];
  readonly filePaths: readonly string[];
  readonly symbols: readonly { readonly name: string; readonly file: string }[];
}

/** 锚去重/排序键（nodeId, kind, path, symbol 四元组；symbol null 归一空串）。 */
export function anchorKey(a: { nodeId: string; anchorKind: string; anchorPath: string; anchorSymbol: string | null }): string {
  return `${a.nodeId}\u0000${a.anchorKind}\u0000${a.anchorPath}\u0000${a.anchorSymbol ?? ""}`;
}

/**
 * 最小 glob 编译（Node 零依赖，F-21 同源语义）：
 * `*`=段内任意（不含 /）；`?`=段内单字符；`**`=跨段任意（零或多段，
 * 尾部 `**` 匹配其后一切）。其余字符字面转义。
 */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split("/");
  let re = "^";
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i]!;
    const isLast = i === parts.length - 1;
    if (seg === "**") {
      re += isLast ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    re += escapeSeg(seg);
    if (!isLast) re += "/";
  }
  return new RegExp(`${re}$`);
}

/** 段内转义：* / ? 通配，其余字面（正则元字符转义）。 */
function escapeSeg(seg: string): string {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** symbol pattern 拆分：`pathGlob#symbolName`（首个 # 分割；无 # → 不匹配任何）。 */
function splitSymbolPattern(pattern: string): { pathGlob: string; symbolName: string } | null {
  const idx = pattern.indexOf("#");
  if (idx <= 0 || idx >= pattern.length - 1) return null;
  return { pathGlob: pattern.slice(0, idx), symbolName: pattern.slice(idx + 1) };
}

/**
 * 三级作用域确定性 join。输出按 (nodeId, anchorPath, anchorSymbol) 码点序
 * 稳定排序；同一锚四元组去重（同声明多命中/重复声明）。
 */
export function materializeAnchors(input: MaterializeInput): readonly MaterializedAnchor[] {
  const byKey = new Map<string, MaterializedAnchor>();
  const put = (anchor: MaterializedAnchor): void => {
    byKey.set(anchorKey(anchor), anchor);
  };

  // 符号面索引：path glob → 该 glob 命中的符号集（同 file 同 name 去重）
  const symbolsByFile = new Map<string, Set<string>>();
  for (const sym of input.symbols) {
    let names = symbolsByFile.get(sym.file);
    if (names === undefined) {
      names = new Set<string>();
      symbolsByFile.set(sym.file, names);
    }
    names.add(sym.name);
  }

  for (const decl of input.declarations) {
    if (decl.scopeKind === "global") continue; // 永不物化（AD-13）
    if (decl.scopeKind === "path") {
      const re = globToRegExp(decl.pattern);
      for (const filePath of input.filePaths) {
        if (!re.test(filePath)) continue;
        put({ nodeId: decl.nodeId, anchorPath: filePath, anchorSymbol: null, anchorKind: "path" });
      }
      continue;
    }
    // symbol：pathGlob 限定文件域 + symbolName 精确（同名多文件各自成锚）
    const split = splitSymbolPattern(decl.pattern);
    if (split === null) continue;
    const re = globToRegExp(split.pathGlob);
    for (const filePath of input.filePaths) {
      if (!re.test(filePath)) continue;
      const names = symbolsByFile.get(filePath);
      if (names === undefined || !names.has(split.symbolName)) continue;
      put({ nodeId: decl.nodeId, anchorPath: filePath, anchorSymbol: split.symbolName, anchorKind: "symbol" });
    }
  }

  return [...byKey.values()].sort((a, b) =>
    anchorKey(a) < anchorKey(b) ? -1 : anchorKey(a) > anchorKey(b) ? 1 : 0,
  );
}

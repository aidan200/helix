/**
 * 附着四层递降匹配（architecture.md §5.3，CL-1 F1.1，AD-7 补充/AD-13）。
 *
 * L1 方法级全等 → L2 contains 类上溯 → L3 span 保守兜底 → L4 文件级兜底；
 * 高层命中即短路，不再降层。全程「宁可沉默不可错附」：任何不确定
 * （多候选无法消歧 / 快照缺字段 / 类型失配）→ 该锚沉默，不猜。
 *
 * callee 不挂：只匹配 `symbolAnchors[path=input.filePath]`（本文件定义
 * 符号）；他文件符号名（不在本文件锚域）不产生任何命中。
 *
 * 纯函数、零 IO（TR-AD-1）。文件名从 architecture.md §11 目录树
 * （scope-matcher.ts）；主入口签名从 T1.2 brief 契约（matchAnchors）。
 */

import type {
  AttachmentInput,
  AttachmentSnapshot,
  KgNodeDigestRow,
  SymbolAnchor,
} from "../types";
import { extractIdentifiers } from "./identifier-extract";

/** 命中域：特异性排序键（符号域 > 路径域，AD-4/AD-13）。 */
export type AnchorDomain = "symbol" | "path";

/** 四层递降的单个命中（渲染与预算的输入）。 */
export interface MatchedAnchor {
  readonly nodeId: string;
  readonly kind: KgNodeDigestRow["kind"];
  readonly name: string;
  readonly digest: string;
  /** 命中域：L1/L2/L3=symbol，L4=path。 */
  readonly domain: AnchorDomain;
  /** 命中层（诊断与测试断言用；1 最特异）。 */
  readonly layer: 1 | 2 | 3 | 4;
}

/** L3 回扫窗口：从 span 起行向上最多 10 行（含起行）。 */
const RESCAN_LINES = 10;

/** 正则元字符转义（符号名插值安全）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 声明行形态：`function X` / `class X` / `const X = (`（brief 决策消解）。 */
function declLineRe(symbol: string): RegExp {
  return new RegExp(
    "^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?" +
      `(?:function\\s*\\*?\\s+${escapeRe(symbol)}\\b` +
      `|class\\s+${escapeRe(symbol)}\\b` +
      `|(?:const|let|var)\\s+${escapeRe(symbol)}\\s*=\\s*(?:async\\s+)?\\()`,
  );
}

/** 声明行形态：类方法（缩进 + 可见性/静态/异步修饰 + `X(...) {`）。 */
function methodDeclLineRe(symbol: string): RegExp {
  return new RegExp(
    `^\\s+(?:(?:public|private|protected|static|readonly|override|async)\\s+|\\*\\s+)*` +
      `${escapeRe(symbol)}\\s*\\([^)]*\\)\\s*\\{`,
  );
}

/**
 * span 陈旧时向上回扫：从起行向上 ≤10 行内找 symbol 的**唯一**声明行。
 * 找不到或撞双候选 → undefined（宁可沉默）。
 */
function findUniqueDeclLine(
  fileLines: readonly string[],
  spanStartLine: number,
  symbol: string,
): number | undefined {
  const from = Math.max(1, spanStartLine - (RESCAN_LINES - 1));
  const to = Math.min(spanStartLine, fileLines.length);
  const declRe = declLineRe(symbol);
  const methodRe = methodDeclLineRe(symbol);
  let found: number | undefined;
  for (let ln = to; ln >= from; ln--) {
    const line = fileLines[ln - 1] ?? "";
    if (declRe.test(line) || methodRe.test(line)) {
      if (found !== undefined) return undefined; // 唯一性破坏 → 跳过
      found = ln;
    }
  }
  return found;
}

/** span 结构合法（闭区间且 start ≥ 1）。 */
function spanWellFormed(span: SymbolAnchor["span"]): boolean {
  return span !== undefined && span.startLine >= 1 && span.endLine >= span.startLine;
}

/**
 * L3：编辑区完整落入**恰好一个**符号 span → 该锚。
 * 跨多符号 / 双候选 / 边界压双符号 → 全部跳过；span 与当前文件行数
 * 明显失配（陈旧）→ 回扫唯一声明行校验，仍不确定 → 跳过。
 */
function matchBySpan(
  input: AttachmentInput,
  symbolAnchors: readonly SymbolAnchor[],
): SymbolAnchor | undefined {
  const candidates = symbolAnchors.filter((a) => spanWellFormed(a.span));
  if (candidates.length === 0) return undefined;

  const { editLineStart, editLineEnd } = input;
  // 行号无效（倒置/越界）→ 不启用兜底
  if (
    !Number.isInteger(editLineStart) ||
    !Number.isInteger(editLineEnd) ||
    editLineStart < 1 ||
    editLineEnd < editLineStart
  ) {
    return undefined;
  }
  // 快照缺字段（fileLines 缺失）→ 无法校验陈旧性 → 沉默
  const lineCount = input.fileLines.length;
  if (lineCount === 0) return undefined;

  const containing = candidates.filter(
    (a) =>
      a.span!.startLine <= editLineStart && editLineEnd <= a.span!.endLine,
  );
  if (containing.length !== 1) return undefined;

  const anchor = containing[0]!;
  const span = anchor.span!;
  // 明显失配（span 越出当前文件）→ 回扫唯一声明行校验包围关系
  if (span.endLine > lineCount || span.startLine > lineCount) {
    const declLine = findUniqueDeclLine(input.fileLines, span.startLine, anchor.symbol);
    if (declLine === undefined || declLine > editLineStart) return undefined;
  }
  return anchor;
}

/**
 * 四层递降主入口：edit 现场快照 → 命中锚集（按 snapshot.nodes 顺序稳定
 * 输出、按 nodeId 去重）；四层全部未命中 → 空数组（沉默零成本）。
 */
export function matchAnchors(
  input: AttachmentInput,
  snapshot: AttachmentSnapshot,
): MatchedAnchor[] {
  const nodes: readonly KgNodeDigestRow[] = snapshot.nodes ?? [];
  const nodesById = new Map<string, KgNodeDigestRow>();
  for (const n of nodes) nodesById.set(n.id, n);

  /** 防御性有效锚：节点行可解析且非 global（global 不进附着，AD-13）。 */
  const anchorable = (nodeId: string): KgNodeDigestRow | undefined => {
    const n = nodesById.get(nodeId);
    return n !== undefined && n.scopeKind !== "global" ? n : undefined;
  };

  const fileAnchors = (snapshot.fileAnchors ?? []).filter(
    (a) => a.path === input.filePath,
  );
  const symbolAnchors = (snapshot.symbolAnchors ?? []).filter(
    (a) => a.path === input.filePath,
  );
  const contains = (snapshot.contains ?? []).filter((e) => e.file === input.filePath);

  const identifiers = extractIdentifiers(input.oldText, input.newText);

  const hits = new Map<string, { layer: 1 | 2 | 3 | 4; domain: AnchorDomain }>();
  const addHit = (
    nodeId: string,
    layer: 1 | 2 | 3 | 4,
    domain: AnchorDomain,
  ): void => {
    if (!hits.has(nodeId) && anchorable(nodeId) !== undefined) {
      hits.set(nodeId, { layer, domain });
    }
  };
  /** 按 snapshot.nodes 顺序物化输出（budget 特异性排序的稳定基序）。 */
  const materialize = (): MatchedAnchor[] => {
    const out: MatchedAnchor[] = [];
    for (const n of nodes) {
      const hit = hits.get(n.id);
      if (hit === undefined) continue;
      out.push({
        nodeId: n.id,
        kind: n.kind,
        name: n.name,
        digest: n.digest,
        domain: hit.domain,
        layer: hit.layer,
      });
    }
    return out;
  };

  // L1 方法级：identifier 集 ∩ symbolAnchors 的 symbol 全等匹配
  // （非子串、非前缀；词边界切分词同受全等约束——见 identifier-extract）。
  for (const a of symbolAnchors) {
    if (identifiers.has(a.symbol)) addHit(a.nodeId, 1, "symbol");
  }
  if (hits.size > 0) return materialize();

  // L2 类级：只沿 contains 边上溯，不猜测命名空间。
  // ① identifier 命中成员符号（inner，无论其自身是否锚定）→ 外层类有锚则命中；
  // ② identifier 直接等于类名（outer）：类名已锚定时由 L1 全等承载（短路），
  //    此处对未锚定 outer 的查找自然落空——两分支合流为「查 outer 锚」。
  for (const e of contains) {
    if (!identifiers.has(e.inner) && !identifiers.has(e.outer)) continue;
    for (const a of symbolAnchors) {
      if (a.symbol === e.outer) addHit(a.nodeId, 2, "symbol");
    }
  }
  if (hits.size > 0) return materialize();

  // L3 span 保守兜底：仅当 L1/L2 零命中。
  const spanHit = matchBySpan(input, symbolAnchors);
  if (spanHit !== undefined) {
    addHit(spanHit.nodeId, 3, "symbol");
    if (hits.size > 0) return materialize();
  }

  // L4 文件级兜底：该文件路径域锚。
  for (const a of fileAnchors) {
    addHit(a.nodeId, 4, "path");
  }
  return materialize();
}

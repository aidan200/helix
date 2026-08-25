/**
 * edit 失败三级推荐管线（F1.4，AD-12）——纯函数，无 IO。
 *
 * 输入：LF 归一后的文件内容 + 失败 oldText（kernel 精确/模糊匹配均已落空的
 * 情形）。输出：最近似现场（scene）+ 按序三建议（①引号归一化 ②行锚 ③滑窗
 * 相似度+行号前缀剥离）。
 *
 * 设计口径（brief 决策消解）：
 * - 「失败即 read」→ 现场行带 cat -n 风格行号前缀（%6d\\t，与 ReadTool 同构），
 *   可直接复制重写 oldText 或转 edit-lines 行锚；
 * - 「引号归一化」→ 仅 ASCII ' " ` 风格互换（内核 normalizeForFuzzyMatch 只
 *   归一智能引号/尾空白/unicode 变体，不吃 ASCII 风格互换——F-16 最高频失配）;
 * - 「行号前缀剥离」→ 剥离 `\\d+[:\\s]?` 前缀（read 输出与 cat -n 形态），仅
 *   ③级比对视图使用（对称剥离，内容行首数字被对称吃掉不致错配）。
 */

/** 建议③/②命中的窗口相似度门槛（bigram Dice 均值）。 */
const WINDOW_HIT_THRESHOLD = 0.5;
/** 现场渲染行数上限（~10 行窗口，超出取首尾各 5 行）。 */
const SCENE_MAX_LINES = 10;

/** 引号风格归一（' " ` → "，保长——偏移与原内容 1:1 对应）。 */
export function normalizeQuoteStyle(text: string): string {
  return text.replace(/['"`]/g, '"');
}

/** 剥离行号前缀（`^\s*\d+[:\s]?`——read 输出/cat -n 常见形态）。 */
export function stripLineNumberPrefix(line: string): string {
  return line.replace(/^\s*\d+[:\t ]?\s*/, "");
}

/** 行相似度（字符 bigram Dice 系数；空串对空串 = 1）。 */
export function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let totalA = 0;
  for (const n of counts.values()) totalA += n;
  let totalB = 0;
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    totalB += 1;
    const n = counts.get(gram) ?? 0;
    if (n > 0) {
      overlap += 1;
      counts.set(gram, n - 1);
    }
  }
  return (2 * overlap) / (totalA + totalB);
}

/** 窗口相似度：内容窗口行 vs oldText 行逐行 bigram Dice 均值。 */
function windowScore(contentLines: readonly string[], start: number, oldLines: readonly string[]): number {
  let sum = 0;
  for (let k = 0; k < oldLines.length; k++) {
    sum += lineSimilarity(contentLines[start + k] ?? "", oldLines[k]!);
  }
  return sum / oldLines.length;
}

/** 字符偏移 → 1 起行号。 */
export function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/** 按行切分（丢弃末尾换行产生的空尾元素；cat -n 语义）。 */
function toLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface Level1Result {
  readonly hit: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface Level2Result {
  readonly hit: boolean;
  readonly anchorLine?: number;
}

export interface Level3Result {
  readonly hit: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
  /** 最佳窗口相似度（0-1；miss 时也携带最高值供「最高相似度 N%」表述）。 */
  readonly score: number;
}

export interface RecoveryReport {
  readonly level1: Level1Result;
  readonly level2: Level2Result;
  readonly level3: Level3Result;
  /** 现场窗口（1 起行号，含端点）。 */
  readonly scene: { readonly startLine: number; readonly endLine: number };
  readonly contentLines: readonly string[];
}

/** ①引号归一化重匹配：' " ` 风格归一后 indexOf（保长映射，偏移直读原内容）。 */
function runLevel1(content: string, oldText: string): Level1Result {
  const normalized = normalizeQuoteStyle(content);
  const target = normalizeQuoteStyle(oldText);
  const index = normalized.indexOf(target);
  if (index === -1) return { hit: false };
  return {
    hit: true,
    startLine: lineOfOffset(content, index),
    endLine: lineOfOffset(content, index + target.length - 1),
  };
}

/** ②行锚重匹配：oldText 首个非空行为锚（包含定位）+ 窗口重比对。 */
function runLevel2(contentLines: readonly string[], oldLines: readonly string[]): Level2Result {
  let anchorIndex = -1;
  for (let i = 0; i < oldLines.length; i++) {
    if (oldLines[i]!.trim() !== "") {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex === -1) return { hit: false };
  const anchor = oldLines[anchorIndex]!;
  for (let i = 0; i + anchorIndex < contentLines.length; i++) {
    if (contentLines[i]!.includes(anchor)) {
      const start = i - anchorIndex;
      if (start < 0) break;
      const score = windowScore(contentLines, start, oldLines);
      if (score >= WINDOW_HIT_THRESHOLD) return { hit: true, anchorLine: start + 1 };
      break;
    }
  }
  return { hit: false };
}

/** ③滑窗相似度+行号前缀剥离：双侧剥前缀后滑窗取最近似区段。 */
function runLevel3(contentLines: readonly string[], oldLines: readonly string[]): Level3Result {
  const strippedOld = oldLines.map(stripLineNumberPrefix);
  const strippedContent = contentLines.map(stripLineNumberPrefix);
  const width = Math.max(1, strippedOld.length);
  let bestScore = -1;
  let bestStart = 0;
  for (let start = 0; start + width <= strippedContent.length; start++) {
    const score = windowScore(strippedContent, start, strippedOld);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  if (bestScore < 0) return { hit: false, score: 0 };
  return {
    hit: bestScore >= WINDOW_HIT_THRESHOLD,
    startLine: bestStart + 1,
    endLine: bestStart + width,
    score: bestScore,
  };
}

/** 三级管线主入口：content/oldText 均为 LF 归一后文本。 */
export function buildRecovery(content: string, oldText: string): RecoveryReport {
  const contentLines = toLines(content);
  const oldLines = oldText.split("\n");
  const level1 = runLevel1(content, oldText);
  const level2 = runLevel2(contentLines, oldLines);
  const level3 = runLevel3(contentLines, oldLines);
  // 现场取最高特异性来源：①命中区段 > ②锚定窗口 > ③最佳窗口（兜底必存在）
  let sceneStart = level3.startLine ?? 1;
  let sceneEnd = level3.endLine ?? sceneStart;
  if (level2.hit && level2.anchorLine !== undefined) {
    sceneStart = level2.anchorLine;
    sceneEnd = Math.min(contentLines.length, sceneStart + oldLines.length - 1);
  }
  if (level1.hit && level1.startLine !== undefined && level1.endLine !== undefined) {
    sceneStart = level1.startLine;
    sceneEnd = level1.endLine;
  }
  return { level1, level2, level3, scene: { startLine: sceneStart, endLine: sceneEnd }, contentLines };
}

/** cat -n 风格行号渲染（%6d\\t，与 ReadTool 同构——失败即 read）。 */
export function numberLine(lineNo: number, line: string): string {
  return `${String(lineNo).padStart(6, " ")}\t${line}`;
}

/** 现场窗口渲染（≤10 行；超出取首 5 + ... + 尾 5）。 */
function renderScene(report: RecoveryReport): string {
  const { startLine, endLine } = report.scene;
  const width = endLine - startLine + 1;
  const out: string[] = [];
  if (width <= SCENE_MAX_LINES) {
    for (let n = startLine; n <= endLine; n++) {
      out.push(numberLine(n, report.contentLines[n - 1] ?? ""));
    }
  } else {
    const headEnd = startLine + 4;
    for (let n = startLine; n <= headEnd; n++) out.push(numberLine(n, report.contentLines[n - 1] ?? ""));
    out.push("      ...");
    const tailStart = endLine - 4;
    for (let n = tailStart; n <= endLine; n++) out.push(numberLine(n, report.contentLines[n - 1] ?? ""));
  }
  return out.join("\n");
}

/** 组装「失败即 read」附录：现场块 + 按序三建议（拼在 kernel 错误消息之后）。 */
export function renderRecovery(report: RecoveryReport, displayPath: string): string {
  const { level1, level2, level3 } = report;
  const sceneBlock =
    `最近似现场（${displayPath} L${report.scene.startLine}-L${report.scene.endLine}；` +
    "失败即 read——现场内容可直接复制重写 oldText，或转 edit-lines 以行号锚定）：\n" +
    renderScene(report);
  const l1 = level1.hit
    ? `① 引号归一化重匹配：命中 L${level1.startLine}-L${level1.endLine}——现场与 oldText 仅引号风格不同；把 oldText 引号改成与现场一致后重试`
    : "① 引号归一化重匹配：未命中（不止引号风格差异）";
  const l2 = level2.hit && level2.anchorLine !== undefined
    ? `② 行锚重匹配：锚行命中 L${level2.anchorLine}——现场行段与 oldText 有漂移；按最近似现场重写 oldText，或改用 edit-lines（startLine=${level2.anchorLine}）`
    : "② 行锚重匹配：未命中（oldText 首行在现场找不到定位锚）";
  const pct = Math.round(level3.score * 100);
  const l3 = level3.hit && level3.startLine !== undefined && level3.endLine !== undefined
    ? `③ 滑窗相似度+行号前缀剥离：最近似 L${level3.startLine}-L${level3.endLine}（相似度 ${pct}%）——oldText 若带行号前缀先剥离；或以现场内容为准重写 oldText`
    : `③ 滑窗相似度+行号前缀剥离：未命中（最高相似度 ${pct}%）`;
  return `${sceneBlock}\n建议（按序尝试）：\n${l1}\n${l2}\n${l3}`;
}

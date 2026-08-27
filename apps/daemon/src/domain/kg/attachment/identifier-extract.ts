/**
 * 标识符提取（architecture.md §5.3 第 1 步；CL-1 F1.1，AD-7 补充）。
 *
 * 决策消解（brief T1.2）：标识符 = `[A-Za-z_$][A-Za-z0-9_$]*` 且长度≥3
 * 且不在保留字表；camelCase / snake_case 双产出（原词 + 切分词均入集合）。
 *
 * 纯函数、零 IO（TR-AD-1）。
 */

/** 词元正则：连续标识符字符段。 */
const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * camel 边界切分：`withFileMutationQueue → with|File|Mutation|Queue`、
 * `HTTPServer → HTTP|Server`、`myrender → myrender`（无边界不切）。
 */
const CAMEL_SPLIT_RE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9$]+/g;

/**
 * 保留字表（决策消解：JS/TS 关键字 + true/false/null/undefined/this
 * + 常见全局名 console/window 等）。表为精度装置：高频噪声词一律不产
 * 出——宁可少附不可错附。
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  // JS / TS 关键字
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "finally",
  "for", "function", "if", "import", "in", "instanceof", "new", "return",
  "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while",
  "with", "as", "implements", "interface", "let", "package", "private",
  "protected", "public", "static", "yield", "await", "async", "abstract",
  "declare", "namespace", "readonly", "override", "satisfies", "keyof",
  "type", "from", "of",
  // 字面量与上下文噪声
  "true", "false", "null", "undefined", "arguments",
  // 常见全局名（编辑文本高频出现、无锚定价值）
  "console", "window", "globalThis", "global", "process", "document",
  "require", "module", "exports", "string", "number", "boolean", "object",
  "symbol", "unknown", "never", "any", "NaN", "Infinity",
]);

/** 单词元入集判定：长度≥3 且非保留字。 */
function keep(word: string): boolean {
  return word.length >= 3 && !RESERVED_WORDS.has(word);
}

/** 词元切分：先按 `_` 分段，再对每段做 camel 边界切分。 */
function splitWords(token: string): string[] {
  const words: string[] = [];
  for (const seg of token.split("_")) {
    if (seg === "") continue;
    words.push(...(seg.match(CAMEL_SPLIT_RE) ?? [seg]));
  }
  return words;
}

/**
 * 从 edit 的 oldText/newText 抽取标识符集合（并集）。
 * 原词与切分词均入集合（camelCase / snake_case 双产出）。
 */
export function extractIdentifiers(oldText: string, newText: string): Set<string> {
  const ids = new Set<string>();
  const emit = (text: string): void => {
    for (const token of text.match(TOKEN_RE) ?? []) {
      if (keep(token)) ids.add(token);
      for (const word of splitWords(token)) {
        if (keep(word)) ids.add(word);
      }
    }
  };
  emit(oldText);
  emit(newText);
  return ids;
}

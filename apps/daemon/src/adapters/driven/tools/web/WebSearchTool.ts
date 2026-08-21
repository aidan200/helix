import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";

/**
 * WebSearchTool —— 静态联网搜索工具（T1 静态族；动态层 browser_open/browser_eval
 * 属 T2/T3，本文件只在其全失败文案中预留兜底提示）。
 *
 * 分两半（同 GrepTool 分半模式）：
 * - **解析核 = 纯函数**（本文件上半区）：搜索引擎 HTML → 结果列表；零 IO、
 *   零框架依赖，可单测。DDG 的真实 URL 在 uddg= 重定向参数里（需
 *   decodeURIComponent）；Bing 在 `<li class="b_algo">` 块内 h2>a（链接）+ p（摘要）。
 * - **取数 = 薄封装**（下半区）：DuckDuckGo html 版为主、Bing 兜底，逐引擎
 *   fetch（伪装浏览器 UA + Accept 头，10s 超时）→ 解析 → ≥1 条即返回；
 *   两者全失败抛异常（pi 工具惯例，CoreToolExecutor 转 isError），文案预留
 *   动态层兜底提示。不实现 Google 解析（风控最严、v1 实证基本失效）。
 */

// ── 解析核（纯函数区，framework-free） ─────────────────────

/** 一条搜索结果（title/url/snippet 三元组）。 */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * DuckDuckGo html 版结果页解析：`<a class="result__a" href="...uddg=...">` 为
 * 结果锚点（真实 URL 在 uddg= 重定向参数，decodeURIComponent 还原；非 uddg
 * 形态保留原 href，协议相对 // 补 https:）；摘要取锚点后至下一锚点间首个
 * `<a class="result__snippet">`（无则空串）。标题为空的结果跳过。
 */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const anchors: { href: string; titleHtml: string; start: number; end: number }[] = [];
  // matchAll（非 exec 循环——AG-06 守护以 exec 调用为 SQLite 写点启发式，正则不踩）
  for (const m of html.matchAll(anchorRe)) {
    anchors.push({ href: m[1]!, titleHtml: m[2]!, start: m.index!, end: m.index! + m[0].length });
  }
  const results: WebSearchResult[] = [];
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const anchor = anchors[i]!;
    const title = stripTags(anchor.titleHtml).trim();
    if (!title) continue;
    const uddg = anchor.href.match(/[?&]uddg=([^&]+)/);
    const url = uddg
      ? decodeURIComponent(uddg[1]!)
      : anchor.href.startsWith("//")
        ? `https:${anchor.href}`
        : anchor.href;
    // 摘要：本锚点结束至下一锚点开始之间的首个 result__snippet
    const regionEnd = i + 1 < anchors.length ? anchors[i + 1]!.start : html.length;
    const region = html.slice(anchor.end, regionEnd);
    const snippetMatch = region.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]!).trim() : "";
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Bing 结果页解析：`<li class="b_algo">` 分块，块内 `<h2><a href>` 为链接、
 * 首个 `<p>` 为摘要（无则空串）；非 b_algo 块（答案框等）忽略。
 */
export function parseBingHtml(html: string, limit: number): WebSearchResult[] {
  const blocks = html.split(/<li class="b_algo"[^>]*>/).slice(1);
  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const link = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
    if (!link) continue;
    const title = stripTags(link[2]!).trim();
    const url = link[1]!;
    if (!title || !url) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = p ? stripTags(p[1]!).trim() : "";
    results.push({ title, url, snippet });
  }
  return results;
}

/** 标签剥除 + 实体解码 + 空白收敛（搜索摘要/标题共用）。 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

// ── 工具封装（AgentHarnessTool：双引擎逐试薄封装） ─────────────

/** web_search 工具参数（JSON Schema，手写；与 GrepTool 同构风格）。 */
const searchParameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "搜索关键词" },
    limit: { type: "number", description: "返回结果条数上限（默认 10）" },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** 浏览器伪装 UA（静态抓取防风控的最低限度伪装）。 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 引擎清单：DDG html 版为主、Bing 兜底（无 Google——v1 实证基本失效）。 */
const SEARCH_ENGINES = [
  { name: "DuckDuckGo", baseUrl: "https://html.duckduckgo.com/html/?q=", parse: parseDuckDuckGoHtml },
  { name: "Bing", baseUrl: "https://www.bing.com/search?q=", parse: parseBingHtml },
] as const;

const SEARCH_TIMEOUT_MS = 10_000;

/** 逐引擎尝试：fetch → 解析 → ≥1 条即返回；全失败抛异常（含动态层兜底提示）。 */
async function searchWithEngines(query: string, limit: number): Promise<{ results: WebSearchResult[]; engine: string }> {
  const failures: string[] = [];
  for (const engine of SEARCH_ENGINES) {
    try {
      const res = await fetch(`${engine.baseUrl}${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        failures.push(`${engine.name} HTTP ${res.status}`);
        continue;
      }
      const results = engine.parse(await res.text(), limit);
      if (results.length > 0) return { results, engine: engine.name };
      failures.push(`${engine.name} 解析零结果`);
    } catch (error) {
      failures.push(`${engine.name} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `静态搜索不可用（${failures.join("；")}）。` +
      "可用 browser_open 打开搜索引擎页面 + browser_eval 提取结果（动态层兜底）。",
  );
}

/** web_search 工具：联网搜索（DDG 主/Bing 兜底），返回标题/链接/摘要可读行。 */
export function createWebSearchTool(): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "web_search",
    label: "web_search",
    description:
      "联网搜索（DuckDuckGo 主通道、Bing 兜底），返回标题/链接/摘要列表。" +
      "静态抓取（无浏览器）；两引擎均不可用时报错并提示动态层兜底路径。",
    parameters: searchParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { query, limit = 10 } = params as { query: string; limit?: number };
      const { results, engine } = await searchWithEngines(query, limit);
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
      );
      const text = `搜索 "${query}"（引擎 ${engine}，${results.length} 条）：\n\n${lines.join("\n\n")}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

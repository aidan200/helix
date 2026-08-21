import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * T1 静态联网工具族 integration：工具级三路径 + 双形态 + Jina 备选。
 * globalThis.fetch 全程 mock（路由式：按 URL 分发 fixture/错误），零真实网络。
 * 经 CoreToolExecutor.execute 走真实装配链路（工具异常 → isError 转换即被测面）。
 */

const DDG_HTML = `<html><body>
<div class="result"><h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-one&amp;rut=x">DDG 结果一</a>
</h2><a class="result__snippet" href="#">DDG 摘要一</a></div>
</body></html>`;

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/bing-one">Bing 结果一</a></h2><p>Bing 摘要一</p></li>
</ol></body></html>`;

const PAGE_HTML = `<html><head><title>页</title><style>x{}</style></head>
<body><h1>正文标题</h1><p>第一段</p><script>bad()</script></body></html>`;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

let originalFetch: typeof fetch;
let calls: string[];

/** 安装路由式 fetch mock；未命中路由抛网络错（测试未预期 URL 即失败）。 */
function installFetch(routes: Record<string, Response | (() => Promise<Response>)>): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (u.startsWith(prefix)) {
        return typeof handler === "function" ? handler() : handler;
      }
    }
    throw new Error(`ECONNREFUSED（mock 未路由：${u}）`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const executor = new CoreToolExecutor({ cwd: tmpdir() });
let tcSeq = 0;
function runTool(toolName: string, args: unknown) {
  return executor.execute({ toolCallId: `tc-web-${++tcSeq}`, toolName, args, signal: undefined });
}

describe("web_search 三路径（DDG 主 / Bing 兜底 / 全失败）", () => {
  test("① DDG 成功路径：标题/链接/摘要可读行；请求带浏览器 UA", async () => {
    let seenUA: string | undefined;
    installFetch({
      "https://html.duckduckgo.com/html/?q=": (async () => {
        return new Response(DDG_HTML, { status: 200 });
      }) as () => Promise<Response>,
    });
    // 捕获 UA：包一层
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUA = (init?.headers as Record<string, string>)?.["User-Agent"];
      return inner(url, init);
    }) as unknown as typeof fetch;

    const result = await runTool("web_search", { query: "helix 测试", limit: 5 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("DDG 结果一");
    expect(result.content).toContain("https://example.com/ddg-one"); // uddg 已解码
    expect(result.content).toContain("DDG 摘要一");
    expect(calls[0]).toContain("https://html.duckduckgo.com/html/?q=");
    expect(calls).toHaveLength(1); // 主引擎命中即不试兜底
    expect(seenUA).toContain("Mozilla/5.0");
  });

  test("② DDG 失败（HTTP 403）→ Bing 兜底成功", async () => {
    installFetch({
      "https://html.duckduckgo.com/": new Response("forbidden", { status: 403 }),
      "https://www.bing.com/search?q=": new Response(BING_HTML, { status: 200 }),
    });
    const result = await runTool("web_search", { query: "兜底验证" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Bing 结果一");
    expect(result.content).toContain("https://example.com/bing-one");
    expect(calls[0]).toContain("duckduckgo.com");
    expect(calls[1]).toContain("bing.com");
  });

  test("③ 双引擎全失败 → isError + CDP 兜底提示（browser_open/browser_eval）", async () => {
    installFetch({
      "https://html.duckduckgo.com/": new Response("blocked", { status: 403 }),
      "https://www.bing.com/": new Response("captcha", { status: 200 }), // 200 但零结果 = 解析失败
    });
    const result = await runTool("web_search", { query: "全失败" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("静态搜索不可用");
    expect(result.content).toContain("browser_open");
    expect(result.content).toContain("browser_eval");
  });
});

describe("web_fetch 双形态 + Jina 备选", () => {
  test("① markdown 形态（缺省）：HTML 转 Markdown（script/style 剥除）", async () => {
    installFetch({ "https://example.com/page": new Response(PAGE_HTML, { status: 200 }) });
    const result = await runTool("web_fetch", { url: "https://example.com/page" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("# 正文标题");
    expect(result.content).toContain("第一段");
    expect(result.content).not.toContain("bad()");
    expect(result.content).not.toContain("<style>");
  });

  test("② html 形态：原样返回", async () => {
    installFetch({ "https://example.com/page": new Response(PAGE_HTML, { status: 200 }) });
    const result = await runTool("web_fetch", { url: "https://example.com/page", format: "html" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe(PAGE_HTML);
  });

  test("③ 直连失败（非 2xx）→ Jina 备选通道（r.jina.ai + 去协议前缀 URL）", async () => {
    installFetch({
      "https://example.com/": new Response("Server Error", { status: 502 }),
      "https://r.jina.ai/": new Response("# Jina 抓取结果\n\n备选通道正文", { status: 200 }),
    });
    const result = await runTool("web_fetch", { url: "https://example.com/protected" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Jina 抓取结果");
    expect(calls).toEqual(["https://example.com/protected", "https://r.jina.ai/example.com/protected"]);
  });

  test("④ 直连网络异常也走 Jina；Jina 再失败 → isError 双通道说明", async () => {
    installFetch({
      // example.com 无路由 → mock 抛网络错（直连失败）
      "https://r.jina.ai/": new Response("rate limited", { status: 429 }),
    });
    const result = await runTool("web_fetch", { url: "https://unreachable.example.com/x" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("429");
  });

  test("⑤ 超长正文（>50KB）截断并注明", async () => {
    const big = `<p>${"长".repeat(60 * 1024)}</p>`;
    installFetch({ "https://example.com/big": new Response(big, { status: 200 }) });
    const result = await runTool("web_fetch", { url: "https://example.com/big", format: "html" });
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThan(big.length);
    expect(result.content).toContain("截断");
  });
});
